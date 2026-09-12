/**
 * Regression fixtures for the email-discovery pipeline.
 *
 * Pure: no network. Each case is a page (or listing) we already fetched, run
 * through extract → score → decide, plus the identity check that decides
 * whether a page is this business at all. The Bolton run's 6/33 miss is what
 * these pin down: a public address that exists on a contact page, a footer, a
 * Cloudflare-protected span, or a matching Yell listing must be FOUND; a
 * competitor, a guessed info@, and a directory-of-many must not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decide,
  extractCandidates,
  rankCandidates,
  scoreCandidate,
  type EmailCandidate,
} from "./email-discovery.ts";
import {
  emailsAllowedFromMatch,
  isSingleBusinessListing,
  listingClearlyMatches,
  scoreWebsiteMatch,
  WEBSITE_MIN_SCORE,
  type BusinessIdentity,
} from "./website-discovery.ts";
import { discoveredWebsitePatch } from "./qualify.ts";
import { createLead } from "./leads.ts";

const clark: BusinessIdentity = {
  businessName: "Clark Joinery",
  town: "Bolton",
  trade: "Joiner",
  phone: "01204 555111",
  address: "14 Fold Street, Bolton BL1 2RX",
};

const ctx = { websiteUrl: "https://clarkjoinery.co.uk", businessName: "Clark Joinery" };

function harvest(html: string, url: string, source: EmailCandidate["source"] = "OFFICIAL_WEBSITE") {
  return extractCandidates(html, url, source);
}

function verdict(candidates: EmailCandidate[], websiteUrl = ctx.websiteUrl) {
  return decide({
    candidates,
    context: { websiteUrl, businessName: clark.businessName },
    sourcesChecked: [websiteUrl],
    attempts: 2,
    sawContactPage: true,
  });
}

describe("realistic UK trade pages — addresses that must be found", () => {
  it("1. email on the homepage", () => {
    const html = `<h1>Clark Joinery</h1><p>Email info@clarkjoinery.co.uk for a quote.</p>`;
    const r = verdict(harvest(html, "https://clarkjoinery.co.uk/"));
    assert.equal(r.status, "FOUND");
    assert.equal(r.email, "info@clarkjoinery.co.uk");
    assert.equal(r.confidence, "HIGH");
  });

  it("2. email only on the contact page", () => {
    const home = harvest(`<h1>Clark Joinery Bolton</h1><a href="/contact">Contact</a>`, "https://clarkjoinery.co.uk/");
    assert.equal(home.length, 0);
    const contact = harvest(
      `<h1>Contact</h1><a href="mailto:hello@clarkjoinery.co.uk">email</a>`,
      "https://clarkjoinery.co.uk/contact",
      "OFFICIAL_CONTACT_PAGE",
    );
    const r = verdict(contact);
    assert.equal(r.status, "FOUND");
    assert.equal(r.email, "hello@clarkjoinery.co.uk");
    assert.equal(r.source, "OFFICIAL_CONTACT_PAGE");
  });

  it("3. email only in the footer", () => {
    const html = `<h1>Clark Joinery</h1><footer>Clark Joinery · office@clarkjoinery.co.uk · Bolton</footer>`;
    assert.equal(verdict(harvest(html, "https://clarkjoinery.co.uk/")).email, "office@clarkjoinery.co.uk");
  });

  it("4. mailto link", () => {
    const found = harvest(`<a href="mailto:quotes@clarkjoinery.co.uk">Get a quote</a>`, "https://clarkjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE");
    assert.equal(found[0]?.method, "MAILTO_LINK");
    assert.equal(verdict(found).confidence, "HIGH");
  });

  it("5. obfuscated [at]/[dot]", () => {
    const html = `<p>Write to info [at] clarkjoinery [dot] co.uk</p>`;
    assert.equal(verdict(harvest(html, "https://clarkjoinery.co.uk/")).email, "info@clarkjoinery.co.uk");
  });

  it("6. JSON-LD", () => {
    const html = `<script type="application/ld+json">{"@type":"LocalBusiness","email":"info@clarkjoinery.co.uk"}</script>`;
    const found = harvest(html, "https://clarkjoinery.co.uk/");
    assert.equal(found[0]?.method, "JSON_LD");
    assert.equal(verdict(found).email, "info@clarkjoinery.co.uk");
  });

  it("7. privacy page", () => {
    const html = `<h1>Privacy</h1><p>Questions: privacy is not a mailbox, write to office@clarkjoinery.co.uk</p>`;
    const r = verdict(harvest(html, "https://clarkjoinery.co.uk/privacy", "OFFICIAL_CONTACT_PAGE"));
    assert.equal(r.email, "office@clarkjoinery.co.uk");
  });

  it("8. Gmail business address published on the contact page", () => {
    const found = harvest(
      `<a href="mailto:clarkjoinerybolton@gmail.com">email</a>`,
      "https://clarkjoinery.co.uk/contact",
      "OFFICIAL_CONTACT_PAGE",
    );
    const r = verdict(found);
    assert.equal(r.status, "FOUND");
    assert.notEqual(r.confidence, "LOW");
    assert.equal(r.email, "clarkjoinerybolton@gmail.com");
  });

  it("9. Outlook / Hotmail business address on the site", () => {
    const found = harvest(
      `<p>clark.joinery@hotmail.co.uk</p>`,
      "https://clarkjoinery.co.uk/contact",
      "OFFICIAL_CONTACT_PAGE",
    );
    const r = verdict(found);
    assert.equal(r.status, "FOUND");
    assert.equal(r.email, "clark.joinery@hotmail.co.uk");
  });

  it("10. domain email on a discovered site (context.websiteUrl updated)", () => {
    // The Bolton bug: listing URL was empty or a directory, so a real .co.uk
    // address was penalised as "different domain" and could drop to LOW.
    const found = harvest(`<p>info@clarkjoinery.co.uk</p>`, "https://clarkjoinery.co.uk/");
    const withSite = verdict(found, "https://clarkjoinery.co.uk");
    const withYell = verdict(found, "https://www.yell.com/biz/clark-joinery-bolton");
    assert.equal(withSite.confidence, "HIGH");
    assert.ok(withSite.score! > withYell.score!, "a directory URL must not penalise the real domain");
  });
});

describe("directories, social, competitors — what must not be trusted", () => {
  it("11. directory-only email on a listing that matches this business is MEDIUM", () => {
    const listing = "Clark Joinery, Bolton. 14 Fold Street BL1 2RX. Tel 01204 555111. info@clarkjoinery.co.uk";
    assert.equal(listingClearlyMatches(listing, clark), true);
    assert.equal(isSingleBusinessListing(listing), true);
    const found = harvest(`<p>${listing}</p>`, "https://www.yell.com/biz/clark-joinery", "PUBLIC_DIRECTORY");
    const r = verdict(found, "");
    assert.equal(r.status, "FOUND");
    assert.equal(r.confidence, "MEDIUM");
    assert.equal(r.email, "info@clarkjoinery.co.uk");
  });

  it("12. social-profile email on a matching listing is usable, not HIGH", () => {
    const text = "Clark Joinery Bolton. Tel 01204 555111. clarkjoinerybolton@gmail.com";
    assert.equal(listingClearlyMatches(text, clark), true);
    const found = harvest(`<p>${text}</p>`, "https://facebook.com/clarkjoinerybolton", "PUBLIC_BUSINESS_PROFILE");
    const r = verdict(found, "");
    assert.notEqual(r.status, "NOT_FOUND");
    assert.notEqual(r.confidence, "HIGH");
  });

  it("13. unrelated directory email is LOW / not sent", () => {
    const found = harvest(
      `<p>Some other firm. info@unrelated-roofing.co.uk</p>`,
      "https://www.yell.com/biz/other",
      "PUBLIC_DIRECTORY",
    );
    const r = verdict(found, "https://clarkjoinery.co.uk");
    assert.notEqual(r.confidence, "HIGH");
    assert.equal(r.nextAction, "CALL");
  });

  it("14. unrelated website is REJECTED, so its emails are not harvested", () => {
    const match = scoreWebsiteMatch(
      {
        url: "https://smithroofing.co.uk",
        title: "Smith Roofing Bolton",
        text: "Smith Roofing, Bolton. Call 01204 999000. 8 Deansgate, Bolton BL1 1AA. Roofing across Greater Manchester.",
      },
      clark,
    );
    assert.equal(emailsAllowedFromMatch(match), false);
    assert.ok(match.score < WEBSITE_MIN_SCORE);
  });

  it("15. same name, different town, different phone — competitor, not this business", () => {
    const match = scoreWebsiteMatch(
      {
        url: "https://clarkjoinery.co.uk",
        title: "Clark Joinery Preston",
        text: "Clark Joinery, Preston. Call 01772 111222. 4 Fishergate, Preston PR1 2AB. Bespoke joinery across Lancashire.",
      },
      clark,
    );
    assert.ok(match.score < WEBSITE_MIN_SCORE, `scored ${match.score}`);
    assert.ok(match.evidence.some((e) => /different phone/.test(e)));
  });

  it("16. example/demo emails on a template are dropped", () => {
    const found = harvest(
      `<p>Replace this with your@email.com and info@example.com</p><img alt="logo@2x.png">`,
      "https://clarkjoinery.co.uk/",
    );
    assert.equal(found.length, 0);
  });

  it("17. multiple emails — role mailbox on the own domain wins", () => {
    const html = `<a href="mailto:dave@clarkjoinery.co.uk">Dave</a><a href="mailto:info@clarkjoinery.co.uk">Info</a>`;
    const ranked = rankCandidates(harvest(html, "https://clarkjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE"), ctx);
    assert.equal(ranked[0].email, "info@clarkjoinery.co.uk");
    assert.ok(ranked.length >= 2);
  });

  it("18. duplicate emails recorded once, at the strongest sighting", () => {
    const html = `<p>info@clarkjoinery.co.uk</p><a href="mailto:info@clarkjoinery.co.uk">mail</a>`;
    const found = harvest(html, "https://clarkjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE");
    assert.equal(found.length, 1);
    assert.equal(found[0].method, "MAILTO_LINK");
  });

  it("19. malformed addresses are ignored", () => {
    const found = harvest(`<p>write to info@ or hello@@clarkjoinery or not-an-email</p>`, "https://clarkjoinery.co.uk/");
    assert.equal(found.length, 0);
  });

  it("20. no email anywhere → NOT_FOUND, never a guessed info@", () => {
    const html = `<h1>Clark Joinery</h1><p>Call 01204 555111. Fold Street, Bolton. Free quotes.</p>`;
    const r = verdict(harvest(html, "https://clarkjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE"));
    assert.equal(r.status, "NOT_FOUND");
    assert.equal(r.email, null);
    assert.equal(r.reason, "CONTACT_PAGE_NO_EMAIL");
    assert.equal(r.nextAction, "CALL");
  });
});

describe("the Bolton miss — possible site, phone on the contact page", () => {
  it("a homepage without a phone stays POSSIBLE until contact details are folded in", () => {
    const home = scoreWebsiteMatch(
      {
        url: "https://boltonbespoke.co.uk",
        title: "Clark Joinery - Bolton",
        text: "Clark Joinery of Bolton. Bespoke kitchens, staircases and fitted furniture across Greater Manchester. Get in touch for a free quote.",
      },
      clark,
    );
    assert.equal(home.confidence, "POSSIBLE");
    assert.equal(emailsAllowedFromMatch(home), true, "still worth crawling for an address");

    const combined = scoreWebsiteMatch(
      {
        url: "https://boltonbespoke.co.uk",
        title: "Clark Joinery - Bolton",
        text:
          "Clark Joinery of Bolton. Bespoke kitchens, staircases and fitted furniture. " +
          "Call 01204 555111. 14 Fold Street, Bolton BL1 2RX. Email info@clarkjoinery.co.uk",
      },
      clark,
    );
    assert.equal(combined.confidence, "STRONG");
    assert.ok(combined.score >= WEBSITE_MIN_SCORE);
  });

  it("a search snippet carrying the listing phone makes the same homepage STRONG", () => {
    const m = scoreWebsiteMatch(
      {
        url: "https://clarkjoinery.co.uk",
        title: "Clark Joinery - Bolton",
        text: "Clark Joinery of Bolton. Bespoke kitchens, staircases and fitted furniture across Greater Manchester. Get in touch for a free quote.",
        extraText: "Clark Joinery Bolton. 01204 555111. Fold Street BL1 2RX.",
      },
      clark,
    );
    assert.equal(m.confidence, "STRONG");
  });

  it("NEVER stores info@ just because the domain was found", () => {
    const guessed = "info@clarkjoinery.co.uk";
    const page = `<h1>Clark Joinery</h1><p>Call 01204 555111</p>`;
    const found = harvest(page, "https://clarkjoinery.co.uk/");
    assert.ok(!found.some((c) => c.email === guessed));
    assert.equal(verdict(found).email, null);
  });
});

describe("persisting a discovered website", () => {
  it("fills an empty website from a STRONG match", () => {
    const lead = createLead({ businessName: "Clark Joinery", website: "", websiteStatus: "No Website Found" });
    const patch = discoveredWebsitePatch(lead, {
      url: "https://clarkjoinery.co.uk",
      confidence: "STRONG",
      character: "BUSINESS",
    });
    assert.equal(patch.website, "https://clarkjoinery.co.uk");
    assert.equal(patch.websiteStatus, "Proper Website");
  });

  it("replaces a directory listing with a STRONG own site", () => {
    const lead = createLead({
      website: "https://www.yell.com/biz/clark-joinery",
      websiteStatus: "Directory Only",
    });
    const patch = discoveredWebsitePatch(lead, {
      url: "https://clarkjoinery.co.uk",
      confidence: "STRONG",
      character: "BUSINESS",
    });
    assert.equal(patch.website, "https://clarkjoinery.co.uk");
  });

  it("does not overwrite a proper website the lead already has", () => {
    const lead = createLead({ website: "https://already.co.uk", websiteStatus: "Proper Website" });
    const patch = discoveredWebsitePatch(lead, {
      url: "https://clarkjoinery.co.uk",
      confidence: "STRONG",
      character: "BUSINESS",
    });
    assert.deepEqual(patch, {});
  });

  it("does not persist a POSSIBLE or directory match", () => {
    const lead = createLead({ website: "" });
    assert.deepEqual(
      discoveredWebsitePatch(lead, { url: "https://clarkjoinery.co.uk", confidence: "POSSIBLE", character: "BUSINESS" }),
      {},
    );
    assert.deepEqual(
      discoveredWebsitePatch(lead, { url: "https://www.yell.com/x", confidence: "STRONG", character: "DIRECTORY" }),
      {},
    );
  });
});

describe("other trades — same engine, different names", () => {
  const cases: { identity: BusinessIdentity; url: string; html: string; email: string }[] = [
    {
      identity: { businessName: "Peak Roofing", town: "Bolton", trade: "Roofer", phone: "01204 111222", address: "BL1 1AA" },
      url: "https://peakroofing.co.uk",
      html: `<a href="mailto:info@peakroofing.co.uk">email</a>`,
      email: "info@peakroofing.co.uk",
    },
    {
      identity: { businessName: "Aqueduct Plumbing", town: "Crieff", trade: "Plumber", phone: "01764 650111", address: "PH7 3AA" },
      url: "https://aqueductplumbing.co.uk",
      html: `<p>enquiries@aqueductplumbing.co.uk</p>`,
      email: "enquiries@aqueductplumbing.co.uk",
    },
    {
      identity: { businessName: "Tay Electrical", town: "Perth", trade: "Electrician", phone: "01738 445000", address: "PH2 8PG" },
      url: "https://tayelectrical.co.uk",
      html: `<script type="application/ld+json">{"email":"office@tayelectrical.co.uk"}</script>`,
      email: "office@tayelectrical.co.uk",
    },
  ];

  for (const fixture of cases) {
    it(`finds the published address for ${fixture.identity.businessName}`, () => {
      const found = harvest(fixture.html, fixture.url, "OFFICIAL_CONTACT_PAGE");
      const r = decide({
        candidates: found,
        context: { websiteUrl: fixture.url, businessName: fixture.identity.businessName },
        sourcesChecked: [fixture.url],
        attempts: 1,
        sawContactPage: true,
      });
      assert.equal(r.email, fixture.email);
      assert.equal(r.status, "FOUND");
    });
  }
});

describe("scoring sanity", () => {
  it("a contact-page mailto on the own domain is HIGH", () => {
    const s = scoreCandidate(
      {
        email: "info@clarkjoinery.co.uk",
        source: "OFFICIAL_CONTACT_PAGE",
        sourceUrl: "https://clarkjoinery.co.uk/contact",
        method: "MAILTO_LINK",
        evidence: "",
      },
      ctx,
    );
    assert.equal(s.confidence, "HIGH");
  });

  it("a directory page-text address without a domain match is MEDIUM when the listing matched", () => {
    const s = scoreCandidate(
      {
        email: "info@clarkjoinery.co.uk",
        source: "PUBLIC_DIRECTORY",
        sourceUrl: "https://www.yell.com/biz/clark",
        method: "PAGE_TEXT",
        evidence: "",
      },
      { websiteUrl: "", businessName: "Clark Joinery" },
    );
    assert.equal(s.confidence, "MEDIUM");
  });
});
