import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chSearchQueries,
  displayCompanyName,
  extractUkPostcode,
  filterCompanyHits,
  hitInArea,
  isActiveCompany,
  isRejectedCompanyName,
  nameMatchesTrade,
  parseCompaniesHouseHtml,
  parseCompaniesHouseJson,
  specForTrade,
  type CompanyHit,
} from "./companies-house.ts";

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

const HTML = `
<ul id='results' class="results-list">
  <li class="type-company">
    <h3><a class="govuk-link" href="/company/SC399373">G ROBERTS HEATING & PLUMBING LIMITED</a></h3>
    <p class="meta crumbtrail"> SC399373 - Incorporated on 12 May 2011 </p>
    <p>Fairness, Comrie, Crieff, Perth And Kinross, United Kingdom, PH6 2JA</p>
  </li>
  <li class="type-company">
    <h3><a class="govuk-link" href="/company/SC468888">JOHN DOUGLAS PLUMBING AND HEATING (PERTHSHIRE) LIMITED</a></h3>
    <p class="meta crumbtrail"> SC468888 - Dissolved on 18 June 2024 </p>
    <p>Imphal, Academy Road, Crieff, Scotland, PH7 4AT</p>
  </li>
</ul>
`;

describe("specForTrade", () => {
  it("leads with the Companies House word that actually ranks, not an OSM tag", () => {
    // The FIRST word is the one used on its own in outlying towns, so it has
    // to be the one company names most often carry. The rest widen the search
    // in the main town; pinning the exact list here is what kept this to a
    // single word and made "… Joiners" unfindable.
    assert.equal(specForTrade("Joiner").queries[0], "joinery");
    assert.equal(specForTrade("Plumber").queries[0], "plumbing");
    assert.equal(specForTrade("Electrician").queries[0], "electrical");
    assert.equal(specForTrade("Builder").queries[0], "construction");
    assert.equal(specForTrade("Tiler").queries[0], "tiling");
    assert.equal(specForTrade("Gym").queries[0], "fitness");
    assert.equal(specForTrade("Mechanic").queries[0], "motors");
    assert.equal(specForTrade("Garage").queries[0], "motors");
  });

  it("offers more than one naming style for the common trades", () => {
    for (const trade of ["Joiner", "Plumber", "Electrician", "Builder"]) {
      assert.ok(
        specForTrade(trade).queries.length >= 2,
        `${trade} can only be searched one way, so other naming styles are unfindable`,
      );
    }
  });

  it("keeps every search word a plain company-name word", () => {
    for (const trade of ["Joiner", "Plumber", "Electrician", "Roofer", "Tiler"]) {
      for (const word of specForTrade(trade).queries) {
        assert.match(word, /^[a-z]+( [a-z]+)?$/, `${trade}: "${word}" is not a name-style word`);
      }
    }
  });
});

describe("name matching", () => {
  it("requires the trade in the company name", () => {
    const tokens = specForTrade("Joiner").tokens;
    assert.equal(nameMatchesTrade("Cherry Joinery (Perth)", tokens), true);
    assert.equal(nameMatchesTrade("Ace Taxis Perth", tokens), false);
    assert.equal(nameMatchesTrade("G Roberts Heating & Plumbing", specForTrade("Plumber").tokens), true);
  });

  it("drops consultants, societies and similar", () => {
    assert.equal(isRejectedCompanyName("Crieff Construction Consultants"), true);
    assert.equal(isRejectedCompanyName("Crieff Construction"), false);
    assert.equal(isRejectedCompanyName("Abbeyfield Perth Society"), true);
  });
});

describe("status", () => {
  it("keeps active JSON rows and skips dissolved / charities", () => {
    assert.equal(isActiveCompany("active", "ltd", "SC649045"), true);
    assert.equal(isActiveCompany("dissolved", "ltd", "SC653126"), false);
    assert.equal(isActiveCompany("liquidation", "ltd", "SC440105"), false);
    assert.equal(isActiveCompany("active", "ltd", "SP1901RS"), false);
  });

  it("reads Companies House HTML crumbtrails", () => {
    assert.equal(isActiveCompany("SC399373 - Incorporated on 12 May 2011", "", "SC399373"), true);
    assert.equal(isActiveCompany("SC468888 - Dissolved on 18 June 2024", "", "SC468888"), false);
  });
});

describe("display + postcode", () => {
  it("title-cases a registered name and strips Limited", () => {
    assert.equal(displayCompanyName("CHERRY JOINERY (PERTH) LIMITED"), "Cherry Joinery (Perth)");
    assert.equal(displayCompanyName("S&S JOINERY PERTH LTD"), "S&S Joinery Perth");
    assert.equal(displayCompanyName("RW CONSTRUCTION PERTH LTD"), "RW Construction Perth");
  });

  it("extracts a UK postcode", () => {
    assert.equal(extractUkPostcode("24 Milnab Street, Crieff, Perthshire, PH7 4BH"), "PH7 4BH");
    assert.equal(extractUkPostcode("no postcode here"), "");
  });
});

describe("parsers", () => {
  it("keeps live joinery/construction companies from JSON", () => {
    const hits = filterCompanyHits(parseCompaniesHouseJson(JOINERY_JSON), "Joiner");
    assert.deepEqual(
      hits.map((hit) => hit.businessName),
      ["Cherry Joinery (Perth)"],
    );
    const builders = filterCompanyHits(parseCompaniesHouseJson(JOINERY_JSON), "Builder");
    assert.deepEqual(
      builders.map((hit) => hit.businessName),
      ["Crieff Construction"],
    );
  });

  it("parses HTML and skips dissolved plumbers", () => {
    const hits = filterCompanyHits(parseCompaniesHouseHtml(HTML), "Plumber");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.businessName, "G Roberts Heating & Plumbing");
    assert.equal(hits[0]?.postcode, "PH6 2JA");
    assert.equal(hits[0]?.town, "Crieff");
  });
});

describe("queries and area", () => {
  it("builds a short Companies House query list for Crieff builders", () => {
    const queries = chSearchQueries("Builder", ["Crieff", "Perth", "Auchterarder"]);
    assert.ok(queries.includes("construction Crieff"));
    assert.ok(queries.includes("construction Perth"));
    assert.ok(queries.length <= 4);
  });

  it("keeps a geocoded hit inside the radius and drops one outside", () => {
    const crieff = { lat: 56.3727, lng: -3.8389 };
    const local: CompanyHit = {
      businessName: "Crieff Construction",
      companyNumber: "SC612222",
      address: "24 Milnab Street, Crieff, PH7 4BH",
      town: "Crieff",
      postcode: "PH7 4BH",
      lat: 56.375,
      lng: -3.84,
      notes: "",
    };
    const dundee: CompanyHit = {
      ...local,
      businessName: "NWR Electrical Perth",
      town: "Dundee",
      lat: 56.462,
      lng: -2.9707,
    };
    assert.equal(hitInArea(local, crieff, 25, ["Perth", "Comrie"], "Crieff"), true);
    assert.equal(hitInArea(dundee, crieff, 25, ["Perth", "Comrie"], "Crieff"), false);
  });

  it("falls back to town-in-name when there is no postcode geo", () => {
    const crieff = { lat: 56.3727, lng: -3.8389 };
    const hit: CompanyHit = {
      businessName: "Campbell Construction (Crieff)",
      companyNumber: "SC1",
      address: "227 West George Street, Glasgow",
      town: "Glasgow",
      postcode: "G2 2ND",
      lat: "",
      lng: "",
      notes: "",
    };
    assert.equal(hitInArea(hit, crieff, 25, ["Perth"], "Crieff"), true);
  });
});

describe("how wide the company search actually casts", () => {
  it("searches every naming style of a trade, not just one word", () => {
    // The bug this pins: `queries` are what is SEARCHED FOR and `tokens` only
    // filter what comes back, so a company registered as "… Joiners" could
    // never be found while the only search word was "joinery".
    const queries = chSearchQueries("Joiner", ["Perth"]);
    const text = queries.join(" | ");
    assert.match(text, /joinery Perth/);
    assert.match(text, /joiners Perth/, "a company named '… Joiners' has to be searchable");
    assert.match(text, /carpentry Perth/);
  });

  it("gives the main town every word before any outlying town gets one", () => {
    const queries = chSearchQueries("Joiner", ["Perth", "Scone", "Errol"]);
    const firstOutlying = queries.findIndex((query) => /Scone|Errol/.test(query));
    const perthQueries = queries.slice(0, firstOutlying);
    assert.ok(perthQueries.length >= 3, `the main town got only ${perthQueries.length} words`);
    assert.ok(perthQueries.every((query) => query.endsWith("Perth")));
  });

  it("spends the rest of the budget on reaching more towns", () => {
    const towns = ["Perth", "Scone", "Bridge of Earn", "Methven", "Errol", "Stanley", "Abernethy", "Dunning"];
    const queries = chSearchQueries("Joiner", towns);
    const reached = new Set(towns.filter((town) => queries.some((query) => query.endsWith(town))));
    assert.ok(reached.size >= 6, `only reached ${reached.size} towns: ${[...reached].join(", ")}`);
  });

  it("still has a hard ceiling, because every query is a real request", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Town${i}`);
    assert.ok(chSearchQueries("Joiner", many).length <= 14);
  });

  it("widens the other trades the same way", () => {
    for (const [trade, expected] of [
      ["Plumber", /plumbers/],
      ["Electrician", /electricians/],
      ["Roofer", /roofers/],
    ] as const) {
      assert.match(chSearchQueries(trade, ["Perth"]).join(" | "), expected, trade);
    }
  });

  it("never repeats a query", () => {
    const queries = chSearchQueries("Joiner", ["Perth", "Perth", " Perth ", "Scone"]);
    assert.equal(new Set(queries).size, queries.length);
  });

  it("asks for nothing when there is no town to ask about", () => {
    assert.deepEqual(chSearchQueries("Joiner", []), []);
    assert.deepEqual(chSearchQueries("Joiner", ["", " "]), []);
  });
});
