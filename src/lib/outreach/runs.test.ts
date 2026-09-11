import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runDate,
  runDuration,
  runHadTrouble,
  runOutcome,
  runTitle,
  runTotals,
  type RunRecord,
} from "./runs.ts";

function run(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    startedAt: "2026-03-04T10:00:00.000Z",
    finishedAt: "2026-03-04T10:02:00.000Z",
    location: "Perth",
    businessType: "Joiner",
    mode: "prepare",
    found: 20,
    qualified: 12,
    hot: 4,
    warm: 5,
    callCount: 6,
    skipped: 8,
    emailsFound: 7,
    prepared: 5,
    sent: 0,
    replies: 0,
    errors: 0,
    bottleneck: "",
    summary: "",
    ...partial,
  };
}

describe("runDate", () => {
  it("formats a real timestamp", () => {
    assert.equal(runDate("2026-03-04T10:00:00.000Z"), "4 Mar");
  });

  it("returns nothing rather than Invalid Date", () => {
    assert.equal(runDate(""), "");
    assert.equal(runDate("not a date"), "");
  });
});

describe("runDuration", () => {
  it("reports seconds for a short run and minutes for a long one", () => {
    assert.equal(runDuration("2026-03-04T10:00:00Z", "2026-03-04T10:00:42Z"), "42s");
    assert.equal(runDuration("2026-03-04T10:00:00Z", "2026-03-04T10:04:00Z"), "4m");
  });

  it("says nothing when either end is missing or impossible", () => {
    assert.equal(runDuration("", "2026-03-04T10:00:00Z"), "");
    assert.equal(runDuration("2026-03-04T10:00:00Z", ""), "");
    assert.equal(runDuration("2026-03-04T10:05:00Z", "2026-03-04T10:00:00Z"), "");
  });
});

describe("runTitle", () => {
  it("names the trade and the place", () => {
    assert.equal(runTitle({ businessType: "Joiner", location: "Perth" }), "Joiner in Perth");
  });

  it("keeps a multi-trade run exactly as it was run", () => {
    assert.equal(
      runTitle({ businessType: "Joiner, Plumber", location: "Greater Manchester" }),
      "Joiner, Plumber in Greater Manchester",
    );
  });

  it("degrades to whatever it has rather than showing half a sentence", () => {
    assert.equal(runTitle({ businessType: "Joiner", location: "" }), "Joiner");
    assert.equal(runTitle({ businessType: "", location: "Perth" }), "Perth");
    assert.equal(runTitle({ businessType: "", location: "" }), "Outreach run");
  });
});

describe("runOutcome", () => {
  it("reports what a send run sent", () => {
    assert.equal(runOutcome({ mode: "send", sent: 6, prepared: 6, found: 20 }), "6 sent");
    assert.equal(runOutcome({ mode: "send", sent: 0, prepared: 0, found: 20 }), "0 sent");
  });

  it("never reports 0 sent for a run that was never allowed to send", () => {
    assert.equal(runOutcome({ mode: "prepare", sent: 0, prepared: 5, found: 20 }), "5 prepared");
    assert.equal(runOutcome({ mode: "prepare", sent: 0, prepared: 0, found: 20 }), "20 found");
  });
});

describe("runHadTrouble", () => {
  it("is true only when a run really recorded errors", () => {
    assert.equal(runHadTrouble({ errors: 0 }), false);
    assert.equal(runHadTrouble({ errors: 3 }), true);
  });
});

describe("runTotals", () => {
  it("sums exactly the runs it was given", () => {
    const totals = runTotals([
      run({ found: 20, emailsFound: 7, prepared: 5, sent: 0, replies: 0 }),
      run({ id: "r2", found: 10, emailsFound: 3, prepared: 3, sent: 3, replies: 1 }),
    ]);
    assert.deepEqual(totals, {
      runs: 2,
      found: 30,
      emailsFound: 10,
      prepared: 8,
      sent: 3,
      replies: 1,
    });
  });

  it("totals an empty history to zeros, not to nothing", () => {
    assert.deepEqual(runTotals([]), {
      runs: 0,
      found: 0,
      emailsFound: 0,
      prepared: 0,
      sent: 0,
      replies: 0,
    });
  });
});
