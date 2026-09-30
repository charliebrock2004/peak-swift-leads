/**
 * Upgrading a database that already has real data in it.
 *
 * Every other integration test starts from an empty schema with all migrations
 * applied. Production does not: it has months of rows written by older code,
 * some of them in shapes the new constraints would refuse. This builds the
 * schema as it was before 0009, fills it with representative rows — including
 * ones that are already "dirty" — applies 0009, and checks that nothing was
 * lost or changed, that the new invariants hold for new writes, and that the
 * app's own loaders still read the old rows.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sqlFrom } from "./test-support/pglite.ts";
import * as store from "./outreach/store.server.ts";
import { isSealed } from "./crypto/secrets.server.ts";
import type { Sql } from "./db.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => a.localeCompare(b));
const NEW = "0009_production.sql";
const USER = "legacy-user";

let pg: PGlite;
let sql: Sql;

async function apply(names: string[]) {
  for (const name of names) await pg.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
}

async function count(table: string): Promise<number> {
  const rows = await pg.query<{ n: number }>(`select count(*)::int as n from ${table} where user_id = $1`, [USER]);
  return rows.rows[0]!.n;
}

/** Everything the old code could have written, and a few things it should not have. */
async function seedLegacy() {
  const q = (text: string, params: unknown[] = []) => pg.query(text, params);
  for (const [id, name, status] of [
    ["l1", "Tay Valley Joinery", "Sent"],
    ["l2", "Strathearn Builders", ""],
    ["l3", "Old Deleted Co", ""],
  ] as const) {
    await q(
      `insert into leads (user_id, id, business_name, trade, town, email, email_confidence, outreach_status, unsubscribed, last_emailed_at, deleted_at)
       values ($1, $2, $3, 'Joiner', 'Perth', $4, 'HIGH', $5, $6, $7, $8)`,
      [USER, id, name, `info@${id}.co.uk`, status, id === "l1" ? "" : "", id === "l1" ? "2026-09-01T10:00:00Z" : "", id === "l3" ? "2026-09-02T10:00:00Z" : null],
    );
  }
  // Tokens stored in plain text, as every row was before encryption existed.
  await q(
    `insert into gmail_accounts (user_id, email, access_token, refresh_token, status) values ($1, 'me@example.co.uk', 'plain-access', 'plain-refresh', 'connected')`,
    [USER],
  );
  // A daily limit the new constraint would refuse (the old UI allowed it).
  await q(`insert into outreach_settings (user_id, daily_limit, batch_size) values ($1, 80, 5)`, [USER]);
  const email = (id: string, status: string, extra: Record<string, unknown> = {}) => {
    const cols = ["user_id", "id", "lead_id", "business_name", "recipient", "subject", "body", "status", ...Object.keys(extra)];
    const values = [USER, id, "l1", "Tay Valley Joinery", `${id}@tayvalley.co.uk`, "Subject", "Body", status, ...Object.values(extra)];
    return q(`insert into outreach_emails (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, values);
  };
  await email("e-draft", "draft");
  await email("e-approved", "approved");
  await email("e-queued", "queued");
  await email("e-sending", "sending");
  await email("e-sent", "sent", { gmail_message_id: "m1", gmail_thread_id: "t1", sent_at: "2026-09-01T10:00:00Z" });
  await email("e-replied", "replied", { gmail_message_id: "m2", gmail_thread_id: "t2", sent_at: "2026-09-01T10:00:00Z", replied_at: "2026-09-02T10:00:00Z" });
  await email("e-failed", "failed", { error: "Gmail said no" });
  await email("e-skipped", "skipped");
  await email("e-unsub", "unsubscribed");
  // Dirty: marked sent with no Gmail id (the old code trusted a 200 with no body).
  await email("e-sent-no-proof", "sent", { sent_at: "2026-09-01T10:00:00Z" });
  // Dirty: an address stored with capitals before lowercasing was enforced.
  await q(`insert into outreach_suppression (user_id, email, reason) values ($1, 'Info@Shouty.co.uk', 'asked')`, [USER]);
  await q(`insert into outreach_suppression (user_id, email, reason) values ($1, 'quiet@example.co.uk', 'asked')`, [USER]);
  await q(`insert into outreach_runs (user_id, id, location, business_type, found) values ($1, 'run-old', 'Perth', 'Joiner', 12)`, [USER]);
  await q(`insert into campaigns (user_id, id, name, status) values ($1, 'c1', 'Perth Joiners', 'ACTIVE')`, [USER]);
  await q(`insert into campaign_prospects (user_id, campaign_id, lead_id) values ($1, 'c1', 'l1')`, [USER]);
}

const TABLES = ["leads", "gmail_accounts", "outreach_settings", "outreach_emails", "outreach_suppression", "outreach_runs", "campaigns", "campaign_prospects"];

describe("upgrading a live database to 0009", () => {
  const counts: Record<string, number> = {};
  let snapshot: Record<string, unknown>[] = [];

  before(async () => {
    pg = new PGlite({ parsers: { 20: Number, 1082: (v: string) => v, 1186: (v: string) => v } });
    await pg.waitReady;
    assert.ok(files.includes(NEW), "0009 must exist");
    await apply(files.filter((name) => name < NEW));
    await seedLegacy();
    for (const table of TABLES) counts[table] = await count(table);
    snapshot = (await pg.query<Record<string, unknown>>(`select id, status, recipient, gmail_message_id, sent_at, error from outreach_emails where user_id = $1 order by id`, [USER])).rows;
    // 0009, then everything after it: the loaders below are today's code.
    await apply(files.filter((name) => name >= NEW));
    sql = sqlFrom(pg);
  });

  after(async () => {
    await pg.close();
  });

  it("applies over dirty legacy rows without failing", async () => {
    for (const table of TABLES) assert.equal(await count(table), counts[table], `${table} lost or gained rows`);
  });

  it("leaves every existing email exactly as it was", async () => {
    const now = (await pg.query<Record<string, unknown>>(`select id, status, recipient, gmail_message_id, sent_at, error from outreach_emails where user_id = $1 order by id`, [USER])).rows;
    assert.deepEqual(now, snapshot);
  });

  it("gives new columns safe defaults on old rows", async () => {
    const run = (await pg.query<{ status: string; funnel: string; lead_ids: string }>(`select status, funnel, lead_ids from outreach_runs where id = 'run-old'`)).rows[0]!;
    assert.equal(run.status, "done", "a run written before 0009 was a finished run");
    assert.equal(run.funnel, "");
    const settings = (await pg.query<{ search_daily_budget: number; ai_daily_budget: number; test_recipient: string }>(`select search_daily_budget, ai_daily_budget, test_recipient from outreach_settings where user_id = $1`, [USER])).rows[0]!;
    assert.deepEqual(settings, { search_daily_budget: 300, ai_daily_budget: 150, test_recipient: "" });
    const reply = (await pg.query<{ reply_stage: string; failure_kind: string }>(`select reply_stage, failure_kind from outreach_emails where id = 'e-replied'`)).rows[0]!;
    assert.deepEqual(reply, { reply_stage: "", failure_kind: "" });
  });

  it("is idempotent — a second deploy re-running it changes nothing", async () => {
    await apply([NEW]);
    for (const table of TABLES) assert.equal(await count(table), counts[table]);
  });

  it("reads the old rows through the app's own loaders", async () => {
    const emails = await store.loadEmails(sql, USER);
    assert.equal(emails.length, counts.outreach_emails);
    const replied = emails.find((email) => email.id === "e-replied")!;
    assert.equal(replied.status, "replied");
    const settings = await store.loadSettings(sql, USER);
    assert.equal(settings.dailyLimit, 30, "a legacy limit above today's ceiling is clamped when read, so it cannot be sent past");
    const suppression = await store.loadSuppression(sql, USER);
    assert.equal(suppression.length, 2);
  });

  it("opens plain-text legacy tokens and seals them in place", async () => {
    const account = await store.loadGmailAccount(sql, USER);
    assert.ok(account);
    assert.equal(account.tokenProblem, undefined);
    assert.equal(account.access_token, "plain-access");
    assert.equal(account.refresh_token, "plain-refresh");
    const stored = (await pg.query<{ access_token: string; refresh_token: string }>(`select access_token, refresh_token from gmail_accounts where user_id = $1`, [USER])).rows[0]!;
    assert.ok(isSealed(stored.access_token) && isSealed(stored.refresh_token), "tokens must not stay in plain text");
    const again = await store.loadGmailAccount(sql, USER);
    assert.equal(again?.access_token, "plain-access", "sealed tokens open to the same value");
  });

  it("enforces the new invariants on every new write", async () => {
    await assert.rejects(
      pg.query(`insert into outreach_emails (user_id, id, lead_id, status, sent_at) values ($1, 'new-no-proof', 'l2', 'sent', now())`, [USER]),
      /outreach_emails_sent_has_proof/,
    );
    await assert.rejects(
      pg.query(`insert into outreach_emails (user_id, id, lead_id, status) values ($1, 'new-odd', 'l2', 'delivered')`, [USER]),
      /outreach_emails_status_known/,
    );
    await assert.rejects(
      pg.query(`insert into outreach_suppression (user_id, email) values ($1, 'New@Upper.co.uk')`, [USER]),
      /outreach_suppression_lowercase/,
    );
  });

  it("still lets the code move clean legacy rows on", async () => {
    // A legacy queued email can be claimed and marked sent with proof.
    const claim = await store.claimWithinLimits(sql, USER, "e-queued", {
      rfc822MessageId: "<x@example.co.uk>",
      dayStartIso: new Date(Date.now() - 3_600_000).toISOString(),
      dailyLimit: 30,
      campaignLimit: null,
    });
    assert.equal(claim.claimed, true);
    assert.equal(await store.markSent(sql, USER, "e-queued", { messageId: "m9", threadId: "t9", account: "me@example.co.uk", rfc822MessageId: "<x@example.co.uk>", providerResponse: "{}" }), true);
    // A legacy sent email can take a reply.
    await store.markReplied(sql, USER, "e-sent", { from: "Them <e-sent@tayvalley.co.uk>", subject: "Re: Subject", snippet: "Yes please", kind: "human", suggestion: "interested" });
    const replied = (await store.loadEmails(sql, USER)).find((email) => email.id === "e-sent")!;
    assert.equal(replied.status, "replied");
    assert.equal(replied.replyStage, "new");
  });

  it("does not let a dirty legacy row block work on the clean ones", async () => {
    // The unproven "sent" row is never picked up for reply checks (no thread),
    // and a batch that touches only clean rows is unaffected by its presence.
    const waiting = await store.awaitingReply(sql, USER);
    assert.ok(!waiting.some((email) => email.id === "e-sent-no-proof"));
    await store.markRepliesChecked(sql, USER, waiting.map((email) => email.id));
  });
});
