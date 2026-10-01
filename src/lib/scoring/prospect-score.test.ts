import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import type { AuditSummary, OutreachLead } from "../outreach/types.ts";
import { factsWith, searchedNoWebsite } from "../test-support/facts.ts";
import { describeBottleneck, rankByScore, scoreProspect, tallyScores } from "./prospect-score.ts";
import { tradeTier } from "./trade-value.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function lead(over: Partial<Lead> = {}, facts = factsWith()): OutreachLead {
  return { ...(createLead({ businessName: "Tayside Roofing Ltd", trade: "Roofer", town: "Perth", websiteStatus: "No Website Found", foundAt: ago(3), ...over }) as OutreachLead), facts };
}

const searched = (days = 2) => factsWith({ websiteEvidence: searchedNoWebsite({ checkedAt: ago(days) }) });
const company = { companyNumber: "SC555555", companyType: "ltd", companyStatus: "active", companyCheckedAt: ago(2) };
const screenedClear = { tps: "clear" as const, ctps: "clear" as const, checkedAt: ago(1) };

function audit(opportunity: AuditSummary["opportunity"], days = 3, keyFindings: AuditSummary["keyFindings"] = []): AuditSummary {
  return { id: "a1", status: "ok", httpStatus: 200, url: "https://tayside.co.uk", finishedAt: ago(days), opportunity, points: 20, keyFindings };
}
const findings: AuditSummary["keyFindings"] = [
  { kind: "no_viewport", title: "Not set up for phones", evidence: "No viewport.", impact: 7, observedAt: ago(3), source: "homepage" },
  { kind: "psi_performance", title: "Mobile performance", evidence: "42/100", impact: 6, observedAt: ago(3), source: "pagespeed" },
];

describe("a strong, emailable prospect", () => {
  const score = scoreProspect(
    lead({ email: "info@taysideroofing.co.uk", emailConfidence: "HIGH", emailSource: "Contact page", phone: "01738 440011", reviews: 48, rating: 4.8 }, { ...searched(), ...company }),
    { now: NOW },
  );

  it("is STRONG with a recommended action of EMAIL", () => {
    assert.equal(score.band, "STRONG");
    assert.equal(score.action, "EMAIL");
    assert.ok(score.priority >= 70);
    assert.deepEqual(score.blockers, []);
  });

  it("explains itself with dated, sourced reasons on every axis", () => {
    const texts = score.why.map((reason) => `${reason.axis}: ${reason.text} [${reason.source}]`);
    assert.ok(texts.some((text) => /need: No independent website found \[website search\]/.test(text)), texts.join("\n"));
    assert.ok(texts.some((text) => /value: 48 reviews averaging 4\.8/.test(text)), texts.join("\n"));
    assert.ok(texts.some((text) => /value: Active registered company \[Companies House\]/.test(text)));
    assert.ok(texts.some((text) => /reach: Email info@taysideroofing\.co\.uk/.test(text)));
    for (const reason of score.why) assert.ok(reason.source, reason.text);
    assert.equal(score.freshness, "fresh");
  });
});

describe("need is measured, never assumed", () => {
  it("an unsearched missing website is plausible, not proven — and blocks the claim", () => {
    const score = scoreProspect(lead({ email: "info@tayside.co.uk", emailConfidence: "HIGH", emailSource: "Contact page" }), { now: NOW });
    assert.equal(score.need.reasons[0]!.text, "No website listed — not yet searched");
    assert.ok(score.need.score < scoreProspect(lead({ email: "info@tayside.co.uk", emailConfidence: "HIGH", emailSource: "Contact page" }, searched()), { now: NOW }).need.score);
    assert.ok(score.blockers.includes("Search for their website before saying they have none"));
  });

  it("a website nobody has audited is a REVIEW: audit first", () => {
    const score = scoreProspect(lead({ website: "https://tayside.co.uk", websiteStatus: "Proper Website", phone: "01738 440011" }), { now: NOW, screening: screenedClear });
    assert.equal(score.action, "REVIEW");
    assert.deepEqual(score.blockers, ["Audit the website"]);
  });

  it("audit findings become the reasons, with their sources", () => {
    const score = scoreProspect(lead({ website: "https://tayside.co.uk", websiteStatus: "Proper Website", phone: "01738 440011" }, factsWith({ audit: audit("strong", 3, findings) })), { now: NOW, screening: screenedClear });
    assert.equal(score.need.level, "high");
    assert.deepEqual(score.need.reasons.map((reason) => [reason.text, reason.source]), [["Not set up for phones", "website audit"], ["Mobile performance", "Google PageSpeed"]]);
    assert.equal(score.action, "CALL");
  });

  it("an audit that found nothing makes it NOT a prospect", () => {
    const score = scoreProspect(lead({ website: "https://tayside.co.uk", websiteStatus: "Proper Website", email: "info@tayside.co.uk", emailConfidence: "HIGH", emailSource: "x" }, factsWith({ ...company, audit: audit("none") })), { now: NOW });
    assert.equal(score.band, "NONE");
    assert.equal(score.action, "SKIP");
    assert.equal(score.actionReason, "No measured website opportunity");
  });

  it("stale evidence counts for less, and says so", () => {
    const fresh = scoreProspect(lead({ website: "https://t.co.uk", websiteStatus: "Proper Website" }, factsWith({ audit: audit("strong", 3, findings) })), { now: NOW });
    const stale = scoreProspect(lead({ website: "https://t.co.uk", websiteStatus: "Proper Website" }, factsWith({ audit: audit("strong", 200, findings) })), { now: NOW });
    assert.ok(stale.need.score < fresh.need.score);
    assert.equal(stale.freshness, "stale");
    assert.ok(stale.need.reasons.some((reason) => /stale — re-check/.test(reason.text)));
  });
});

describe("reach decides the channel", () => {
  it("a sole trader's personal mailbox: CALL, after TPS/CTPS screening", () => {
    const unscreened = scoreProspect(lead({ businessName: "J Smith Roofing", email: "jsmithroofing@gmail.com", emailConfidence: "HIGH", emailSource: "Facebook", phone: "07700 900123" }, searched()), { now: NOW });
    assert.equal(unscreened.action, "CALL");
    assert.equal(unscreened.reach.email, "BLOCKED");
    assert.equal(unscreened.reach.call, "UNKNOWN");
    assert.ok(unscreened.blockers.includes("Screen the number against TPS and CTPS"));
    const screened = scoreProspect(lead({ businessName: "J Smith Roofing", email: "jsmithroofing@gmail.com", emailConfidence: "HIGH", emailSource: "Facebook", phone: "07700 900123" }, searched()), { now: NOW, screening: screenedClear });
    assert.equal(screened.action, "CALL");
    assert.deepEqual(screened.blockers, []);
  });

  it("not confirmed as a company and no phone: REVIEW the legal form", () => {
    const score = scoreProspect(lead({ businessName: "Tayside Roofing", email: "info@tayside.co.uk", emailConfidence: "HIGH", emailSource: "Contact page", phone: "" }, searched()), { now: NOW });
    assert.equal(score.action, "REVIEW");
    assert.deepEqual(score.blockers, ["Confirm the legal form (Companies House)"]);
  });

  it("a number on the do-not-call list, and nothing else: SKIP", () => {
    const score = scoreProspect(lead({ phone: "01738 440011" }, searched()), { now: NOW, doNotCall: { source: "objection", reason: "asked" } });
    assert.equal(score.reach.channel, "none");
    assert.equal(score.action, "SKIP");
  });

  it("a callback they asked for is a CALL even with an emailable address", () => {
    const score = scoreProspect(lead({ email: "info@tayside.co.uk", emailConfidence: "HIGH", emailSource: "x", phone: "01738 440011", callResult: "Callback", called: "Callback" }, { ...searched(), ...company }), { now: NOW });
    assert.equal(score.action, "CALL");
    assert.equal(score.actionReason, "They asked you to call back");
  });

  it("a guessed or low-confidence email is not a channel", () => {
    const score = scoreProspect(lead({ email: "info@tayside.co.uk", emailConfidence: "LOW", emailSource: "x" }, { ...searched(), ...company }), { now: NOW });
    assert.equal(score.reach.email, "NONE");
  });
});

describe("states that override the score", () => {
  const base = { email: "info@tayside.co.uk", emailConfidence: "HIGH" as const, emailSource: "x", phone: "01738 440011" };
  it("unsubscribed or suppressed: SKIP, not a prospect", () => {
    assert.deepEqual([scoreProspect(lead({ ...base, unsubscribed: "2026-09-01" }, searched()), { now: NOW }).action, scoreProspect(lead(base, searched()), { now: NOW, suppressed: true }).action], ["SKIP", "SKIP"]);
  });
  it("replied, already emailed or booked: WAIT", () => {
    assert.equal(scoreProspect(lead({ ...base, outreachStatus: "Replied" }, searched()), { now: NOW }).action, "WAIT");
    assert.equal(scoreProspect(lead({ ...base, lastEmailedAt: ago(2) }, searched()), { now: NOW }).action, "WAIT");
    assert.equal(scoreProspect(lead({ ...base, callResult: "Booked" }, searched()), { now: NOW }).action, "WAIT");
  });
  it("not interested: SKIP", () => {
    assert.equal(scoreProspect(lead({ ...base, callResult: "Not Interested" }, searched()), { now: NOW }).action, "SKIP");
  });
  it("an excluded trade or a closed listing: SKIP", () => {
    assert.equal(scoreProspect(lead(base, searched()), { now: NOW, profile: { excludedTrades: ["roof"] } }).action, "SKIP");
    assert.equal(scoreProspect(lead({ ...base, businessStatus: "Permanently closed" }, searched()), { now: NOW }).action, "SKIP");
  });
});

describe("value", () => {
  it("knows which trades buy bigger projects, and honours the profile", () => {
    assert.equal(tradeTier("Roofer"), "high");
    assert.equal(tradeTier("Hairdresser"), "medium");
    assert.equal(tradeTier("Takeaway"), "low");
    assert.equal(tradeTier("Barber"), "medium", "'bar' is not a pub");
    assert.equal(tradeTier("Interior design"), "high");
    assert.equal(tradeTier("Takeaway", { preferredTrades: ["takeaway"] }), "high");
    assert.equal(tradeTier("Roofer", { excludedTrades: ["roof"] }), "excluded");
  });
});

describe("ranking and summaries", () => {
  it("puts actionable prospects first, then by priority", () => {
    const leads = [
      lead({ id: "wait", lastEmailedAt: ago(1), email: "a@a.co.uk", emailConfidence: "HIGH", emailSource: "x" }, searched()),
      lead({ id: "weak", trade: "Takeaway", phone: "01738 440022" }, factsWith()),
      lead({ id: "strong", email: "info@t.co.uk", emailConfidence: "HIGH", emailSource: "x", reviews: 40 }, { ...searched(), ...company }),
    ];
    const ranked = rankByScore(leads, (item) => scoreProspect(item, { now: NOW, screening: screenedClear }));
    assert.deepEqual(ranked.map((item) => item.id), ["strong", "weak", "wait"]);
  });

  it("tallies and names the bottleneck", () => {
    const leads = [lead({ phone: "01738 440033" }, searched()), lead({ website: "https://x.co.uk", websiteStatus: "Proper Website" })];
    const scores = leads.map((item) => scoreProspect(item, { now: NOW }));
    const tally = tallyScores(leads, scores);
    assert.equal(tally.call, 1);
    assert.equal(tally.review, 1);
    assert.equal(describeBottleneck(scores), "1 prospect to ring — none can be emailed.");
    assert.equal(describeBottleneck([]), "No prospects in this set.");
  });
});
