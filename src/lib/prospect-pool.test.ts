import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DISCOVERY_SAFETY } from "./discovery-limits.ts";
import {
  buildProspectPool,
  createProspectPool,
  rankProspects,
  scoreProspect,
  stopReason,
} from "./prospect-pool.ts";
import type { Prospect } from "./research.ts";

function prospect(partial: Partial<Prospect> & { businessName: string }): Prospect {
  return {
    trade: "Joiner",
    town: "Perth",
    address: "",
    phone: "",
    email: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "No Website Found",
    notes: "",
    source: "test",
    priority: "WARM",
    reason: "",
    lat: "",
    lng: "",
    placeId: "",
    foundAt: "2026-01-01",
    businessStatus: "",
    ...partial,
  };
}

/** A business distinct from every other: its own phone, name and place id. */
function distinct(index: number, town = "Perth"): Prospect {
  return prospect({
    businessName: `Joinery Number ${index} Limited`,
    town,
    phone: `01738 ${String(100000 + index).slice(-6)}`,
    placeId: `place-${index}`,
  });
}

describe("the target actually means something", () => {
  it("returns up to the target from a large candidate pool", () => {
    // The Perth run found 596 unique businesses and delivered 31.
    const candidates = Array.from({ length: 596 }, (_, i) => distinct(i));
    const { prospects, diagnostics } = buildProspectPool(candidates, { target: 60 });

    assert.equal(prospects.length, 60);
    assert.equal(diagnostics.targetRequested, 60);
    assert.equal(diagnostics.targetAchieved, 60);
    assert.equal(diagnostics.newCandidates, 596);
    assert.equal(diagnostics.remainingAfterTarget, 536);
  });

  it("does not silently become 12", () => {
    const candidates = Array.from({ length: 300 }, (_, i) => distinct(i));
    const { prospects } = buildProspectPool(candidates, { target: 60 });
    assert.notEqual(prospects.length, 12);
    assert.equal(prospects.length, 60);
  });

  it("returns 60 when 100 genuinely new candidates exist", () => {
    const candidates = Array.from({ length: 100 }, (_, i) => distinct(i));
    assert.equal(buildProspectPool(candidates, { target: 60 }).prospects.length, 60);
  });

  it("returns 37 when only 37 genuinely new candidates exist", () => {
    const candidates = Array.from({ length: 37 }, (_, i) => distinct(i));
    const { prospects, diagnostics } = buildProspectPool(candidates, { target: 60 });
    assert.equal(prospects.length, 37);
    assert.equal(diagnostics.targetAchieved, 37);
    assert.equal(diagnostics.remainingAfterTarget, 0);
  });

  it("invents nothing to reach the target", () => {
    const { prospects } = buildProspectPool([distinct(1)], { target: 60 });
    assert.equal(prospects.length, 1);
    assert.equal(prospects[0]?.businessName, "Joinery Number 1 Limited");
  });
});

describe("cross-area deduplication happens before the cap", () => {
  it("counts a business listed in ten towns as one slot", () => {
    const towns = [
      "Perth", "Scone", "Bridge of Earn", "Methven", "Errol",
      "Stanley", "Abernethy", "Dunning", "Kinross", "Auchterarder",
    ];
    // One firm, found by ten different town searches. Same phone each time,
    // which is how the real sources report it.
    const listings = towns.map((town) =>
      prospect({ businessName: "Strathearn Joinery Ltd", town, phone: "01764 652211" }),
    );
    const { prospects, diagnostics } = buildProspectPool(listings, { target: 60 });

    assert.equal(prospects.length, 1);
    assert.equal(diagnostics.collected, 10);
    assert.equal(diagnostics.duplicatesAcrossAreas, 9);
    assert.equal(diagnostics.newCandidates, 1);
  });

  it("does not merge two different businesses that share a town", () => {
    // Precision over recall: different names, different phones, same town.
    const { prospects } = buildProspectPool(
      [
        prospect({ businessName: "Tay Joinery", town: "Perth", phone: "01738 111111" }),
        prospect({ businessName: "Almond Joinery", town: "Perth", phone: "01738 222222" }),
      ],
      { target: 60 },
    );
    assert.equal(prospects.length, 2);
  });

  it("does not merge two businesses that only share a social page", () => {
    // A Facebook URL is not an identity. Two joiners with only a Facebook
    // presence must stay two businesses.
    const { prospects } = buildProspectPool(
      [
        prospect({
          businessName: "Bridgend Joiners",
          town: "Perth",
          website: "https://facebook.com/bridgend",
          phone: "01738 333333",
        }),
        prospect({
          businessName: "Craigie Woodwork",
          town: "Scone",
          website: "https://facebook.com/craigie",
          phone: "01738 444444",
        }),
      ],
      { target: 60 },
    );
    assert.equal(prospects.length, 2);
  });

  it("merges on a shared independent website even when names differ", () => {
    const { prospects, diagnostics } = buildProspectPool(
      [
        prospect({ businessName: "Tay Joinery", town: "Perth", website: "https://tayjoinery.co.uk" }),
        prospect({ businessName: "Tay Joinery & Sons", town: "Scone", website: "https://tayjoinery.co.uk/contact" }),
      ],
      { target: 60 },
    );
    assert.equal(prospects.length, 1);
    assert.equal(diagnostics.duplicatesAcrossAreas, 1);
  });
});

describe("existing leads never consume the target", () => {
  it("keeps returning new prospects when 500 candidates are already known", () => {
    const candidates = Array.from({ length: 596 }, (_, i) => distinct(i));
    const known = candidates.slice(0, 500);
    const { prospects, diagnostics } = buildProspectPool(candidates, { target: 60, known });

    // 96 genuinely new remain; the target takes 60 of those, not 60 of the 596.
    assert.equal(diagnostics.alreadyKnown, 500);
    assert.equal(diagnostics.newCandidates, 96);
    assert.equal(prospects.length, 60);
    for (const item of prospects) {
      assert.ok(!known.some((lead) => lead.placeId === item.placeId));
    }
  });

  it("returns 0 only when every candidate really is already known", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => distinct(i));
    const { prospects, diagnostics } = buildProspectPool(candidates, {
      target: 60,
      known: candidates,
    });
    assert.equal(prospects.length, 0);
    assert.equal(diagnostics.alreadyKnown, 40);
    assert.equal(diagnostics.newCandidates, 0);
  });

  it("an existing business listed in several towns consumes zero new slots", () => {
    const known = [prospect({ businessName: "Strathearn Joinery Ltd", town: "Crieff", phone: "01764 652211" })];
    const listings = ["Perth", "Scone", "Methven", "Errol"].map((town) =>
      prospect({ businessName: "Strathearn Joinery Ltd", town, phone: "01764 652211" }),
    );
    const fresh = Array.from({ length: 5 }, (_, i) => distinct(i));
    const { prospects, diagnostics } = buildProspectPool([...listings, ...fresh], {
      target: 60,
      known,
    });

    // One business, four listings: counted once as known, three as duplicates.
    assert.equal(diagnostics.alreadyKnown, 1);
    assert.equal(diagnostics.duplicatesAcrossAreas, 3);
    assert.equal(prospects.length, 5);
    assert.ok(!prospects.some((item) => item.businessName === "Strathearn Joinery Ltd"));
  });

  it("excludes suppressed businesses and says so", () => {
    const suppressed = [
      prospect({ businessName: "Unsub Joinery", town: "Perth", email: "stop@unsub.co.uk" }),
    ];
    const { prospects, diagnostics } = buildProspectPool(
      [
        prospect({ businessName: "Unsub Joinery", town: "Perth", email: "stop@unsub.co.uk" }),
        distinct(1),
      ],
      { target: 60, suppressed },
    );
    assert.equal(diagnostics.suppressed, 1);
    assert.equal(prospects.length, 1);
    assert.ok(!prospects.some((item) => item.businessName === "Unsub Joinery"));
  });

  it("excludes already-contacted businesses and says so", () => {
    const contacted = [prospect({ businessName: "Written To Ltd", town: "Perth", phone: "01738 909090" })];
    const { prospects, diagnostics } = buildProspectPool(
      [
        prospect({ businessName: "Written To Ltd", town: "Perth", phone: "01738 909090" }),
        distinct(2),
      ],
      { target: 60, contacted },
    );
    assert.equal(diagnostics.alreadyContacted, 1);
    assert.equal(prospects.length, 1);
  });

  it("reports a suppressed business as suppressed, not merely known", () => {
    const one = prospect({ businessName: "Unsub Joinery", town: "Perth", phone: "01738 121212" });
    const { diagnostics } = buildProspectPool([one], {
      target: 60,
      known: [one],
      suppressed: [one],
    });
    assert.equal(diagnostics.suppressed, 1);
    assert.equal(diagnostics.alreadyKnown, 0);
  });
});

describe("the safety ceiling is explicit, never silent", () => {
  it("stops collecting at the ceiling and reports it", () => {
    const candidates = Array.from({ length: 400 }, (_, i) => distinct(i));
    const { prospects, diagnostics } = buildProspectPool(candidates, { target: 60, ceiling: 120 });

    assert.equal(diagnostics.newCandidates, 120);
    assert.equal(diagnostics.ceilingHit, true);
    assert.equal(diagnostics.droppedToSafetyCeiling, 280);
    assert.equal(prospects.length, 60);
  });

  it("never advises raising a target the ceiling has overtaken", () => {
    const candidates = Array.from({ length: 400 }, (_, i) => distinct(i));
    const { diagnostics } = buildProspectPool(candidates, { target: 60, ceiling: 120 });
    const reason = stopReason(diagnostics) ?? "";
    assert.match(reason, /safety ceiling/i);
    assert.doesNotMatch(reason, /raise it to keep them/i);
  });

  it("does advise raising the target when the target is what stopped it", () => {
    const candidates = Array.from({ length: 200 }, (_, i) => distinct(i));
    const { diagnostics } = buildProspectPool(candidates, { target: 60 });
    const reason = stopReason(diagnostics) ?? "";
    assert.match(reason, /raise it to keep them/i);
    assert.doesNotMatch(reason, /safety ceiling/i);
  });

  it("explains a short run as a thin area rather than a cap", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => distinct(i));
    const { diagnostics } = buildProspectPool(candidates, { target: 60, known: candidates.slice(0, 4) });
    const reason = stopReason(diagnostics) ?? "";
    assert.match(reason, /out of new businesses/i);
    assert.doesNotMatch(reason, /raise it/i);
  });

  it("says nothing when the target was met exactly", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => distinct(i));
    assert.equal(stopReason(buildProspectPool(candidates, { target: 60 }).diagnostics), null);
  });

  it("clamps an absurd target to the engine ceiling", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => distinct(i));
    const { diagnostics } = buildProspectPool(candidates, { target: 99999 });
    assert.equal(diagnostics.targetRequested, DISCOVERY_SAFETY.targetMax);
  });
});

describe("ranking prefers contactable businesses without excluding anyone", () => {
  const withEmail = prospect({
    businessName: "Tay Joinery",
    town: "Perth",
    website: "https://tayjoinery.co.uk",
    websiteStatus: "Proper Website",
    email: "hello@tayjoinery.co.uk",
    phone: "01738 555111",
    address: "1 Mill Street",
  });
  const withSite = prospect({
    businessName: "Almond Woodwork",
    town: "Perth",
    website: "https://almondwoodwork.co.uk",
    websiteStatus: "Basic Website",
    phone: "01738 555222",
  });
  const socialOnly = prospect({
    businessName: "Craigie Joiners",
    town: "Perth",
    website: "https://facebook.com/craigie",
    phone: "01738 555333",
  });
  const noWebsite = prospect({ businessName: "Bridgend Carpentry", town: "Perth", phone: "01738 555444" });

  it("ranks a public email above a site above no site", () => {
    const ranked = rankProspects([noWebsite, socialOnly, withSite, withEmail], {
      tradeTerms: ["joiner"],
      townTerms: ["Perth"],
    });
    assert.deepEqual(
      ranked.map((item) => item.businessName),
      ["Tay Joinery", "Almond Woodwork", "Craigie Joiners", "Bridgend Carpentry"],
    );
  });

  it("keeps businesses with no website — they are the call list", () => {
    const { prospects } = buildProspectPool([noWebsite, socialOnly, withSite, withEmail], { target: 60 });
    assert.equal(prospects.length, 4);
    assert.ok(prospects.some((item) => item.businessName === "Bridgend Carpentry"));
  });

  it("rewards a site whose domain matches the business name", () => {
    const matching = prospect({
      businessName: "Strathearn Joinery",
      website: "https://strathearnjoinery.co.uk",
      websiteStatus: "Proper Website",
    });
    const borrowed = prospect({
      businessName: "Strathearn Joinery",
      website: "https://someother-host.co.uk",
      websiteStatus: "Proper Website",
    });
    assert.ok(scoreProspect(matching) > scoreProspect(borrowed));
  });

  it("never invents an email while ranking", () => {
    const { prospects } = buildProspectPool([noWebsite, withSite], { target: 60 });
    for (const item of prospects) {
      if (item.businessName !== "Tay Joinery") assert.equal(item.email, "");
    }
  });

  it("counts websites and emails in the delivered set, not the raw set", () => {
    const { diagnostics } = buildProspectPool([noWebsite, socialOnly, withSite, withEmail], { target: 2 });
    assert.equal(diagnostics.targetAchieved, 2);
    assert.equal(diagnostics.withWebsite, 2);
    assert.equal(diagnostics.withoutWebsite, 0);
    assert.equal(diagnostics.withListedEmail, 1);
  });
});

/**
 * The live Perth / Joiner run, rebuilt as a fixture.
 *
 * 691 raw rows · 596 unique within areas · 168 kept by the old per-area cap of
 * 12 across 14 towns · 31 after cross-area dedupe · 0 new to the sheet. The
 * shape that produced those numbers is the important part: fourteen towns
 * around one city return largely the same prominent firms first, so capping
 * each town at twelve kept the same twelve over and over and binned the
 * distinct tail before anything noticed it was new.
 */
describe("the Perth regression", () => {
  const TOWNS = [
    "Perth", "Scone", "Bridge of Earn", "Methven", "Errol", "Stanley", "Abernethy",
    "Dunning", "Kinross", "Coupar Angus", "Auchterarder", "Crieff", "Blairgowrie", "Dunkeld",
  ];
  /** Firms every town search surfaces first — the ones the old cap kept. */
  const PROMINENT = 31;

  /** What one town's search returns, prominent firms first, then its own. */
  function areaResults(town: string, index: number): Prospect[] {
    const shared = Array.from({ length: PROMINENT }, (_, i) =>
      prospect({
        businessName: `Perthshire Joinery ${i} Limited`,
        town,
        phone: `01738 ${String(200000 + i).slice(-6)}`,
        placeId: `shared-${i}`,
      }),
    );
    const local = Array.from({ length: 40 }, (_, i) =>
      prospect({
        businessName: `${town} Joinery ${i} Limited`,
        town,
        phone: `01738 ${String(300000 + index * 100 + i).slice(-6)}`,
        placeId: `local-${index}-${i}`,
      }),
    );
    return [...shared, ...local];
  }

  const areas = TOWNS.map((town, index) => areaResults(town, index));

  it("reproduces the old 168-kept / 31-delivered collapse when each area is capped first", () => {
    // The OLD order: cap every area at 12, then dedupe across areas.
    const keptPerArea = areas.map((rows) => rows.slice(0, 12));
    const kept = keptPerArea.flat();
    assert.equal(kept.length, 168);

    const { prospects } = buildProspectPool(kept, { target: 60 });
    // Every town's first twelve are the same twelve prominent firms.
    assert.equal(prospects.length, 12);
    assert.ok(prospects.length < 31);
  });

  it("delivers the full target from the same data once the cap comes last", () => {
    // The NEW order: pool everything, dedupe, then apply the target.
    const { prospects, diagnostics } = buildProspectPool(areas.flat(), { target: 60 });

    assert.equal(prospects.length, 60);
    assert.equal(diagnostics.newCandidates, PROMINENT + TOWNS.length * 40);
    assert.ok(diagnostics.newCandidates > 500);
    assert.ok(diagnostics.duplicatesAcrossAreas > 300);
    assert.equal(diagnostics.targetAchieved, 60);
  });

  it("still delivers 60 new when the previous run's 31 are already on the sheet", () => {
    // The exact failure: "0 new to your sheet · 31 already there".
    const known = Array.from({ length: 31 }, (_, i) =>
      prospect({
        businessName: `Perthshire Joinery ${i} Limited`,
        town: "Perth",
        phone: `01738 ${String(200000 + i).slice(-6)}`,
        placeId: `shared-${i}`,
      }),
    );
    const { prospects, diagnostics } = buildProspectPool(areas.flat(), { target: 60, known });

    assert.equal(prospects.length, 60);
    assert.equal(diagnostics.targetAchieved, 60);
    assert.ok(diagnostics.alreadyKnown >= 31);
    for (const item of prospects) {
      assert.ok(!item.placeId.startsWith("shared-"), `${item.businessName} was already on the sheet`);
    }
  });

  it("never lets a per-area cap bind again: the pool is fed uncapped", () => {
    const pool = createProspectPool({ target: 60 });
    for (const rows of areas) pool.offer(rows);
    assert.ok(pool.size > 500);
    assert.equal(pool.full, false);
  });
});

describe("rediscovered leads are kept for field-filling, not for slots", () => {
  it("hands back a known business's fresh copy without spending a slot", () => {
    const known = [prospect({ businessName: "Tay Joinery", town: "Perth", phone: "01738 555111" })];
    // Same business, rediscovered with an address it did not have before.
    const rediscovered = prospect({
      businessName: "Tay Joinery",
      town: "Perth",
      phone: "01738 555111",
      email: "hello@tayjoinery.co.uk",
    });
    const { prospects, knownMatches, diagnostics } = buildProspectPool(
      [rediscovered, distinct(1)],
      { target: 60, known },
    );

    assert.equal(prospects.length, 1);
    assert.equal(prospects[0]?.businessName, "Joinery Number 1 Limited");
    assert.equal(knownMatches.length, 1);
    assert.equal(knownMatches[0]?.email, "hello@tayjoinery.co.uk");
    assert.equal(diagnostics.alreadyKnown, 1);
  });

  it("never hands back a suppressed business for field-filling", () => {
    const one = prospect({ businessName: "Unsub Joinery", town: "Perth", phone: "01738 121212" });
    const { knownMatches } = buildProspectPool([one], { target: 60, known: [one], suppressed: [one] });
    assert.equal(knownMatches.length, 0);
  });

  it("returns one copy of a known business listed in many towns", () => {
    const known = [prospect({ businessName: "Strathearn Joinery Ltd", town: "Crieff", phone: "01764 652211" })];
    const listings = ["Perth", "Scone", "Methven"].map((town) =>
      prospect({ businessName: "Strathearn Joinery Ltd", town, phone: "01764 652211" }),
    );
    const { knownMatches } = buildProspectPool(listings, { target: 60, known });
    assert.equal(knownMatches.length, 1);
  });
});
