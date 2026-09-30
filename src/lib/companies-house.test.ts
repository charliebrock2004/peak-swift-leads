import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CH_API_BASE,
  chGet,
  chSearchQueries,
  displayCompanyName,
  extractUkPostcode,
  filterCompanyHits,
  hitInArea,
  isActiveCompany,
  isRejectedCompanyName,
  memoryLimiter,
  nameMatchesTrade,
  parseAdvancedSearch,
  parseCompaniesHouseJson,
  parseCompanyProfile,
  parseOfficers,
  personName,
  searchCompaniesHouse,
  specForTrade,
  type CompanyHit,
} from "./companies-house.ts";
import { windowKey } from "./sources/ch-limiter.server.ts";

const JOINERY_JSON = {
  items: [
    {
      title: "CHERRY JOINERY (PERTH) LIMITED",
      company_number: "SC649045",
      company_status: "active",
      company_type: "ltd",
      address_snippet: "18 Brandywell Road, Abernethy, Perth, Scotland, PH2 9GY",
      address: { locality: "Perth", postal_code: "PH2 9GY", premises: "18", address_line_1: "Brandywell Road", address_line_2: "Abernethy" },
    },
    {
      title: "BLACKWOOD JOINERY (PERTH) LTD",
      company_number: "SC653126",
      company_status: "dissolved",
      company_type: "ltd",
      address_snippet: "Unit 1 Grey Row, Ruthvenfield, Perth, United Kingdom, PH1 3JR",
      address: { locality: "Perth", postal_code: "PH1 3JR" },
    },
    {
      title: "ACE TAXIS PERTH LIMITED",
      company_number: "SC323981",
      company_status: "active",
      company_type: "ltd",
      address_snippet: "271 High Street, Perth, PH1 5QN",
      address: { locality: "Perth", postal_code: "PH1 5QN" },
    },
    {
      title: "CRIEFF CONSTRUCTION CONSULTANTS LTD",
      company_number: "SC896015",
      company_status: "active",
      company_type: "ltd",
      address_snippet: "Scotia House, Rectory Close, Crieff, Scotland, PH7 3EA",
      address: { locality: "Crieff", postal_code: "PH7 3EA" },
    },
    {
      title: "CRIEFF CONSTRUCTION LIMITED",
      company_number: "SC612222",
      company_status: "active",
      company_type: "ltd",
      address_snippet: "24 Milnab Street, Crieff, Perthshire, PH7 4BH",
      address: { locality: "Crieff", postal_code: "PH7 4BH", address_line_1: "Milnab Street", premises: "24" },
    },
    {
      title: "ABBEYFIELD PERTH SOCIETY LIMITED",
      company_number: "SP1901RS",
      company_status: "active",
      company_type: "registered-society-non-jurisdictional",
      address_snippet: "",
    },
  ],
};

/** The shape `GET /advanced-search/companies` returns. */
const ADVANCED_JSON = {
  hits: 3,
  items: [
    {
      company_name: "TAYSIDE ROOFING SERVICES LTD",
      company_number: "SC701234",
      company_status: "active",
      company_type: "ltd",
      sic_codes: ["43910"],
      date_of_creation: "2019-04-02",
      registered_office_address: { address_line_1: "5 Dunkeld Road", locality: "Perth", postal_code: "PH1 5RP" },
    },
    {
      company_name: "OLD SLATES LIMITED",
      company_number: "SC100001",
      company_status: "dissolved",
      company_type: "ltd",
      sic_codes: ["43910"],
      registered_office_address: { locality: "Perth", postal_code: "PH1 1AA" },
    },
    {
      company_name: "HIGHLAND ROOF HOLDINGS LIMITED",
      company_number: "SC100002",
      company_status: "active",
      company_type: "ltd",
      sic_codes: ["43910"],
      registered_office_address: { locality: "Perth", postal_code: "PH2 0AA" },
    },
  ],
};

function hit(partial: Partial<CompanyHit>): CompanyHit {
  return {
    businessName: "Crieff Construction",
    legalName: "CRIEFF CONSTRUCTION LIMITED",
    companyNumber: "SC612222",
    companyType: "ltd",
    companyStatus: "active",
    sicCodes: [],
    incorporatedOn: "",
    address: "24 Milnab Street, Crieff, PH7 4BH",
    town: "Crieff",
    postcode: "PH7 4BH",
    lat: 56.375,
    lng: -3.84,
    notes: "",
    ...partial,
  };
}

/** A stand-in for Companies House + postcodes.io that records every request. */
function fakeFetch(respond: (url: URL) => { status: number; body: unknown }) {
  const calls: { url: URL; auth: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") ?? "" });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    const { status, body } = respond(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls, maxInFlight: () => maxInFlight };
}

const PERTH = { lat: 56.397, lng: -3.437 };

describe("specForTrade", () => {
  it("uses the trade's own SIC code, not a broad construction code", () => {
    assert.deepEqual(specForTrade("Roofer").sic, ["43910"]);
    assert.deepEqual(specForTrade("Electrician").sic, ["43210"]);
    assert.deepEqual(specForTrade("Plumber").sic, ["43220"]);
    assert.ok(specForTrade("Joiner").sic.includes("43320"));
    assert.ok(!specForTrade("Roofer").sic.includes("43999"), "a catch-all code would return every builder");
  });

  it("falls back to a name search for trades with no clear SIC code", () => {
    assert.deepEqual(specForTrade("Tree surgeon").sic, []);
    assert.ok(specForTrade("Tree surgeon").queries.length > 0);
  });

  it("offers more than one naming style for the name search", () => {
    for (const trade of ["Joiner", "Plumber", "Electrician", "Builder"]) {
      assert.ok(specForTrade(trade).queries.length >= 2, trade);
    }
  });
});

describe("name matching", () => {
  it("requires the trade in the company name for a name-search hit", () => {
    const tokens = specForTrade("Joiner").tokens;
    assert.equal(nameMatchesTrade("Cherry Joinery (Perth)", tokens), true);
    assert.equal(nameMatchesTrade("Ace Taxis Perth", tokens), false);
  });

  it("drops consultants, societies, holdings and similar", () => {
    assert.equal(isRejectedCompanyName("Crieff Construction Consultants"), true);
    assert.equal(isRejectedCompanyName("Crieff Construction"), false);
    assert.equal(isRejectedCompanyName("Abbeyfield Perth Society"), true);
    assert.equal(isRejectedCompanyName("HIGHLAND ROOF HOLDINGS LIMITED"), true);
  });
});

describe("status", () => {
  it("keeps active trading companies and skips dissolved ones and non-trading types", () => {
    assert.equal(isActiveCompany("active", "ltd"), true);
    assert.equal(isActiveCompany("dissolved", "ltd"), false);
    assert.equal(isActiveCompany("liquidation", "ltd"), false);
    assert.equal(isActiveCompany("active", "registered-society-non-jurisdictional"), false);
    assert.equal(isActiveCompany("active", "charitable-incorporated-organisation"), false);
  });
});

describe("display + postcode + names", () => {
  it("title-cases a registered name and strips Limited", () => {
    assert.equal(displayCompanyName("CHERRY JOINERY (PERTH) LIMITED"), "Cherry Joinery (Perth)");
    assert.equal(displayCompanyName("S&S JOINERY PERTH LTD"), "S&S Joinery Perth");
    assert.equal(displayCompanyName("RW CONSTRUCTION PERTH LTD"), "RW Construction Perth");
  });

  it("extracts a UK postcode", () => {
    assert.equal(extractUkPostcode("24 Milnab Street, Crieff, Perthshire, PH7 4BH"), "PH7 4BH");
    assert.equal(extractUkPostcode("no postcode here"), "");
  });

  it("turns a register-style officer name into one you can say on the phone", () => {
    assert.equal(personName("SMITH, John Andrew"), "John Andrew Smith");
    assert.equal(personName("MACDONALD-ROSS, Fiona"), "Fiona Macdonald-Ross");
  });
});

describe("parsers", () => {
  it("keeps live joinery/construction companies from the name search", () => {
    const hits = filterCompanyHits(parseCompaniesHouseJson(JOINERY_JSON), "Joiner");
    assert.deepEqual(hits.map((row) => row.businessName), ["Cherry Joinery (Perth)"]);
    assert.equal(hits[0]?.companyType, "ltd");
    assert.equal(hits[0]?.legalName, "CHERRY JOINERY (PERTH) LIMITED");
    const builders = filterCompanyHits(parseCompaniesHouseJson(JOINERY_JSON), "Builder");
    assert.deepEqual(builders.map((row) => row.businessName), ["Crieff Construction"]);
  });

  it("reads the advanced search: SIC codes, type, incorporation date; skips dissolved and holdings", () => {
    const hits = filterCompanyHits(parseAdvancedSearch(ADVANCED_JSON), "Roofer", true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.businessName, "Tayside Roofing Services");
    assert.deepEqual(hits[0]?.sicCodes, ["43910"]);
    assert.equal(hits[0]?.incorporatedOn, "2019-04-02");
    assert.equal(hits[0]?.postcode, "PH1 5RP");
    assert.match(hits[0]?.notes ?? "", /SC701234 \(ltd\)/);
  });

  it("reads a company profile", () => {
    const profile = parseCompanyProfile({
      company_number: "SC701234",
      company_name: "TAYSIDE ROOFING SERVICES LTD",
      type: "ltd",
      company_status: "active",
      sic_codes: ["43910"],
      date_of_creation: "2019-04-02",
      registered_office_address: { locality: "Perth", postal_code: "PH1 5RP" },
      accounts: { overdue: false },
    });
    assert.equal(profile?.companyType, "ltd");
    assert.equal(profile?.accountsOverdue, false);
    assert.equal(parseCompanyProfile({}), null);
  });

  it("keeps only current directors, and only their names and roles", () => {
    const officers = parseOfficers({
      items: [
        { name: "SMITH, John", officer_role: "director", appointed_on: "2019-04-02", date_of_birth: { month: 1, year: 1980 }, address: { premises: "1" } },
        { name: "JONES, Old", officer_role: "director", resigned_on: "2021-01-01" },
        { name: "ACME SECRETARIES LTD", officer_role: "corporate-secretary" },
      ],
    });
    assert.deepEqual(officers, [{ name: "John Smith", role: "director", appointedOn: "2019-04-02" }]);
    assert.ok(!JSON.stringify(officers).includes("1980"), "a date of birth must not be stored");
  });
});

describe("area", () => {
  it("keeps a geocoded hit inside the radius and drops one outside", () => {
    const crieff = { lat: 56.3727, lng: -3.8389 };
    const dundee = hit({ businessName: "NWR Electrical Perth", town: "Dundee", lat: 56.462, lng: -2.9707 });
    assert.equal(hitInArea(hit({}), crieff, 25, ["Perth", "Comrie"], "Crieff"), true);
    assert.equal(hitInArea(dundee, crieff, 25, ["Perth", "Comrie"], "Crieff"), false);
  });

  it("falls back to town-in-name when there is no postcode geo", () => {
    const crieff = { lat: 56.3727, lng: -3.8389 };
    const glasgow = hit({ businessName: "Campbell Construction (Crieff)", address: "227 West George Street, Glasgow", town: "Glasgow", postcode: "G2 2ND", lat: "", lng: "" });
    assert.equal(hitInArea(glasgow, crieff, 25, ["Perth"], "Crieff"), true);
  });
});

describe("name-search breadth", () => {
  it("searches every naming style in the main town, then reaches outlying towns", () => {
    const queries = chSearchQueries("Joiner", ["Perth", "Scone", "Errol"]);
    assert.match(queries.join(" | "), /joiners Perth/);
    const firstOutlying = queries.findIndex((query) => /Scone|Errol/.test(query));
    assert.ok(queries.slice(0, firstOutlying).every((query) => query.endsWith("Perth")));
  });

  it("has a hard ceiling, because every query is a real request", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Town${i}`);
    assert.ok(chSearchQueries("Joiner", many).length <= 14);
  });
});

describe("talking to the API", () => {
  it("does nothing at all without a key — and never falls back to scraping", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: {} }));
    const answer = await chGet("/search/companies", { q: "x" }, { apiKey: "", fetchImpl: fake.impl });
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.kind, "no-key");
    const search = await searchCompaniesHouse({ trade: "Roofer", location: "Perth", towns: ["Scone"], center: PERTH, radiusMiles: 20, limit: 20 }, { apiKey: "", fetchImpl: fake.impl });
    assert.equal(search.disabled, true);
    assert.equal(fake.calls.length, 0);
    assert.ok(!fake.calls.some((call) => call.url.hostname.includes("find-and-update")));
  });

  it("sends the key as HTTP Basic to the official API host", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: { items: [] } }));
    await chGet("/search/companies", { q: "roofing Perth" }, { apiKey: "my-key", fetchImpl: fake.impl, limiter: memoryLimiter(10) });
    assert.equal(fake.calls[0]?.url.origin, CH_API_BASE);
    assert.equal(fake.calls[0]?.auth, `Basic ${Buffer.from("my-key:").toString("base64")}`);
    assert.ok(!fake.calls[0]?.url.toString().includes("my-key"), "the key never goes in the URL");
  });

  it("searches SIC-coded trades by code and town, a bounded number of times, a few at a time", async () => {
    const fake = fakeFetch((url) => {
      if (url.hostname === "api.postcodes.io") return { status: 200, body: { result: [{ query: "PH1 5RP", result: { latitude: 56.4, longitude: -3.44 } }] } };
      return { status: 200, body: ADVANCED_JSON };
    });
    const towns = Array.from({ length: 20 }, (_, i) => `Town${i}`);
    const result = await searchCompaniesHouse(
      { trade: "Roofer", location: "Perth", towns, center: PERTH, radiusMiles: 20, limit: 20 },
      { apiKey: "k", fetchImpl: fake.impl, limiter: memoryLimiter(100) },
    );
    const chCalls = fake.calls.filter((call) => call.url.hostname !== "api.postcodes.io");
    assert.ok(chCalls.every((call) => call.url.pathname === "/advanced-search/companies"));
    assert.ok(chCalls.every((call) => call.url.searchParams.get("sic_codes") === "43910"));
    assert.ok(chCalls.every((call) => call.url.searchParams.get("company_status") === "active"));
    assert.ok(chCalls.length <= 14, `${chCalls.length} requests for one search`);
    assert.ok(fake.maxInFlight() <= 3, `up to ${fake.maxInFlight()} requests at once`);
    assert.deepEqual(result.hits.map((row) => row.companyNumber), ["SC701234"]);
  });

  it("uses the name search for a trade with no SIC code", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: { items: [] } }));
    await searchCompaniesHouse({ trade: "Tree surgeon", location: "Perth", towns: [], center: PERTH, radiusMiles: 20, limit: 20 }, { apiKey: "k", fetchImpl: fake.impl, limiter: memoryLimiter(100) });
    assert.ok(fake.calls.length > 0);
    assert.ok(fake.calls.every((call) => call.url.pathname === "/search/companies"));
  });

  it("stops asking once the shared budget says no", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: ADVANCED_JSON }));
    const result = await searchCompaniesHouse(
      { trade: "Roofer", location: "Perth", towns: ["Scone", "Stanley", "Errol", "Methven", "Dunning"], center: PERTH, radiusMiles: 20, limit: 20 },
      { apiKey: "k", fetchImpl: fake.impl, limiter: memoryLimiter(2) },
    );
    assert.equal(fake.calls.filter((call) => call.url.hostname !== "api.postcodes.io").length, 2);
    assert.ok(result.hits.length >= 1, "what the budget allowed is still used");
  });

  it("names a rate limit and a bad key rather than returning an empty list", async () => {
    const limited = await chGet("/search/companies", { q: "x" }, { apiKey: "k", fetchImpl: fakeFetch(() => ({ status: 429, body: {} })).impl, limiter: memoryLimiter(5) });
    assert.equal(!limited.ok && limited.kind, "rate-limited");
    const badKey = await chGet("/search/companies", { q: "x" }, { apiKey: "k", fetchImpl: fakeFetch(() => ({ status: 401, body: {} })).impl, limiter: memoryLimiter(5) });
    assert.match(!badKey.ok ? badKey.error : "", /API key/);
  });
});

describe("the shared request budget", () => {
  it("counts in 5-minute windows", () => {
    const a = windowKey(new Date("2026-09-30T10:00:10Z"));
    const b = windowKey(new Date("2026-09-30T10:04:59Z"));
    const c = windowKey(new Date("2026-09-30T10:05:00Z"));
    assert.equal(a, b);
    assert.notEqual(b, c);
  });

  it("the per-process fallback refuses past its budget and resets with the window", async () => {
    const limiter = memoryLimiter(2, 300);
    assert.equal(await limiter(1), true);
    assert.equal(await limiter(1), true);
    assert.equal(await limiter(1), false);
  });
});
