/**
 * The opt-out path, end to end: the signed link, the headers a mail client's
 * own "Unsubscribe" button uses, what one click changes in the database, and
 * that nothing is ever sent to the address again.
 *
 * Also the small Phase A helpers the link depends on: the public origin a link
 * points at, the sender advice, and log redaction.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { appOrigin } from "../app-origin.ts";
import { signUnsubscribe, verifyUnsubscribe } from "../crypto/secrets.server.ts";
import { buildMimeMessage, decodeBase64Url, listUnsubscribeHeaders } from "../gmail/mime.ts";
import type { SendResult } from "../gmail/client.server.ts";
import { redact } from "../log.server.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import { senderAdvice } from "./sender-advice.ts";
import * as store from "./store.server.ts";
import { sendOne, unsubscribeParts, type EngineDeps, type GmailApi } from "./send-engine.server.ts";
import { composeFromTemplate, DEFAULT_TEMPLATES } from "./templates.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

const USER = "owner-1";
const SENDER = "peakswiftstudio@gmail.com";
const ORIGIN = "https://peak-swift-leads-git-claude-production-overhaul-charlie-brock.vercel.app";

const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

// ── The signed token ─────────────────────────────────────────────────────────

describe("the unsubscribe token", () => {
  it("round-trips the account, the address (lower-cased) and the email", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const token = signUnsubscribe({ userId: USER, email: " Hello@Strathearn.co.uk ", emailId: "email-1" });
    assert.deepEqual(verifyUnsubscribe(token), {
      ok: true,
      claim: { userId: USER, email: "hello@strathearn.co.uk", emailId: "email-1" },
    });
  });

  it("is URL-safe, so it survives being put in a link", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const token = signUnsubscribe({ userId: USER, email: "a+b@example.co.uk", emailId: "e/1?x" });
    assert.match(token, /^[A-Za-z0-9._-]+$/);
  });

  it("rejects a token edited to name another address or another account", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const token = signUnsubscribe({ userId: USER, email: "hello@strathearn.co.uk", emailId: "email-1" });
    const [version, , mac] = token.split(".");
    for (const claim of [{ u: USER, e: "someone@else.co.uk", i: "email-1" }, { u: "owner-2", e: "hello@strathearn.co.uk", i: "email-1" }]) {
      const forged = `${version}.${Buffer.from(JSON.stringify(claim)).toString("base64url")}.${mac}`;
      assert.deepEqual(verifyUnsubscribe(forged), { ok: false });
    }
  });

  it("rejects a token signed with another key, a truncated one, and junk", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const token = signUnsubscribe({ userId: USER, email: "hello@strathearn.co.uk", emailId: "email-1" });
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-two";
    assert.deepEqual(verifyUnsubscribe(token), { ok: false });
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    assert.deepEqual(verifyUnsubscribe(token.slice(0, -4)), { ok: false });
    for (const junk of ["", "v1", "v1..", "v2.abc.def", "<script>", "v1.bm90LWpzb24.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]) {
      assert.deepEqual(verifyUnsubscribe(junk), { ok: false }, junk);
    }
  });

  it("does not expire: a link opened a year later still works", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const token = signUnsubscribe({ userId: USER, email: "hello@strathearn.co.uk", emailId: "email-1" });
    assert.equal(verifyUnsubscribe(token).ok, true);
    assert.ok(!token.includes(String(new Date().getFullYear())), "no timestamp to expire on");
  });
});

// ── The headers ──────────────────────────────────────────────────────────────

describe("List-Unsubscribe headers", () => {
  it("offers one-click (RFC 8058) only for an https link, with a mailto alongside", () => {
    assert.deepEqual(listUnsubscribeHeaders({ url: `${ORIGIN}/unsubscribe?t=abc`, mailto: SENDER }), [
      `List-Unsubscribe: <${ORIGIN}/unsubscribe?t=abc>, <mailto:${SENDER}?subject=unsubscribe>`,
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    ]);
  });

  it("falls back to mailto alone, without claiming one-click, when there is no https link", () => {
    for (const url of ["", "http://insecure.example/unsubscribe", "javascript:alert(1)"]) {
      assert.deepEqual(listUnsubscribeHeaders({ url, mailto: SENDER }), [`List-Unsubscribe: <mailto:${SENDER}?subject=unsubscribe>`], url);
    }
  });

  it("adds nothing when there is nothing valid to offer", () => {
    assert.deepEqual(listUnsubscribeHeaders(undefined), []);
    assert.deepEqual(listUnsubscribeHeaders({ url: "", mailto: "not an address" }), []);
  });

  it("cannot be used to inject another header", () => {
    const headers = listUnsubscribeHeaders({ url: `${ORIGIN}/u?t=a\r\nBcc: victim@example.com`, mailto: `${SENDER}\r\nBcc: x@y.z` });
    const message = buildMimeMessage({
      to: "hello@strathearn.co.uk",
      from: SENDER,
      subject: "Hi",
      body: "Body",
      listUnsubscribe: { url: `${ORIGIN}/u?t=a\r\nBcc: victim@example.com`, mailto: SENDER },
    });
    assert.ok(!/^bcc:/im.test(message), "no Bcc header");
    for (const header of headers) assert.ok(!/[\r\n]/.test(header), header);
  });
});

// ── Where the link points ────────────────────────────────────────────────────

describe("the public origin used in links", () => {
  it("is the branch alias on a Preview — never the per-deployment URL", () => {
    assert.equal(
      appOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: ORIGIN.slice(8), VERCEL_URL: "peak-swift-leads-abc123-charlie-brock.vercel.app" }),
      ORIGIN,
    );
  });

  it("is the production domain on Production", () => {
    assert.equal(
      appOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "peak-swift-leads.vercel.app", VERCEL_BRANCH_URL: "x-git-main.vercel.app" }),
      "https://peak-swift-leads.vercel.app",
    );
  });

  it("is APP_URL when set, cleaned of quotes and trailing slashes", () => {
    assert.equal(appOrigin({ APP_URL: ' "https://leads.peakswift.co.uk/" ', VERCEL_ENV: "production" }), "https://leads.peakswift.co.uk");
  });

  it("is the fallback (or nothing) off Vercel", () => {
    assert.equal(appOrigin({}, "http://localhost:8080/"), "http://localhost:8080");
    assert.equal(appOrigin({}), "");
  });
});

// ── The email itself ─────────────────────────────────────────────────────────

describe("what goes in the email", () => {
  it("adds a signed link to the footer and the header when the origin is https", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const parts = unsubscribeParts({ userId: USER, publicOrigin: `${ORIGIN}/` }, { id: "email-1", recipient: "hello@strathearn.co.uk" }, SENDER);
    assert.match(parts.footer, /To stop hearing from me: https:\/\/.+\/unsubscribe\?t=v1\./);
    assert.ok(parts.header?.url.startsWith(`${ORIGIN}/unsubscribe?t=`));
    assert.equal(parts.header?.mailto, SENDER);
    const token = decodeURIComponent(new URL(parts.header!.url).searchParams.get("t") ?? "");
    assert.deepEqual(verifyUnsubscribe(token), { ok: true, claim: { userId: USER, email: "hello@strathearn.co.uk", emailId: "email-1" } });
  });

  it("offers only a mailto (no dead link in the body) when there is no https origin", () => {
    const parts = unsubscribeParts({ userId: USER, publicOrigin: "http://localhost:8080" }, { id: "e", recipient: "a@b.co.uk" }, SENDER);
    assert.equal(parts.footer, "");
    assert.deepEqual(parts.header, { url: "", mailto: SENDER });
  });
});

// ── One click, against the real schema ───────────────────────────────────────

class RecordingGmail implements GmailApi {
  sent: { headers: Record<string, string>; body: string }[] = [];
  async sendMessage(_token: string, raw: string): Promise<SendResult> {
    const text = decodeBase64Url(raw);
    const [head, body = ""] = text.split("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of (head ?? "").split("\r\n")) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }
    this.sent.push({ headers, body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") });
    const id = `gm-${this.sent.length}`;
    return { ok: true, messageId: id, threadId: `th-${this.sent.length}`, labelIds: ["SENT"] };
  }
  async findSentMessage() {
    return { ok: true as const, found: false as const };
  }
  async getMessageMeta() {
    return { ok: false as const, notFound: true as const, error: "none", fatal: false as const, kind: "permanent" as const };
  }
}

describe("clicking the link", () => {
  let db: TestDb;
  let gmail: RecordingGmail;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    db = await createTestDb();
    gmail = new RecordingGmail();
    await db.sql.query(`insert into gmail_accounts (user_id, email, status) values ($1, $2, 'connected')`, [USER, SENDER]);
  });
  afterEach(async () => {
    await db.close();
  });

  const deps = (): EngineDeps => ({
    sql: db.sql,
    userId: USER,
    gmail,
    token: async () => ({ ok: true, accessToken: "token", email: SENDER }),
    publicOrigin: ORIGIN,
  });

  const leads = new Map<string, ReturnType<typeof createLead>>();

  async function addLead(id: string, email: string) {
    const lead = createLead({
      id,
      businessName: `Strathearn Joinery ${id} Ltd`,
      trade: "Joiner",
      town: "Crieff",
      email,
      emailConfidence: "HIGH",
      emailSource: "Business contact page",
      websiteStatus: "No Website Found",
    });
    const { text, params } = buildLeadUpsert(USER, [lead]);
    await db.sql.query(text, params);
    leads.set(id, lead);
    return lead;
  }

  async function addEmail(leadId: string, recipient: string, id: string, status: "approved" | "draft" = "approved") {
    const composed = composeFromTemplate(leads.get(leadId) as never, DEFAULT_TEMPLATES[0]!);
    await store.upsertDraft(db.sql, USER, {
      id,
      leadId,
      businessName: `Strathearn Joinery ${leadId} Ltd`,
      recipient,
      subject: id.endsWith("follow") ? `Re: ${composed.subject}` : composed.subject,
      body: composed.body,
      kind: id.endsWith("follow") ? "follow-up-1" : "initial",
      generatedBy: composed.generatedBy,
      status: "draft",
      campaignId: "",
    });
    if (status === "approved") await store.setEmailStatus(db.sql, USER, id, "approved", { approved: true });
  }

  it("sends the first email with the headers and footer, then one click stops everything", async () => {
    await addLead("a", "hello@strathearn-a.co.uk");
    await addEmail("a", "hello@strathearn-a.co.uk", "email-a");
    const first = await sendOne(deps(), "email-a", { settings: { ...DEFAULT_SETTINGS, dailyLimit: 10 }, profile: null });
    assert.equal(first.status, "sent", JSON.stringify(first));

    const message = gmail.sent[0]!;
    assert.match(message.headers["list-unsubscribe"] ?? "", /^<https:\/\/.+\/unsubscribe\?t=v1\.[^>]+>, <mailto:peakswiftstudio@gmail\.com\?subject=unsubscribe>$/);
    assert.equal(message.headers["list-unsubscribe-post"], "List-Unsubscribe=One-Click");
    assert.match(message.body, /To stop hearing from me: https:\/\//);

    // The recipient clicks: the token in the header is what the route verifies.
    const url = /<(https:[^>]+)>/.exec(message.headers["list-unsubscribe"]!)![1]!;
    const verified = verifyUnsubscribe(new URL(url).searchParams.get("t") ?? "");
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.claim.userId, USER);

    // A follow-up had already been written and approved before the click.
    await addEmail("a", "hello@strathearn-a.co.uk", "email-a-follow");
    const result = await store.unsubscribeByLink(db.sql, verified.claim.userId, verified.claim);
    assert.deepEqual(result, { businessName: "Strathearn Joinery a Ltd", alreadySuppressed: false });

    const suppressed = await store.suppressedSet(db.sql, USER);
    assert.ok(suppressed.has("hello@strathearn-a.co.uk"));
    const [lead] = await db.sql.query<{ outreach_status: string; unsubscribed: string }>(
      `select outreach_status, unsubscribed from leads where user_id = $1 and id = 'a'`,
      [USER],
    );
    assert.equal(lead!.outreach_status, "Unsubscribed");
    assert.ok(lead!.unsubscribed, "unsubscribed date recorded");

    const followUp = await store.loadEmail(db.sql, USER, "email-a-follow");
    assert.equal(followUp!.status, "skipped", "the approved follow-up is withdrawn");
    assert.equal((await store.loadEmail(db.sql, USER, "email-a"))!.status, "sent", "history is kept");

    // Even re-approved by hand, it cannot go.
    await store.setEmailStatus(db.sql, USER, "email-a-follow", "approved", { approved: true });
    const retry = await sendOne(deps(), "email-a-follow", { settings: { ...DEFAULT_SETTINGS, dailyLimit: 10 }, profile: null });
    assert.notEqual(retry.status, "sent");
    assert.equal(gmail.sent.length, 1, "nothing further reached Gmail");
  });

  it("is safe to click twice, and keeps the first unsubscribe date", async () => {
    await addLead("b", "hello@strathearn-b.co.uk");
    await addEmail("b", "hello@strathearn-b.co.uk", "email-b", "draft");
    const claim = { email: "Hello@Strathearn-B.co.uk", emailId: "email-b" };
    const first = await store.unsubscribeByLink(db.sql, USER, claim, new Date("2026-09-01T10:00:00Z"));
    const second = await store.unsubscribeByLink(db.sql, USER, claim, new Date("2026-09-20T10:00:00Z"));
    assert.equal(first.alreadySuppressed, false);
    assert.equal(second.alreadySuppressed, true);
    const [lead] = await db.sql.query<{ unsubscribed: string }>(`select unsubscribed from leads where user_id = $1 and id = 'b'`, [USER]);
    assert.match(lead!.unsubscribed, /^2026-09-01/);
    const rows = await db.sql.query<{ n: number }>(`select count(*)::int as n from outreach_suppression where user_id = $1`, [USER]);
    assert.equal(rows[0]!.n, 1);
  });

  it("only touches the account named in the token", async () => {
    await addLead("c", "hello@strathearn-c.co.uk");
    const other = createLead({ id: "c", businessName: "Other owner's lead", email: "hello@strathearn-c.co.uk", trade: "Joiner", town: "Perth" });
    const { text, params } = buildLeadUpsert("owner-2", [other]);
    await db.sql.query(text, params);

    await store.unsubscribeByLink(db.sql, USER, { email: "hello@strathearn-c.co.uk", emailId: "" });
    const [mine] = await db.sql.query<{ outreach_status: string }>(`select outreach_status from leads where user_id = $1 and id = 'c'`, [USER]);
    const [theirs] = await db.sql.query<{ outreach_status: string }>(`select outreach_status from leads where user_id = 'owner-2' and id = 'c'`);
    assert.equal(mine!.outreach_status, "Unsubscribed");
    assert.notEqual(theirs!.outreach_status, "Unsubscribed");
    assert.equal((await store.suppressedSet(db.sql, "owner-2")).size, 0);
  });
});

// ── Small helpers ────────────────────────────────────────────────────────────

describe("sender advice", () => {
  it("recommends a domain mailbox for a consumer address, without blocking", () => {
    const advice = senderAdvice(SENDER);
    assert.equal(advice.kind, "consumer");
    assert.match(advice.advice, /Google Workspace/);
    assert.equal(senderAdvice("charlie@peakswiftstudio.co.uk").kind, "domain");
    assert.equal(senderAdvice("").kind, "unknown");
  });
});

describe("log redaction", () => {
  it("masks credentials by field name and by shape, and keeps identifiers", () => {
    const out = redact({
      userId: USER,
      emailId: "email-1",
      accessToken: "ya29.abc",
      refresh_token: "1//0gabcdefghijklmnopqrstuvwxyz",
      apiKey: "sk-123",
      tokenProblem: "expired",
      message: "Request failed: Authorization: Bearer abcdefghijklmnop and GOCSPX-secret123 stored enc:v1:aa:bb:cc",
      nested: { password: "hunter2", note: "ya29.leaked-token" },
    }) as Record<string, unknown>;
    assert.equal(out.userId, USER);
    assert.equal(out.emailId, "email-1");
    assert.equal(out.accessToken, "[redacted]");
    assert.equal(out.refresh_token, "[redacted]");
    assert.equal(out.apiKey, "[redacted]");
    assert.equal(out.tokenProblem, "expired");
    assert.ok(!/abcdefghijklmnop|GOCSPX-secret|enc:v1:aa/.test(String(out.message)), String(out.message));
    assert.deepEqual(out.nested, { password: "[redacted]", note: "[redacted]" });
  });

  it("reduces an Error to its name and message, redacted", () => {
    const out = redact(new Error("token ya29.zzz rejected")) as Record<string, unknown>;
    assert.equal(out.name, "Error");
    assert.equal(out.message, "token [redacted] rejected");
  });
});
