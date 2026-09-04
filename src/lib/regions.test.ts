import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CITIES,
  REGIONS,
  SCOTLAND_AREAS,
  batchSize,
  buildBatchQueue,
  callBudget,
  planSearch,
} from "./regions.ts";

describe("planning where to search", () => {
  it("searches just the one place for a town", () => {
    const plan = planSearch("Town", "Crieff");
    assert.deepEqual(plan.areas, ["Crieff"]);
    assert.equal(plan.wide, false);
    assert.equal(plan.context, "");
  });

  it("spreads a region across its real towns", () => {
    const plan = planSearch("District / Region", "Perthshire");
    assert.ok(plan.wide);
    assert.equal(plan.context, "Perthshire");
    assert.ok(plan.areas.length >= 15, "Perthshire needs enough towns to reach 100");
    for (const town of ["Perth", "Crieff", "Blairgowrie", "Pitlochry", "Auchterarder"]) {
      assert.ok(plan.areas.includes(town), `${town} should be swept`);
    }
  });

  it("matches a region however it is spelled", () => {
    for (const spelling of ["perthshire", "PERTHSHIRE", "Perth-shire", "Perth & Kinross"]) {
      const plan = planSearch("District / Region", spelling);
      assert.ok(plan.areas.includes("Crieff"), `"${spelling}" should resolve to Perthshire`);
      assert.equal(plan.unknownArea, false);
    }
  });

  it("still searches a region it has never heard of, rather than failing", () => {
    const plan = planSearch("District / Region", "Barsetshire");
    assert.deepEqual(plan.areas, ["Barsetshire"]);
    assert.equal(plan.unknownArea, true);
    assert.equal(plan.context, "Barsetshire");
  });

  it("covers a city through its own districts, not one repeated query", () => {
    const plan = planSearch("City", "Dundee");
    assert.ok(plan.areas.length > 3);
    assert.equal(plan.areas[0], "Dundee");
    assert.ok(plan.areas.includes("Broughty Ferry"));
  });

  it("sweeps the biggest places first for Scotland", () => {
    const plan = planSearch("Scotland", "Scotland");
    assert.equal(plan.areas[0], "Glasgow");
    assert.ok(plan.areas.includes("Perth"));
    assert.ok(plan.areas.length >= 20);
  });

  it("returns nothing to search for an empty location", () => {
    assert.deepEqual(planSearch("Town", "   ").areas, []);
  });
});

describe("geography data", () => {
  it("has no duplicate towns inside one region", () => {
    for (const [region, towns] of Object.entries(REGIONS)) {
      assert.equal(new Set(towns).size, towns.length, `${region} lists a town twice`);
    }
    for (const [city, areas] of Object.entries(CITIES)) {
      assert.equal(new Set(areas).size, areas.length, `${city} lists an area twice`);
    }
    assert.equal(new Set(SCOTLAND_AREAS).size, SCOTLAND_AREAS.length);
  });

  it("names a city's own area first", () => {
    for (const [city, areas] of Object.entries(CITIES)) {
      assert.equal(areas[0], city, `${city} should search itself first`);
    }
  });
});

describe("the call budget", () => {
  it("grows with the target but stays capped", () => {
    assert.equal(callBudget(25), 8);
    assert.equal(callBudget(50), 12);
    assert.equal(callBudget(100), 20);
    assert.ok(callBudget(1000) <= 24, "no target may run away with the API bill");
  });

  it("asks for a useful number per call without overshooting the target", () => {
    assert.equal(batchSize(100), 12);
    assert.equal(batchSize(7), 7);
    assert.equal(batchSize(1), 4, "a floor, so the last call is still worth making");
  });
});

describe("the batch queue", () => {
  it("sweeps round-robin so stopping early still covers the region", () => {
    const plan = planSearch("District / Region", "Perthshire");
    const queue = buildBatchQueue(plan, 100);
    const firstPass = queue.slice(0, 5).map((batch) => batch.area);
    assert.equal(new Set(firstPass).size, 5, "the first calls must hit five different towns");
  });

  it("never exceeds the call budget", () => {
    for (const target of [25, 50, 100]) {
      const plan = planSearch("District / Region", "Perthshire");
      assert.ok(buildBatchQueue(plan, target).length <= callBudget(target));
    }
  });

  it("revisits a single town over several rounds", () => {
    const queue = buildBatchQueue(planSearch("Town", "Crieff"), 25);
    assert.ok(queue.length > 1, "one call cannot find 25 joiners in Crieff");
    assert.ok(queue.every((batch) => batch.area === "Crieff"));
    assert.deepEqual(
      queue.map((batch) => batch.round),
      queue.map((_, index) => index),
    );
  });

  it("has nothing to do with no areas", () => {
    assert.deepEqual(buildBatchQueue(planSearch("Town", ""), 25), []);
  });
});
