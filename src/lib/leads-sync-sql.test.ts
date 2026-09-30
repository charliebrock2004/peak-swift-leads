/**
 * The sync upsert, run as real SQL against the real schema.
 *
 * The rules under test protect facts the server learned that a device only
 * holds a copy of: that a lead was emailed, and that somebody asked to be left
 * alone. A stale device push must never erase either.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createLead, type Lead } from "./leads.ts";
import { buildLeadUpsert, leadFromRow, normaliseUnsubscribed, type LeadRow } from "./leads-row.ts";
import { createTestDb, type TestDb } from "./test-support/pglite.ts";

const USER = "owner-1";
let db: TestDb;

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

async function push(leads: Lead[], userId = USER): Promise<void> {
  const { text, params } = buildLeadUpsert(userId, leads);
  await db.sql.query(text, params);
}

async function read(id: string, userId = USER): Promise<Lead> {
  const rows = await db.sql.query<LeadRow>(`select * from leads where user_id = $1 and id = $2`, [userId, id]);
  assert.equal(rows.length, 1);
  return leadFromRow(rows[0]!);
}

describe("normaliseUnsubscribed", () => {
  it("keeps both markers the app writes", () => {
    assert.equal(normaliseUnsubscribed("yes"), "yes");
    assert.equal(normaliseUnsubscribed("2026-09-30T10:00:00.000Z"), "2026-09-30T10:00:00.000Z");
  });
  it("drops anything that is not a flag", () => {
    assert.equal(normaliseUnsubscribed(""), "");
    assert.equal(normaliseUnsubscribed("maybe"), "");
    assert.equal(normaliseUnsubscribed(null), "");
  });
});

describe("pushing leads never regresses server-owned outreach facts", () => {
  it("a stale device cannot un-unsubscribe a lead (regression)", async () => {
    const lead = createLead({ id: "u1", businessName: "Tay Roofing", email: "hi@tayroofing.co.uk" });
    await push([lead]);
    // Outreach records the opt-out server-side, as a timestamp.
    await db.sql.query(
      `update leads set unsubscribed = $3, outreach_status = 'Unsubscribed' where user_id = $1 and id = $2`,
      [USER, "u1", "2026-09-30T10:00:00.000Z"],
    );
    // A device that never pulled edits a note and pushes its old copy.
    await push([{ ...lead, notes: "rang, no answer", unsubscribed: "", outreachStatus: "" }]);
    const stored = await read("u1");
    assert.equal(stored.unsubscribed, "2026-09-30T10:00:00.000Z");
    assert.equal(stored.outreachStatus, "Unsubscribed");
    assert.equal(stored.notes, "rang, no answer", "the device's own edit still lands");
  });

  it("a stale device cannot erase that a lead was emailed", async () => {
    const lead = createLead({ id: "s1", businessName: "Crieff Joinery" });
    await push([lead]);
    await db.sql.query(
      `update leads set outreach_status = 'Sent', last_emailed_at = '2026-09-29T09:00:00.000Z'
        where user_id = $1 and id = $2`,
      [USER, "s1"],
    );
    await push([{ ...lead, callResult: "No Answer", outreachStatus: "", lastEmailedAt: "" }]);
    const stored = await read("s1");
    assert.equal(stored.outreachStatus, "Sent");
    assert.equal(stored.lastEmailedAt, "2026-09-29T09:00:00.000Z");
    assert.equal(stored.callResult, "No Answer");
  });

  it("last_emailed_at only ever moves forward", async () => {
    const lead = createLead({ id: "t1", businessName: "Perth Plumbing", lastEmailedAt: "2026-09-20T09:00:00.000Z" });
    await push([lead]);
    await push([{ ...lead, lastEmailedAt: "2026-09-01T09:00:00.000Z" }]);
    assert.equal((await read("t1")).lastEmailedAt, "2026-09-20T09:00:00.000Z");
    await push([{ ...lead, lastEmailedAt: "2026-09-25T09:00:00.000Z" }]);
    assert.equal((await read("t1")).lastEmailedAt, "2026-09-25T09:00:00.000Z");
  });

  it("a brand-new lead takes whatever the device sent", async () => {
    await push([createLead({ id: "n1", businessName: "New Co", unsubscribed: "yes", outreachStatus: "Sent" })]);
    const stored = await read("n1");
    assert.equal(stored.unsubscribed, "yes");
    assert.equal(stored.outreachStatus, "Sent");
  });

  it("stays scoped to the account that pushed", async () => {
    await push([createLead({ id: "shared-id", businessName: "Mine" })], "owner-1");
    await push([createLead({ id: "shared-id", businessName: "Theirs" })], "stranger");
    assert.equal((await read("shared-id", "owner-1")).businessName, "Mine");
    assert.equal((await read("shared-id", "stranger")).businessName, "Theirs");
  });
});
