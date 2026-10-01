/**
 * The send engine, end to end, against the real schema (PGLite, every
 * migration applied) and a scripted stand-in for Gmail.
 *
 * Nothing here talks to Google. The stand-in records what it was asked to send
 * and can be told to fail in each of the ways Gmail really does — so every
 * claim the product makes about sending ("never twice", "never marked sent
 * without Gmail", "a lost answer is checked before a retry") is exercised as
 * running code, not asserted in a comment.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { decodeBase64Url } from "../gmail/mime.ts";
import type { GmailFailureKind, MessageMeta, SendResult, SentLookup } from "../gmail/client.server.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import * as store from "./store.server.ts";
import { composeFromTemplate, DEFAULT_TEMPLATES } from "./templates.ts";
import { DEFAULT_SETTINGS, type EmailKind, type OutreachSettings } from "./types.ts";
import {
  reconcileStale,
  retryEmails,
  runEndToEndTest,
  sendOne,
  type EngineDeps,
  type GmailApi,
  type TokenResult,
} from "./send-engine.server.ts";

const USER = "owner-1";
const SENDER = "peakswiftstudio@gmail.com";

// ── A stand-in for Gmail ─────────────────────────────────────────────────────

type Sent = { id: string; threadId: string; raw: string; headers: Record<string, string>; body: string };
type Script = "ok" | { fail: GmailFailureKind; status?: number; error?: string } | "lost-after-send";

class FakeGmail implements GmailApi {
  sent: Sent[] = [];
  calls = 0;
  script: Script[] = [];
  /** Gmail sometimes replaces the Message-ID; simulate it. */
  rewriteMessageId = false;
  /** Gmail's search can lag behind a send: the next N lookups see nothing. */
  lookupLag = 0;

  private parse(raw: string): { headers: Record<string, string>; body: string } {
    const text = decodeBase64Url(raw);
    const [head, body = ""] = text.split("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of (head ?? "").split("\r\n")) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }
    return { headers, body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") };
  }

  async sendMessage(_token: string, raw: string, threadId?: string): Promise<SendResult> {
    this.calls += 1;
    const step = this.script.shift() ?? "ok";
    if (typeof step === "object") {
      return { ok: false, error: step.error ?? `simulated ${step.fail}`, fatal: step.fail === "auth", status: step.status ?? 0, kind: step.fail };
    }
    const parsed = this.parse(raw);
    const id = `gm-${this.sent.length + 1}`;
    const record = {
      id,
      threadId: threadId ?? `th-${this.sent.length + 1}`,
      raw,
      headers: {
        ...parsed.headers,
        "message-id": this.rewriteMessageId ? `<CAgmail-${id}@mail.gmail.com>` : parsed.headers["message-id"] ?? "",
      },
      body: parsed.body,
    };
    this.sent.push(record);
    if (step === "lost-after-send") {
      return { ok: false, error: "Gmail did not answer in time — it may or may not have sent.", fatal: false, status: 0, kind: "uncertain" };
    }
    return { ok: true, messageId: id, threadId: record.threadId, labelIds: ["SENT"] };
  }

  async findSentMessage(
    _token: string,
    input: { rfc822MessageId?: string; to: string; subject: string; sinceEpochSeconds: number },
  ): Promise<SentLookup> {
    if (this.lookupLag > 0) {
      this.lookupLag -= 1;
      return { ok: true, found: false };
    }
    const hit = this.sent.find(
      (message) =>
        (input.rfc822MessageId && message.headers["message-id"] === input.rfc822MessageId) ||
        (message.headers.to?.toLowerCase().includes(input.to.toLowerCase()) && message.headers.subject === input.subject),
    );
    return hit
      ? { ok: true, found: true, id: hit.id, threadId: hit.threadId, rfc822MessageId: hit.headers["message-id"] ?? "" }
      : { ok: true, found: false };
  }

  async getMessageMeta(_token: string, id: string): Promise<({ ok: true } & MessageMeta) | { ok: false; notFound: true; error: string; fatal: false; kind: "permanent" }> {
    const hit = this.sent.find((message) => message.id === id);
    if (!hit) return { ok: false, notFound: true, error: "No such message.", fatal: false, kind: "permanent" };
    return { ok: true, id, threadId: hit.threadId, labelIds: ["SENT"], headers: hit.headers, snippet: "", internalDate: "" };
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let db: TestDb;
let gmail: FakeGmail;
let failNextMarkSent = 0;
let tokenResult: TokenResult;
let settings: OutreachSettings;

function deps(): EngineDeps {
  return { sql: db.sql, userId: USER, gmail, token: async () => tokenResult };
}

async function addLead(id: string, overrides: Partial<Lead> = {}): Promise<Lead> {
  const lead = createLead({
    id,
    businessName: `Strathearn Joinery ${id} Ltd`,
    trade: "Joiner",
    town: "Crieff",
    email: `hello@strathearn-${id}.co.uk`,
    emailConfidence: "HIGH",
    emailSource: "Business contact page",
    websiteStatus: "No Website Found",
    phone: "01764 123456",
    ...overrides,
  });
  const { text, params } = buildLeadUpsert(USER, [lead]);
  await db.sql.query(text, params);
  return lead;
}

async function addEmail(
  lead: Lead,
  options: { id?: string; status?: "queued" | "approved" | "draft"; kind?: EmailKind; campaignId?: string; subject?: string } = {},
): Promise<string> {
  const composed = composeFromTemplate(lead as never, DEFAULT_TEMPLATES[0]!);
  const id = options.id ?? `email-${lead.id}-${options.kind ?? "initial"}`;
  await store.upsertDraft(db.sql, USER, {
    id,
    leadId: lead.id,
    businessName: lead.businessName,
    recipient: lead.email,
    subject: options.subject ?? composed.subject,
    body: composed.body,
    kind: options.kind ?? "initial",
    generatedBy: composed.generatedBy,
    status: "draft",
    campaignId: options.campaignId ?? "",
  });
  if ((options.status ?? "queued") !== "draft") {
    await store.setEmailStatus(db.sql, USER, id, options.status ?? "queued", { approved: true });
  }
  return id;
}

async function row(id: string) {
  const email = await store.loadEmail(db.sql, USER, id);
  assert.ok(email, `email ${id} exists`);
  return email!;
}

beforeEach(async () => {
  failNextMarkSent = 0;
  db = await createTestDb({
    intercept: (text) => {
      if (failNextMarkSent > 0 && /set status = 'sent', gmail_message_id/.test(text)) {
        failNextMarkSent -= 1;
        throw new Error("simulated database outage");
      }
    },
  });
  gmail = new FakeGmail();
  tokenResult = { ok: true, accessToken: "token", email: SENDER };
  settings = { ...DEFAULT_SETTINGS, dailyLimit: 10 };
  await db.sql.query(
    `insert into gmail_accounts (user_id, email, status) values ($1, $2, 'connected')`,
    [USER, SENDER],
  );
});

afterEach(async () => {
  await db.close();
});

const send = (id: string) => sendOne(deps(), id, { settings, profile: null });

// ── The happy path ───────────────────────────────────────────────────────────

describe("sending one approved email", () => {
  it("sends through Gmail and records exactly what happened", async () => {
    const lead = await addLead("a");
    const id = await addEmail(lead);
    const outcome = await send(id);
    assert.equal(outcome.status, "sent");
    assert.equal(gmail.sent.length, 1);

    const stored = await row(id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.gmailMessageId, "gm-1");
    assert.equal(stored.gmailThreadId, "th-1");
    assert.equal(stored.sendingAccount, SENDER);
    assert.ok(stored.sentAt, "sent_at recorded");
    assert.ok(stored.rfc822MessageId?.startsWith("<peakswift."), "Message-ID recorded");
    assert.match(stored.providerResponse ?? "", /"id":"gm-1"/);
    assert.equal(stored.attempts, 1);

    const message = gmail.sent[0]!;
    assert.equal(message.headers.to, lead.email);
    assert.match(message.headers.from ?? "", /Charlie at PeakSwiftStudio <peakswiftstudio@gmail\.com>/);
    assert.match(message.body, /Strathearn Joinery a Ltd/);

    const [leadRow] = await db.sql.query<{ outreach_status: string; last_emailed_at: string }>(
      `select outreach_status, last_emailed_at from leads where user_id = $1 and id = 'a'`,
      [USER],
    );
    assert.equal(leadRow!.outreach_status, "Sent");
    assert.ok(leadRow!.last_emailed_at);
  });

  it("never sends the same email twice, however often Send is pressed", async () => {
    const id = await addEmail(await addLead("b"));
    assert.equal((await send(id)).status, "sent");
    const again = await send(id);
    assert.equal(again.status, "already_sent");
    assert.equal(gmail.calls, 1);
  });

  it("sends once when two requests race for the same email", async () => {
    const id = await addEmail(await addLead("c"));
    const results = await Promise.all([send(id), send(id), send(id)]);
    assert.equal(gmail.calls, 1, "Gmail called exactly once");
    assert.equal(results.filter((result) => result.status === "sent").length, 1);
  });

  it("refuses a draft that was never approved", async () => {
    const id = await addEmail(await addLead("d"), { status: "draft" });
    const outcome = await send(id);
    assert.equal(outcome.status, "skipped");
    assert.equal(gmail.calls, 0);
  });
});

// ── The second gate: things that changed after approval ──────────────────────

describe("the second gate, immediately before Gmail", () => {
  it("blocks an address suppressed after approval", async () => {
    const lead = await addLead("s");
    const id = await addEmail(lead);
    await store.suppress(db.sql, USER, { email: lead.email, reason: "asked to stop" });
    const outcome = await send(id);
    assert.equal(outcome.status, "blocked");
    assert.match((outcome as { reason: string }).reason, /opted out/);
    assert.equal(gmail.calls, 0);
    assert.equal((await row(id)).status, "skipped");
  });

  it("blocks an address a verifier found undeliverable after approval", async () => {
    const lead = await addLead("v");
    const id = await addEmail(lead);
    const { saveVerification } = await import("../contactability/store.server.ts");
    await saveVerification(db.sql, USER, { email: lead.email, result: "invalid", provider: "test" });
    const outcome = await send(id);
    assert.equal(outcome.status, "blocked");
    assert.equal(gmail.calls, 0);
  });

  it("a catch-all address is not refused by verification alone", async () => {
    const lead = await addLead("c");
    const id = await addEmail(lead);
    const { saveVerification } = await import("../contactability/store.server.ts");
    await saveVerification(db.sql, USER, { email: lead.email, result: "catch_all", provider: "test" });
    assert.equal((await send(id)).status, "sent");
  });

  it("blocks a lead that replied during the campaign", async () => {
    const lead = await addLead("r");
    const id = await addEmail(lead);
    await store.updateLeadOutreach(db.sql, USER, lead.id, { outreachStatus: "Replied" });
    assert.equal((await send(id)).status, "blocked");
    assert.equal(gmail.calls, 0);
  });

  it("blocks a lead marked Not Interested after a phone call", async () => {
    const lead = await addLead("n");
    const id = await addEmail(lead);
    await store.updateLeadOutcome(db.sql, USER, lead.id, { called: "Not Interested", callResult: "Not Interested" });
    const outcome = await send(id);
    assert.equal(outcome.status, "blocked");
    assert.match((outcome as { reason: string }).reason, /Not Interested/);
  });

  it("blocks when the lead's address changed after the email was written", async () => {
    const lead = await addLead("m");
    const id = await addEmail(lead);
    const { text, params } = buildLeadUpsert(USER, [{ ...lead, email: "new@strathearn-m.co.uk" }]);
    await db.sql.query(text, params);
    const outcome = await send(id);
    assert.equal(outcome.status, "blocked");
    assert.match((outcome as { reason: string }).reason, /address changed/);
  });

  it("blocks a business already emailed under another campaign (same address)", async () => {
    const lead = await addLead("dup");
    const first = await addEmail(lead, { id: "first", campaignId: "camp-1" });
    assert.equal((await send(first)).status, "sent");
    // A second lead row for the same business, found by another campaign.
    const twin = await addLead("dup2", { email: lead.email, businessName: lead.businessName });
    await store.upsertDraft(db.sql, USER, {
      id: "second",
      leadId: twin.id,
      businessName: twin.businessName,
      recipient: twin.email,
      subject: "A website?",
      body: "x",
      kind: "initial",
      generatedBy: "manual",
      status: "draft",
      campaignId: "camp-2",
    });
    // The database itself refuses a second live initial email to that address.
    await assert.rejects(store.setEmailStatus(db.sql, USER, "second", "queued", { approved: true }), /unique|duplicate/i);
    assert.equal(gmail.calls, 1);
  });
});

// ── Limits ───────────────────────────────────────────────────────────────────

describe("daily and campaign limits", () => {
  it("holds everything past the daily limit, untouched and still approved", async () => {
    settings = { ...settings, dailyLimit: 2 };
    const ids = [];
    for (const key of ["l1", "l2", "l3"]) ids.push(await addEmail(await addLead(key)));
    const results = [];
    for (const id of ids) results.push(await send(id));
    assert.deepEqual(results.map((result) => result.status), ["sent", "sent", "held"]);
    assert.equal((await row(ids[2]!)).status, "queued");
    assert.equal(gmail.calls, 2);
  });

  it("holds a campaign's emails past the campaign's own daily limit", async () => {
    const now = new Date().toISOString();
    await store.upsertCampaign(db.sql, USER, {
      id: "camp",
      name: "Perthshire Joiners",
      status: "ACTIVE",
      locations: "Perthshire",
      trades: "Joiner",
      targetProspects: 50,
      dailyTarget: 1,
      batchSize: 5,
      sendMode: "prepare",
      createdAt: now,
      updatedAt: now,
    });
    const a = await addEmail(await addLead("ca"), { campaignId: "camp" });
    const b = await addEmail(await addLead("cb"), { campaignId: "camp" });
    const c = await addEmail(await addLead("cc"));
    assert.equal((await send(a)).status, "sent");
    const held = await send(b);
    assert.equal(held.status, "held");
    assert.match((held as { reason: string }).reason, /campaign's daily limit/);
    assert.equal((await send(c)).status, "sent", "other work is not held by one campaign's limit");
  });

  it("holds the emails of a paused campaign", async () => {
    const now = new Date().toISOString();
    await store.upsertCampaign(db.sql, USER, {
      id: "paused",
      name: "Paused one",
      status: "PAUSED",
      locations: "Perth",
      trades: "Roofer",
      targetProspects: 10,
      dailyTarget: 10,
      batchSize: 5,
      sendMode: "prepare",
      createdAt: now,
      updatedAt: now,
    });
    const id = await addEmail(await addLead("p"), { campaignId: "paused" });
    const outcome = await send(id);
    assert.equal(outcome.status, "held");
    assert.equal(gmail.calls, 0);
  });

  it("does not count test emails against the prospect limit", async () => {
    settings = { ...settings, dailyLimit: 1 };
    const e2e = await runEndToEndTest(deps(), { to: SENDER, designated: "", profile: null });
    assert.equal(e2e.ok, true, JSON.stringify(e2e.steps));
    assert.equal((await send(await addEmail(await addLead("after-test")))).status, "sent");
  });
});

// ── Gmail failures ───────────────────────────────────────────────────────────

describe("when Gmail fails", () => {
  it("an expired or revoked token sends nothing, keeps the email approved and stops the batch", async () => {
    const id = await addEmail(await addLead("auth"));
    gmail.script = [{ fail: "auth", status: 401, error: "invalid_grant: Token has been expired or revoked." }];
    const outcome = await send(id);
    assert.equal(outcome.status, "not_sent");
    assert.equal((outcome as { stopBatch?: boolean }).stopBatch, true);
    const stored = await row(id);
    assert.equal(stored.status, "queued", "still approved, ready once Gmail is reconnected");
    assert.equal(stored.failureKind, "auth");
    const account = await store.loadGmailAccount(db.sql, USER);
    assert.equal(account?.status, "needs_attention");
  });

  it("a token that cannot be refreshed stops before anything is claimed", async () => {
    const id = await addEmail(await addLead("tok"));
    tokenResult = { ok: false, error: "Gmail connection needs attention. Reconnect the account.", needsAttention: true };
    const outcome = await send(id);
    assert.equal(outcome.status, "not_sent");
    assert.equal(gmail.calls, 0);
    assert.equal((await row(id)).status, "queued");
  });

  it("a rate limit sends nothing and stops the batch", async () => {
    const id = await addEmail(await addLead("rl"));
    gmail.script = [{ fail: "rate_limit", status: 429, error: "rateLimitExceeded" }];
    const outcome = await send(id);
    assert.equal(outcome.status, "not_sent");
    assert.equal((await row(id)).status, "queued");
  });

  it("a permanent rejection fails that email only, and is not retried as-is", async () => {
    const bad = await addEmail(await addLead("perm"));
    const good = await addEmail(await addLead("fine"));
    gmail.script = [{ fail: "permanent", status: 400, error: "Invalid To header" }];
    const first = await send(bad);
    assert.equal(first.status, "failed");
    assert.equal((first as { retryable?: boolean }).retryable, false);
    assert.equal((await send(good)).status, "sent", "the batch carries on");
    const [retry] = await retryEmails(deps(), [bad]);
    assert.equal(retry!.result, "refused");
    assert.equal((await row(bad)).status, "failed");
  });

  it("partial batch: 8 sent, 2 failed, each failure named", async () => {
    const ids = [];
    for (let i = 0; i < 10; i += 1) ids.push(await addEmail(await addLead(`batch${i}`)));
    gmail.script = ["ok", "ok", { fail: "permanent", status: 400, error: "Invalid To header" }, "ok", "ok", "ok", { fail: "transient", status: 503, error: "Backend Error" }, "ok", "ok", "ok"];
    const results = [];
    for (const id of ids) results.push(await send(id));
    assert.equal(results.filter((result) => result.status === "sent").length, 8);
    const failed = results.filter((result) => result.status === "failed");
    assert.equal(failed.length, 2);
    for (const item of failed) assert.ok((item as { reason: string }).reason.length > 10);
    const rows = await store.loadEmails(db.sql, USER);
    assert.equal(rows.filter((email) => email.status === "sent").length, 8);
    assert.ok(rows.filter((email) => email.status === "sent").every((email) => email.gmailMessageId));
  });

  it("a 5xx is retried only after Gmail confirms it never went", async () => {
    const id = await addEmail(await addLead("t5"));
    gmail.script = [{ fail: "transient", status: 503, error: "Backend Error" }];
    assert.equal((await send(id)).status, "failed");
    const [retry] = await retryEmails(deps(), [id]);
    assert.equal(retry!.result, "requeued");
    assert.equal((await send(id)).status, "sent");
    assert.equal(gmail.sent.length, 1);
  });

  it("a lost answer where Gmail DID send is recorded as sent — never resent", async () => {
    const id = await addEmail(await addLead("lost"));
    gmail.script = ["lost-after-send"];
    const outcome = await send(id);
    assert.equal(outcome.status, "sent");
    assert.equal((outcome as { recovered?: boolean }).recovered, true);
    assert.equal(gmail.sent.length, 1);
    assert.equal((await row(id)).status, "sent");
    const [retry] = await retryEmails(deps(), [id]);
    assert.equal(retry!.result, "already_sent");
    assert.equal(gmail.sent.length, 1);
  });

  it("a lost answer Gmail had not indexed yet is caught by the retry check, not resent", async () => {
    const id = await addEmail(await addLead("lag"));
    gmail.script = ["lost-after-send"];
    gmail.lookupLag = 1; // the immediate check misses it
    const outcome = await send(id);
    assert.equal(outcome.status, "failed");
    assert.equal((outcome as { retryable?: boolean }).retryable, true);
    assert.equal(gmail.sent.length, 1, "Gmail did send it");
    const [retry] = await retryEmails(deps(), [id]);
    assert.equal(retry!.result, "already_sent", "the retry found it in Gmail");
    assert.equal((await row(id)).status, "sent");
    assert.equal((await send(id)).status, "already_sent");
    assert.equal(gmail.sent.length, 1, "never sent a second copy");
  });

  it("a lost answer where Gmail did NOT send is failed, then safely retried", async () => {
    const id = await addEmail(await addLead("lost2"));
    gmail.script = [{ fail: "uncertain", error: "Gmail did not answer in time — it may or may not have sent." }];
    const outcome = await send(id);
    assert.equal(outcome.status, "failed");
    assert.equal((await row(id)).failureKind, "uncertain");
    const [retry] = await retryEmails(deps(), [id]);
    assert.equal(retry!.result, "requeued");
    assert.equal((await send(id)).status, "sent");
    assert.equal(gmail.sent.length, 1);
  });

  it("Gmail sends but the database write fails: reported as sent, reconciled later, never resent", async () => {
    const id = await addEmail(await addLead("dbfail"));
    failNextMarkSent = 2;
    const outcome = await send(id);
    assert.equal(outcome.status, "sent_unrecorded");
    assert.match((outcome as { reason: string }).reason, /do not resend/);
    assert.equal((await row(id)).status, "sending", "left for reconciliation, not failed");
    // A second press does not send it again.
    assert.equal((await send(id)).status, "skipped");
    // Later, reconciliation finishes it from Gmail's own record.
    await db.sql.query(`update outreach_emails set sending_started_at = now() - interval '10 minutes' where id = $1`, [id]);
    const reconciled = await reconcileStale(deps());
    assert.equal(reconciled.recovered, 1);
    const stored = await row(id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.gmailMessageId, "gm-1");
    assert.equal(gmail.sent.length, 1);
  });

  it("a function that died after claiming (Gmail never called) is released for a safe retry", async () => {
    const id = await addEmail(await addLead("died"));
    await db.sql.query(
      `update outreach_emails set status = 'sending', sending_started_at = now() - interval '10 minutes', rfc822_message_id = '<x@gmail.com>' where id = $1`,
      [id],
    );
    const reconciled = await reconcileStale(deps());
    assert.equal(reconciled.released, 1);
    assert.equal((await row(id)).status, "failed");
    const [retry] = await retryEmails(deps(), [id]);
    assert.equal(retry!.result, "requeued");
    assert.equal((await send(id)).status, "sent");
    assert.equal(gmail.sent.length, 1);
  });

  it("the token expiring mid-batch stops the rest without touching them", async () => {
    const a = await addEmail(await addLead("m1"));
    const b = await addEmail(await addLead("m2"));
    assert.equal((await send(a)).status, "sent");
    tokenResult = { ok: false, error: "Gmail connection needs attention. Reconnect the account.", needsAttention: true };
    assert.equal((await send(b)).status, "not_sent");
    assert.equal((await row(b)).status, "queued");
  });
});

// ── The database's own guarantees ────────────────────────────────────────────

describe("database invariants", () => {
  it("refuses to record a send without Gmail's message id", async () => {
    const id = await addEmail(await addLead("proof"));
    await db.sql.query(`update outreach_emails set status = 'sending' where id = $1`, [id]);
    await assert.rejects(
      store.markSent(db.sql, USER, id, { messageId: "", threadId: "", account: SENDER }),
      /sent_has_proof/,
    );
  });
});

// ── Follow-ups ───────────────────────────────────────────────────────────────

describe("follow-ups thread under the original", () => {
  it("uses the Message-ID Gmail actually used, and the same thread", async () => {
    gmail.rewriteMessageId = true;
    const lead = await addLead("f");
    const first = await addEmail(lead);
    assert.equal((await send(first)).status, "sent");
    const original = await row(first);
    assert.equal(original.rfc822MessageId, "<CAgmail-gm-1@mail.gmail.com>", "the real header is stored");

    const follow = await addEmail(lead, { kind: "follow-up-1", subject: `Re: ${original.subject}` });
    await db.sql.query(`update outreach_emails set gmail_thread_id = $2 where id = $1`, [follow, original.gmailThreadId]);
    assert.equal((await send(follow)).status, "sent");
    const second = gmail.sent[1]!;
    assert.equal(second.headers["in-reply-to"], "<CAgmail-gm-1@mail.gmail.com>");
    assert.equal(second.headers.references, "<CAgmail-gm-1@mail.gmail.com>");
    assert.equal(second.threadId, original.gmailThreadId);
  });
});

// ── The end-to-end test mode ─────────────────────────────────────────────────

describe("end-to-end test mode", () => {
  it("refuses any address that is not a designated test address", async () => {
    const result = await runEndToEndTest(deps(), { to: "hello@real-prospect.co.uk", designated: "me@example.com", profile: null });
    assert.equal(result.ok, false);
    assert.equal(gmail.calls, 0);
    assert.match(result.steps.at(-1)!.detail, /refused/);
  });

  it("runs the whole pipeline to the designated address and confirms it in Gmail", async () => {
    const result = await runEndToEndTest(deps(), { to: "me@example.com", designated: "me@example.com", profile: null });
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));
    assert.deepEqual(
      result.steps.map((step) => step.step),
      ["Gmail connection", "Test recipient", "Test prospect", "Email written", "Quality gate", "Approved", "Sent through Gmail", "Recorded", "Confirmed by Gmail"],
    );
    const [stored] = await db.sql.query<{ status: string; kind: string; gmail_message_id: string }>(
      `select status, kind, gmail_message_id from outreach_emails where user_id = $1 and kind = 'test'`,
      [USER],
    );
    assert.equal(stored!.status, "test_sent");
    assert.equal(stored!.gmail_message_id, result.messageId);
    assert.match(gmail.sent[0]!.headers.subject ?? "", /^\[TEST\]/);
  });
});
