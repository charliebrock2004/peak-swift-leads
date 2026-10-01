/**
 * AI personalisation 2.0: one angle chosen from evidence, the writer given
 * only that evidence, and every site claim in the text licensed — in code — by
 * a measured audit finding on record for THIS business.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { factsWith, searchedNoWebsite } from "../test-support/facts.ts";
import { selectAngle } from "./angles.ts";
import { buildPrompt, composeEmail } from "./compose.ts";
import { checkEmailQuality } from "./quality.ts";
import type { AuditSummary, OutreachLead } from "./types.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function audit(findings: AuditSummary["keyFindings"], days = 5): AuditSummary {
  return { id: "a1", status: "ok", httpStatus: 200, url: "https://strathearnjoinery.co.uk", finishedAt: ago(days), opportunity: "strong", points: 20, keyFindings: findings };
}

const SLOW: AuditSummary["keyFindings"][number] = { kind: "slow_lcp", title: "Main content slow to appear", evidence: "In PageSpeed's mobile test on 25 Sep, the main content took 6.1 s to appear (Google's target is 2.5 s).", impact: 5, observedAt: ago(5), source: "pagespeed" };
const NO_FORM: AuditSummary["keyFindings"][number] = { kind: "no_enquiry_form", title: "No enquiry form", evidence: "The homepage has no enquiry or contact form.", impact: 7, observedAt: ago(5), source: "homepage" };
const NO_VIEWPORT: AuditSummary["keyFindings"][number] = { kind: "no_viewport", title: "Not set up for phones", evidence: "The homepage has no mobile viewport setting.", impact: 6, observedAt: ago(5), source: "homepage" };

function lead(over: Partial<Lead> = {}, facts = factsWith()): OutreachLead {
  return {
    ...(createLead({
      id: "L",
      businessName: "Strathearn Joinery Ltd",
      trade: "Joiner",
      town: "Crieff",
      email: "hello@strathearnjoinery.co.uk",
      emailConfidence: "HIGH",
      emailSource: "Contact page",
      ...over,
    }) as OutreachLead),
    facts,
  };
}

const withSite = (findings: AuditSummary["keyFindings"], days = 5) =>
  lead({ website: "https://strathearnjoinery.co.uk", websiteStatus: "Proper Website" }, factsWith({ audit: audit(findings, days) }));
const searched = factsWith({ websiteEvidence: searchedNoWebsite({ checkedAt: ago(2) }) });

describe("angle selection", () => {
  it("a well-reviewed business with no website: the reputation gap", () => {
    const choice = selectAngle(lead({ reviews: 40, rating: 4.8 }, searched));
    assert.equal(choice.angle, "reputation_gap");
    assert.deepEqual(choice.evidence.map((item) => item.kind), ["NO_WEBSITE", "WELL_REVIEWED"]);
    assert.ok(choice.alternatives.includes("no_website"));
  });

  it("no website, few reviews: no_website", () => {
    assert.equal(selectAngle(lead({ reviews: 3 }, searched)).angle, "no_website");
  });

  it("an unsearched missing website is not an angle", () => {
    const choice = selectAngle(lead({ websiteStatus: "No Website Found" }));
    assert.equal(choice.angle, "general");
    assert.deepEqual(choice.evidence, []);
  });

  it("a measured site: the highest-impact finding's angle, with only that finding", () => {
    const choice = selectAngle(withSite([NO_FORM, SLOW]));
    assert.equal(choice.angle, "missing_enquiry");
    assert.deepEqual(choice.evidence.map((item) => item.finding), ["no_enquiry_form"]);
    assert.deepEqual(choice.alternatives, ["website_performance"]);
  });

  it("an old audit no longer supports an angle", () => {
    assert.equal(selectAngle(withSite([SLOW], 200)).angle, "general");
  });
});

describe("the writer sees one angle's evidence", () => {
  it("lists the chosen finding and not the others", () => {
    const prompt = buildPrompt(withSite([NO_FORM, SLOW]));
    assert.match(prompt, /The angle for this email — No easy way to enquire/);
    assert.match(prompt, /no enquiry or contact form/);
    assert.doesNotMatch(prompt, /6\.1 s/);
  });

  it("composeEmail records the angle, and a template records only what it says", async () => {
    const ai = await composeEmail(withSite([SLOW]), {
      generate: async () => ({
        subject: "Strathearn Joinery website",
        body: "Hi,\n\nI'm Charlie from PeakSwift Studio. I ran a quick check of the Strathearn Joinery Ltd website: on a phone, the main content took 6.1 seconds to appear.\n\nI build simple, quick sites for joiners around Crieff and could have a look at what's slowing it down.\n\nWould a short chat be useful?\n\nIf you'd rather I didn't contact you again, just let me know and I won't.",
      }),
    });
    assert.equal(ai.generatedBy, "ai", ai.fellBackBecause);
    assert.equal(ai.angle, "website_performance");
    const template = await composeEmail(lead({ reviews: 3, websiteStatus: "No Website Found" }, searched));
    assert.equal(template.angle, "no_website");
  });
});

// ── Claims, checked in code ──────────────────────────────────────────────────

const OPT_OUT = "If you'd rather I didn't contact you again, just let me know and I won't.";
function gate(middle: string, subject: OutreachLead) {
  const body = `Hi,\n\nI'm Charlie from PeakSwift Studio, writing about Strathearn Joinery Ltd. ${middle}\n\nWould a short chat be useful?\n\n${OPT_OUT}\n\nCharlie\nPeakSwift Studio`;
  return checkEmailQuality({ subject: "Strathearn Joinery website", body, recipient: "hello@strathearnjoinery.co.uk", lead: subject });
}
const codes = (verdict: ReturnType<typeof gate>) => (verdict.ok ? [] : verdict.problems.map((problem) => `${problem.code}: ${problem.message}`));

describe("site claims need a measured finding", () => {
  it("a speed claim with the measured number passes; a different number does not", () => {
    assert.deepEqual(codes(gate("On a phone, your website took 6.1 seconds to show its main content.", withSite([SLOW]))), []);
    const wrong = codes(gate("On a phone, your website took 7.8 seconds to show its main content.", withSite([SLOW])));
    assert.ok(wrong.some((problem) => /7\.8/.test(problem)), wrong.join("\n"));
  });

  it("the same speed claim with no audit on record is refused", () => {
    const refused = codes(gate("Your website loads slowly on phones.", lead({ website: "https://strathearnjoinery.co.uk", websiteStatus: "Proper Website" }, factsWith())));
    assert.ok(refused.some((problem) => problem.startsWith("fabricated")), refused.join("\n"));
  });

  it("a mobile claim needs a mobile finding — a speed finding is not enough", () => {
    assert.deepEqual(codes(gate("Your website isn't mobile friendly at the moment.", withSite([NO_VIEWPORT]))), []);
    assert.ok(codes(gate("Your website isn't mobile friendly at the moment.", withSite([SLOW]))).some((problem) => problem.startsWith("fabricated")));
  });

  it("a missing-form claim needs the measured gap", () => {
    assert.deepEqual(codes(gate("There's no contact form on the site, so people have to ring.", withSite([NO_FORM]))), []);
    assert.ok(codes(gate("There's no contact form on the site, so people have to ring.", withSite([SLOW]))).some((problem) => problem.startsWith("fabricated")));
  });

  it("search ranking is never measured, audit or not", () => {
    assert.ok(codes(gate("Your SEO could be a lot better.", withSite([SLOW, NO_FORM, NO_VIEWPORT]))).some((problem) => problem.startsWith("fabricated")));
  });

  it("stale findings license nothing", () => {
    assert.ok(codes(gate("On a phone, your website took 6.1 seconds to show its main content.", withSite([SLOW], 200))).length > 0);
  });

  it("offers with numbers are not claims about their site", () => {
    assert.deepEqual(codes(gate("I usually build a 5-page site in about two weeks.", withSite([SLOW]))), []);
  });
});

describe("writing style", () => {
  it("refuses sales-speak and shouting", () => {
    assert.ok(codes(gate("I just wanted to reach out about your website.", withSite([SLOW]))).some((problem) => problem.startsWith("generic")));
    assert.ok(codes(gate("This could really help! Let's talk!", withSite([SLOW]))).some((problem) => problem.startsWith("generic")));
    assert.ok(codes(gate("I came across your amazing joinery business.", withSite([SLOW]))).length > 0);
  });
});
