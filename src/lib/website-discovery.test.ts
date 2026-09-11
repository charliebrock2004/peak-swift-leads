import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bestWebsite,
  candidateDomains,
  MAX_WEBSITE_CANDIDATES,
  normalisePhone,
  pageHasPhone,
  pageText,
  pageTitle,
  scoreWebsiteMatch,
  WEBSITE_MIN_SCORE,
} from "./website-discovery.ts";

const cuttingEdge = {
  businessName: "Cutting Edge", town: "Cupar", trade: "Hairdresser", phone: "01334 652000",
};

describe("guessing where to look", () => {
  it("builds plausible hostnames from the business name", () => {
    const domains = candidateDomains("Cutting Edge", "Cupar", "Hairdresser");
    assert.ok(domains.includes("cuttingedge.co.uk"));
    assert.ok(domains.length <= MAX_WEBSITE_CANDIDATES);
  });

  it("tries the UK domain of every stem before any .com", () => {
    const domains = candidateDomains("Cutting Edge", "Cupar", "Hairdresser");
    const firstCom = domains.findIndex((d) => d.endsWith(".com"));
    const lastUk = domains.map((d) => d.endsWith(".co.uk")).lastIndexOf(true);
    if (firstCom !== -1) assert.ok(lastUk < firstCom, domains.join(", "));
  });

  it("drops company suffixes that carry no identity", () => {
    assert.ok(candidateDomains("Strathearn Joinery Ltd", "Crieff", "Joiner").includes("strathearnjoinery.co.uk"));
  });

  it("tries a town-qualified and a trade-qualified form", () => {
    const domains = candidateDomains("Cutting Edge", "Cupar", "Hairdresser", 12);
    assert.ok(domains.some((d) => d.includes("cupar")));
    assert.ok(domains.some((d) => /hair|salon/.test(d)));
  });

  it("refuses to guess from a name too short to identify anything", () => {
    assert.deepEqual(candidateDomains("A&B", "Cupar", "Hairdresser"), []);
    assert.deepEqual(candidateDomains("", "Cupar", "Hairdresser"), []);
    assert.deepEqual(candidateDomains("Ltd", "Cupar", ""), []);
  });

  it("stays inside its budget", () => {
    assert.ok(candidateDomains("Gary Wightman Hairdressing Salon", "Dundee", "Hairdresser").length <= MAX_WEBSITE_CANDIDATES);
  });
});

describe("phone numbers as identity", () => {
  it("compares numbers regardless of spacing or country code", () => {
    assert.equal(normalisePhone("+44 1334 652000"), "01334652000");
    assert.equal(normalisePhone("01334 652000"), "01334652000");
    assert.equal(normalisePhone("(01334) 652-000"), "01334652000");
  });
  it("spots the number on a page however it is written", () => {
    for (const written of ["01334 652000", "01334652000", "+44 1334 652000", "Tel: 01334 652 000"]) {
      assert.ok(pageHasPhone(written, "01334 652000"), written);
    }
  });
  it("does not match a different number", () => {
    assert.equal(pageHasPhone("01577 863000", "01334 652000"), false);
  });
  it("ignores a number too short to identify anyone", () => {
    assert.equal(pageHasPhone("12345", "1234"), false);
  });
});

describe("deciding whether a page is the right business", () => {
  const page = (over: Partial<{ url: string; text: string; title: string }> = {}) => ({
    url: "https://cuttingedge.co.uk", text: "", title: "", ...over,
  });

  it("accepts a page carrying the listing's phone number", () => {
    const m = scoreWebsiteMatch(page({
      title: "Cutting Edge Hair", text: "Cutting Edge, Cupar. Call 01334 652000 for an appointment.",
    }), cuttingEdge);
    assert.equal(m.confidence, "STRONG");
    assert.ok(m.score >= WEBSITE_MIN_SCORE);
    assert.ok(m.evidence.some((e) => /phone number/.test(e)));
  });

  it("accepts a page whose title is the business, in the right town", () => {
    const m = scoreWebsiteMatch(page({
      title: "Cutting Edge", text: "Hairdressing in Cupar, Fife. Book online.",
    }), cuttingEdge);
    assert.ok(m.score >= WEBSITE_MIN_SCORE, `scored ${m.score}`);
  });

  it("REJECTS the same business name in a different town", () => {
    // The whole risk: "Cutting Edge" is a hairdresser in a dozen towns, and
    // attaching the wrong one produces a confident, evidenced, wrong address.
    const m = scoreWebsiteMatch(page({
      title: "Cutting Edge", text: "Cutting Edge hairdressers, Inverness. Call 01463 200000.",
    }), cuttingEdge);
    assert.notEqual(m.confidence, "STRONG");
    assert.ok(m.score < WEBSITE_MIN_SCORE, `scored ${m.score}`);
  });

  it("REJECTS a parked or unrelated page", () => {
    for (const text of [
      "This domain is for sale. Buy this domain.",
      "Welcome to WordPress. This is your first post.",
      "Cupar hairdressers directory. Find a salon near you.",
    ]) {
      const m = scoreWebsiteMatch(page({ text, title: "" }), cuttingEdge);
      assert.notEqual(m.confidence, "STRONG", text);
    }
  });

  it("REJECTS a page that never names the business, however much else matches", () => {
    const m = scoreWebsiteMatch(page({
      title: "Fife Salons", text: "Hairdressing in Cupar, Fife.",
    }), cuttingEdge);
    assert.ok(m.score < WEBSITE_MIN_SCORE, `scored ${m.score}`);
    assert.ok(m.evidence.some((e) => /largely absent/.test(e)));
  });

  it("never lets town and trade alone carry a candidate", () => {
    const m = scoreWebsiteMatch(page({ title: "", text: "Cupar hairdresser" }), cuttingEdge);
    assert.ok(m.score < WEBSITE_MIN_SCORE);
  });

  it("records why it decided, every time", () => {
    assert.ok(scoreWebsiteMatch(page({ title: "Cutting Edge", text: "Cupar 01334 652000" }), cuttingEdge).evidence.length > 0);
  });
});

describe("choosing between candidates", () => {
  const m = (url: string, score: number) => ({ url, score, confidence: "STRONG" as const, evidence: [] });

  it("takes the strongest that clears the bar", () => {
    assert.equal(bestWebsite([m("a", 80), m("b", 95), m("c", 76)])?.url, "b");
  });
  it("returns nothing when none clears the bar", () => {
    assert.equal(bestWebsite([m("a", 74), m("b", 40)]), null);
  });
  it("returns nothing from an empty field", () => {
    assert.equal(bestWebsite([]), null);
  });
});

describe("reading a page", () => {
  it("strips markup, scripts and styles", () => {
    const text = pageText(`<script>var a="x@y.test"</script><style>p{}</style><h1>Cutting Edge</h1><p>Cupar</p>`);
    assert.ok(text.includes("Cutting Edge"));
    assert.ok(text.includes("Cupar"));
    assert.ok(!text.includes("var a"));
  });
  it("reads the title", () => {
    assert.equal(pageTitle(`<title>  Cutting Edge  </title>`), "Cutting Edge");
    assert.equal(pageTitle(`<html></html>`), "");
  });
});
