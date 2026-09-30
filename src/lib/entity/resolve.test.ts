import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareBusinesses, foldName, nameRelation, normalizePostcode, type BusinessRecord } from "./resolve.ts";

const osm = (overrides: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id: "osm-1",
  name: "Strathearn Joinery",
  town: "Crieff",
  postcode: "PH7 3AA",
  phone: "01764 123456",
  website: "https://strathearnjoinery.co.uk",
  sourceIds: ["osm:node:1"],
  ...overrides,
});

const verdict = (a: BusinessRecord, b: BusinessRecord) => compareBusinesses(a, b).verdict;

describe("names", () => {
  it("folds case, punctuation, '&', and legal suffixes", () => {
    assert.equal(foldName("STRATHEARN JOINERY LIMITED"), "strathearn joinery");
    assert.equal(foldName("Smith & Sons (Builders) Ltd."), "smith and sons builders");
    assert.equal(foldName("J. S. Joinery"), "js joinery");
    assert.equal(foldName("O'Brien's Barbers"), "obriens barbers");
  });

  it("relates trading names to legal names, and catches small misspellings", () => {
    assert.equal(nameRelation("Tayside Roofing", "TAYSIDE ROOFING SERVICES LIMITED"), "contains");
    assert.equal(nameRelation("Strathearn Joinery", "Strathern Joinery"), "similar");
    assert.equal(nameRelation("Strathearn Joinery Ltd", "strathearn-joinery"), "equal");
  });

  it("does not relate names that only share trade words", () => {
    assert.equal(nameRelation("Roofing Services", "Roofing Services Scotland"), "different");
    assert.equal(nameRelation("Perth Joinery", "Crieff Joinery"), "different");
    assert.equal(nameRelation("Joe's Barbers", "Jo's Barbers"), "different", "short names: one letter is a different business");
  });

  it("normalises postcodes and rejects non-postcodes", () => {
    assert.equal(normalizePostcode("ph7 3aa"), "PH73AA");
    assert.equal(normalizePostcode("Crieff"), "");
  });
});

describe("exact duplicates", () => {
  it("the same record from two providers is the same business", () => {
    assert.equal(verdict(osm(), osm({ id: "osm-2" })), "same");
  });

  it("a shared source id is decisive", () => {
    const result = compareBusinesses(osm(), { id: "x", name: "Something else", sourceIds: ["osm:node:1"] });
    assert.equal(result.verdict, "same");
    assert.match(result.reasons[0]!, /osm:node:1/);
  });

  it("a shared company number is decisive; different numbers never merge", () => {
    assert.equal(verdict(osm({ companyNumber: "SC612222" }), { id: "ch", name: "TOTALLY DIFFERENT LTD", companyNumber: "sc612222" }), "same");
    const twins = compareBusinesses(
      osm({ companyNumber: "SC100001" }),
      osm({ id: "osm-2", companyNumber: "SC100002" }),
    );
    assert.equal(twins.verdict, "different", "same name, phone and site, but two registered companies");
  });
});

describe("spelling and punctuation differences", () => {
  it("merges a misspelling at the same premises", () => {
    assert.equal(verdict(osm({ phone: "", website: "" }), osm({ id: "b", name: "Strathern Joinery", phone: "", website: "", sourceIds: [] })), "same");
  });

  it("merges punctuation and suffix differences with the same phone", () => {
    const a = osm({ name: "Smith & Sons Builders", postcode: "", website: "" });
    const b = osm({ id: "b", name: "SMITH AND SONS BUILDERS LTD", postcode: "", website: "", phone: "+44 (0)1764 123456", sourceIds: [] });
    assert.equal(verdict(a, b), "same");
  });

  it("only flags a misspelling when there is nothing else to go on", () => {
    const a = osm({ postcode: "", phone: "", website: "" });
    const b = { id: "b", name: "Strathern Joinery", town: "Crieff" };
    assert.equal(verdict(a, b), "possible");
  });
});

describe("trading name vs legal name", () => {
  it("merges a Companies House record with its trading name at the same postcode", () => {
    const trading = osm({ name: "Tayside Roofing", postcode: "PH1 3TW", website: "", phone: "" });
    const legal: BusinessRecord = { id: "ch", name: "TAYSIDE ROOFING SERVICES LIMITED", postcode: "PH1 3TW", companyNumber: "SC555555", sourceIds: ["ch:SC555555"] };
    assert.equal(verdict(trading, legal), "same");
  });

  it("only flags one whose registered office is elsewhere (an accountant's address)", () => {
    const trading = osm({ name: "Tayside Roofing", postcode: "PH7 3AA", website: "", phone: "" });
    const legal: BusinessRecord = { id: "ch", name: "TAYSIDE ROOFING SERVICES LIMITED", postcode: "PH1 5RP", companyNumber: "SC555555" };
    const result = compareBusinesses(trading, legal);
    assert.equal(result.verdict, "possible");
    assert.match(result.reasons[0]!, /registered office elsewhere/);
  });

  it("uses a known alias", () => {
    const a = osm({ name: "The Wee Barber", aliases: ["G BROCK LIMITED"], postcode: "PH2 8AA", website: "", phone: "" });
    const b: BusinessRecord = { id: "ch", name: "G BROCK LIMITED", postcode: "PH2 8AA" };
    assert.equal(verdict(a, b), "same");
  });
});

describe("shared phone numbers", () => {
  it("does not merge two differently named businesses on a shared number", () => {
    const joinery = osm({ website: "", postcode: "" });
    const plumbing = { id: "b", name: "Crieff Plumbing & Heating", town: "Crieff", phone: "01764 123456" };
    const result = compareBusinesses(joinery, plumbing);
    assert.equal(result.verdict, "possible");
    assert.match(result.reasons[0]!, /different names/);
  });

  it("does not merge two websites that share a switchboard", () => {
    const a = osm({ name: "Perth Business Centre Unit 1", website: "https://unit1.co.uk" });
    const b = osm({ id: "b", name: "Perth Business Centre Unit 2", website: "https://unit2.co.uk", sourceIds: [] });
    assert.equal(verdict(a, b), "possible");
  });
});

describe("shared addresses", () => {
  it("keeps businesses in the same building apart", () => {
    const a: BusinessRecord = { id: "a", name: "Inveralmond Electrical", postcode: "PH1 3TW", town: "Perth" };
    const b: BusinessRecord = { id: "b", name: "Kinnoull Kitchens", postcode: "PH1 3TW", town: "Perth" };
    const result = compareBusinesses(a, b);
    assert.equal(result.verdict, "different");
    assert.match(result.reasons[0]!, /shared building/);
  });
});

describe("chains", () => {
  it("never merges branches: same website, different postcodes", () => {
    const perth: BusinessRecord = { id: "a", name: "Screwfix Perth", website: "https://www.screwfix.com/stores/perth", postcode: "PH1 3AA", town: "Perth" };
    const stirling: BusinessRecord = { id: "b", name: "Screwfix Stirling", website: "https://www.screwfix.com/stores/stirling", postcode: "FK7 7AA", town: "Stirling" };
    assert.equal(verdict(perth, stirling), "possible");
  });

  it("flags, but does not merge, two same-named shops in one town", () => {
    const a: BusinessRecord = { id: "a", name: "Subway", town: "Perth", postcode: "PH1 5AA" };
    const b: BusinessRecord = { id: "b", name: "Subway", town: "Perth", postcode: "PH2 8BB" };
    assert.equal(verdict(a, b), "possible");
  });
});

describe("false-positive merges it must refuse", () => {
  it("similar names in the same town with different numbers", () => {
    const a = osm({ website: "", postcode: "" });
    const b = { id: "b", name: "Strathearn Joinery", town: "Crieff", phone: "01764 999999" };
    assert.notEqual(verdict(a, b), "same");
  });

  it("names that share only trade words", () => {
    const a: BusinessRecord = { id: "a", name: "Perth Roofing Services", town: "Perth" };
    const b: BusinessRecord = { id: "b", name: "Tay Roofing Services", town: "Perth" };
    assert.equal(verdict(a, b), "different");
  });

  it("the same name with nothing else in common", () => {
    const a: BusinessRecord = { id: "a", name: "Highland Joinery" };
    const b: BusinessRecord = { id: "b", name: "Highland Joinery" };
    assert.equal(verdict(a, b), "possible", "flagged for a person, never merged");
  });

  it("two social-media-only businesses are not linked by 'facebook.com'", () => {
    const a: BusinessRecord = { id: "a", name: "Kim's Nails", website: "https://facebook.com/kimsnails", town: "Perth" };
    const b: BusinessRecord = { id: "b", name: "Tay Nails", website: "https://facebook.com/taynails", town: "Perth" };
    assert.equal(verdict(a, b), "different");
  });
});

describe("a person's ruling", () => {
  it("overrides every rule, in either argument order", () => {
    const a = osm();
    const b = osm({ id: "osm-2" });
    assert.equal(compareBusinesses(a, b, [{ a: "osm-1", b: "osm-2", decision: "different", note: "two brothers" }]).verdict, "different");
    assert.equal(compareBusinesses(b, a, [{ a: "osm-1", b: "osm-2", decision: "different" }]).verdict, "different");
    const c: BusinessRecord = { id: "c", name: "Totally Unrelated" };
    assert.equal(compareBusinesses(a, c, [{ a: "c", b: "osm-1", decision: "same" }]).verdict, "same");
  });
});
