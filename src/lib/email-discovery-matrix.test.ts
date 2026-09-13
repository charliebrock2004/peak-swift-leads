/**
 * The adversarial matrix for email discovery.
 *
 * A live run found 41 businesses and 14 addresses, with five good prospects
 * reported as having no public email. The audit behind this file found the
 * likeliest cause: the page budget was shared between working out WHICH site
 * belongs to a business and READING that site for an address, so a business
 * whose site had to be guessed arrived at the contact crawl with nothing left
 * and its verified website was never opened.
 *
 * These fixtures are every shape of real small-business site the pipeline has
 * to cope with. The rule they all serve: find more addresses that are genuinely
 * published, and never invent one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANDIDATE_PATHS,
  MAX_PAGES,
  contactLinks,
  decide,
  decodeCfEmail,
  extractCandidates,
  mailboxRejection,
  rankCandidates,
  sitemapContactUrls,
  type EmailCandidate,
  type RejectedEmail,
} from "./email-discovery.ts";

const SITE = "https://clarkjoinery.co.uk";
const HOST = "clarkjoinery.co.uk";
const TARGET = `info@${HOST}`;

function found(html: string, url = SITE): string[] {
  return extractCandidates(html, url, "OFFICIAL_WEBSITE").map((candidate) => candidate.email);
}

/** A genuine Cloudflare payload: every byte XORed with the key, key first. */
function cloudflare(email: string, key = 0x5e): string {
  let hex = key.toString(16).padStart(2, "0");
  for (const char of email) hex += (char.charCodeAt(0) ^ key).toString(16).padStart(2, "0");
  return hex;
}

describe("every shape an address is published in", () => {
  const FIXTURES: [string, string][] = [
    ["a mailto link", `<a href="mailto:${TARGET}">Email</a>`],
    ["visible body text", `<p>Contact ${TARGET}</p>`],
    ["a footer", `<footer><p>${TARGET}</p></footer>`],
    ["a header", `<header><span>${TARGET}</span></header>`],
    ["JSON-LD", `<script type="application/ld+json">{"@type":"LocalBusiness","email":"${TARGET}"}</script>`],
    ["a schema.org itemprop", `<span itemprop="email">${TARGET}</span>`],
    ["a meta tag", `<meta name="contact" content="${TARGET}">`],
    ["an HTML attribute", `<div data-email="${TARGET}"></div>`],
    ["a JavaScript literal", `<script>var e = "info" + "@" + "${HOST}";</script>`],
    ["an inline data payload", `<script>window.__DATA__={"email":"${TARGET}"}</script>`],
    ["spaced separators", `<p>info @ clarkjoinery . co . uk</p>`],
    ["bracketed at/dot", `<p>info [at] clarkjoinery [dot] co.uk</p>`],
    ["parenthesised at/dot", `<p>info(at)clarkjoinery(dot)co.uk</p>`],
    ["numeric HTML entities", `<p>info&#64;clarkjoinery&#46;co.uk</p>`],
    ["named HTML entities", `<p>info&commat;clarkjoinery&period;co.uk</p>`],
    ["Cloudflare href protection", `<a href="/cdn-cgi/l/email-protection#${cloudflare(TARGET)}">[email protected]</a>`],
    ["Cloudflare data-cfemail", `<span data-cfemail="${cloudflare(TARGET)}">[email protected]</span>`],
    ["link text differing from href", `<a href="mailto:${TARGET}">Click here to email us</a>`],
    ["a JS-heavy page with nothing visible", `<div id="root"></div><script>var CONFIG={contact:{email:"${TARGET}"}}</script>`],
  ];

  for (const [label, html] of FIXTURES) {
    it(`finds an address published as ${label}`, () => {
      assert.ok(found(html).includes(TARGET), `${label}: got ${found(html).join(", ") || "nothing"}`);
    });
  }

  it("finds all nineteen", () => {
    const hits = FIXTURES.filter(([, html]) => found(html).includes(TARGET)).length;
    assert.equal(hits, FIXTURES.length);
  });

  it("keeps several legitimate addresses from one site", () => {
    const emails = found(`<a href="mailto:${TARGET}">a</a><p>sales@${HOST}</p><p>enquiries@${HOST}</p>`);
    assert.equal(emails.length, 3);
  });
});

describe("Cloudflare decoding never invents an address", () => {
  it("decodes a real payload", () => {
    assert.equal(decodeCfEmail(cloudflare(TARGET)), TARGET);
  });

  it("decodes a business's own consumer mailbox", () => {
    assert.equal(decodeCfEmail(cloudflare("clarkjoinery@gmail.com")), "clarkjoinery@gmail.com");
  });

  it("finds one through the extractor, both markup forms", () => {
    assert.ok(found(`<a href="/cdn-cgi/l/email-protection#${cloudflare(TARGET)}">x</a>`).includes(TARGET));
    assert.ok(found(`<span data-cfemail="${cloudflare(TARGET)}">x</span>`).includes(TARGET));
  });

  it("REFUSES hex whose wrong key decodes to a plausible address", () => {
    // A wrong key can decode to characters that all happen to be legal,
    // producing an address nobody published. The extractor refuses it because
    // it lands on a domain that is not this site's.
    const junk = "5e3b32302c31371e3d31302d2c30333b3d312e333a70303b2a";
    assert.deepEqual(found(`<span data-cfemail="${junk}">x</span>`), []);
  });

  it("REFUSES a decode that lands on somebody else's domain", () => {
    assert.deepEqual(found(`<span data-cfemail="${cloudflare("bob@someoneelse.com")}">x</span>`), []);
  });

  it("refuses invalid hex, odd lengths and control bytes", () => {
    assert.equal(decodeCfEmail("zzzz"), "");
    assert.equal(decodeCfEmail("5e3b3"), "");
    assert.equal(decodeCfEmail("0001020304"), "");
    assert.equal(decodeCfEmail(""), "");
  });
});

describe("the pages a verified site is read for", () => {
  const WANTED = [
    "/contact", "/contact-us", "/get-in-touch", "/find-us", "/about", "/about-us",
    "/team", "/meet-the-team", "/services", "/enquiries", "/privacy", "/terms",
  ];

  it("follows every one of them when the site links to it", () => {
    const html = WANTED.map((path) => `<a href="${path}">x</a>`).join("");
    const links = contactLinks(html, SITE, 30).map((url) => new URL(url).pathname);
    for (const path of WANTED) assert.ok(links.includes(path), `${path} was not followed`);
  });

  it("guesses the important ones when the site links to nothing", () => {
    for (const path of ["/contact", "/contact-us", "/get-in-touch", "/find-us", "/about", "/team", "/privacy"]) {
      assert.ok((CANDIDATE_PATHS as readonly string[]).includes(path), `${path} is never guessed`);
    }
  });

  it("reads a contact page before a privacy page", () => {
    const html = `<a href="/privacy">Privacy</a><a href="/contact">Contact</a>`;
    const links = contactLinks(html, SITE, 10).map((url) => new URL(url).pathname);
    assert.deepEqual(links, ["/contact", "/privacy"]);
  });

  it("finds contact pages in a sitemap, privacy last", () => {
    const xml = `<urlset>${WANTED.map((p) => `<loc>${SITE}${p}</loc>`).join("")}</urlset>`;
    const urls = sitemapContactUrls(xml, SITE, 20).map((url) => new URL(url).pathname);
    assert.ok(urls.includes("/contact"));
    assert.ok(urls.includes("/find-us"));
    assert.ok(urls.indexOf("/contact") < urls.indexOf("/privacy"));
  });

  it("never leaves the site", () => {
    assert.deepEqual(contactLinks(`<a href="https://someone-else.co.uk/contact">c</a>`, SITE, 4), []);
  });
});

describe("the page budget", () => {
  it("gives the contact crawl room for several pages", () => {
    // Shared budgets were the bug: a business found by domain guess arrived
    // here with nothing left and its verified site was never read. Website
    // probing is counted separately in the server, against its own ceiling.
    assert.ok(MAX_PAGES >= 8, "a verified site needs room for several contact pages");
  });

  it("still bounds it, so one website cannot run away with the run", () => {
    assert.ok(MAX_PAGES <= 15);
  });
});

describe("which addresses are worth having", () => {
  const context = { websiteUrl: SITE, businessName: "Clark Joinery" };
  const on = (email: string): EmailCandidate => ({
    email, source: "OFFICIAL_CONTACT_PAGE", sourceUrl: `${SITE}/contact`,
    method: "MAILTO_LINK", evidence: "published on the contact page",
  });

  it("treats every ordinary business mailbox as usable", () => {
    for (const local of ["info", "hello", "contact", "enquiries", "office", "sales", "admin", "bookings"]) {
      const scored = rankCandidates([on(`${local}@${HOST}`)], context)[0]!;
      assert.equal(scored.confidence, "HIGH", `${local}@ scored ${scored.score}`);
    }
  });

  it("accepts a consumer mailbox the business itself publishes", () => {
    for (const email of ["clarkjoinery@gmail.com", "clark.joinery@outlook.com"]) {
      const scored = rankCandidates([on(email)], context)[0]!;
      assert.notEqual(scored.confidence, "LOW", `${email} scored ${scored.score}`);
    }
  });

  it("REFUSES automated and third-party mailboxes outright", () => {
    for (const email of [
      "noreply@clarkjoinery.co.uk", "no-reply@x.co.uk", "donotreply@x.co.uk",
      "notifications@x.co.uk", "mailer@x.co.uk", "tracking@x.co.uk", "analytics@x.co.uk",
      "bounce@x.co.uk", "unsubscribe@x.co.uk", "postmaster@x.co.uk",
      "pixel@sentry.io", "a@wixpress.com", "logo@company.png", "t@mailinator.com",
    ]) {
      assert.notEqual(mailboxRejection(email), "", `${email} should be refused`);
    }
  });

  it("NEVER builds an address from a domain", () => {
    // The single rule the whole pipeline rests on. A site that publishes
    // nothing yields nothing, however obvious info@<domain> would look.
    const emails = found(`<html><body><h1>Clark Joinery</h1><p>Call 01738 445566</p></body></html>`);
    assert.deepEqual(emails, []);
  });

  it("records what it refused, with the reason", () => {
    const rejected: RejectedEmail[] = [];
    extractCandidates(
      `<a href="mailto:${TARGET}">a</a><p>noreply@${HOST}</p><p>pixel@sentry.io</p>`,
      SITE, "OFFICIAL_CONTACT_PAGE", rejected,
    );
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((entry) => entry.why.length > 0));
    assert.ok(rejected.some((entry) => /noreply/.test(entry.email)));
  });
});

describe("saying precisely why nothing was found", () => {
  const context = { websiteUrl: SITE, businessName: "Clark Joinery" };
  const base = { candidates: [], context, sourcesChecked: [`${SITE}/contact`], attempts: 3 };

  it("distinguishes contact pages read and empty", () => {
    assert.equal(decide({ ...base, sawContactPage: true }).reason, "CONTACT_PAGES_CHECKED_NO_EMAIL");
  });

  it("distinguishes addresses found and all refused", () => {
    assert.equal(decide({ ...base, sawContactPage: true, rejectedEmails: 2 }).reason, "EMAILS_FOUND_BUT_REJECTED");
  });

  it("distinguishes a budget that ran out", () => {
    assert.equal(decide({ ...base, budgetExhausted: true }).reason, "EMAIL_DISCOVERY_EXHAUSTED");
  });

  it("distinguishes a site that would not load", () => {
    assert.equal(decide({ ...base, failure: "WEBSITE_NOT_REACHABLE" }).reason, "WEBSITE_NOT_REACHABLE");
  });

  it("distinguishes never having reached a contact page", () => {
    assert.equal(decide({ ...base, sawContactPage: false }).reason, "NO_CONTACT_PAGE");
  });

  it("reports a real find rather than a reason", () => {
    const verdict = decide({
      ...base,
      candidates: [{
        email: TARGET, source: "OFFICIAL_CONTACT_PAGE", sourceUrl: `${SITE}/contact`,
        method: "MAILTO_LINK", evidence: "published on the contact page",
      }],
    });
    assert.equal(verdict.status, "FOUND");
    assert.equal(verdict.reason, null);
    assert.equal(verdict.email, TARGET);
  });
});
