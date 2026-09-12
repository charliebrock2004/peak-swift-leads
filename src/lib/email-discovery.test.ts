import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANDIDATE_PATHS,
  contactLinks,
  decide,
  deobfuscate,
  decodeCfEmail,
  extractCandidates,
  looksUsable,
  noWebsiteResult,
  rankCandidates,
  scoreCandidate,
  sitemapContactUrls,
  sitemapIndexUrls,
  bestSource,
  biggestBottleneck,
  discoveryIsFresh,
  emptyTally,
  REASON_LABELS,
  tallyDiscovery,
  type DiscoveryResult,
  type EmailCandidate,
  joinScriptLiterals,
} from "./email-discovery.ts";

const ctx = { websiteUrl: "https://strathearnjoinery.co.uk", businessName: "Strathearn Joinery Ltd" };
const emails = (html: string, url = "https://strathearnjoinery.co.uk/") =>
  extractCandidates(html, url, "OFFICIAL_WEBSITE").map((c) => c.email);

describe("finding an address on a page", () => {
  it("reads a mailto link", () => {
    const found = extractCandidates(
      `<a href="mailto:info@strathearnjoinery.co.uk">Email</a>`, "https://x.test/", "OFFICIAL_WEBSITE");
    assert.equal(found[0].email, "info@strathearnjoinery.co.uk");
    assert.equal(found[0].method, "MAILTO_LINK");
  });

  it("reads a mailto with a subject parameter", () => {
    assert.deepEqual(
      emails(`<a href="mailto:info@strathearnjoinery.co.uk?subject=Quote">Email</a>`),
      ["info@strathearnjoinery.co.uk"]);
  });

  it("reads plain text in the page body", () => {
    assert.deepEqual(emails(`<p>Email hello@strathearnjoinery.co.uk today</p>`), ["hello@strathearnjoinery.co.uk"]);
  });

  it("reads a footer address", () => {
    assert.deepEqual(emails(`<footer>2026 &middot; office@strathearnjoinery.co.uk</footer>`), ["office@strathearnjoinery.co.uk"]);
  });

  it("reads JSON-LD structured data", () => {
    const found = extractCandidates(
      `<script type="application/ld+json">{"@type":"LocalBusiness","email":"info@a.test"}</script>`,
      "https://a.test/", "OFFICIAL_WEBSITE");
    assert.equal(found[0].email, "info@a.test");
    assert.equal(found[0].method, "JSON_LD");
    assert.equal(found[0].source, "STRUCTURED_DATA");
  });

  it("reads a meta tag", () => {
    const found = extractCandidates(`<meta name="contact:email" content="info@a.test">`, "https://a.test/", "OFFICIAL_WEBSITE");
    assert.equal(found[0].method, "META_TAG");
  });

  it("reads an inline script payload, the JavaScript-site fallback", () => {
    const found = extractCandidates(
      `<div id="root"></div><script>window.__DATA__={"email":"studio@a.test"}</script>`,
      "https://a.test/", "OFFICIAL_WEBSITE");
    assert.equal(found[0].email, "studio@a.test");
    assert.equal(found[0].method, "INLINE_PAYLOAD");
  });

  it("prefers the mailto record when one address appears twice", () => {
    const found = extractCandidates(
      `<p>info@a.test</p><a href="mailto:info@a.test">m</a>`, "https://a.test/", "OFFICIAL_WEBSITE");
    assert.equal(found.length, 1, "the same address is recorded once");
    assert.equal(found[0].method, "MAILTO_LINK", "recorded by its strongest sighting");
  });

  it("keeps several distinct addresses", () => {
    assert.equal(emails(`<a href="mailto:info@a.test">a</a><a href="mailto:dave@a.test">b</a>`).length, 2);
  });
});

describe("obfuscated addresses", () => {
  it("decodes [at] and [dot]", () => {
    assert.equal(deobfuscate("info [at] example [dot] co.uk"), "info@example.co.uk");
  });
  it("decodes (at) and (dot)", () => {
    assert.equal(deobfuscate("office(at)example(dot)co(dot)uk"), "office@example.co.uk");
  });
  it("decodes spaced words", () => {
    assert.equal(deobfuscate("info at example dot co.uk"), "info@example.co.uk");
  });
  it("decodes HTML entities", () => {
    assert.equal(deobfuscate("info&#64;example&#46;co.uk"), "info@example.co.uk");
  });
  it("finds an obfuscated address in a page", () => {
    const found = extractCandidates(`<p>info [at] a [dot] test</p>`, "https://a.test/", "OFFICIAL_WEBSITE");
    assert.equal(found[0].email, "info@a.test");
    assert.equal(found[0].method, "DEOBFUSCATED");
  });
  it("does not invent an address from text with no local part", () => {
    assert.equal(emails(`<p>email us at example dot com</p>`).length, 0);
  });
});

describe("what is never treated as a business address", () => {
  it("rejects platform and tooling noise", () => {
    for (const bad of ["noreply@wixpress.com", "sentry@sentry.io", "x@example.com", "a@schema.org", "b@googleapis.com"]) {
      assert.equal(looksUsable(bad), false, `${bad} should be rejected`);
    }
  });
  it("rejects filenames that look like addresses", () => {
    for (const bad of ["logo@2x.png", "icon@3x.jpg", "sprite@2x.svg"]) {
      assert.equal(looksUsable(bad), false, bad);
    }
  });
  it("rejects disposable mailboxes", () => {
    assert.equal(looksUsable("a@mailinator.com"), false);
    assert.equal(looksUsable("b@guerrillamail.com"), false);
  });
  it("rejects placeholder and no-reply mailboxes", () => {
    for (const bad of ["noreply@a.test", "no-reply@a.test", "postmaster@a.test", "your@a.test", "username@a.test"]) {
      assert.equal(looksUsable(bad), false, bad);
    }
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["a@", "@a.test", "a@b", "a@.test", "a@b..test", "a b@c.test"]) {
      assert.equal(looksUsable(bad), false, bad);
    }
  });
  it("accepts an ordinary business address", () => {
    assert.ok(looksUsable("info@strathearnjoinery.co.uk"));
    assert.ok(looksUsable("first.last+tag@a.test"));
  });
  it("picks nothing at all out of a page of noise", () => {
    const html = `<link href="https://fonts.googleapis.com/x"><p>noreply@wixpress.com logo@2x.png</p>`;
    assert.deepEqual(emails(html), []);
  });
});

describe("following the site", () => {
  const page = `
    <a href="/contact">Contact</a>
    <a href="/about-us">About</a>
    <a href="/request-a-quote">Quote</a>
    <a href="mailto:x@a.test">mail</a>
    <a href="https://facebook.com/x/contact">fb</a>
    <a href="/">Home</a>`;

  it("follows contact, about and quote links", () => {
    const links = contactLinks(page, "https://a.test/");
    assert.ok(links.some((l) => l.endsWith("/contact")));
    assert.ok(links.some((l) => l.endsWith("/about-us")));
    assert.ok(links.some((l) => l.endsWith("/request-a-quote")));
  });
  it("puts the contact page first", () => {
    assert.ok(contactLinks(page, "https://a.test/")[0].endsWith("/contact"));
  });
  it("never leaves the site or follows mailto", () => {
    const links = contactLinks(page, "https://a.test/");
    assert.ok(links.every((l) => l.startsWith("https://a.test")));
    assert.ok(!links.some((l) => l.includes("mailto")));
  });
  it("resolves relative links against the page", () => {
    assert.deepEqual(contactLinks(`<a href="contact-us">c</a>`, "https://a.test/pages/"),
      ["https://a.test/pages/contact-us"]);
  });
  it("ignores the homepage link", () => {
    assert.deepEqual(contactLinks(`<a href="/">Contact home</a>`, "https://a.test/"), []);
  });
  it("covers the paths a small site actually uses", () => {
    for (const p of [
      "/contact", "/contact-us", "/about", "/about-us", "/get-in-touch",
      "/request-a-quote", "/team", "/find-us", "/our-team", "/privacy",
      "/privacy-policy", "/terms", "/legal",
    ]) {
      assert.ok(CANDIDATE_PATHS.includes(p as never), `${p} should be probed`);
    }
  });
});

describe("sitemaps", () => {
  const xml = `<urlset>
    <url><loc>https://a.test/</loc></url>
    <url><loc>https://a.test/blog/post</loc></url>
    <url><loc>https://a.test/about</loc></url>
    <url><loc>https://a.test/contact</loc></url>
    <url><loc>https://other.test/contact</loc></url>
  </urlset>`;
  it("picks only contact-ish URLs, contact first", () => {
    const urls = sitemapContactUrls(xml, "https://a.test");
    assert.equal(urls[0], "https://a.test/contact");
    assert.ok(urls.includes("https://a.test/about"));
    assert.ok(!urls.some((u) => u.includes("/blog/")));
  });
  it("never leaves the site", () => {
    assert.ok(!sitemapContactUrls(xml, "https://a.test").some((u) => u.includes("other.test")));
  });
  it("follows a sitemap index", () => {
    const index = `<sitemapindex><sitemap><loc>https://a.test/sitemap-pages.xml</loc></sitemap></sitemapindex>`;
    assert.deepEqual(sitemapIndexUrls(index, "https://a.test"), ["https://a.test/sitemap-pages.xml"]);
  });
  it("copes with a sitemap that has nothing useful", () => {
    assert.deepEqual(sitemapContactUrls(`<urlset><url><loc>https://a.test/blog</loc></url></urlset>`, "https://a.test"), []);
  });
});

describe("scoring and ranking", () => {
  const cand = (over: Partial<EmailCandidate>): EmailCandidate => ({
    email: "info@strathearnjoinery.co.uk", source: "OFFICIAL_WEBSITE", sourceUrl: "https://strathearnjoinery.co.uk/",
    method: "PAGE_TEXT", evidence: "", ...over,
  });

  it("rates a mailto on the contact page, on the site own domain, HIGH", () => {
    const s = scoreCandidate(cand({ source: "OFFICIAL_CONTACT_PAGE", method: "MAILTO_LINK" }), ctx);
    assert.equal(s.confidence, "HIGH");
    assert.ok(s.notes.some((n) => /own domain/.test(n)));
  });

  it("keeps a legitimate Gmail business address, at lower confidence", () => {
    const s = scoreCandidate(cand({ email: "strathearnjoinery@gmail.com", source: "OFFICIAL_CONTACT_PAGE", method: "MAILTO_LINK" }), ctx);
    assert.notEqual(s.confidence, "LOW", "a published consumer mailbox is still a real address");
    assert.ok(s.score < scoreCandidate(cand({ source: "OFFICIAL_CONTACT_PAGE", method: "MAILTO_LINK" }), ctx).score);
  });

  it("prefers a general mailbox over a named individual", () => {
    const ranked = rankCandidates([
      cand({ email: "dave.smith@strathearnjoinery.co.uk", method: "MAILTO_LINK" }),
      cand({ email: "info@strathearnjoinery.co.uk", method: "MAILTO_LINK" }),
    ], ctx);
    assert.equal(ranked[0].email, "info@strathearnjoinery.co.uk");
  });

  it("prefers the site own domain over an unrelated one", () => {
    const ranked = rankCandidates([
      cand({ email: "info@someoneelse.test", method: "MAILTO_LINK" }),
      cand({ email: "info@strathearnjoinery.co.uk", method: "MAILTO_LINK" }),
    ], ctx);
    assert.equal(ranked[0].email, "info@strathearnjoinery.co.uk");
  });

  it("prefers the contact page over the homepage for the same address", () => {
    const home = scoreCandidate(cand({ source: "OFFICIAL_WEBSITE" }), ctx);
    const contact = scoreCandidate(cand({ source: "OFFICIAL_CONTACT_PAGE" }), ctx);
    assert.ok(contact.score > home.score);
  });

  it("rates a bare listing address below anything from the site", () => {
    const listing = scoreCandidate(cand({ source: "EXISTING_LISTING", method: "LISTING_FIELD" }), ctx);
    const site = scoreCandidate(cand({ method: "PAGE_TEXT" }), ctx);
    assert.ok(listing.score < site.score);
  });

  it("records the same address once, at its best score", () => {
    const ranked = rankCandidates([
      cand({ method: "PAGE_TEXT" }),
      cand({ source: "OFFICIAL_CONTACT_PAGE", method: "MAILTO_LINK" }),
    ], ctx);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].method, "MAILTO_LINK");
  });

  it("explains every score", () => {
    assert.ok(scoreCandidate(cand({}), ctx).notes.length > 0);
  });
});

describe("the verdict an agent reads", () => {
  const cand = (over: Partial<EmailCandidate> = {}): EmailCandidate => ({
    email: "info@strathearnjoinery.co.uk", source: "OFFICIAL_CONTACT_PAGE",
    sourceUrl: "https://strathearnjoinery.co.uk/contact", method: "MAILTO_LINK",
    evidence: "Published as a mailto: link on the page", ...over,
  });

  it("reports FOUND with its evidence and where it came from", () => {
    const r = decide({ candidates: [cand()], context: ctx, sourcesChecked: ["https://strathearnjoinery.co.uk/"], attempts: 1 });
    assert.equal(r.status, "FOUND");
    assert.equal(r.confidence, "HIGH");
    assert.equal(r.nextAction, "SEND");
    assert.equal(r.sourceUrl, "https://strathearnjoinery.co.uk/contact");
    assert.ok(r.evidence.length > 0);
    assert.equal(r.reason, null);
  });

  it("sends a weak address to the call list instead of to outreach", () => {
    const r = decide({ candidates: [cand({ email: "random@unrelated.test", source: "PUBLIC_DIRECTORY", method: "PAGE_TEXT" })], context: ctx, sourcesChecked: [], attempts: 1 });
    assert.equal(r.status, "LOW_CONFIDENCE");
    assert.equal(r.nextAction, "CALL");
    assert.equal(r.reason, "EMAIL_LOW_CONFIDENCE");
  });

  it("names why nothing was found, and never just says no email", () => {
    const cases: { input: Parameters<typeof decide>[0]; reason: string }[] = [
      { input: { candidates: [], context: ctx, sourcesChecked: ["a"], attempts: 1, sawContactPage: true }, reason: "CONTACT_PAGE_NO_EMAIL" },
      { input: { candidates: [], context: ctx, sourcesChecked: ["a"], attempts: 1 }, reason: "NO_CONTACT_PAGE" },
      { input: { candidates: [], context: ctx, sourcesChecked: [], attempts: 1, failure: "WEBSITE_UNREACHABLE" }, reason: "WEBSITE_UNREACHABLE" },
      { input: { candidates: [], context: ctx, sourcesChecked: [], attempts: 1, failure: "BLOCKED_BY_SITE" }, reason: "BLOCKED_BY_SITE" },
      { input: { candidates: [], context: ctx, sourcesChecked: [], attempts: 1, failure: "RATE_LIMITED" }, reason: "RATE_LIMITED" },
      { input: { candidates: [], context: ctx, sourcesChecked: ["a"], attempts: 1, sawUnreadableObfuscation: true }, reason: "EMAIL_OBFUSCATED_UNREADABLE" },
    ];
    for (const c of cases) assert.equal(decide(c.input).reason, c.reason);
  });

  it("marks a blocked site BLOCKED rather than NOT_FOUND", () => {
    assert.equal(decide({ candidates: [], context: ctx, sourcesChecked: [], attempts: 1, failure: "BLOCKED_BY_SITE" }).status, "BLOCKED");
  });

  it("says NO_WEBSITE when there was nothing to search", () => {
    const r = noWebsiteResult();
    assert.equal(r.reason, "NO_WEBSITE");
    assert.equal(r.nextAction, "CALL");
    assert.equal(r.attempts, 0);
  });

  it("routes every unsuccessful outcome to the call list", () => {
    for (const r of [
      decide({ candidates: [], context: ctx, sourcesChecked: [], attempts: 1 }),
      decide({ candidates: [], context: ctx, sourcesChecked: [], attempts: 1, failure: "BLOCKED_BY_SITE" }),
      noWebsiteResult(),
    ]) assert.equal(r.nextAction, "CALL");
  });

  it("reports what it tried, so a failure can be understood", () => {
    const r = decide({ candidates: [], context: ctx, sourcesChecked: ["https://a.test/", "https://a.test/contact"], attempts: 2 });
    assert.deepEqual(r.sourcesChecked, ["https://a.test/", "https://a.test/contact"]);
    assert.equal(r.attempts, 2);
  });

  it("keeps the runners-up as alternatives", () => {
    const r = decide({ candidates: [cand(), cand({ email: "dave@strathearnjoinery.co.uk" })], context: ctx, sourcesChecked: [], attempts: 1 });
    assert.equal(r.email, "info@strathearnjoinery.co.uk");
    assert.equal(r.alternatives.length, 1);
    assert.equal(r.alternatives[0].email, "dave@strathearnjoinery.co.uk");
  });
});

describe("NEVER GUESS", () => {
  it("returns nothing for a site that publishes nothing", () => {
    const r = decide({
      candidates: extractCandidates(`<html><body><form><input name="msg"></form></body></html>`, "https://strathearnjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE"),
      context: ctx, sourcesChecked: ["https://strathearnjoinery.co.uk/contact"], attempts: 2, sawContactPage: true,
    });
    assert.equal(r.status, "NOT_FOUND");
    assert.equal(r.email, null);
    assert.equal(r.reason, "CONTACT_PAGE_NO_EMAIL");
  });

  it("never manufactures info@ from the domain", () => {
    const r = decide({
      candidates: extractCandidates(`<h1>Strathearn Joinery</h1><p>Call 01764 650000</p>`, "https://strathearnjoinery.co.uk/", "OFFICIAL_WEBSITE"),
      context: ctx, sourcesChecked: [], attempts: 1,
    });
    assert.equal(r.email, null, "a domain is not an address");
  });

  it("only ever returns an address that was in the page", () => {
    const html = `<a href="mailto:office@strathearnjoinery.co.uk">e</a>`;
    const r = decide({ candidates: extractCandidates(html, "https://strathearnjoinery.co.uk/", "OFFICIAL_WEBSITE"), context: ctx, sourcesChecked: [], attempts: 1 });
    assert.ok(html.includes(r.email ?? " "));
  });
});

describe("not crawling the same site over and over", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date("2026-09-11T12:00:00.000Z");

  it("reuses a recent result that actually found something", () => {
    assert.equal(discoveryIsFresh(
      { email: "info@a.test", emailFoundAt: new Date(now.getTime() - 5 * day).toISOString() }, now), true);
  });

  it("searches again once the result is old", () => {
    assert.equal(discoveryIsFresh(
      { email: "info@a.test", emailFoundAt: new Date(now.getTime() - 40 * day).toISOString() }, now), false);
  });

  it("always retries a lead that has no address", () => {
    // A business with no address in March may publish one by May.
    assert.equal(discoveryIsFresh(
      { email: "", emailFoundAt: new Date(now.getTime() - day).toISOString() }, now), false);
  });

  it("searches when there is no timestamp at all", () => {
    assert.equal(discoveryIsFresh({ email: "info@a.test", emailFoundAt: "" }, now), false);
    assert.equal(discoveryIsFresh({ email: "info@a.test", emailFoundAt: "not a date" }, now), false);
  });
});

describe("reporting what a run achieved", () => {
  const found = (source: EmailCandidate["source"], confidence: "HIGH" | "MEDIUM" | "LOW") =>
    ({ status: "FOUND", email: "a@b.test", confidence, score: 90, source, sourceUrl: "", evidence: "",
       reason: null, sourcesChecked: [], attempts: 1, alternatives: [], nextAction: "SEND" }) as DiscoveryResult;
  const missed = (reason: string) =>
    ({ status: "NOT_FOUND", email: null, confidence: null, score: null, source: null, sourceUrl: "",
       evidence: "", reason, sourcesChecked: [], attempts: 3, alternatives: [], nextAction: "CALL" }) as unknown as DiscoveryResult;

  it("counts what was found and where it came from", () => {
    const t = emptyTally();
    tallyDiscovery(t, found("OFFICIAL_CONTACT_PAGE", "HIGH"));
    tallyDiscovery(t, found("OFFICIAL_CONTACT_PAGE", "HIGH"));
    tallyDiscovery(t, found("OFFICIAL_WEBSITE", "MEDIUM"));
    assert.equal(t.searched, 3);
    assert.equal(t.found, 3);
    assert.equal(t.bySource.OFFICIAL_CONTACT_PAGE, 2);
    assert.equal(t.high, 2);
    assert.equal(t.medium, 1);
  });

  it("counts why the rest failed", () => {
    const t = emptyTally();
    tallyDiscovery(t, missed("NO_WEBSITE"));
    tallyDiscovery(t, missed("CONTACT_PAGE_NO_EMAIL"));
    tallyDiscovery(t, missed("CONTACT_PAGE_NO_EMAIL"));
    assert.equal(t.found, 0);
    assert.equal(t.byReason.CONTACT_PAGE_NO_EMAIL, 2);
  });

  it("names the best source and the biggest blocker", () => {
    const t = emptyTally();
    tallyDiscovery(t, found("OFFICIAL_CONTACT_PAGE", "HIGH"));
    tallyDiscovery(t, found("OFFICIAL_CONTACT_PAGE", "HIGH"));
    tallyDiscovery(t, found("STRUCTURED_DATA", "HIGH"));
    tallyDiscovery(t, missed("NO_WEBSITE"));
    tallyDiscovery(t, missed("NO_WEBSITE"));
    tallyDiscovery(t, missed("BLOCKED_BY_SITE"));
    assert.deepEqual(bestSource(t), { source: "OFFICIAL_CONTACT_PAGE", count: 2 });
    assert.deepEqual(biggestBottleneck(t), { reason: "NO_WEBSITE", count: 2 });
  });

  it("has nothing to report on an empty run", () => {
    assert.equal(bestSource(emptyTally()), null);
    assert.equal(biggestBottleneck(emptyTally()), null);
  });

  it("has readable wording for every failure reason", () => {
    for (const reason of Object.keys(REASON_LABELS)) {
      assert.ok(REASON_LABELS[reason as keyof typeof REASON_LABELS].length > 5, reason);
    }
  });

  it("splits website vs directory vs no-site misses", () => {
    const t = emptyTally();
    tallyDiscovery(t, found("OFFICIAL_CONTACT_PAGE", "HIGH"));
    tallyDiscovery(t, found("PUBLIC_DIRECTORY", "MEDIUM"));
    tallyDiscovery(t, missed("CONTACT_PAGE_NO_EMAIL"));
    tallyDiscovery(t, missed("WEBSITE_NOT_VERIFIED"));
    assert.equal(t.websiteEmails, 1);
    assert.equal(t.directoryEmails, 1);
    assert.equal(t.verifiedWebsiteNoEmail, 1);
    assert.equal(t.noVerifiedWebsite, 1);
  });
});

describe("obfuscated addresses the page really does publish", () => {
  const find = (html: string) =>
    extractCandidates(html, "https://clarkjoinery.co.uk", "OFFICIAL_WEBSITE").map((c) => c.email);

  it("reads every spelling of a hidden address", () => {
    for (const [label, html] of [
      ["bracketed", "Email us at info [at] clarkjoinery [dot] co.uk today"],
      ["parenthesised", "info(at)clarkjoinery(dot)co.uk"],
      ["spaced symbols", "info @ clarkjoinery . co . uk"],
      ["spaced dots", "info@clarkjoinery . co . uk"],
      ["numeric entities", "info&#64;clarkjoinery&#46;co.uk"],
      ["named entities", "info&commat;clarkjoinery&period;co.uk"],
      ["words in caps", "INFO AT CLARKJOINERY DOT CO DOT UK"],
      ["mailto link", `<a href="mailto:info@clarkjoinery.co.uk">Email</a>`],
      ["plain text", "Contact info@clarkjoinery.co.uk"],
      ["script literals", `<script>var e = "info" + "@" + "clarkjoinery.co.uk";</script>`],
    ] as const) {
      assert.ok(find(html).includes("info@clarkjoinery.co.uk"), `${label}: ${html}`);
    }
  });

  it("NEVER reassembles an address from separate variables", () => {
    // The address is not written anywhere in this source — building it would be
    // constructing an address rather than reading one, and a constructed
    // address is a guess however plausible it looks.
    const found = find(`<script>var user="info", domain="clarkjoinery.co.uk";</script>`);
    assert.deepEqual(found, [], `invented an address: ${found.join(", ")}`);
  });

  it("does not turn ordinary prose into an address", () => {
    assert.deepEqual(find("Call us . We are open six days a week . Ask for Charlie ."), []);
    assert.deepEqual(find("Meet the team at our workshop . Free quotes ."), []);
  });
});

describe("joinScriptLiterals", () => {
  it("joins adjacent literals that already contain the whole address", () => {
    assert.match(
      joinScriptLiterals(`<script>var e = "info" + "@" + "x.co.uk";</script>`),
      /info@x\.co\.uk/,
    );
    assert.match(
      joinScriptLiterals(`<script>a('hello' + '@' + 'y.com')</script>`),
      /hello@y\.com/,
    );
  });

  it("ignores joins that never produce an address", () => {
    assert.equal(joinScriptLiterals(`<script>var t = "Hello, " + "world";</script>`), "");
  });

  it("ignores a page with no scripts at all", () => {
    assert.equal(joinScriptLiterals("<p>info@x.co.uk</p>"), "");
  });
});

describe("contact pages worth following", () => {
  it("follows every contact path the brief names", () => {
    const paths = [
      "contact", "contact-us", "get-in-touch", "about", "about-us", "team",
      "meet-the-team", "quote", "request-a-quote", "book", "booking",
      "services", "find-us", "enquiries",
    ];
    const html = paths.map((path) => `<a href="/${path}">${path}</a>`).join("");
    const found = contactLinks(html, "https://clarkjoinery.co.uk", 30).map(
      (url) => new URL(url).pathname,
    );
    for (const path of paths) {
      assert.ok(found.includes(`/${path}`), `/${path} was not followed`);
    }
  });

  it("still puts the contact page before the about page", () => {
    const html = `<a href="/about">About</a><a href="/contact">Contact</a>`;
    const found = contactLinks(html, "https://clarkjoinery.co.uk", 4);
    assert.match(found[0]!, /\/contact$/);
  });

  it("never follows a link off the site", () => {
    const html = `<a href="https://someone-else.co.uk/contact">Contact</a>`;
    assert.deepEqual(contactLinks(html, "https://clarkjoinery.co.uk", 4), []);
  });
});

describe("Cloudflare email protection", () => {
  // info@clarkjoinery.co.uk XOR-encoded with key 0x4a. A published address.
  const encoded = "4a23242c250a29262b3821202523242f3833642925643f21";

  it("decodes a data-cfemail payload", () => {
    assert.equal(decodeCfEmail(encoded), "info@clarkjoinery.co.uk");
  });

  it("reads the address out of a protected page", () => {
    const html = `<a href="/cdn-cgi/l/email-protection#${encoded}" data-cfemail="${encoded}">email us</a>`;
    const found = extractCandidates(html, "https://clarkjoinery.co.uk/", "OFFICIAL_WEBSITE");
    assert.ok(found.some((c) => c.email === "info@clarkjoinery.co.uk"), JSON.stringify(found));
    assert.equal(found[0]?.method, "DEOBFUSCATED");
  });

  it("ignores a payload that is not hex", () => {
    assert.equal(decodeCfEmail("zzzz"), "");
    assert.equal(decodeCfEmail("4a"), "");
  });

  it("does not invent an address from an empty attribute", () => {
    const found = extractCandidates(`<span data-cfemail=""></span>`, "https://clarkjoinery.co.uk/", "OFFICIAL_WEBSITE");
    assert.equal(found.length, 0);
  });
});
