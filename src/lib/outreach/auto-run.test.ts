import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeOpportunity, createLead, type Lead } from "../leads.ts";
import {
  appendLog,
  appendSkips,
  autoContext,
  dominantSkip,
  groupSkips,
  mergePatches,
  searchBreadth,
  SKIP_ADVICE,
  AUTO_DAILY_MAX,
  AUTO_TARGET_MAX,
  batchDelayMs,
  clampAutoConfig,
  configProblem,
  DEFAULT_AUTO_CONFIG,
  initialRunState,
  isFinished,
  isRunning,
  LOG_LIMIT,
  planTargets,
  SKIP_LIMIT,
  summarise,
  type AutoSkip,
} from "./auto-run.ts";
import { DEFAULT_SETTINGS, type OutreachEmail, type OutreachLead } from "./types.ts";

/** A lead the shared gate lets through, so each test breaks exactly one thing. */
function sendable(partial: Partial<Lead> = {}): OutreachLead {
  return createLead({
    businessName: "Strathearn Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    email: "hello@strathearnjoinery.co.uk",
    emailConfidence: "HIGH",
    emailSource: "website contact page",
    websiteStatus: "No Website Found",
    businessStatus: "Active",
    ...partial,
  }) as OutreachLead;
}

function email(partial: Partial<OutreachEmail> = {}): OutreachEmail {
  return {
    id: "e1",
    leadId: "l1",
    businessName: "Strathearn Joinery Ltd",
    recipient: "hello@strathearnjoinery.co.uk",
    subject: "s",
    body: "b",
    status: "sent",
    kind: "initial",
    generatedBy: "ai",
    sendingAccount: "",
    gmailMessageId: "",
    gmailThreadId: "",
    error: "",
    attempts: 0,
    approvedAt: "",
    sentAt: new Date().toISOString(),
    repliedAt: "",
    createdAt: "",
    updatedAt: "",
    ...partial,
  };
}

const context = () => autoContext([], [], DEFAULT_SETTINGS);

describe("what a run may be asked to do", () => {
  it("clamps the daily limit to the product ceiling", () => {
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, dailyLimit: 500 }).dailyLimit, AUTO_DAILY_MAX);
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, dailyLimit: -4 }).dailyLimit, 0);
  });

  it("clamps how many businesses one run may target", () => {
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, target: 9999 }).target, AUTO_TARGET_MAX);
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, target: 0 }).target, 1);
  });

  it("falls back rather than accepting nonsense", () => {
    const config = clampAutoConfig({ target: Number.NaN, dailyLimit: undefined });
    assert.equal(config.target, DEFAULT_AUTO_CONFIG.target);
    assert.equal(config.dailyLimit, DEFAULT_AUTO_CONFIG.dailyLimit);
  });

  it("only ever stores a known mode", () => {
    assert.equal(clampAutoConfig({ mode: "blast" as never }).mode, "send");
    assert.equal(clampAutoConfig({ mode: "prepare" }).mode, "prepare");
  });

  it("refuses to start without a place and a trade", () => {
    assert.ok(configProblem(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, location: "" })));
    assert.ok(configProblem(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, businessType: "" })));
    assert.equal(configProblem(clampAutoConfig(DEFAULT_AUTO_CONFIG)), null);
  });

  it("refuses to send with a daily limit of zero, but will still prepare", () => {
    assert.ok(configProblem(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, dailyLimit: 0, mode: "send" })));
    assert.equal(configProblem(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, dailyLimit: 0, mode: "prepare" })), null);
  });
});

describe("choosing who to write to", () => {
  it("takes an eligible lead", () => {
    const plan = planTargets([sendable({ id: "a" })], context(), 10);
    assert.deepEqual(plan.leadIds, ["a"]);
    assert.equal(plan.skipped.length, 0);
  });

  it("never picks up a lead held for manual review", () => {
    // A sole trader's personal mailbox is the strongest hold signal there is.
    const soleTrader = sendable({ id: "a", businessName: "J Smith Joinery", email: "jsmith@gmail.com" });
    const plan = planTargets([soleTrader], context(), 10);
    assert.deepEqual(plan.leadIds, []);
    assert.equal(plan.skipped.length, 1);
    assert.ok(plan.skipped[0].reasons.some((r) => /manual review/i.test(r)));
  });

  it("never picks up a suppressed address", () => {
    const ctx = autoContext([], ["hello@strathearnjoinery.co.uk"], DEFAULT_SETTINGS);
    const plan = planTargets([sendable({ id: "a" })], ctx, 10);
    assert.deepEqual(plan.leadIds, []);
    assert.ok(plan.skipped[0].reasons.some((r) => /suppression/i.test(r)));
  });

  it("never picks up a lead that already has a live email", () => {
    const ctx = autoContext([email({ leadId: "a" })], [], DEFAULT_SETTINGS);
    const plan = planTargets([sendable({ id: "a" })], ctx, 10);
    assert.deepEqual(plan.leadIds, []);
    assert.ok(plan.skipped[0].reasons.some((r) => /already emailed/i.test(r)));
  });

  it("never picks up a second lead sharing an address already written to", () => {
    const ctx = autoContext([email({ leadId: "other" })], [], DEFAULT_SETTINGS);
    const plan = planTargets([sendable({ id: "a" })], ctx, 10);
    assert.deepEqual(plan.leadIds, []);
  });

  it("respects unsubscribed, replied, booked, won and not-interested", () => {
    const cases: Partial<Lead>[] = [
      { unsubscribed: "2026-01-01" },
      { outreachStatus: "Replied" },
      { callResult: "Booked" },
      { callResult: "Won" },
      { callResult: "Not Interested" },
    ];
    for (const [index, patch] of cases.entries()) {
      const plan = planTargets([sendable({ id: `l${index}`, ...patch })], context(), 10);
      assert.deepEqual(plan.leadIds, [], `${JSON.stringify(patch)} should never be targeted`);
    }
  });

  it("refuses a guessed or low-confidence address", () => {
    assert.deepEqual(planTargets([sendable({ id: "a", emailConfidence: "LOW" })], context(), 10).leadIds, []);
    assert.deepEqual(
      planTargets([sendable({ id: "a", emailSource: "Guessed from domain" })], context(), 10).leadIds,
      [],
    );
  });

  it("leaves a business whose website is already good alone", () => {
    const plan = planTargets([sendable({ id: "a", websiteQuality: "good" })], context(), 10);
    assert.deepEqual(plan.leadIds, []);
  });

  it("never returns more leads than the remaining allowance", () => {
    const leads = Array.from({ length: 12 }, (_, index) =>
      sendable({ id: `l${index}`, email: `hello@business${index}.co.uk` }),
    );
    const plan = planTargets(leads, context(), 4);
    assert.equal(plan.leadIds.length, 4);
    assert.equal(plan.heldForTomorrow, 8);
  });

  it("returns nothing at all when there is no allowance left", () => {
    const plan = planTargets([sendable({ id: "a" })], context(), 0);
    assert.deepEqual(plan.leadIds, []);
    assert.equal(plan.heldForTomorrow, 1);
  });

  it("writes to the best opportunity first", () => {
    const strong = sendable({ id: "strong", email: "a@one.co.uk", websiteStatus: "No Website Found" });
    const weaker = sendable({
      id: "weaker",
      email: "b@two.co.uk",
      website: "https://two.co.uk",
      websiteStatus: "Basic Website",
      websiteQuality: "improve",
    });
    const plan = planTargets([weaker, strong], context(), 2);
    assert.equal(plan.leadIds[0], "strong");
  });

  it("only considers the leads a run actually found, when asked to", () => {
    const found = sendable({ id: "found" });
    const older = sendable({ id: "older", email: "old@elsewhere.co.uk" });
    const plan = planTargets([found, older], context(), 10, new Set(["found"]));
    assert.deepEqual(plan.leadIds, ["found"]);
    assert.equal(plan.skipped.length, 0, "leads outside the run are not counted as skipped");
  });
});

describe("the run's own bookkeeping", () => {
  it("starts empty and idle", () => {
    const state = initialRunState(clampAutoConfig(DEFAULT_AUTO_CONFIG));
    assert.equal(state.phase, "idle");
    assert.equal(state.counters.sent, 0);
    assert.equal(isRunning(state.phase), false);
  });

  it("knows which phases are running and which are over", () => {
    assert.ok(isRunning("sending"));
    assert.ok(isFinished("done") && isFinished("stopped") && isFinished("failed"));
    assert.equal(isRunning("done"), false);
    assert.equal(isFinished("idle"), false);
  });

  it("bounds the log and the skip list so a long run cannot grow forever", () => {
    let log = appendLog([], "first");
    for (let index = 0; index < LOG_LIMIT + 50; index += 1) log = appendLog(log, `line ${index}`);
    assert.equal(log.length, LOG_LIMIT);
    assert.equal(log.at(-1)?.text, `line ${LOG_LIMIT + 49}`);

    const many: AutoSkip[] = Array.from({ length: SKIP_LIMIT + 20 }, (_, i) => ({
      businessName: `b${i}`,
      reasons: ["x"],
    }));
    assert.equal(appendSkips([], many).length, SKIP_LIMIT);
  });

  it("throttles batches with the delay the manual queue already uses", () => {
    assert.equal(batchDelayMs({ delaySeconds: 45 }), 45_000);
    assert.equal(batchDelayMs({ delaySeconds: 1 }), 5_000, "never faster than the floor");
    assert.equal(batchDelayMs({ delaySeconds: 9_999 }), 600_000, "never slower than the ceiling");
    assert.equal(batchDelayMs({ delaySeconds: Number.NaN }), 45_000);
  });

  it("summarises a run without claiming sends it did not make", () => {
    const counters = { found: 20, qualified: 12, prepared: 8, sent: 0, replies: 0, skipped: 4, errors: 0 };
    assert.equal(summarise(counters, "prepare").includes("sent"), false);
    assert.ok(summarise({ ...counters, sent: 8 }, "send").includes("8 sent"));
  });
});

/**
 * The Stirling run: 8 businesses found, 0 qualified, 8 skipped.
 *
 * These lock down what actually happened, so a future change cannot quietly
 * reintroduce it — and so the reason it happened stays visible rather than
 * being papered over by loosening a rule.
 */
describe("a search that turns up nothing contactable", () => {
  /** What discovery produces: Companies House gives "Unclear", OSM "No Website Found". */
  function found(partial: Partial<Lead> = {}): OutreachLead {
    return createLead({
      trade: "Joiner",
      town: "Stirling",
      businessStatus: "Active",
      called: "Not Called",
      // Nothing in discovery supplies an address for most businesses.
      email: "",
      emailSource: "",
      emailConfidence: "",
      ...partial,
    }) as OutreachLead;
  }

  const stirling: OutreachLead[] = [
    found({ id: "ch-1", businessName: "Stirling Joinery Services Ltd", websiteStatus: "Unclear" }),
    found({ id: "ch-2", businessName: "Forth Valley Carpentry Ltd", websiteStatus: "Unclear" }),
    found({ id: "ch-3", businessName: "Bannockburn Joiners Ltd", websiteStatus: "Unclear" }),
    found({ id: "osm-1", businessName: "Kings Park Woodwork Ltd", websiteStatus: "No Website Found", phone: "01786 450001" }),
    found({ id: "osm-2", businessName: "Raploch Joinery Ltd", websiteStatus: "No Website Found", phone: "01786 450002" }),
    found({ id: "osm-3", businessName: "Causewayhead Carpentry Ltd", website: "https://facebook.com/cw", websiteStatus: "Social Only", phone: "01786 450003" }),
    found({ id: "osm-4", businessName: "Bridge of Allan Joiners Ltd", website: "https://boa.co.uk", websiteStatus: "Basic Website", phone: "01786 450004" }),
    found({ id: "osm-5", businessName: "Cambusbarron Woodcraft Ltd", website: "https://cw.co.uk", websiteStatus: "Proper Website", phone: "01786 450005" }),
  ];

  it("skips every one of them, and it is the missing email that does it", () => {
    const plan = planTargets(stirling, context(), 30);
    assert.deepEqual(plan.leadIds, []);
    assert.equal(plan.skipped.length, 8);
    const groups = groupSkips(plan.skipped);
    assert.equal(groups[0].reason, "No public email found");
    assert.equal(groups[0].count, 8, "all eight failed for the same reason");
  });

  it("reports the second reason too, instead of hiding it behind the first", () => {
    // The Companies House rows are Low opportunity AS WELL as having no email.
    // Showing only the first reason sends you looking in the wrong place.
    const plan = planTargets(stirling, context(), 30);
    const companiesHouse = plan.skipped.find((s) => s.businessName === "Stirling Joinery Services Ltd");
    assert.ok(companiesHouse);
    assert.deepEqual(companiesHouse.reasons, ["No public email found", "Low opportunity"]);
  });

  it("explains the dominant reason rather than leaving it as a bare count", () => {
    const plan = planTargets(stirling, context(), 30);
    assert.equal(dominantSkip(plan.skipped), "No public email found");
    assert.match(SKIP_ADVICE[dominantSkip(plan.skipped)], /never guesses an address/i);
  });

  it("qualifies the one business that has a real, scrapeable opportunity", () => {
    // What the email lookup can actually achieve: an address from the one site
    // it could fetch. Nothing else about the eight changes.
    const enriched = stirling.map((lead) =>
      lead.id === "osm-4"
        ? { ...lead, email: "info@boa.co.uk", emailSource: "Business contact page", emailConfidence: "HIGH" as const }
        : lead,
    );
    const plan = planTargets(enriched, context(), 30);
    assert.deepEqual(plan.leadIds, ["osm-4"]);
    assert.equal(plan.skipped.length, 7);
  });

  it("still refuses the good-website business even once it has an address", () => {
    const enriched = stirling.map((lead) =>
      lead.id === "osm-5"
        ? {
            ...lead,
            email: "info@cw.co.uk",
            emailSource: "Business contact page",
            emailConfidence: "HIGH" as const,
            websiteQuality: "good" as const,
          }
        : lead,
    );
    const plan = planTargets(enriched, context(), 30);
    assert.equal(plan.leadIds.includes("osm-5"), false);
    const row = plan.skipped.find((s) => s.businessName === "Cambusbarron Woodcraft Ltd");
    assert.ok(row?.reasons.includes("Their website is already good"));
  });
});

describe("counting the reasons a run skipped things", () => {
  it("folds repeats together, commonest first", () => {
    const groups = groupSkips([
      { businessName: "a", reasons: ["No public email found"] },
      { businessName: "b", reasons: ["No public email found", "Low opportunity"] },
      { businessName: "c", reasons: ["No public email found"] },
      { businessName: "d", reasons: ["Low opportunity"] },
    ]);
    assert.deepEqual(groups, [
      { reason: "No public email found", count: 3 },
      { reason: "Low opportunity", count: 2 },
    ]);
  });

  it("copes with a skip that carries no reason at all", () => {
    assert.deepEqual(groupSkips([{ businessName: "a", reasons: [] }]), [
      { reason: "Not eligible", count: 1 },
    ]);
  });

  it("has nothing to say about an empty list", () => {
    assert.deepEqual(groupSkips([]), []);
    assert.equal(dominantSkip([]), "");
  });
});

describe("keeping both halves of the qualify step", () => {
  it("merges the website patch and the email patch instead of losing one", () => {
    // The store keys patches by lead id, so handing it two entries for one lead
    // means the second replaces the first — and the website check always runs
    // first. This is the bug that threw away every website quality score.
    const merged = mergePatches([
      { id: "a", patch: { websiteQuality: "poor", websiteScore: 22, websiteAnalysis: "Thin page." } },
      { id: "a", patch: { email: "hello@a.test", emailConfidence: "HIGH" } },
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].patch, {
      websiteQuality: "poor",
      websiteScore: 22,
      websiteAnalysis: "Thin page.",
      email: "hello@a.test",
      emailConfidence: "HIGH",
    });
  });

  it("lets the later patch win on a field both of them set", () => {
    const merged = mergePatches([
      { id: "a", patch: { email: "old@a.test" } },
      { id: "a", patch: { email: "new@a.test" } },
    ]);
    assert.equal(merged[0].patch.email, "new@a.test");
  });

  it("keeps separate leads separate", () => {
    const merged = mergePatches([
      { id: "a", patch: { email: "a@x.test" } },
      { id: "b", patch: { email: "b@x.test" } },
    ]);
    assert.equal(merged.length, 2);
  });

  it("a lost website patch costs a poor-website lead its opportunity", () => {
    // Why the merge matters: without the website patch the lead is scored on
    // its status alone, and a poor site scores lower than it should.
    const base = createLead({
      businessName: "Doune Joinery Ltd",
      email: "hello@doune.test",
      emailConfidence: "HIGH",
      emailSource: "Business contact page",
      website: "https://doune.test",
      websiteStatus: "Proper Website",
      businessStatus: "Active",
      phone: "01786 450010",
    }) as OutreachLead;
    const withoutQuality = computeOpportunity(base as Lead);
    const withQuality = computeOpportunity({ ...base, websiteQuality: "poor" } as Lead);
    assert.ok(
      withQuality > withoutQuality,
      `losing the website patch drops the score from ${withQuality} to ${withoutQuality}`,
    );
  });
});

describe("how wide a run searches", () => {
  it("looks at several times the number it expects to contact", () => {
    // Most businesses found cannot be emailed at all, so searching for exactly
    // the target is how a run ends with nothing to send.
    assert.ok(searchBreadth(8) > 8);
    assert.equal(searchBreadth(8), 32);
  });

  it("never asks for fewer than one full batch", () => {
    assert.equal(searchBreadth(1), 12);
  });

  it("stays within what the search itself accepts", () => {
    assert.equal(searchBreadth(50), 100);
    assert.equal(searchBreadth(9999), 100);
  });
});
