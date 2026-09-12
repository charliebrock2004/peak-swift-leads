import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQueries,
  candidatesFromResults,
  looksLikeOwnWebsite,
  looksLikePublicProfile,
  MAX_SEARCHES_PER_LEAD,
  classifySearchFailure,
  MAX_RESULTS_PER_QUERY,
  parseBing,
  parseBrave,
  parseProvider,
  parseTavily,
  SEARCH_PROVIDERS,
  providerRequest,
  type SearchResult,
  nameVariations,
} from "./search-provider.ts";

const cuttingEdge = {
  businessName: "Cutting Edge", town: "Cupar", trade: "Hairdresser",
  phone: "01334 652000", address: "12 Bonnygate, Cupar, KY15 4BU",
};

describe("what gets searched for", () => {
  it("quotes the business name so the town does not dissolve it", () => {
    assert.ok(buildQueries(cuttingEdge)[0].text.startsWith('"Cutting Edge"'));
  });
  it("pins every query to something specific, not just the name", () => {
    // The town is no longer the only pin: a postcode and a phone number are
    // both MORE specific than a town, so the strongest queries use those
    // instead. What must hold is that no query is the bare name on its own.
    for (const query of buildQueries(cuttingEdge)) {
      const pinned =
        query.text.includes("Cupar") ||
        query.text.includes("KY15 4BU") ||
        query.text.includes("01334 652000");
      assert.ok(pinned, `nothing pins this query: ${query.text}`);
    }
  });

  it("runs the most specific query first", () => {
    const queries = buildQueries(cuttingEdge);
    // A postcode identifies one address; a town identifies a market town.
    assert.ok(queries[0]!.text.includes("KY15 4BU"), `first query was: ${queries[0]!.text}`);
    for (let i = 1; i < queries.length; i += 1) {
      assert.ok(
        queries[i - 1]!.strength >= queries[i]!.strength,
        "queries must be ordered strongest first, so the waterfall can stop early",
      );
    }
  });

  it("uses the phone number when there is one", () => {
    assert.ok(buildQueries(cuttingEdge).some((q) => q.text.includes("01334 652000")));
  });

  it("falls back to the town when there is no postcode or phone", () => {
    const queries = buildQueries({ ...cuttingEdge, address: "", phone: "" });
    assert.ok(queries.length > 0);
    assert.ok(queries.every((q) => q.text.includes("Cupar")));
  });

  it("searches alternative spellings of a trading name", () => {
    const queries = buildQueries({ ...cuttingEdge, businessName: "Smith & Sons Joinery Ltd" });
    const all = queries.map((q) => q.text).join(" | ");
    assert.ok(/Smith & Sons/.test(all) || /Smith and Sons/.test(all), all);
    assert.ok(
      queries.some((q) => !/\bLtd\b/.test(q.text)),
      "at least one query should drop the Ltd, which only splits the results",
    );
  });
  it("asks for contact details as well as the site", () => {
    assert.ok(buildQueries(cuttingEdge).some((q) => q.intent === "contact"));
  });
  it("stays inside the per-lead budget", () => {
    assert.ok(buildQueries(cuttingEdge).length <= MAX_SEARCHES_PER_LEAD);
  });
  it("never repeats the same query", () => {
    const texts = buildQueries(cuttingEdge).map((q) => q.text);
    assert.equal(new Set(texts).size, texts.length);
  });
  it("searches for nothing when there is no name to search for", () => {
    assert.deepEqual(buildQueries({ ...cuttingEdge, businessName: "" }), []);
  });
  it("copes with a lead that has no trade recorded", () => {
    assert.ok(buildQueries({ ...cuttingEdge, trade: "" }).length > 0);
  });
});

describe("telling a business's own site from a listing of it", () => {
  it("accepts an ordinary business domain", () => {
    assert.ok(looksLikeOwnWebsite("https://cuttingedgecupar.co.uk/"));
  });
  it("rejects social networks", () => {
    for (const url of [
      "https://facebook.com/cuttingedge", "https://www.instagram.com/cuttingedge",
      "https://linkedin.com/company/x", "https://www.tiktok.com/@x",
    ]) assert.equal(looksLikeOwnWebsite(url), false, url);
  });
  it("rejects directories and marketplaces", () => {
    for (const url of [
      "https://www.yell.com/biz/cutting-edge", "https://www.tripadvisor.co.uk/x",
      "https://www.checkatrade.com/x", "https://en.wikipedia.org/wiki/Hair",
      "https://www.treatwell.co.uk/place/x",
    ]) assert.equal(looksLikeOwnWebsite(url), false, url);
  });
  it("rejects blog and product subpaths", () => {
    assert.equal(looksLikeOwnWebsite("https://example.co.uk/blog/best-salons"), false);
    assert.equal(looksLikeOwnWebsite("https://example.co.uk/category/hair"), false);
  });
  it("still recognises a directory as a public profile worth reading", () => {
    assert.ok(looksLikePublicProfile("https://www.yell.com/biz/cutting-edge-cupar"));
    assert.equal(looksLikePublicProfile("https://cuttingedge.co.uk"), false);
  });
});

describe("turning results into candidates", () => {
  const r = (url: string, title = "t", snippet = "s"): SearchResult => ({ url, title, snippet });

  it("keeps one candidate per host", () => {
    const out = candidatesFromResults([
      r("https://cuttingedge.co.uk/"), r("https://cuttingedge.co.uk/contact"),
      r("https://cuttingedge.co.uk/about"),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].origin, "https://cuttingedge.co.uk");
  });

  it("puts a business's own site before a directory profile", () => {
    const out = candidatesFromResults([
      r("https://www.yell.com/biz/cutting-edge"), r("https://cuttingedge.co.uk/"),
    ]);
    assert.equal(out[0].kind, "OWN_WEBSITE");
    assert.equal(out[1].kind, "PUBLIC_PROFILE");
  });

  it("drops results that are neither", () => {
    assert.deepEqual(candidatesFromResults([r("https://facebook.com/x"), r("not a url")]), []);
  });

  it("stays within its budget", () => {
    const many = Array.from({ length: 20 }, (_, i) => r(`https://site${i}.co.uk/`));
    assert.ok(candidatesFromResults(many).length <= 4);
  });
});

describe("provider responses", () => {
  it("reads a Brave payload", () => {
    const out = parseBrave({ web: { results: [
      { title: "Cutting Edge", url: "https://cuttingedge.co.uk", description: "Cupar salon" },
      { title: "x", url: "https://b.co.uk" },
    ] } });
    assert.equal(out.length, 2);
    assert.equal(out[0].url, "https://cuttingedge.co.uk");
    assert.equal(out[0].snippet, "Cupar salon");
    assert.equal(out[1].snippet, "");
  });

  it("reads a Bing payload", () => {
    const out = parseBing({ webPages: { value: [
      { name: "Cutting Edge", url: "https://cuttingedge.co.uk", snippet: "Cupar salon" },
    ] } });
    assert.equal(out[0].title, "Cutting Edge");
    assert.equal(out[0].snippet, "Cupar salon");
  });

  it("survives a payload in any unexpected shape", () => {
    for (const junk of [null, undefined, {}, { web: {} }, { web: { results: "no" } }, [1, 2]]) {
      assert.deepEqual(parseBrave(junk), []);
      assert.deepEqual(parseBing(junk), []);
    }
  });

  it("drops results with no URL", () => {
    assert.deepEqual(parseBrave({ web: { results: [{ title: "x" }] } }), []);
  });

  it("dispatches to the right parser", () => {
    assert.equal(parseProvider("brave", { web: { results: [{ url: "https://a.test" }] } }).length, 1);
    assert.equal(parseProvider("bing", { webPages: { value: [{ url: "https://a.test" }] } }).length, 1);
  });
});

describe("how a provider is called", () => {
  it("uses each provider's own API host, never a results page", () => {
    // Scraping a search results page breaks the provider's terms and their
    // markup. Only documented API endpoints are ever contacted.
    assert.ok(providerRequest("brave", "k", "q").url.startsWith("https://api.search.brave.com/"));
    assert.ok(providerRequest("bing", "k", "q").url.startsWith("https://api.bing.microsoft.com/"));
    for (const p of ["brave", "bing"] as const) {
      assert.ok(!/google\.com\/search|bing\.com\/search|duckduckgo/.test(providerRequest(p, "k", "q").url));
    }
  });

  it("sends the key in the header each provider documents", () => {
    assert.equal(providerRequest("brave", "secret", "q").headers["X-Subscription-Token"], "secret");
    assert.equal(providerRequest("bing", "secret", "q").headers["Ocp-Apim-Subscription-Key"], "secret");
  });

  it("never puts the key in the URL", () => {
    for (const p of ["brave", "bing"] as const) {
      assert.ok(!providerRequest(p, "secret", "q").url.includes("secret"), p);
    }
  });

  it("escapes the query", () => {
    assert.ok(providerRequest("brave", "k", '"Cutting Edge" Cupar').url.includes("%22Cutting%20Edge%22"));
  });
});


describe("Tavily", () => {
  const payload = {
    query: '"Salon T Elle" Kinross',
    results: [
      {
        title: "Salon T Elle | Kinross",
        url: "https://salontelle.co.uk/",
        content: "Hairdressing in Kinross",
        raw_content: "Salon T Elle, 4 High Street, Kinross KY13 8AN. Tel 01577 863000. info@salontelle.co.uk",
        score: 0.97,
      },
      { title: "Yell", url: "https://www.yell.com/biz/salon-t-elle", content: "listing", raw_content: null },
    ],
  };

  it("reads results, snippets and the extracted page text", () => {
    const out = parseTavily(payload);
    assert.equal(out.length, 2);
    assert.equal(out[0].url, "https://salontelle.co.uk/");
    assert.equal(out[0].snippet, "Hairdressing in Kinross");
    assert.match(out[0].rawContent ?? "", /info@salontelle\.co\.uk/);
  });

  it("treats a null raw_content as simply absent", () => {
    assert.equal(parseTavily(payload)[1].rawContent, undefined);
  });

  it("survives any unexpected payload shape", () => {
    for (const junk of [null, undefined, {}, { results: "no" }, { results: [{}] }, [1]]) {
      assert.doesNotThrow(() => parseTavily(junk));
    }
    assert.deepEqual(parseTavily({ results: [{ title: "x" }] }), [], "no URL means no result");
  });

  it("is dispatched to by parseProvider", () => {
    assert.equal(parseProvider("tavily", payload).length, 2);
  });

  it("is preferred over the others when several keys exist", () => {
    assert.equal(SEARCH_PROVIDERS[0], "tavily");
  });
});

describe("how Tavily is called", () => {
  const req = providerRequest("tavily", "tvly-secret", '"Salon T Elle" Kinross');

  it("POSTs to Tavily's documented endpoint, never a results page", () => {
    assert.equal(req.url, "https://api.tavily.com/search");
    assert.equal(req.method, "POST");
    assert.ok(!/google|bing\.com\/search|duckduckgo/.test(req.url));
  });

  it("sends the key as a bearer token, never in the URL or query", () => {
    assert.equal(req.headers.Authorization, "Bearer tvly-secret");
    assert.ok(!req.url.includes("tvly-secret"));
    const body = JSON.parse(req.body ?? "{}");
    assert.ok(!JSON.stringify(body.query).includes("tvly-secret"));
  });

  it("asks for the page text, which is what makes Tavily worth preferring", () => {
    assert.equal(JSON.parse(req.body ?? "{}").include_raw_content, true);
  });

  it("uses the one-credit search depth and a bounded result count", () => {
    const body = JSON.parse(req.body ?? "{}");
    assert.equal(body.search_depth, "basic");
    assert.equal(body.max_results, MAX_RESULTS_PER_QUERY);
    assert.equal(body.include_answer, false);
  });

  it("still sends GET for the header-authenticated providers", () => {
    assert.equal(providerRequest("brave", "k", "q").method, "GET");
    assert.equal(providerRequest("bing", "k", "q").method, "GET");
    assert.equal(providerRequest("brave", "k", "q").body, undefined);
  });
});

describe("Tavily's own limit wording", () => {
  it("is read as quota, not as a rejected key", () => {
    for (const body of [
      "Your usage limit has been reached",
      "You have run out of credits",
      "Credits exceeded for this plan",
    ]) {
      assert.equal(classifySearchFailure(432, body).kind === "AUTH", false, body);
    }
    assert.equal(classifySearchFailure(429, "Your usage limit has been reached").kind, "QUOTA");
  });

  it("reads Tavily's non-standard 432 as quota", () => {
    // Providers do not agree on a code for this: Brave 429, Azure 403, Tavily
    // 432. Only the body works across all three.
    assert.equal(classifySearchFailure(432, "Your usage limit has been reached").kind, "QUOTA");
    assert.equal(classifySearchFailure(433, "You have run out of credits").kind, "QUOTA");
  });

  it("does not call every odd 4xx a quota problem", () => {
    assert.notEqual(classifySearchFailure(432, "Something else went wrong").kind, "QUOTA");
  });

  it("still reports a bad Tavily key as AUTH", () => {
    assert.equal(classifySearchFailure(401, '{"detail":{"error":"Invalid API key"}}').kind, "AUTH");
  });
});

describe("nameVariations", () => {
  it("keeps the name it was given first", () => {
    assert.equal(nameVariations("Clark Joinery")[0], "Clark Joinery");
  });

  it("offers the name without Ltd, which only splits the results", () => {
    const out = nameVariations("MacLeod Plumbing Ltd");
    assert.ok(out.some((name) => name === "MacLeod Plumbing"), out.join(" | "));
  });

  it("swaps & for and, in both directions", () => {
    assert.ok(nameVariations("Smith & Sons").some((n) => n === "Smith and Sons"));
    assert.ok(nameVariations("Smith and Sons").some((n) => n === "Smith & Sons"));
  });

  it("offers a spelling without apostrophes", () => {
    assert.ok(nameVariations("O'Brien's Barbers").some((n) => n === "OBriens Barbers"));
  });

  it("never repeats a spelling, and stays bounded", () => {
    const out = nameVariations("Smith & Sons Joinery Ltd");
    assert.equal(new Set(out.map((n) => n.toLowerCase())).size, out.length);
    assert.ok(out.length <= 3);
  });

  it("has nothing to say about an empty name", () => {
    assert.deepEqual(nameVariations(""), []);
    assert.deepEqual(nameVariations("   "), []);
  });
});
