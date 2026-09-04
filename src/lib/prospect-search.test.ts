import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeOutcome,
  excludeFor,
  mergeBatch,
  recordSeen,
  type SeenByArea,
  rankProspects,
  searchProspects,
  takeWave,
  type BatchRequest,
  type BatchResult,
} from "./prospect-search.ts";
import { callBudget } from "./regions.ts";
import type { Prospect } from "./research-types.ts";

function prospect(partial: Partial<Prospect> & { businessName: string }): Prospect {
  return {
    trade: "Joiner",
    town: "Crieff",
    phone: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "No Website Found",
    notes: "",
    source: "",
    priority: "WARM",
    reason: "",
    ...partial,
  };
}

/**
 * A stand-in for the API that hands out a finite pool of businesses — the point
 * being that the pool runs out, exactly as a real area does.
 */
function poolRunner(pool: Prospect[], opts: { failAfter?: number; failEvery?: number } = {}) {
  const calls: BatchRequest[] = [];
  let served = 0;
  const runBatch = async (request: BatchRequest): Promise<BatchResult> => {
    calls.push(request);
    if (opts.failAfter !== undefined && calls.length > opts.failAfter) {
      return { ok: false, error: "rate limited" };
    }
    if (opts.failEvery && calls.length % opts.failEvery === 0) {
      return { ok: false, error: "transient" };
    }
    const batch = pool.slice(served, served + request.limit);
    served += batch.length;
    return { ok: true, prospects: batch };
  };
  return { runBatch, calls };
}

const bigPool = (n: number, town = "Crieff") =>
  Array.from({ length: n }, (_, i) =>
    prospect({
      businessName: `Joinery ${i + 1}`,
      town,
      phone: `0176400${String(i).padStart(4, "0")}`,
    }),
  );

describe("merging batches", () => {
  it("keeps genuinely different businesses", () => {
    const found = [prospect({ businessName: "A Joinery", phone: "01764 100001" })];
    const kept = mergeBatch(found, [prospect({ businessName: "B Joinery", phone: "01764 100002" })]);
    assert.equal(kept.length, 1);
  });

  it("drops the same firm found again in another town's sweep", () => {
    const found = [prospect({ businessName: "Monzie Joinery", town: "Crieff", phone: "01764 100001" })];
    const kept = mergeBatch(found, [
      prospect({ businessName: "Monzie Joinery Ltd", town: "Perth", phone: "01764 100001" }),
    ]);
    assert.equal(kept.length, 0, "same phone number is the same business");
  });

  it("drops a repeat inside a single batch", () => {
    const kept = mergeBatch(
      [],
      [
        prospect({ businessName: "Strath Joinery", town: "Crieff" }),
        prospect({ businessName: "Strath Joinery", town: "Crieff" }),
      ],
    );
    assert.equal(kept.length, 1);
  });

  it("ignores a nameless row", () => {
    assert.equal(mergeBatch([], [prospect({ businessName: "  " })]).length, 0);
  });
});

describe("ranking", () => {
  it("puts HOT first, then the strongest evidence", () => {
    const ranked = rankProspects([
      prospect({ businessName: "Cold", priority: "COLD", reviews: 500 }),
      prospect({ businessName: "Warm", priority: "WARM", reviews: 5 }),
      prospect({ businessName: "Hot few", priority: "HOT", reviews: 22, rating: 4.6 }),
      prospect({ businessName: "Hot many", priority: "HOT", reviews: 84, rating: 4.7 }),
    ]);
    assert.deepEqual(
      ranked.map((p) => p.businessName),
      ["Hot many", "Hot few", "Warm", "Cold"],
    );
  });
});

describe("the exclude list", () => {
  it("is kept per place, so a second pass over Perth skips Perth's firms", () => {
    const seen: SeenByArea = new Map();
    recordSeen(seen, "Perth", ["A Joinery", "B Joinery"]);
    recordSeen(seen, "Crieff", ["C Joinery"]);
    assert.deepEqual(excludeFor(seen, "Perth"), ["A Joinery", "B Joinery"]);
    assert.deepEqual(excludeFor(seen, "Crieff"), ["C Joinery"]);
    assert.deepEqual(excludeFor(seen, "Alyth"), []);
  });

  it("matches a place however it was capitalised", () => {
    const seen: SeenByArea = new Map();
    recordSeen(seen, "Coupar Angus", ["A Joinery"]);
    assert.deepEqual(excludeFor(seen, "coupar angus"), ["A Joinery"]);
  });

  it("does not repeat a name it already holds", () => {
    const seen: SeenByArea = new Map();
    recordSeen(seen, "Perth", ["A Joinery"]);
    recordSeen(seen, "Perth", ["A Joinery", "B Joinery"]);
    assert.deepEqual(excludeFor(seen, "Perth"), ["A Joinery", "B Joinery"]);
  });

  it("stays bounded so the prompt cannot grow without limit", () => {
    const seen: SeenByArea = new Map();
    recordSeen(seen, "Perth", bigPool(120).map((p) => p.businessName));
    assert.equal(excludeFor(seen, "Perth").length, 40);
  });
});

describe("sweeping for prospects", () => {
  const base = {
    locationType: "District / Region" as const,
    location: "Perthshire",
    businessType: "Joiner",
  };

  it("reaches the target and stops", async () => {
    const { runBatch, calls } = poolRunner(bigPool(400));
    const outcome = await searchProspects({ ...base, target: 25, runBatch });
    assert.equal(outcome.prospects.length, 25);
    assert.equal(outcome.stoppedBecause, "target");
    assert.ok(calls.length < callBudget(25), "should stop early, not spend the whole budget");
  });

  it("gets 100 across many towns for a region", async () => {
    const { runBatch, calls } = poolRunner(bigPool(400));
    const outcome = await searchProspects({ ...base, target: 100, runBatch });
    assert.equal(outcome.prospects.length, 100);
    assert.ok(outcome.areasSearched.length >= 5, "a region sweep must cover several towns");
    assert.ok(calls.length <= callBudget(100));
  });

  it("returns what really exists instead of padding to the number", async () => {
    const { runBatch } = poolRunner(bigPool(63));
    const outcome = await searchProspects({ ...base, target: 100, runBatch });
    assert.equal(outcome.prospects.length, 63, "63 real businesses means 63, never 100");
    assert.equal(outcome.stoppedBecause, "diminishing");
  });

  it("stops paying for calls once they stop finding anything", async () => {
    const { runBatch, calls } = poolRunner(bigPool(10));
    await searchProspects({ ...base, target: 100, runBatch });
    assert.ok(calls.length < callBudget(100), "an exhausted area must not burn the budget");
  });

  it("carries the right context into every call", async () => {
    const { runBatch, calls } = poolRunner(bigPool(400));
    await searchProspects({ ...base, target: 50, runBatch });
    for (const call of calls) {
      assert.equal(call.businessType, "Joiner");
      assert.equal(call.context, "Perthshire");
      assert.ok(call.limit > 0 && call.limit <= 12);
    }
  });

  it("tells a town on its second visit which of its firms it already gave", async () => {
    // A single town gets several passes; without a per-town exclude list the
    // model returns the same businesses each time and every call is wasted.
    const calls: BatchRequest[] = [];
    let served = 0;
    const pool = bigPool(60, "Crieff");
    await searchProspects({
      locationType: "Town",
      location: "Crieff",
      businessType: "Joiner",
      target: 50,
      runBatch: async (request) => {
        calls.push(request);
        const excluded = new Set(request.exclude);
        const available = pool.filter((p) => !excluded.has(p.businessName));
        const batch = available.slice(0, request.limit);
        served += batch.length;
        return { ok: true, prospects: batch };
      },
    });
    assert.ok(calls.length > 1, "one call cannot find 50 in one town");
    assert.ok(calls[1].exclude.length > 0, "the second visit must exclude the first visit's finds");
    assert.ok(served > calls[0].limit, "later calls must return businesses the first one did not");
  });

  it("keeps everything found when the API starts failing partway", async () => {
    const { runBatch } = poolRunner(bigPool(400), { failAfter: 3 });
    const outcome = await searchProspects({ ...base, target: 100, runBatch });
    assert.ok(outcome.prospects.length > 0, "a late failure must not throw away good results");
    assert.ok(outcome.failures.length > 0);
  });

  it("rides out an intermittent failure and carries on", async () => {
    const { runBatch } = poolRunner(bigPool(400), { failEvery: 3 });
    const outcome = await searchProspects({ ...base, target: 25, runBatch });
    assert.equal(outcome.prospects.length, 25);
  });

  it("gives up quickly when nothing works at all", async () => {
    let calls = 0;
    const outcome = await searchProspects({
      ...base,
      target: 100,
      runBatch: async () => {
        calls += 1;
        return { ok: false, error: "Research is not available in this environment." };
      },
    });
    assert.equal(outcome.stoppedBecause, "failed");
    assert.equal(outcome.prospects.length, 0);
    assert.ok(calls <= 3, "a dead API should cost three calls, not twenty");
    assert.match(describeOutcome(outcome, 100), /not available/);
  });

  it("survives a batch runner that throws", async () => {
    const outcome = await searchProspects({
      ...base,
      target: 25,
      runBatch: async () => {
        throw new Error("network exploded");
      },
    });
    assert.equal(outcome.stoppedBecause, "failed");
    assert.match(outcome.failures[0], /network exploded/);
  });

  it("stops on request and keeps what it has", async () => {
    let stop = false;
    const { runBatch } = poolRunner(bigPool(400));
    const outcome = await searchProspects({
      ...base,
      target: 100,
      runBatch: async (request) => {
        stop = true; // cancel after the first wave
        return runBatch(request);
      },
      isCancelled: () => stop,
    });
    assert.equal(outcome.stoppedBecause, "cancelled");
    assert.ok(outcome.prospects.length > 0);
    assert.match(describeOutcome(outcome, 100), /Stopped early/);
  });

  it("reports progress as it goes", async () => {
    const seen: number[] = [];
    const { runBatch } = poolRunner(bigPool(400));
    await searchProspects({
      ...base,
      target: 50,
      runBatch,
      onProgress: (p) => seen.push(p.found),
    });
    assert.ok(seen.length > 1);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "found only ever goes up");
  });

  it("does nothing at all for an empty location", async () => {
    let called = false;
    const outcome = await searchProspects({
      locationType: "Town",
      location: "",
      businessType: "Joiner",
      target: 25,
      runBatch: async () => {
        called = true;
        return { ok: true, prospects: [] };
      },
    });
    assert.equal(called, false);
    assert.equal(outcome.prospects.length, 0);
  });

  it("hands back the best prospects first", async () => {
    const pool = [
      prospect({ businessName: "Cold one", phone: "01764 000001", priority: "COLD" }),
      prospect({ businessName: "Hot one", phone: "01764 000002", priority: "HOT", reviews: 40 }),
      prospect({ businessName: "Warm one", phone: "01764 000003", priority: "WARM", reviews: 4 }),
    ];
    const { runBatch } = poolRunner(pool);
    const outcome = await searchProspects({ ...base, target: 25, runBatch });
    assert.equal(outcome.prospects[0].businessName, "Hot one");
  });

  it("explains a short result without pretending", () => {
    const message = describeOutcome(
      {
        prospects: bigPool(63),
        callsMade: 12,
        areasSearched: ["Perth", "Crieff"],
        failures: [],
        stoppedBecause: "diminishing",
      },
      100,
    );
    assert.match(message, /63 real businesses/);
    assert.match(message, /none were invented/);
  });
});

describe("wave building", () => {
  const q = (...areas: string[]) => areas.map((area) => ({ area }));

  it("fires several different places at once", () => {
    assert.equal(takeWave(q("Perth", "Crieff", "Alyth", "Scone"), 0, 10).length, 3);
  });

  it("never fires the same place twice in one wave", () => {
    // Two concurrent calls for one town go out with the same exclude list and
    // come back with the same businesses — one of them is money burnt.
    assert.deepEqual(takeWave(q("Crieff", "Crieff", "Crieff"), 0, 10), [{ area: "Crieff" }]);
  });

  it("treats a place as the same place whatever the capitalisation", () => {
    assert.equal(takeWave(q("Crieff", "crieff", "Perth"), 0, 10).length, 1);
  });

  it("never exceeds what is left of the budget", () => {
    assert.equal(takeWave(q("Perth", "Crieff", "Alyth"), 0, 2).length, 2);
  });
});
