import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectPlace, locationKindFor, planSearch, RESEARCH_BATCH_MAX } from "./scotland-places.ts";

describe("detectPlace", () => {
  it("treats Perthshire aliases as a region of real towns", () => {
    const place = detectPlace("Perth and Kinross");
    assert.equal(place.kind, "region");
    assert.equal(place.label, "Perthshire");
    assert.ok(place.towns.includes("Crieff"));
    assert.ok(place.towns.includes("Pitlochry"));
    assert.ok(place.towns.includes("Kinross"));
  });

  it("treats Dundee as a city with surrounding towns", () => {
    const place = detectPlace("Dundee");
    assert.equal(place.kind, "city");
    assert.ok(place.towns.includes("Dundee"));
    assert.ok(place.towns.includes("Broughty Ferry"));
  });

  it("treats Scotland as nationwide", () => {
    const place = detectPlace("Scotland");
    assert.equal(place.kind, "nation");
    assert.ok(place.towns.includes("Glasgow"));
    assert.ok(place.towns.includes("Crieff"));
  });

  it("keeps a typed town, and knows its region neighbours", () => {
    const place = detectPlace("Crieff");
    assert.equal(place.kind, "town");
    assert.equal(place.label, "Crieff");
    assert.equal(place.towns[0], "Crieff");
    assert.ok(place.towns.includes("Comrie"));
  });
});

describe("planSearch", () => {
  it("keeps a small town job as a single request", () => {
    const plan = planSearch("Crieff", 8);
    assert.equal(plan.kind, "town");
    assert.deepEqual(
      plan.areas.map((area) => area.name),
      ["Crieff"],
    );
    assert.equal(plan.areas[0]?.quota, 8);
  });

  it("keeps a small city job as a single request", () => {
    const plan = planSearch("Dundee", 12);
    assert.deepEqual(
      plan.areas.map((area) => area.name),
      ["Dundee"],
    );
  });

  it("fans Perthshire into constituent towns, never one 'Perthshire' string", () => {
    const plan = planSearch("Perthshire", 25);
    assert.equal(plan.kind, "region");
    assert.ok(plan.areas.length >= 8);
    const names = plan.areas.map((area) => area.name);
    assert.ok(names.includes("Perth"));
    assert.ok(names.includes("Crieff"));
    assert.ok(!names.includes("Perthshire"));
    for (const area of plan.areas) {
      assert.ok(area.quota >= 6 && area.quota <= RESEARCH_BATCH_MAX);
    }
  });

  it("covers enough Perthshire towns to have a chance at 100", () => {
    const plan = planSearch("Perthshire", 100);
    assert.ok(plan.areas.length >= 10);
    const names = plan.areas.map((area) => area.name);
    assert.ok(names.includes("Pitlochry"));
    assert.ok(names.includes("Auchterarder"));
    assert.ok(names.includes("Blairgowrie"));
  });

  it("fans a large city search into surrounding towns", () => {
    const plan = planSearch("Dundee", 100);
    const names = plan.areas.map((area) => area.name);
    assert.ok(names.includes("Dundee"));
    assert.ok(names.length >= 2);
  });

  it("fans Scotland-wide searches across multiple towns", () => {
    const plan = planSearch("Scotland", 50);
    assert.equal(plan.kind, "nation");
    assert.ok(plan.areas.length >= 5);
    const names = plan.areas.map((area) => area.name);
    assert.ok(names.includes("Glasgow") || names.includes("Edinburgh"));
  });

  it("plans Fife the same way as Perthshire", () => {
    const plan = planSearch("Fife", 25);
    assert.equal(plan.kind, "region");
    const names = plan.areas.map((area) => area.name);
    assert.ok(names.includes("Dunfermline") || names.includes("Kirkcaldy"));
    assert.ok(!names.includes("Fife"));
  });

  it("never asks a single batch for more than the Grok-safe cap", () => {
    const plan = planSearch("Perthshire", 100);
    for (const area of plan.areas) {
      assert.ok(area.quota <= RESEARCH_BATCH_MAX);
    }
  });
});

describe("locationKindFor", () => {
  it("classifies common inputs", () => {
    assert.equal(locationKindFor("Crieff"), "town");
    assert.equal(locationKindFor("Perth"), "city");
    assert.equal(locationKindFor("Perthshire"), "region");
    assert.equal(locationKindFor("Scotland"), "nation");
  });
});
