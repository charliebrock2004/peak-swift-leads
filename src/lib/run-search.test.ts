import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeProspects, runPlannedSearch, sortProspects, type ResearchFn } from "./run-search.ts";
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

  function research(funnel?: Partial<{ queriesSent: number; rawTotal: number; unique: number;
    duplicatesMerged: number; droppedToLimit: number; withWebsite: number;
    withoutWebsite: number; withListedEmail: number }>) {
    return async (input: { location: string }) => ({
      ok: true as const,
      prospects: [prospect({ businessName: `${input.location} Joinery`, town: input.location })],
      location: input.location,
      businessType: "Joiner",
      funnel: {
        queriesSent: 0, towns: [], rawBySource: { nominatim: 0, photon: 0, bizdata: 0, companiesHouse: 0 },
        rawTotal: 0, unique: 0, duplicatesMerged: 0, droppedToLimit: 0,
        withWebsite: 0, withoutWebsite: 0, withListedEmail: 0, returned: 1, ...funnel,
      },
    });
  }

  it("sums the counters across every area searched", async () => {
    const result = await runPlannedSearch({
      ...plan,
      research: research({ queriesSent: 5, rawTotal: 12, unique: 9, duplicatesMerged: 3, withWebsite: 4 }),
    });
    assert.ok(result.funnel.areas >= 1);
    assert.equal(result.funnel.queriesSent, 5 * result.funnel.areas);
    assert.equal(result.funnel.rawTotal, 12 * result.funnel.areas);
    assert.equal(result.funnel.duplicatesMerged, 3 * result.funnel.areas);
  });

  it("reports businesses cut by the caller's own target", async () => {
    // The number that separates "this area is thin" from "we asked for too
    // few" — opposite diagnoses that would otherwise look identical.
    const result = await runPlannedSearch({ ...plan, research: research({ droppedToLimit: 7 }) });
    assert.equal(result.funnel.droppedToLimit, 7 * result.funnel.areas);
  });

  it("counts zeros rather than going missing when a source returns nothing", async () => {
    const result = await runPlannedSearch({ ...plan, research: research() });
    assert.equal(result.funnel.rawTotal, 0);
    assert.ok(result.funnel.areas >= 1, "an area that found nothing is still an area searched");
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
    assert.equal(result.funnel.areas, 0);
    assert.ok(result.prospects.length > 0, "the run still works without diagnostics");
  });
});
