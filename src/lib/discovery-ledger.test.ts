import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyCoverage, coverageWrite, REST_DAYS, tradeKey } from "./discovery-coverage.ts";
import {
  distinctBusinesses,
  emptyLedger,
  emptySearchRow,
  mergeLedger,
  moveOutcome,
  parseLedger,
  reconcileLedger,
  type DiscoveryLedger,
} from "./discovery-ledger.ts";
import { discoveryFromLedger, emptyFunnel, reconcileFunnel } from "./outreach/run-funnel.ts";
import { diagnoseRun } from "./run-diagnosis.ts";

/**
 * The failed real-world run, as the new ledger records it.
 *
 * The old report said "138 listings, 100 unique, 54 duplicates, 35 already on
 * the sheet, 11 contacted, 0 new" and then READY. Rebuilt from the code, the
 * 138 were: 38 second records of a business another source had already
 * returned in the same town, 54 repeats of a business already counted in
 * another town or trade, 35 already on the sheet and 11 contacted — 46
 * distinct businesses, none new.
 */
function reportedRun(): DiscoveryLedger {
  const ledger = emptyLedger();
  const towns = [
    { area: "Perth", listings: 40, merged: 12, repeats: 4, known: 18, contacted: 6 },
    { area: "Scone", listings: 33, merged: 9, repeats: 16, known: 6, contacted: 2 },
    { area: "Crieff", listings: 35, merged: 10, repeats: 17, known: 6, contacted: 2 },
    { area: "Auchterarder", listings: 30, merged: 7, repeats: 17, known: 5, contacted: 1 },
  ];
  for (const town of towns) {
    const row = emptySearchRow(town.area, "Joiner", 3);
    row.listings = town.listings;
    row.outcomes.duplicate_in_search = town.merged + town.repeats;
    row.outcomes.in_database = town.known;
    row.outcomes.contacted = town.contacted;
    ledger.searches.push(row);
    ledger.listings += town.listings;
    ledger.outcomes.duplicate_in_search += town.merged + town.repeats;
    ledger.outcomes.in_database += town.known;
    ledger.outcomes.contacted += town.contacted;
    ledger.duplicates.acrossSources += town.merged;
    ledger.duplicates.acrossAreas += town.repeats;
  }
  return ledger;
}

describe("the ledger", () => {
  it("reconciles the reported run: 138 = 38 + 54 + 35 + 11 + 0", () => {
    const ledger = reportedRun();
    assert.equal(ledger.listings, 138);
    assert.equal(ledger.duplicates.acrossSources, 38);
    assert.equal(ledger.duplicates.acrossAreas, 54);
    assert.equal(ledger.outcomes.in_database, 35);
    assert.equal(ledger.outcomes.contacted, 11);
    assert.equal(distinctBusinesses(ledger), 46);
    assert.deepEqual(reconcileLedger(ledger), []);
  });

  it("catches a listing with no outcome, in the total and in its search's row", () => {
    const ledger = reportedRun();
    ledger.listings += 1;
    ledger.searches[0]!.listings += 1;
    const problems = reconcileLedger(ledger);
    assert.match(problems.join("\n"), /listings 139 ≠ sum of outcomes 138/);
    assert.match(problems.join("\n"), /Joiner in Perth: 41 listings ≠ 40 outcomes/);
  });

  it("catches duplicates whose kinds do not add up, and invalid rows without a reason", () => {
    const ledger = reportedRun();
    ledger.duplicates.acrossTrades += 2;
    ledger.outcomes.invalid += 1;
    ledger.outcomes.duplicate_in_search -= 1;
    const problems = reconcileLedger(ledger).join("\n");
    assert.match(problems, /duplicates/);
    assert.match(problems, /invalid 1 ≠ sum of reasons 0/);
  });

  it("merges trades and moves outcomes without losing a listing", () => {
    const a = reportedRun();
    const b = emptyLedger();
    const row = emptySearchRow("Comrie", "Roofer");
    row.listings = 5;
    row.outcomes.accepted = 3;
    row.outcomes.invalid = 2;
    b.searches.push(row);
    b.listings = 5;
    b.outcomes.accepted = 3;
    b.outcomes.invalid = 2;
    b.invalidReasons.chain = 2;
    const merged = mergeLedger(a, b);
    assert.equal(merged.listings, 143);
    assert.deepEqual(reconcileLedger(merged), []);
    // At save time one accepted business turns out to be on the sheet after all.
    moveOutcome(merged, "accepted", "in_database", 1);
    assert.equal(merged.outcomes.accepted, 2);
    assert.equal(merged.outcomes.in_database, 36);
    assert.deepEqual(reconcileLedger(merged), []);
  });

  it("projects onto the run funnel, which then reconciles too", () => {
    const funnel = emptyFunnel();
    discoveryFromLedger(funnel, reportedRun());
    assert.equal(funnel.rawFound, 138);
    assert.equal(funnel.unique, 46);
    assert.equal(funnel.selected, 0);
    assert.deepEqual(reconcileFunnel(funnel), []);
  });

  it("round-trips through storage and ignores what is not a ledger", () => {
    const ledger = reportedRun();
    assert.deepEqual(parseLedger(JSON.parse(JSON.stringify(ledger))), ledger);
    assert.equal(parseLedger(null), null);
    assert.equal(parseLedger({ rawFound: 3 }), null);
  });
});

describe("why a run produced nothing", () => {
  const funnel = { checked: 0, eligible: 0, call: 0, manualReview: 0, goodWebsite: 0, lowOpportunity: 0, noWayToContact: 0 };

  it("the reported run lost everything at de-duplication, and says the towns are worked out", () => {
    const diagnosis = diagnoseRun(reportedRun(), funnel, { location: "Perthshire", trades: ["Joiner"] })!;
    assert.equal(diagnosis.stage, "deduplication");
    assert.match(diagnosis.headline, /46 businesses found is already yours/);
    assert.equal(diagnosis.exhausted.length, 4);
    assert.match(diagnosis.details.join(" "), /138 listings → 46 distinct businesses → none new/);
    assert.match(diagnosis.details.join(" "), /35 already in your database, 11 already contacted/);
  });

  it("points at review when nothing is certain but some might be new", () => {
    const ledger = reportedRun();
    ledger.outcomes.in_database -= 3;
    ledger.outcomes.needs_review += 3;
    ledger.searches[0]!.outcomes.in_database -= 3;
    ledger.searches[0]!.outcomes.needs_review += 3;
    const diagnosis = diagnoseRun(ledger, funnel, { location: "Perthshire", trades: ["Joiner"] })!;
    assert.equal(diagnosis.stage, "deduplication");
    assert.match(diagnosis.headline, /3 need your decision/);
    assert.equal(diagnosis.exhausted.length, 3, "a town with something to check is not worked out");
  });

  it("separates sources that failed from an area that is empty", () => {
    const failed = emptyLedger();
    failed.searches.push({ ...emptySearchRow("Perth", "Joiner"), error: "Photon: HTTP 503" });
    assert.match(diagnoseRun(failed, funnel, { location: "Perth", trades: ["Joiner"] })!.headline, /every search failed/);
    const empty = emptyLedger();
    empty.searches.push(emptySearchRow("Perth", "Joiner"));
    assert.match(diagnoseRun(empty, funnel, { location: "Perth", trades: ["Joiner"] })!.headline, /returned no joiner around Perth/);
  });

  it("blames discovery when every listing was refused", () => {
    const ledger = emptyLedger();
    const row = emptySearchRow("Perth", "Joiner");
    row.listings = 7;
    row.outcomes.invalid = 7;
    ledger.searches.push(row);
    ledger.listings = 7;
    ledger.outcomes.invalid = 7;
    ledger.invalidReasons.chain = 5;
    ledger.invalidReasons.outside_area = 2;
    const diagnosis = diagnoseRun(ledger, funnel, { location: "Perth", trades: ["Joiner"] })!;
    assert.equal(diagnosis.stage, "discovery");
    assert.match(diagnosis.details.join(" "), /5 national chain or merchant, 2 outside the area searched/);
  });

  it("blames contactability, or scoring, when new businesses cannot be worked", () => {
    const ledger = emptyLedger();
    ledger.listings = 4;
    ledger.outcomes.accepted = 4;
    const unreachable = diagnoseRun(ledger, { ...funnel, checked: 4, noWayToContact: 4 }, { location: "Perth", trades: ["Joiner"] })!;
    assert.equal(unreachable.stage, "contactability");
    const notNeeded = diagnoseRun(ledger, { ...funnel, checked: 4, goodWebsite: 3, lowOpportunity: 1 }, { location: "Perth", trades: ["Joiner"] })!;
    assert.equal(notNeeded.stage, "scoring");
  });

  it("stays out of the way when there is someone to contact", () => {
    const ledger = emptyLedger();
    ledger.listings = 4;
    ledger.outcomes.accepted = 4;
    assert.equal(diagnoseRun(ledger, { ...funnel, checked: 4, eligible: 1, call: 2 }, { location: "Perth", trades: ["Joiner"] }), null);
  });
});

describe("coverage memory", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const days = (iso: string) => Math.round((Date.parse(iso) - now.getTime()) / 86_400_000);

  it("rests a town whose search returned only businesses you have", () => {
    const row = { ...emptySearchRow("Crieff", "Joiner"), listings: 12 };
    row.outcomes.in_database = 12;
    assert.equal(days(coverageWrite(row, now)!.exhaustedUntil), REST_DAYS.nothingNew);
  });

  it("rests an empty town longer, and leaves a productive one open", () => {
    assert.equal(days(coverageWrite(emptySearchRow("Muthill", "Joiner"), now)!.exhaustedUntil), REST_DAYS.empty);
    const productive = { ...emptySearchRow("Comrie", "Joiner"), listings: 6 };
    productive.outcomes.accepted = 2;
    productive.outcomes.in_database = 4;
    assert.equal(coverageWrite(productive, now)!.exhaustedUntil, "");
  });

  it("never records a failed search: the source was down, the town was not searched", () => {
    assert.equal(coverageWrite({ ...emptySearchRow("Perth", "Joiner"), error: "HTTP 503" }, now), null);
  });

  it("counts searches so the next one rotates its words", () => {
    const write = coverageWrite({ ...emptySearchRow("Perth", "Joiner"), listings: 3, outcomes: { ...emptySearchRow("", "").outcomes, accepted: 3 } }, now)!;
    const once = applyCoverage(undefined, write, now);
    const twice = applyCoverage(once, write, now);
    assert.equal(twice.searches, 2);
    assert.equal(tradeKey(" Joiner "), "joiner");
  });
});
