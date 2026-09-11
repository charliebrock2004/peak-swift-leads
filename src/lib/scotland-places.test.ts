import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectPlace,
  locationKindFor,
  planSearch,
  RESEARCH_BATCH_MAX,
  chSearchTowns,
  ENGLAND_REGION_SUGGESTIONS,
  ENGLAND_CITY_SUGGESTIONS,
  NATIONS,
  ENGLAND_TOWN_SUGGESTIONS,
  nationFor,
} from "./scotland-places.ts";

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

describe("chSearchTowns", () => {
  it("adds Perth next to Crieff so nearby trades are queried", () => {
    const towns = chSearchTowns("Crieff", 3);
    assert.equal(towns[0], "Crieff");
    assert.ok(towns.includes("Perth"));
  });

  it("uses real towns for a region, not the region name", () => {
    const towns = chSearchTowns("Perthshire", 3);
    assert.ok(towns.includes("Perth"));
    assert.ok(towns.includes("Crieff"));
    assert.ok(!towns.includes("Perthshire"));
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

describe("England expansion", () => {
  it("still detects Scotland exactly as before", () => {
    const place = detectPlace("Scotland");
    assert.equal(place.kind, "nation");
    assert.equal(place.label, "Scotland");
    assert.ok(place.towns.includes("Glasgow"));
    assert.ok(!place.towns.includes("Manchester"));
  });

  it("treats England as its own nation of English towns", () => {
    const place = detectPlace("England");
    assert.equal(place.kind, "nation");
    assert.equal(place.label, "England");
    assert.ok(place.towns.includes("Manchester"));
    assert.ok(place.towns.includes("Birmingham"));
    assert.ok(!place.towns.includes("Crieff"));
  });

  it("detects an English region and returns its towns", () => {
    const place = detectPlace("Greater Manchester");
    assert.equal(place.kind, "region");
    assert.equal(place.label, "Greater Manchester");
    assert.ok(place.towns.includes("Bolton"));
    assert.ok(place.towns.includes("Stockport"));
  });

  it("detects an English city and keeps it a city, not a bare town", () => {
    const place = detectPlace("Leeds");
    assert.equal(place.kind, "city");
    assert.ok(place.towns.includes("Leeds"));
    assert.ok(place.towns.includes("Bradford"));
  });

  it("fans a typed English town out to its region neighbours", () => {
    const place = detectPlace("Huddersfield");
    assert.equal(place.kind, "town");
    assert.equal(place.label, "Huddersfield");
    assert.equal(place.towns[0], "Huddersfield");
    assert.ok(place.towns.includes("Leeds"));
  });

  it("keeps an unknown location a lone town rather than guessing a nation", () => {
    const place = detectPlace("Llandudno");
    assert.equal(place.kind, "town");
    assert.deepEqual(place.towns, ["Llandudno"]);
  });

  it("plans an England-wide run across many English towns", () => {
    const plan = planSearch("England", 50);
    assert.equal(plan.kind, "nation");
    assert.equal(plan.label, "England");
    assert.ok(plan.areas.length >= 5);
    const names = plan.areas.map((area) => area.name);
    assert.ok(names.includes("Manchester") || names.includes("Birmingham"));
    assert.ok(!names.includes("Glasgow"));
    for (const area of plan.areas) {
      assert.ok(area.quota <= RESEARCH_BATCH_MAX);
    }
  });

  it("classifies English inputs by kind", () => {
    assert.equal(locationKindFor("England"), "nation");
    assert.equal(locationKindFor("Cheshire"), "region");
    assert.equal(locationKindFor("Sheffield"), "city");
  });

  it("searches English anchors for an England-wide company lookup", () => {
    const towns = chSearchTowns("England", 4);
    assert.ok(towns.includes("Manchester"));
    assert.ok(!towns.includes("Glasgow"));
    assert.deepEqual(chSearchTowns("Scotland", 4)[0], "Glasgow");
  });

  it("offers English regions and cities as suggestions", () => {
    assert.ok(ENGLAND_REGION_SUGGESTIONS.includes("West Yorkshire"));
    assert.ok(ENGLAND_CITY_SUGGESTIONS.includes("Liverpool"));
    assert.deepEqual([...NATIONS], ["Scotland", "England"]);
  });

  it("never lists the same town twice within a nation", () => {
    for (const nation of ["Scotland", "England"]) {
      const towns = detectPlace(nation).towns;
      assert.equal(new Set(towns.map((t) => t.toLowerCase())).size, towns.length);
    }
  });
});

describe("nationFor", () => {
  it("routes English places to England and everything else to Scotland", () => {
    assert.equal(nationFor("England"), "England");
    assert.equal(nationFor("Greater Manchester"), "England");
    assert.equal(nationFor("Liverpool"), "England");
    assert.equal(nationFor("Huddersfield"), "England");
    assert.equal(nationFor("Scotland"), "Scotland");
    assert.equal(nationFor("Crieff"), "Scotland");
    assert.equal(nationFor("Perthshire"), "Scotland");
  });

  it("falls back to the home market for anything it does not recognise", () => {
    assert.equal(nationFor(""), "Scotland");
    assert.equal(nationFor("Llandudno"), "Scotland");
  });

  it("offers English town chips that are real English towns", () => {
    assert.ok(ENGLAND_TOWN_SUGGESTIONS.length > 0);
    for (const town of ENGLAND_TOWN_SUGGESTIONS) {
      assert.equal(nationFor(town), "England");
    }
  });
});
