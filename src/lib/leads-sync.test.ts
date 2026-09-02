import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "./leads.ts";
import {
  describeSync,
  mergeServerLeads,
  pruneTombstones,
  settledDirtyIds,
} from "./leads-sync.ts";

function lead(partial: Partial<Lead>): Lead {
  return createLead(partial);
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("merging pulled rows", () => {
  it("adds rows this device has never seen", () => {
    const merged = mergeServerLeads([], [lead({ id: "a", businessName: "Comrie Cut" })], []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].businessName, "Comrie Cut");
  });

  it("takes the server's copy for a lead this device has not touched", () => {
    const local = [lead({ id: "a", businessName: "Old name", notes: "local" })];
    const merged = mergeServerLeads(local, [lead({ id: "a", businessName: "New name" })], []);
    assert.equal(merged[0].businessName, "New name");
  });

  it("keeps an unpushed local edit even when the server sends that row", () => {
    const local = [lead({ id: "a", businessName: "Edited here" })];
    const merged = mergeServerLeads(local, [lead({ id: "a", businessName: "Server copy" })], ["a"]);
    assert.equal(merged[0].businessName, "Edited here");
  });

  it("carries a tombstone through so the delete reaches this device", () => {
    const local = [lead({ id: "a", businessName: "Gone" })];
    const merged = mergeServerLeads(
      local,
      [lead({ id: "a", businessName: "Gone", deletedAt: new Date().toISOString() })],
      [],
    );
    assert.ok(merged[0].deletedAt);
  });
});

describe("tombstone pruning", () => {
  it("keeps live leads and recent tombstones, drops old ones", () => {
    const kept = pruneTombstones([
      lead({ id: "live" }),
      lead({ id: "recent", deletedAt: daysAgo(2) }),
      lead({ id: "ancient", deletedAt: daysAgo(400) }),
    ]);
    assert.deepEqual(
      kept.map((item) => item.id),
      ["live", "recent"],
    );
  });

  it("keeps a tombstone whose timestamp cannot be read rather than guessing", () => {
    const kept = pruneTombstones([lead({ id: "odd", deletedAt: "not-a-date" })]);
    assert.equal(kept.length, 1);
  });
});

describe("settling the dirty set after a push", () => {
  it("clears leads that did not change while the push was in flight", () => {
    const pushed = [lead({ id: "a", updatedAt: "2026-09-02T10:00:00.000Z" })];
    const current = [lead({ id: "a", updatedAt: "2026-09-02T10:00:00.000Z" })];
    assert.deepEqual(settledDirtyIds(pushed, current), ["a"]);
  });

  it("holds a lead that was edited again mid-push", () => {
    const pushed = [lead({ id: "a", updatedAt: "2026-09-02T10:00:00.000Z" })];
    const current = [lead({ id: "a", updatedAt: "2026-09-02T10:00:05.000Z" })];
    assert.deepEqual(settledDirtyIds(pushed, current), []);
  });
});

describe("status wording", () => {
  it("never claims a durable save when the server copy is not durable", () => {
    assert.equal(describeSync("synced", 0, false), "Preview storage");
    assert.equal(describeSync("synced", 0, true), "Saved to your account");
  });

  it("is honest about being offline or signed out", () => {
    assert.equal(describeSync("error", 3, true), "Offline — saved on this device");
    assert.equal(describeSync("local-only", 3, true), "This device only");
  });

  it("counts work still queued", () => {
    assert.equal(describeSync("idle", 4, true), "4 to save");
  });
});
