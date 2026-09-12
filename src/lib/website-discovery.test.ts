import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bestWebsite,
  bestPossibleWebsite,
  candidateDomains,
  MAX_WEBSITE_CANDIDATES,
  normalisePhone,
  pageHasPhone,
  pageText,
  pageTitle,
  scoreWebsiteMatch,
  WEBSITE_MIN_SCORE,
  WEBSITE_POSSIBLE_MIN,
  detectPageCharacter,
  domainMatchesName,
  phonesOnPage,
  postcodesOnPage,
  listingClearlyMatches,
  emailsAllowedFromMatch,
  isSingleBusinessListing,
  distinctiveAddressTokens,
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
      title: "Fife Salons",
      // Long enough to be a real page: a 28-character fixture reads as an empty
      // holding page and would be rejected for that instead, which is not what
      // this test is about.
      text:
        "Fife Salons. Hairdressing in Cupar, Fife. Cuts, colour and styling for " +
        "the whole family. Walk-ins welcome six days a week. Book online or pop in.",
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
  const m = (url: string, score: number) => ({
    url,
    score,
    confidence: "STRONG" as const,
    evidence: [],
    character: "BUSINESS" as const,
  });

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

describe("possible sites — crawl for emails, never attach", () => {
  const m = (url: string, score: number, confidence: "STRONG" | "POSSIBLE" | "REJECTED" = "POSSIBLE") => ({
    url, score, confidence, evidence: [] as string[], character: "BUSINESS" as const,
  });

  it("picks the strongest POSSIBLE site", () => {
    assert.equal(bestPossibleWebsite([m("a", 60), m("b", 72), m("c", 40, "REJECTED")])?.url, "b");
    assert.ok(72 >= WEBSITE_POSSIBLE_MIN && 72 < WEBSITE_MIN_SCORE);
  });
  it("ignores STRONG sites — those go through bestWebsite", () => {
    assert.equal(bestPossibleWebsite([m("a", 90, "STRONG"), m("b", 70)])?.url, "b");
  });
  it("returns nothing when everything is rejected or strong", () => {
    assert.equal(bestPossibleWebsite([m("a", 90, "STRONG"), m("b", 40, "REJECTED")]), null);
  });
  it("allows email harvest from POSSIBLE and STRONG, never REJECTED", () => {
    assert.equal(emailsAllowedFromMatch(m("a", 80, "STRONG")), true);
    assert.equal(emailsAllowedFromMatch(m("a", 60, "POSSIBLE")), true);
    assert.equal(emailsAllowedFromMatch(m("a", 20, "REJECTED")), false);
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

describe("page character", () => {
  const chr = (url: string, title: string, text: string) => detectPageCharacter(url, title, text);
  const REAL =
    "Bespoke joinery in Perth for over twenty years. Staircases, kitchens and " +
    "fitted wardrobes. Free quotes across Perthshire.";

  it("recognises a single business's own site", () => {
    assert.equal(chr("https://clarkjoinery.co.uk", "Clark Joinery", REAL), "BUSINESS");
  });

  it("recognises a short one-page site for a sole trader as a real business", () => {
    assert.equal(chr("https://x.co.uk", "Clark Joinery", "Clark Joinery, Perth. Call 01738 445566 for a quote."), "BUSINESS");
  });

  it("recognises a site that keeps its contact details on another page", () => {
    assert.equal(
      chr("https://clarkjoinery.co.uk", "Clark Joinery - Perth",
        "Clark Joinery of Perth. Bespoke staircases, kitchens and fitted wardrobes " +
        "across Perthshire. Established 1998. Get in touch for a free quote."),
      "BUSINESS",
      "a homepage with no phone number is still a business, not a parked domain",
    );
  });

  it("recognises social profiles", () => {
    for (const host of ["facebook.com", "www.instagram.com", "linkedin.com", "x.com"]) {
      assert.equal(chr(`https://${host}/clarkjoinery`, "Clark Joinery", REAL), "SOCIAL", host);
    }
  });

  it("recognises the directories it knows by name", () => {
    for (const host of ["yell.com", "www.checkatrade.com", "freeindex.co.uk", "trustpilot.com"]) {
      assert.equal(chr(`https://${host}/x`, "Clark Joinery, Perth", REAL), "DIRECTORY", host);
    }
  });

  it("recognises a directory it has never heard of, by shape", () => {
    assert.equal(
      chr("https://sometradesite.co.uk/perth/joiners", "Joiners in Perth",
        `Clark Joinery, 22 South Street, Perth PH2 8PG. Tel 01738 445566.
         Smith Joinery, 5 Main Road, Perth PH1 2AB. Tel 01738 221100.
         Jones & Sons, 18 Kings Way, Perth PH2 0QR. Tel 01738 667788.
         Perth Woodworks, 3 Canal St, Perth PH2 8LF. Tel 01738 334455.
         Fair City Joiners, 9 Tay St, Perth PH1 5LQ. Tel 01738 889900.`),
      "DIRECTORY",
      "five businesses' contact details on one page is a list, whatever the host",
    );
  });

  it("treats result-counting language as decisive", () => {
    assert.equal(chr("https://x.co.uk", "Clark Joinery Perth", `${REAL} Showing 1-20 of 340.`), "DIRECTORY");
    assert.equal(chr("https://x.co.uk", "Joiners in Perth", `${REAL} 40 more joiners in Perth.`), "DIRECTORY");
  });

  it("recognises a parked or for-sale domain", () => {
    assert.equal(chr("https://x.co.uk", "x.co.uk", "This domain is for sale. Make an offer today."), "PARKED");
    assert.equal(chr("https://x.co.uk", "", "   "), "PARKED");
    assert.equal(chr("https://x.co.uk", "Clark Joinery", "Website coming soon. Clark Joinery of Perth."), "PARKED");
  });
});

describe("domainMatchesName", () => {
  it("matches a domain built from the business name", () => {
    assert.ok(domainMatchesName("https://clarkjoinery.co.uk", "Clark Joinery"));
    assert.ok(domainMatchesName("https://www.clark-joinery.com", "Clark Joinery Ltd"));
    assert.ok(domainMatchesName("https://clarkjoineryperth.co.uk", "Clark Joinery"));
  });

  it("does not match an unrelated domain", () => {
    assert.equal(domainMatchesName("https://tradesdirectory.co.uk", "Clark Joinery"), false);
    assert.equal(domainMatchesName("https://perthwoodcraft.co.uk", "Clark Joinery"), false);
  });

  it("ignores a domain too short to carry a name", () => {
    assert.equal(domainMatchesName("https://ab.co.uk", "Clark Joinery"), false);
  });
});

describe("identity verification — the cases that must never attach", () => {
  const clark = {
    businessName: "Clark Joinery", town: "Perth", trade: "Joinery",
    phone: "01738 445566", address: "22 South Street, Perth PH2 8PG",
  };
  const score = (url: string, title: string, text: string, kind?: "OWN_WEBSITE" | "PUBLIC_PROFILE") =>
    scoreWebsiteMatch({ url, title, text }, clark, kind ? { kind } : {});

  it("REJECTS the same name in the same town when phone and postcode contradict", () => {
    const m = score("https://clarkjoineryperth.co.uk", "Clark Joinery Perth",
      "Clark Joinery, Perth. Quality joinery throughout Perthshire for thirty years. " +
      "Call 01738 999111. 9 Mill Street, Perth PH1 9ZZ. Free estimates.");
    assert.ok(m.score < WEBSITE_MIN_SCORE, `scored ${m.score}: ${m.evidence.join("; ")}`);
    assert.ok(
      m.evidence.some((e) => /different phone/.test(e)),
      "the contradicting phone number must be counted against, not merely ignored",
    );
  });

  it("REJECTS the same name in a different town", () => {
    const m = score("https://clarkjoinery.co.uk", "Clark Joinery Dundee",
      "Clark Joinery, Dundee. Joinery and carpentry across Tayside. " +
      "Call 01382 111222. 4 Reform Street, Dundee DD1 1AA.");
    assert.ok(m.score < WEBSITE_MIN_SCORE, `scored ${m.score}: ${m.evidence.join("; ")}`);
  });

  it("REJECTS a directory listing even when every detail is right", () => {
    const m = score("https://www.yell.com/biz/clark-joinery-perth-123/", "Clark Joinery, Perth | Yell",
      "Clark Joinery, Perth. Joinery. 22 South Street, Perth PH2 8PG. Tel 01738 445566. " +
      "Read reviews and compare quotes from local joiners.");
    assert.equal(m.score, 0);
    assert.equal(m.character, "DIRECTORY");
  });

  it("REJECTS a directory the search layer flagged, whatever the page looks like", () => {
    const m = score("https://unknown-directory.example/perth", "Clark Joinery",
      "Clark Joinery, Perth PH2 8PG, 01738 445566. Bespoke joinery across Perthshire.",
      "PUBLIC_PROFILE");
    assert.equal(m.score, 0, "the caller's own classification is respected");
  });

  it("REJECTS a social profile even when every detail is right", () => {
    const m = score("https://www.facebook.com/clarkjoineryperth", "Clark Joinery | Facebook",
      "Clark Joinery, Perth. Joinery. 01738 445566. 22 South Street, Perth PH2 8PG. Bespoke work.");
    assert.equal(m.score, 0);
    assert.equal(m.character, "SOCIAL");
  });

  it("REJECTS a parked domain carrying the business name", () => {
    const m = score("https://clarkjoinery.co.uk", "Clark Joinery",
      "Clark Joinery. This domain is for sale. Perth joinery. Enquire now.");
    assert.equal(m.score, 0);
    assert.equal(m.character, "PARKED");
  });

  it("never lets name, town and trade alone reach the bar", () => {
    const m = score("https://someothersite.co.uk", "Clark Joinery",
      "Clark Joinery. Joinery in Perth. We cover the whole of Perthshire and beyond " +
      "with bespoke carpentry, staircases and fitted furniture for homes and offices.");
    assert.ok(
      m.score < WEBSITE_MIN_SCORE,
      `name + town + trade must not be enough on its own, scored ${m.score}`,
    );
  });
});

describe("identity verification — the cases that must attach", () => {
  const clark = {
    businessName: "Clark Joinery", town: "Perth", trade: "Joinery",
    phone: "01738 445566", address: "22 South Street, Perth PH2 8PG",
  };
  const score = (url: string, title: string, text: string) =>
    scoreWebsiteMatch({ url, title, text }, clark);

  it("ACCEPTS the right business on a domain bearing no resemblance to its name", () => {
    const m = score("https://perthwoodcraft.co.uk", "Perth Woodcraft - Bespoke Joinery",
      "Trading as Clark Joinery. Perth. Call 01738 445566. 22 South Street, Perth PH2 8PG. " +
      "Bespoke staircases, kitchens and fitted wardrobes across Perthshire.");
    assert.ok(m.score >= WEBSITE_MIN_SCORE, `scored ${m.score}`);
  });

  it("ACCEPTS on an exact phone match", () => {
    const m = score("https://somename.co.uk", "Joinery in Perth",
      "Perth's joinery specialists. Call 01738 445566 today. Clark Joinery has served " +
      "Perthshire for twenty years with staircases, kitchens and fitted furniture.");
    assert.ok(m.score >= WEBSITE_MIN_SCORE, `an exact phone match should carry it, scored ${m.score}`);
  });

  it("ACCEPTS on an exact postcode match plus the name", () => {
    const m = score("https://somename.co.uk", "Clark Joinery",
      "Clark Joinery. Visit us at 22 South Street, Perth PH2 8PG. Bespoke joinery, " +
      "staircases and fitted furniture made in our own workshop.");
    assert.ok(m.score >= WEBSITE_MIN_SCORE, `scored ${m.score}`);
  });

  it("ACCEPTS a matching domain plus title plus town, with no phone published", () => {
    const m = score("https://clarkjoinery.co.uk", "Clark Joinery - Perth",
      "Clark Joinery of Perth. Bespoke staircases, kitchens and fitted wardrobes across " +
      "Perthshire. Established 1998. Get in touch for a free quote on your project.");
    assert.ok(m.score >= WEBSITE_MIN_SCORE, `scored ${m.score}`);
  });

  it("handles &/and, Ltd/Limited, apostrophes and punctuation", () => {
    for (const [name, title] of [
      ["Smith & Sons Joinery", "Smith and Sons Joinery, Perth"],
      ["MacLeod Plumbing Ltd", "MacLeod Plumbing Limited - Perth"],
      ["O'Brien's Barbers", "OBriens Barbers Perth"],
      ["A.J. Clark Joinery", "AJ Clark Joinery Perth"],
    ] as const) {
      const m = scoreWebsiteMatch(
        {
          url: "https://x.co.uk",
          title,
          text: `${title}. Serving Perth and Perthshire. Call 01738 445566 for a free quote on any job.`,
        },
        { ...clark, businessName: name },
      );
      assert.ok(m.score >= WEBSITE_MIN_SCORE, `${name} vs ${title} scored ${m.score}`);
    }
  });
});

describe("reading contact details off a page", () => {
  it("finds every UK phone number printed", () => {
    const phones = phonesOnPage("Call 01738 445566 or 0131 555 1234, mobile 07700 900123.");
    assert.ok(phones.includes("01738445566"));
    assert.ok(phones.includes("01315551234"));
    assert.equal(phones.length, 3);
  });

  it("finds every UK postcode printed", () => {
    const codes = postcodesOnPage("Perth PH2 8PG and Dundee DD1 1AA and London EC1A 1BB");
    assert.deepEqual(codes.sort(), ["DD11AA", "EC1A1BB", "PH28PG"]);
  });

  it("reports nothing rather than nonsense on a page with neither", () => {
    assert.deepEqual(phonesOnPage("We are open six days a week."), []);
    assert.deepEqual(postcodesOnPage("We are open six days a week."), []);
  });
});

describe("search snippet as corroboration, not as a free pass", () => {
  const clark = {
    businessName: "Clark Joinery", town: "Perth", trade: "Joinery",
    phone: "01738 445566", address: "22 South Street, Perth PH2 8PG",
  };

  it("ACCEPTS a homepage whose search snippet carries the listing phone", () => {
    const m = scoreWebsiteMatch(
      {
        url: "https://perthwoodcraft.co.uk",
        title: "Perth Woodcraft",
        text: "Clark Joinery of Perth. Bespoke staircases, kitchens and fitted wardrobes across Perthshire for twenty years.",
        extraText: "Clark Joinery Perth. Tel 01738 445566.",
      },
      clark,
    );
    assert.ok(m.score >= WEBSITE_MIN_SCORE, `scored ${m.score}: ${m.evidence.join("; ")}`);
    assert.ok(m.evidence.some((e) => /search listing/.test(e)));
  });

  it("does NOT let a snippet phone override a different number printed on the page", () => {
    const m = scoreWebsiteMatch(
      {
        url: "https://clarkjoinerydundee.co.uk",
        title: "Clark Joinery Dundee",
        text: "Clark Joinery, Dundee. Call 01382 111222. 4 Reform Street, Dundee DD1 1AA. Joinery across Tayside.",
        extraText: "Clark Joinery. Tel 01738 445566.",
      },
      clark,
    );
    assert.ok(m.score < WEBSITE_MIN_SCORE, `scored ${m.score}: ${m.evidence.join("; ")}`);
    assert.ok(m.evidence.some((e) => /different phone/.test(e)));
  });
});

describe("directory listings as email sources, never as websites", () => {
  const clark = {
    businessName: "Clark Joinery", town: "Perth", trade: "Joinery",
    phone: "01738 445566", address: "22 South Street, Perth PH2 8PG",
  };

  it("recognises a single listing that carries this business's phone", () => {
    const text = "Clark Joinery, Perth. 22 South Street PH2 8PG. Tel 01738 445566. info@clarkjoinery.co.uk";
    assert.equal(listingClearlyMatches(text, clark), true);
    assert.equal(isSingleBusinessListing(text), true);
  });

  it("rejects a list of many businesses even when ours is among them", () => {
    const text =
      "Clark Joinery 01738 445566 PH2 8PG. Smith Joinery 01738 221100 PH1 2AB. " +
      "Jones Joinery 01738 667788 PH2 0QR. Perth Woodworks 01738 334455 PH2 8LF.";
    assert.equal(isSingleBusinessListing(text), false);
  });

  it("rejects a listing that only shares a name", () => {
    assert.equal(
      listingClearlyMatches("Clark Joinery of Dundee. Call 01382 111222.", clark),
      false,
    );
  });
});

describe("distinctive address tokens", () => {
  it("keeps a rare street name", () => {
    assert.ok(distinctiveAddressTokens("12 Bonnygate, Cupar, KY15 4BU", "Cupar").includes("bonnygate"));
  });
  it("drops High / South / Street", () => {
    assert.deepEqual(distinctiveAddressTokens("22 South Street, Perth PH2 8PG", "Perth"), []);
  });
});
