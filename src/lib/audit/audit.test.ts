import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditHomepage, homepageFacts, type HomepageInput } from "./homepage.ts";
import { freshness, keyOpportunities, opportunityLevel, type Finding } from "./findings.ts";
import { pageSpeedFindings, parsePageSpeed, runPageSpeed } from "./pagespeed.ts";
import { websitePhrase, websiteVerification } from "./website-state.ts";
import { checkEmailQuality } from "../outreach/quality.ts";
import { createLead } from "../leads.ts";
import type { OutreachLead } from "../outreach/types.ts";
import { factsWith, searchedNoWebsite } from "../test-support/facts.ts";

const OBSERVED = "2026-09-30T10:00:00.000Z";
const input = (html: string, over: Partial<HomepageInput> = {}): HomepageInput => ({
  url: "https://strathearnjoinery.co.uk",
  finalUrl: "https://strathearnjoinery.co.uk/",
  status: 200,
  html,
  responseMs: 640,
  bytes: html.length,
  redirects: [],
  business: { name: "Strathearn Joinery", town: "Crieff", trade: "Joiner" },
  observedAt: OBSERVED,
  ...over,
});
const kinds = (findings: Finding[], status: Finding["status"] = "opportunity") => findings.filter((f) => f.status === status).map((f) => f.kind).sort();

const WEAK = `<!doctype html><html><head><title>Home</title><meta name="generator" content="WordPress 5.2"></head>
<body><div class="header">Strathearn Joinery</div>
<p>Joinery and carpentry. Call 01764 123456.</p><p>We do kitchens, doors and stairs for homes.</p>
<form role="search" action="/?s="><input type="search" name="s"></form>
<footer>© 2017 Strathearn Joinery</footer></body></html>`;

const STRONG_WORDS = Array.from({ length: 320 }, (_, i) => `word${i}`).join(" ");
const STRONG = `<!doctype html><html lang="en"><head>
<title>Strathearn Joinery | Joiners in Crieff, Perthshire</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Kitchens, doors and stairs across Perthshire.">
<link rel="canonical" href="https://strathearnjoinery.co.uk/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"HomeAndConstructionBusiness","name":"Strathearn Joinery"}]}</script>
</head><body>
<h1>Joiners in Crieff</h1>
<a href="tel:+441764123456">01764 123456</a> <a href="/contact">Get a free quote</a>
<a href="/services/kitchens">Kitchens</a> <a href="/services/stairs">Stairs</a>
<p>Serving Crieff and Perthshire. ${STRONG_WORDS}</p>
<section><h2>What our customers say</h2><p>★★★★★ Brilliant work</p></section>
<p>Checkatrade approved. 12 High Street, Crieff PH7 3AA</p>
<form class="wpcf7-form"><input name="your-name"><input type="email" name="your-email"><textarea name="your-message"></textarea><button type="submit">Send</button></form>
<footer>© 2025–2026 Strathearn Joinery</footer></body></html>`;

describe("the homepage audit, on a weak trades site", () => {
  const { facts, findings } = auditHomepage(input(WEAK, { finalUrl: "http://strathearnjoinery.co.uk/", url: "http://strathearnjoinery.co.uk" }));

  it("reads what the page actually contains", () => {
    assert.equal(facts.https, false);
    assert.equal(facts.title, "Home");
    assert.equal(facts.viewport, false);
    assert.equal(facts.telLinks, 0);
    assert.equal(facts.phoneShown, true);
    assert.equal(facts.enquiryForms, 0, "a search box is not an enquiry form");
    assert.equal(facts.copyrightYear, 2017);
    assert.equal(facts.mentionsTown, false);
    assert.deepEqual(facts.technology.map((t) => [t.name, t.confidence]), [["WordPress", "high"]]);
  });

  it("finds the measurable opportunities", () => {
    for (const kind of ["no_https", "no_viewport", "phone_not_tappable", "no_enquiry_form", "no_cta", "no_quote_request", "stale_copyright", "weak_title", "no_meta_description", "no_h1", "no_local_schema", "no_location", "thin_content", "no_testimonials"]) {
      assert.ok(kinds(findings).includes(kind), `expected ${kind}`);
    }
  });

  it("states each finding as a measurement with its value, source, URL and date", () => {
    const copyright = findings.find((f) => f.kind === "stale_copyright")!;
    assert.equal(copyright.evidence, "The homepage copyright notice says 2017.");
    assert.equal(copyright.value, "2017");
    assert.equal(copyright.observedAt, OBSERVED);
    assert.equal(copyright.url, "http://strathearnjoinery.co.uk/");
    for (const finding of findings) {
      assert.ok(finding.evidence.length > 10, finding.kind);
      assert.ok(["homepage", "http", "pagespeed", "robots.txt", "sitemap", "link-check"].includes(finding.source));
      // Measurements, never verdicts.
      assert.doesNotMatch(finding.evidence, /\b(outdated|bad|ugly|terrible|poor quality|old-fashioned)\b/i, finding.kind);
    }
  });

  it("rates it a strong opportunity and leads with the biggest findings", () => {
    assert.equal(opportunityLevel(findings).level, "strong");
    const key = keyOpportunities(findings);
    assert.ok(key.length >= 3 && key.length <= 5);
    assert.equal(key[0]!.kind, "no_viewport");
    assert.equal(new Set(key.map((f) => f.kind)).size, key.length);
  });
});

describe("the homepage audit, on a good site", () => {
  const { facts, findings } = auditHomepage(input(STRONG));

  it("recognises what is already done well", () => {
    assert.equal(facts.localBusinessSchema, true);
    assert.equal(facts.enquiryForms, 1);
    assert.ok(facts.ctaText.includes("Get a free quote"));
    assert.equal(facts.quoteCta, true);
    assert.equal(facts.testimonials, true);
    assert.deepEqual(facts.trustSignals, ["Checkatrade"]);
    assert.equal(facts.copyrightYear, 2026);
    assert.equal(facts.mentionsTown, true);
    assert.ok(kinds(findings, "ok").includes("tap_to_call"));
  });

  it("finds little or nothing to pitch", () => {
    assert.deepEqual(kinds(findings), []);
    assert.equal(opportunityLevel(findings).level, "none");
  });
});

describe("what the homepage audit refuses to guess", () => {
  it("does not report missing content on a JavaScript-rendered shell", () => {
    const shell = `<html><head><title>Strathearn Joinery</title><meta name="viewport" content="width=device-width"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    const { facts, findings } = auditHomepage(input(shell));
    assert.equal(facts.scriptRendered, true);
    assert.ok(findings.some((f) => f.kind === "script_rendered" && f.status === "info"));
    for (const kind of ["no_phone", "no_enquiry_form", "no_cta", "thin_content", "no_h1", "no_testimonials", "no_location"]) {
      assert.equal(kinds(findings).includes(kind), false, `${kind} would be a guess`);
    }
  });

  it("reports only the error for an error page", () => {
    const { findings } = auditHomepage(input("<html><body>Internal error</body></html>", { status: 500 }));
    assert.deepEqual(findings.map((f) => f.kind), ["http_error"]);
    assert.match(findings[0]!.evidence, /HTTP 500 when checked on 30 Sept? 2026/);
  });

  it("recognises a holding page", () => {
    const { findings } = auditHomepage(input("<html><head><meta name=viewport content=x></head><body><h1>Coming soon</h1><p>This website is under construction.</p></body></html>"));
    assert.ok(kinds(findings).includes("parked"));
  });

  it("asks salons about booking, not trades", () => {
    const salon = { name: "Tay Hair", town: "Perth", trade: "Hairdresser" };
    assert.ok(kinds(auditHomepage(input(STRONG, { business: salon })).findings).includes("no_online_booking"));
    const withFresha = STRONG.replace("</body>", `<a href="https://www.fresha.com/book-now/tay-hair">Book now</a></body>`);
    assert.equal(kinds(auditHomepage(input(withFresha, { business: salon })).findings).includes("no_online_booking"), false);
    assert.equal(kinds(auditHomepage(input(STRONG)).findings).includes("no_online_booking"), false, "a joiner is not expected to take bookings");
  });

  it("flags a site that shuts out search engines", () => {
    const { findings } = auditHomepage(input(STRONG, { robots: { found: true, disallowAll: true } }));
    assert.ok(kinds(findings).includes("robots_blocks_all"));
    const noindex = STRONG.replace("<head>", `<head><meta name="robots" content="noindex,nofollow">`);
    assert.ok(kinds(auditHomepage(input(noindex)).findings).includes("noindex"));
  });

  it("reports broken links only from real error statuses", () => {
    const { findings } = auditHomepage(input(STRONG, { links: { checked: 6, broken: [{ url: "https://strathearnjoinery.co.uk/gallery", status: 404 }] } }));
    const broken = findings.find((f) => f.kind === "broken_links")!;
    assert.match(broken.evidence, /1 of 6 links.*gallery → HTTP 404/);
    assert.equal(broken.source, "link-check");
  });

  it("ignores impossible copyright years", () => {
    assert.equal(homepageFacts(input("<p>© 1066 and © 2099</p>")).copyrightYear, null);
  });
});

const PSI = {
  id: "https://strathearnjoinery.co.uk/",
  analysisUTCTimestamp: OBSERVED,
  loadingExperience: {
    overall_category: "SLOW",
    metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 5200 }, INTERACTION_TO_NEXT_PAINT: { percentile: 620 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 31 } },
  },
  lighthouseResult: {
    fetchTime: OBSERVED,
    finalDisplayedUrl: "https://strathearnjoinery.co.uk/",
    categories: { performance: { score: 0.42 }, accessibility: { score: 0.65 }, seo: { score: 0.91 }, "best-practices": { score: 0.78 } },
    audits: {
      "largest-contentful-paint": { numericValue: 7800 },
      "cumulative-layout-shift": { numericValue: 0.05 },
      "total-blocking-time": { numericValue: 900 },
      "first-contentful-paint": { numericValue: 3100 },
      "speed-index": { numericValue: 6400 },
      "total-byte-weight": { numericValue: 5_200_000 },
      "font-size": { score: 0 },
      viewport: { score: 1 },
    },
  },
};

describe("PageSpeed Insights", () => {
  it("parses scores, lab metrics and field data", () => {
    const result = parsePageSpeed(PSI)!;
    assert.equal(result.performance, 42);
    assert.equal(result.accessibility, 65);
    assert.equal(result.lab.lcpMs, 7800);
    assert.deepEqual(result.field, { lcpMs: 5200, inpMs: 620, cls: 0.31, category: "SLOW" });
    assert.deepEqual(result.failedMobileAudits, ["font-size"]);
    assert.equal(parsePageSpeed({}), null);
  });

  it("reports measurements, dated, never verdicts", () => {
    const findings = pageSpeedFindings(parsePageSpeed(PSI)!, "https://strathearnjoinery.co.uk/");
    const performance = findings.find((f) => f.kind === "psi_performance")!;
    assert.match(performance.evidence, /^PageSpeed measured mobile performance at 42\/100 on 30 Sept? 2026\.$/);
    assert.equal(performance.source, "pagespeed");
    const lcp = findings.find((f) => f.kind === "slow_lcp")!;
    assert.match(lcp.evidence, /Real Chrome users on phones wait 5\.2 s/);
    assert.equal(lcp.confidence, "high", "field data outranks the lab");
    assert.ok(findings.some((f) => f.kind === "psi_font-size"));
    assert.ok(findings.some((f) => f.kind === "heavy_page"));
    assert.ok(findings.some((f) => f.kind === "psi_accessibility"));
    assert.equal(findings.some((f) => f.kind === "psi_seo"), false, "91 is fine");
  });

  it("asks for mobile, every category, and never leaks the key in an error", async () => {
    let asked = "";
    const fake = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ error: { message: "Bad request for key=SECRETKEY123" } }), { status: 400 });
    }) as unknown as typeof fetch;
    const outcome = await runPageSpeed("https://strathearnjoinery.co.uk", { key: "SECRETKEY123", fetchImpl: fake });
    assert.match(asked, /strategy=mobile/);
    assert.match(asked, /category=performance&category=accessibility&category=seo&category=best-practices/);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && !outcome.error.includes("SECRETKEY123"));
  });

  it("names a quota problem as one", async () => {
    const fake = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const outcome = await runPageSpeed("https://x.co.uk", { key: "", fetchImpl: fake });
    assert.ok(!outcome.ok && outcome.quota && /PAGESPEED_API_KEY/.test(outcome.error));
  });
});

describe("what we know about the website", () => {
  const now = new Date(OBSERVED);

  it("VERIFIED_NO_WEBSITE needs a recent, successful search that found none", () => {
    const verified = websiteVerification({ website: "" }, searchedNoWebsite({ checkedAt: "2026-09-20T00:00:00.000Z" }), null, now);
    assert.equal(verified.state, "VERIFIED_NO_WEBSITE");
    assert.equal(verified.canClaimNoWebsite, true);
    assert.match(verified.reasons[0]!, /Searched tavily on 20 Sept? 2026 \(2 queries\); 3 candidate sites were checked/);
    assert.equal(websitePhrase(verified, "Strathearn Joinery"), "I couldn't find an independent website for Strathearn Joinery.");
    assert.deepEqual(verified.search?.queries, ["Strathearn Joinery Crieff", "Strathearn Joinery Crieff website"]);
  });

  it("is NOT_CONFIRMED when nobody searched, the search is old, or it failed", () => {
    for (const evidence of [null, searchedNoWebsite({ checkedAt: "2026-01-01T00:00:00.000Z" }), searchedNoWebsite({ searchFailure: "quota" }), searchedNoWebsite({ searchesRun: 0 })]) {
      const state = websiteVerification({ website: "" }, evidence, null, now);
      assert.equal(state.state, "WEBSITE_NOT_CONFIRMED");
      assert.equal(state.canClaimNoWebsite, false);
    }
  });

  it("separates social-only and directory-only, and only claims absence after a search", () => {
    const social = websiteVerification({ website: "https://facebook.com/strathearn" }, null, null, now);
    assert.equal(social.state, "SOCIAL_ONLY");
    assert.equal(social.canClaimNoWebsite, false);
    assert.equal(websiteVerification({ website: "https://facebook.com/strathearn" }, searchedNoWebsite({ checkedAt: "2026-09-29T00:00:00.000Z" }), null, now).canClaimNoWebsite, true);
    assert.equal(websiteVerification({ website: "https://www.yell.com/biz/x" }, null, null, now).state, "DIRECTORY_ONLY");
  });

  it("WEBSITE_FOUND needs confirmation or an audit; unreachable is its own state", () => {
    assert.equal(websiteVerification({ website: "https://strathearn.co.uk" }, null, null, now).state, "WEBSITE_NOT_CONFIRMED");
    assert.equal(websiteVerification({ website: "https://strathearn.co.uk" }, { ...searchedNoWebsite(), verified: true, url: "https://strathearn.co.uk" }, null, now).state, "WEBSITE_FOUND");
    const audited = websiteVerification({ website: "https://strathearn.co.uk" }, null, { status: "ok", httpStatus: 200, finishedAt: OBSERVED, url: "https://strathearn.co.uk" }, now);
    assert.equal(audited.state, "WEBSITE_FOUND");
    const down = websiteVerification({ website: "https://strathearn.co.uk" }, null, { status: "unreachable", httpStatus: 0, finishedAt: OBSERVED, url: "https://strathearn.co.uk" }, now);
    assert.equal(down.state, "WEBSITE_UNREACHABLE");
    assert.equal(down.canClaimNoWebsite, false);
  });

  it("the same search stops supporting the claim once a website is on record", () => {
    const state = websiteVerification({ website: "https://strathearn.co.uk" }, searchedNoWebsite(), null, now);
    assert.equal(state.canClaimNoWebsite, false);
  });
});

describe("the send gate and 'no website' claims", () => {
  const body = (line: string) => `Hi,\n\nI'm Charlie from PeakSwiftStudio. ${line} I build simple sites for trades around Perthshire.\n\nWould a quick chat be useful?\n\nCharlie\nPeakSwiftStudio\n\nIf you'd rather not hear from me, just reply and I won't contact you again.`;
  const lead = (facts: OutreachLead["facts"], website = ""): OutreachLead => ({
    ...(createLead({ businessName: "Strathearn Joinery Ltd", trade: "Joiner", town: "Crieff", email: "hello@strathearnjoinery.co.uk", emailConfidence: "HIGH", emailSource: "Contact page", websiteStatus: "No Website Found", website }) as OutreachLead),
    facts,
  });
  const check = (target: OutreachLead, line: string) =>
    ((verdict) => (verdict.ok ? [] : verdict.problems.map((p) => p.message)))(
      checkEmailQuality({ subject: "A website for Strathearn Joinery?", body: body(line), recipient: target.email, lead: target }),
    );

  it("allows it after a recent search found nothing", () => {
    assert.deepEqual(check(lead(factsWith({ websiteEvidence: searchedNoWebsite() })), "I couldn't find an independent website for Strathearn Joinery."), []);
  });

  it("refuses it when nobody searched, even though the listing said 'No Website Found'", () => {
    const problems = check(lead(factsWith()), "I couldn't find a website for you.");
    assert.ok(problems.some((message) => /no recent web search confirmed/.test(message)), problems.join(" | "));
  });

  it("refuses it when a website is on record", () => {
    const problems = check(lead(factsWith({ websiteEvidence: searchedNoWebsite() }), "https://strathearnjoinery.co.uk"), "You don't seem to have a website.");
    assert.ok(problems.some((message) => /a website is on record/.test(message)), problems.join(" | "));
  });
});

describe("freshness", () => {
  it("fresh for a month, aging to three, then stale", () => {
    const now = new Date(OBSERVED);
    assert.equal(freshness("2026-09-10T00:00:00.000Z", now), "fresh");
    assert.equal(freshness("2026-07-20T00:00:00.000Z", now), "aging");
    assert.equal(freshness("2026-01-01T00:00:00.000Z", now), "stale");
    assert.equal(freshness("", now), "stale");
  });
});
