/**
 * Phase K performance work, held to its promise: faster, and identical.
 * The send queue judges each email against all the others in one pass, and
 * the state fingerprint changes exactly when the data does.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import { decideApproval } from "./approval.ts";
import { autoContext, autoContextExcluding } from "./auto-run.ts";
import { DEFAULT_PROFILE } from "./profile.ts";
import { sendQueue } from "./send-queue.ts";
import * as store from "./store.server.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";

const company = { companyNumber: "SC1", companyType: "ltd", companyStatus: "active", companyCheckedAt: new Date().toISOString(), legalFormOverride: "" as const, legalFormNote: "", legalFormSetAt: "" };
const BODY = "Hi,\n\nI'm Charlie from PeakSwift Studio, writing about NAME. Your listing has no website.\n\nWould a short chat be useful?\n\nIf you'd rather I didn't contact you again, just let me know and I won't.";

function world(seed: number) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const leads: OutreachLead[] = Array.from({ length: 40 }, (_, i) => ({
    ...(createLead({ id: `l${i}`, businessName: `Firm ${i} Ltd`, trade: "Roofer", town: "Perth", email: `info@firm${i % 30}.co.uk`, emailConfidence: "HIGH", emailSource: "Contact page", websiteStatus: "No Website Found" }) as OutreachLead),
    facts: company,
  }));
  const statuses = ["draft", "approved", "queued", "sent", "replied", "failed", "skipped"] as const;
  const emails: OutreachEmail[] = Array.from({ length: 120 }, (_, i) => {
    const lead = leads[Math.floor(random() * leads.length)]!;
    return {
      id: `e${i}`, leadId: lead.id, businessName: lead.businessName, recipient: lead.email, subject: `${lead.businessName} website`, body: BODY.replace("NAME", lead.businessName),
      status: statuses[Math.floor(random() * statuses.length)]!, kind: random() < 0.85 ? "initial" : "follow-up-1", generatedBy: "ai", sendingAccount: "", gmailMessageId: "", gmailThreadId: "", error: "", attempts: 0,
      approvedAt: "", sentAt: "", repliedAt: "", createdAt: `2026-10-01T0${i % 10}:00:00.000Z`, updatedAt: "", personalisationEvidence: "", campaignId: "",
    };
  });
  return { leads, emails, suppression: [{ email: "info@firm3.co.uk" }], settings: { includeLow: false, dailyLimit: 30 }, profile: DEFAULT_PROFILE } as never;
}

/** The previous implementation: rebuild the context from every other email, per email. */
function slowVerdicts(state: { leads: OutreachLead[]; emails: OutreachEmail[]; suppression: { email: string }[]; settings: never; profile: typeof DEFAULT_PROFILE }) {
  const leads = new Map(state.leads.map((lead) => [lead.id, lead]));
  const suppressedList = state.suppression.map((entry) => entry.email);
  return state.emails
    .filter((email) => ["draft", "approved", "queued"].includes(email.status))
    .map((email) => {
      const outcome = decideApproval({
        decision: "queue",
        email: { ...email, status: "draft" },
        lead: leads.get(email.leadId) ?? null,
        context: autoContext(state.emails.filter((other) => other.id !== email.id), suppressedList, state.settings),
        suppressed: new Set(suppressedList),
        studio: state.profile.businessName,
      });
      return `${email.id}:${outcome.action}`;
    })
    .sort();
}

describe("the send queue in one pass", () => {
  it("gives every email the same verdict as judging it against all the others one by one", () => {
    for (const seed of [1, 7, 42, 2026]) {
      const state = world(seed);
      const queue = sendQueue(state);
      const fast = [...queue.ready.map((entry) => `${entry.email.id}:queue`), ...queue.attention.map((entry) => `${entry.email.id}:refuse`)].sort();
      const slow = slowVerdicts(state).map((entry) => entry.replace(/:(approve|queue|send)$/, ":queue"));
      assert.deepEqual(fast, slow, `seed ${seed}`);
      assert.ok(queue.attention.some((entry) => /already/i.test(entry.blocked)), "some emails really are blocked as duplicates");
    }
  });

  it("an approved email is not 'already contacted' by itself, but two for one business block each other", () => {
    const one = { kind: "initial", status: "approved", leadId: "a", recipient: "info@a.co.uk" } as OutreachEmail;
    const contextFor = autoContextExcluding([{ ...one, id: "1" }, { ...one, id: "2", leadId: "b", recipient: "info@b.co.uk" }, { ...one, id: "3", leadId: "b", recipient: "info@b.co.uk" }], [], { includeLow: false, contactRules: undefined });
    assert.equal(contextFor("1").alreadyContacted.has("a"), false);
    assert.equal(contextFor("1").contactedAddresses.has("info@a.co.uk"), false);
    assert.equal(contextFor("1").alreadyContacted.has("b"), true);
    assert.equal(contextFor("2").alreadyContacted.has("b"), true);
    assert.deepEqual([...contextFor("1").alreadyContacted], ["b"]);
    assert.equal(contextFor("1").alreadyContacted.size, 1);
  });
});

describe("the state fingerprint", () => {
  const USER = "owner-1";
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("stays the same until the data changes — including a removal and a new day", async () => {
    const now = new Date("2026-10-01T10:00:00.000Z");
    const { text, params } = buildLeadUpsert(USER, [createLead({ id: "l1", businessName: "Tayside Roofing", trade: "Roofer", town: "Perth" })]);
    await db.sql.query(text, params);
    const first = await store.stateVersion(db.sql, USER, now);
    assert.ok(first.length > 10);
    assert.equal(await store.stateVersion(db.sql, USER, now), first);
    await db.sql.query(`update leads set notes = 'x', updated_at = now() + interval '1 second' where user_id = $1`, [USER]);
    const edited = await store.stateVersion(db.sql, USER, now);
    assert.notEqual(edited, first);
    await db.sql.query(`insert into prospect_feedback (user_id, lead_id, verdict) values ($1, 'l1', 'good')`, [USER]);
    const marked = await store.stateVersion(db.sql, USER, now);
    assert.notEqual(marked, edited);
    await db.sql.query(`delete from prospect_feedback where user_id = $1`, [USER]);
    assert.notEqual(await store.stateVersion(db.sql, USER, now), marked);
    assert.notEqual(await store.stateVersion(db.sql, USER, new Date("2026-10-02T10:00:00.000Z")), await store.stateVersion(db.sql, USER, now));
    assert.notEqual(await store.stateVersion(db.sql, "someone-else", now), await store.stateVersion(db.sql, USER, now));
  });

  it("loads a batch of businesses in one query", async () => {
    const rows = ["a", "b", "c"].map((id) => createLead({ id, businessName: `Firm ${id}`, trade: "Roofer", town: "Perth" }));
    const { text, params } = buildLeadUpsert(USER, rows);
    await db.sql.query(text, params);
    const loaded = await store.loadLeadsByIds(db.sql, USER, ["a", "c", "a", "missing"]);
    assert.deepEqual(loaded.map((lead) => lead.id).sort(), ["a", "c"]);
    assert.deepEqual(await store.loadLeadsByIds(db.sql, "someone-else", ["a"]), []);
  });
});
