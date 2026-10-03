import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeProspects, runPlannedSearch, sortProspects, type ResearchFn } from "./run-search.ts";
import { emptyRejectTally } from "./discovery-reasons.ts";
import { outcomeTotal, reconcileLedger } from "./discovery-ledger.ts";
import type { DiscoveryFunnel } from "./osm-discover.ts";
import type { Prospect } from "./research.ts";

function prospect(partial: Partial<Prospect> & { businessName: string; town: string }): Prospect {
  return {
    trade: "Joiner",
    phone: "",
    email: "",
    address: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "Unclear",
    notes: "",
    source: "test",
    priority: "WARM",
    reason: "test",
    lat: "",
    lng: "",
    placeId: "",
    foundAt: "",
    businessStatus: "",
    ...partial,
  };
}

describe("mergeProspects", () => {
  it("drops the same business found in two towns", () => {
    const first = [prospect({ businessName: "W B Dodds Ltd", town: "Crieff", phone: "01764 652264" })];
    const next = mergeProspects(first, [
      prospect({ businessName: "WB Dodds", town: "Perth", phone: "01764 652264" }),
      prospect({ businessName: "Monzie Joinery", town: "Crieff", phone: "01764 111111" }),
    ], 25);
    assert.equal(next.length, 2);
    assert.equal(next[1]?.businessName, "Monzie Joinery");
  });

  it("stops at the requested limit", () => {
    const incoming = [
      prospect({ businessName: "One Joinery", town: "Perth" }),
      prospect({ businessName: "Two Joinery", town: "Crieff" }),
      prospect({ businessName: "Three Joinery", town: "Comrie" }),
    ];
    const next = mergeProspects([], incoming, 2);
    assert.equal(next.length, 2);
  });
});

describe("sortProspects", () => {
  it("puts HOT ahead of WARM and COLD", () => {
    const sorted = sortProspects([
      prospect({ businessName: "Cold Co", town: "Perth", priority: "COLD", reviews: 90 }),
      prospect({ businessName: "Hot Co", town: "Crieff", priority: "HOT", reviews: 20 }),
      prospect({ businessName: "Warm Co", town: "Comrie", priority: "WARM", reviews: 10 }),
    ]);
    assert.deepEqual(
      sorted.map((item) => item.businessName),
      ["Hot Co", "Warm Co", "Cold Co"],
    );
  });
});

describe("runPlannedSearch", () => {
  it("searches Perthshire towns and stops at the unique limit", async () => {
    const calls: Array<{ location: string; limit: number; excludeNames: string[] }> = [];
    let serial = 0;
    const research: ResearchFn = async (input) => {
      calls.push(input);
      const batch: Prospect[] = [];
      for (let i = 0; i < 6; i += 1) {
        serial += 1;
        batch.push(
          prospect({
            businessName: `${input.location} Trade ${serial}`,
            town: input.location,
            phone: `01764 65${String(serial).padStart(4, "0")}`,
            priority: i === 0 ? "HOT" : i < 3 ? "WARM" : "COLD",
          }),
        );
      }
      return {
        ok: true,
        location: input.location,
        businessType: "Joiner",
        prospects: batch,
      };
    };

    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 25,
      research,
      concurrency: 1,
      rateLimitPauseMs: 0,
    });

    assert.equal(result.plan.kind, "region");
    assert.ok(result.plan.areas.length >= 4);
    assert.equal(result.prospects.length, 25);
    assert.equal(result.errors.length, 0);
    assert.ok(calls.length >= 4);
    assert.ok(calls.length < result.plan.areas.length || result.prospects.length === 25);
    assert.ok(calls.some((call) => call.location === "Crieff" || call.location === "Perth"));
    assert.ok(calls.every((call) => call.location !== "Perthshire"));
    const names = new Set(result.prospects.map((item) => item.businessName));
    assert.equal(names.size, 25);
  });

  it("keeps successful towns when one batch fails", async () => {
    let n = 0;
    const research: ResearchFn = async (input) => {
      if (input.location === "Crieff") {
        return { ok: false, error: "Lead search hit the xAI rate limit. Wait a minute and try again." };
      }
      n += 1;
      return {
        ok: true,
        location: input.location,
        businessType: "Joiner",
        prospects: [
          prospect({
            businessName: `${input.location} Joinery`,
            town: input.location,
            phone: `01764 65${String(n).padStart(4, "0")}`,
          }),
        ],
      };
    };

    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 25,
      research,
      concurrency: 1,
      rateLimitPauseMs: 0,
    });

    assert.ok(result.prospects.length >= 1);
    assert.ok(result.errors.some((error) => /Crieff/.test(error) && /rate limit/i.test(error)));
    assert.ok(!result.prospects.some((item) => item.town === "Crieff"));
  });

  it("does not invent filler when research returns fewer than the limit", async () => {
    const research: ResearchFn = async (input) => ({
      ok: true,
      location: input.location,
      businessType: "Joiner",
      prospects: [
        prospect({ businessName: `${input.location} Joinery`, town: input.location, phone: "01764 650022" }),
      ],
    });

    const result = await runPlannedSearch({
      location: "Crieff",
      businessType: "Joiner",
      limit: 8,
      research,
      concurrency: 1,
      rateLimitPauseMs: 0,
    });

    assert.equal(result.prospects.length, 1);
    assert.equal(result.prospects[0]?.businessName, "Crieff Joinery");
  });

  it("passes already-found names so later towns skip them", async () => {
    const seen: string[][] = [];
    const research: ResearchFn = async (input) => {
      seen.push(input.excludeNames);
      return {
        ok: true,
        location: input.location,
        businessType: "Joiner",
        prospects: [
          prospect({
            businessName: `${input.location} Unique Joinery`,
            town: input.location,
            phone: `0171 ${input.location.length}`.padEnd(12, "0"),
          }),
        ],
      };
    };

    await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 25,
      research,
      concurrency: 1,
      rateLimitPauseMs: 0,
    });

    assert.ok(seen.length >= 2);
    assert.equal(seen[0]?.length, 0);
    assert.ok(seen[1] && seen[1].length >= 1);
  });

  it("stops starting new towns when cancelled", async () => {
    let calls = 0;
    let cancel = false;
    const research: ResearchFn = async (input) => {
      calls += 1;
      if (calls === 1) cancel = true;
      return {
        ok: true,
        location: input.location,
        businessType: "Joiner",
        prospects: [prospect({ businessName: `${input.location} Joinery`, town: input.location })],
      };
    };

    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 100,
      research,
      concurrency: 1,
      rateLimitPauseMs: 0,
      shouldCancel: () => cancel,
    });

    assert.equal(result.cancelled, true);
    assert.ok(calls <= 2);
    assert.ok(result.prospects.length >= 1);
  });
});

describe("the discovery funnel a run reports", () => {
  const plan = { location: "Perth", businessType: "Joiner", limit: 20 };

  function research(funnel?: Partial<DiscoveryFunnel>) {
    return async (input: { location: string }) => ({
      ok: true as const,
      prospects: [prospect({ businessName: `${input.location} Joinery`, town: input.location })],
      location: input.location,
      businessType: "Joiner",
      funnel: {
        queriesSent: 0, towns: [], terms: [], listings: 1, rejected: emptyRejectTally(),
        rawBySource: { nominatim: 1, photon: 0, companiesHouse: 0, overpass: 0 },
        rawTotal: 1, unique: 1, duplicatesMerged: 0,
        withWebsite: 0, withoutWebsite: 1, withListedEmail: 0, returned: 1, ...funnel,
      },
    });
  }

  it("sums the counters across every area searched", async () => {
    const rejected = { ...emptyRejectTally(), chain: 2, outside_area: 3 };
    const result = await runPlannedSearch({
      ...plan,
      research: research({ queriesSent: 5, listings: 14, rejected, rawTotal: 9, unique: 1, duplicatesMerged: 8, withWebsite: 4 }),
    });
    assert.ok(result.funnel.areas >= 1);
    assert.equal(result.funnel.queriesSent, 5 * result.funnel.areas);
    assert.equal(result.funnel.listings, 14 * result.funnel.areas);
    assert.equal(result.funnel.duplicatesMerged, 8 * result.funnel.areas);
    assert.equal(result.ledger.outcomes.invalid, 5 * result.funnel.areas);
    assert.equal(result.ledger.invalidReasons.outside_area, 3 * result.funnel.areas);
    assert.deepEqual(reconcileLedger(result.ledger), []);
  });

  it("counts zeros rather than going missing when a source returns nothing", async () => {
    const result = await runPlannedSearch({
      ...plan,
      research: async (input: { location: string }) => ({ ok: true as const, prospects: [], location: input.location, businessType: "Joiner" }),
    });
    assert.equal(result.funnel.rawTotal, 0);
    assert.ok(result.funnel.areas >= 1, "an area that found nothing is still an area searched");
    assert.equal(result.ledger.searches.length, result.funnel.areas, "and it has a row in the ledger");
  });

  it("survives a research function that reports no funnel at all", async () => {
    const result = await runPlannedSearch({
      ...plan,
      research: async (input: { location: string }) => ({
        ok: true as const,
        prospects: [prospect({ businessName: `${input.location} Joinery`, town: input.location })],
        location: input.location,
        businessType: "Joiner",
      }),
    });
    assert.ok(result.prospects.length > 0, "the run still works without diagnostics");
    assert.deepEqual(reconcileLedger(result.ledger), []);
  });

  it("records a failed search as a row with its error and no listings", async () => {
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 8,
      rateLimitPauseMs: 0,
      research: async (input) => (input.location === "Perth" ? { ok: false as const, error: "Photon: HTTP 503" } : research()(input)),
    });
    const failed = result.ledger.searches.find((row) => row.area === "Perth");
    assert.equal(failed?.error, "Photon: HTTP 503");
    assert.equal(failed?.listings, 0);
    assert.deepEqual(reconcileLedger(result.ledger), []);
  });
});

describe("every listing has exactly one outcome", () => {
  /**
   * The failed real-world run, rebuilt: 138 listings across overlapping towns,
   * most of them businesses already on the sheet or contacted. Every one of the
   * 138 must land in exactly one outcome, per search and in total.
   */
  it("accounts for every listing of an overlapping, mostly-known search", async () => {
    const firms = Array.from({ length: 46 }, (_, i) =>
      prospect({ businessName: `Firm ${String.fromCharCode(65 + (i % 26))}${i} Joinery`, town: "Perth", phone: `01738 ${String(400000 + i)}`, placeId: `osm:node:${i}` }),
    );
    const known = firms.slice(0, 35).map((firm) => ({ ...firm, mapsLink: "" }));
    const contacted = firms.slice(35, 46).map((firm) => ({ ...firm, mapsLink: "" }));
    const towns = ["Perth", "Scone", "Crieff", "Auchterarder"];
    const research: ResearchFn = async (input) => {
      const index = towns.indexOf(input.location);
      // Each town sees an overlapping window of the same 46 firms.
      const slice = firms.slice(index * 7, index * 7 + 25);
      return {
        ok: true,
        location: input.location,
        businessType: "Joiner",
        prospects: slice,
        funnel: {
          queriesSent: 3, towns: [input.location], terms: ["joiner"], listings: slice.length + 9, rejected: { ...emptyRejectTally(), chain: 2 },
          rawBySource: { nominatim: slice.length, photon: 7, companiesHouse: 0, overpass: 0 },
          rawTotal: slice.length + 7, unique: slice.length, duplicatesMerged: 7, withWebsite: 0, withoutWebsite: slice.length, withListedEmail: 0, returned: slice.length,
        },
      };
    };
    const result = await runPlannedSearch({
      location: "Perth",
      businessType: "Joiner",
      limit: 20,
      rateLimitPauseMs: 0,
      plan: { kind: "city", label: "Perth", places: ["Perth"], restingAreas: [], areas: towns.map((name) => ({ name, quota: 60 })) },
      research,
      known,
      contacted,
    });
    const { ledger } = result;
    assert.deepEqual(reconcileLedger(ledger), []);
    assert.equal(ledger.listings, 4 * 25 + 4 * 9);
    assert.equal(ledger.outcomes.invalid, 8);
    assert.equal(ledger.outcomes.accepted, 0, "nothing new existed");
    assert.equal(ledger.outcomes.in_database + ledger.outcomes.contacted, 46, "each firm is counted once, at its first sighting");
    assert.equal(ledger.duplicates.acrossSources, 28);
    assert.equal(ledger.duplicates.acrossAreas, 100 - 46);
    for (const row of ledger.searches) assert.equal(outcomeTotal(row.outcomes), row.listings, row.area);
  });

  it("holds a possible match for review instead of calling it known or new", async () => {
    const result = await runPlannedSearch({
      location: "Crieff",
      businessType: "Joiner",
      limit: 8,
      rateLimitPauseMs: 0,
      research: async (input) => ({
        ok: true,
        location: input.location,
        businessType: "Joiner",
        prospects: [
          prospect({ businessName: "Strathearn Joinery Ltd", town: "Crieff" }),
          prospect({ businessName: "Monzie Woodwork", town: "Crieff" }),
        ],
      }),
      known: [{ businessName: "Strathearn Joinery", town: "Perth", phone: "", mapsLink: "" }],
    });
    assert.equal(result.ledger.outcomes.needs_review, 1);
    assert.equal(result.ledger.outcomes.accepted, 1);
    assert.equal(result.ledger.review[0]?.matchedName, "Strathearn Joinery");
    assert.equal(result.ledger.review[0]?.match, "database");
    assert.ok(result.prospects.every((item) => item.businessName !== "Strathearn Joinery Ltd"));
  });

  it("counts a business an earlier trade took as a duplicate, not as already known", async () => {
    const firm = prospect({ businessName: "Tay Building & Joinery", town: "Perth", phone: "01738 555111" });
    const result = await runPlannedSearch({
      location: "Perth",
      businessType: "Builder",
      limit: 8,
      rateLimitPauseMs: 0,
      plan: { kind: "town", label: "Perth", places: ["Perth"], restingAreas: [], areas: [{ name: "Perth", quota: 60 }] },
      research: async (input) => ({ ok: true, location: input.location, businessType: "Builder", prospects: [firm] }),
      inRun: [{ ...firm, mapsLink: "" }],
    });
    assert.equal(result.ledger.outcomes.in_database, 0);
    assert.equal(result.ledger.outcomes.duplicate_in_search, 1);
    assert.equal(result.ledger.duplicates.acrossTrades, 1);
  });

  it("passes each area its own radius, Companies House town and search-word rotation", async () => {
    const seen: { location: string; radiusMiles?: number; chTowns?: string[]; variant?: number }[] = [];
    await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 8,
      rateLimitPauseMs: 0,
      plan: { kind: "region", label: "Perthshire", places: ["Perthshire"], restingAreas: [], areas: [{ name: "Crieff", quota: 60, radiusMiles: 7, chTowns: ["Crieff"], variant: 2 }] },
      research: async (input) => {
        seen.push(input);
        return { ok: true, location: input.location, businessType: "Joiner", prospects: [] };
      },
    });
    assert.equal(seen[0]?.radiusMiles, 7);
    assert.deepEqual(seen[0]?.chTowns, ["Crieff"]);
    assert.equal(seen[0]?.variant, 2);
  });
});

/**
 * The Perth failure, at the level of the runner rather than the pool.
 *
 * A run asking for 60 delivered 31, of which 0 were new, because every town
 * was capped at 12 rows before anything looked across towns or at the sheet.
 * These tests hold the corrected order: collect every area, dedupe, drop what
 * is already known, then apply the target.
 */
describe("discovery collects before it caps", () => {
  function prospectIn(town: string, index: number, shared = false): Prospect {
    return prospect({
      businessName: shared ? `Perthshire Joinery ${index} Ltd` : `${town} Joinery ${index} Ltd`,
      town,
      phone: shared
        ? `01738 ${String(200000 + index).slice(-6)}`
        : `01738 ${String(300000 + town.length * 1000 + index).slice(-6)}`,
    });
  }

  /** Every town surfaces the same prominent firms first, then its own. */
  const research: ResearchFn = async (input) => ({
    ok: true,
    location: input.location,
    businessType: "Joiner",
    prospects: [
      ...Array.from({ length: 12 }, (_, i) => prospectIn(input.location, i, true)),
      ...Array.from({ length: 20 }, (_, i) => prospectIn(input.location, i)),
    ],
  });

  it("never asks an area for a slice of the target", async () => {
    const limits: number[] = [];
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 60,
      concurrency: 1,
      rateLimitPauseMs: 0,
      research: async (input) => {
        limits.push(input.limit);
        return research(input);
      },
    });
    assert.ok(limits.length > 1);
    // Identical for every area, and unrelated to the target or to what is left.
    assert.equal(new Set(limits).size, 1);
    assert.notEqual(limits[0], 12);
    assert.ok(result.prospects.length > 0);
  });

  it("keeps searching every planned area after the target is reachable", async () => {
    let areasSearched = 0;
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 10,
      concurrency: 1,
      rateLimitPauseMs: 0,
      research: async (input) => {
        areasSearched += 1;
        return research(input);
      },
    });
    // Stopping at the first area that satisfied the target would let a worse
    // prospect win a slot a later town could have filled better.
    assert.equal(areasSearched, result.plan.areas.length);
    assert.equal(result.prospects.length, 10);
  });

  it("delivers the full target from towns that mostly overlap", async () => {
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 60,
      concurrency: 1,
      rateLimitPauseMs: 0,
      research,
    });
    assert.equal(result.prospects.length, 60);
    assert.equal(result.pool.targetAchieved, 60);
    assert.ok(result.pool.duplicatesAcrossAreas > 0);
    const names = new Set(result.prospects.map((item) => item.businessName));
    assert.equal(names.size, 60);
  });

  it("does not let businesses already on the sheet consume the target", async () => {
    const known = Array.from({ length: 12 }, (_, i) => ({
      businessName: `Perthshire Joinery ${i} Ltd`,
      town: "Perth",
      phone: `01738 ${String(200000 + i).slice(-6)}`,
      mapsLink: "",
    }));
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 60,
      concurrency: 1,
      rateLimitPauseMs: 0,
      research,
      known,
    });

    assert.equal(result.prospects.length, 60);
    assert.equal(result.pool.alreadyKnown, 12);
    for (const item of result.prospects) {
      assert.ok(
        !known.some((lead) => lead.businessName === item.businessName),
        `${item.businessName} was already on the sheet`,
      );
    }
  });

  it("reports the safety ceiling rather than pretending the target was met", async () => {
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 200,
      concurrency: 1,
      rateLimitPauseMs: 0,
      research,
      ceiling: 40,
    });
    assert.equal(result.pool.ceilingHit, true);
    assert.ok(result.pool.droppedToSafetyCeiling > 0);
    assert.equal(result.prospects.length, 40);
  });

  it("excludes suppressed businesses from discovery entirely", async () => {
    const result = await runPlannedSearch({
      location: "Perthshire",
      businessType: "Joiner",
      limit: 60,
      concurrency: 1,
      rateLimitPauseMs: 0,
      research,
      suppressed: [
        { businessName: "Perthshire Joinery 0 Ltd", town: "Perth", phone: "01738 200000", mapsLink: "" },
      ],
    });
    assert.equal(result.pool.suppressed, 1);
    assert.ok(!result.prospects.some((item) => item.businessName === "Perthshire Joinery 0 Ltd"));
  });
});
