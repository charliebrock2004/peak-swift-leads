import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQueries,
  candidatesFromResults,
  looksLikeOwnWebsite,
  looksLikePublicProfile,
  MAX_SEARCHES_PER_LEAD,
  parseBing,
  parseBrave,
  parseProvider,
  providerRequest,
  type SearchResult,
} from "./search-provider.ts";

const cuttingEdge = {
  businessName: "Cutting Edge", town: "Cupar", trade: "Hairdresser",
  phone: "01334 652000", address: "12 Bonnygate, Cupar, KY15 4BU",
};

describe("what gets searched for", () => {
  it("quotes the business name so the town does not dissolve it", () => {
    assert.ok(buildQueries(cuttingEdge)[0].text.startsWith('"Cutting Edge"'));
  });
  it("pins the business with its town", () => {
    assert.ok(buildQueries(cuttingEdge).every((q) => q.text.includes("Cupar")));
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
