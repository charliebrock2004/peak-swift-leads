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
  MAX_TRADES,
  parseTrades,
  tradeBreadth,
  planTargets,
  SKIP_LIMIT,
  summarise,
  type AutoSkip,
} from "./auto-run.ts";
import { checkEligibility, matchesFilter } from "./eligibility.ts";
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
    personalisationEvidence: "",
    campaignId: "",
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

  it("only ever stores a known mode, and defaults to dry run", () => {
    assert.equal(clampAutoConfig({ mode: "blast" as never }).mode, "prepare");
    assert.equal(clampAutoConfig({ mode: "prepare" }).mode, "prepare");
    assert.equal(clampAutoConfig({ mode: "send" }).mode, "send");
    assert.equal(DEFAULT_AUTO_CONFIG.mode, "prepare");
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
    const counters = {
      found: 20,
      qualified: 12,
      prepared: 8,
      sent: 0,
      replies: 0,
      skipped: 4,
      errors: 0,
      hot: 5,
      warm: 2,
      call: 1,
      low: 0,
      emailsFound: 8,
    };
    assert.match(summarise(counters, "prepare"), /dry run/i);
    assert.equal(/8 sent/.test(summarise(counters, "prepare")), false);
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

  it("skips the ones that cannot be emailed or rung", () => {
    const plan = planTargets(stirling, context(), 30);
    assert.deepEqual(plan.leadIds, []);
    // Strong no-email businesses with a phone are CALL, not SKIP.
    assert.ok(plan.ringing.length >= 3);
    assert.ok(plan.skipped.length >= 3);
    const groups = groupSkips(plan.skipped);
    assert.ok(groups.some((group) => group.reason === "No public email found" || group.reason === "Low opportunity"));
  });

  it("reports the second reason too, instead of hiding it behind the first", () => {
    // The Companies House rows are Low opportunity AS WELL as having no email.
    // Showing only the first reason sends you looking in the wrong place.
    const plan = planTargets(stirling, context(), 30);
    const companiesHouse = plan.skipped.find((s) => s.businessName === "Stirling Joinery Services Ltd");
    assert.ok(companiesHouse);
    assert.deepEqual(companiesHouse.reasons, ["No public email found", "Low opportunity"]);
    // And a hold that checkEligibility short-circuited past is still reported.
    const soleTrader = planTargets(
      [{ ...stirling[0], id: "st", businessName: "J Smith Joinery", phone: "01786 9" }],
      context(),
      10,
    ).skipped[0];
    assert.ok(soleTrader.reasons.includes("Manual review required"));
  });

  it("explains the dominant reason rather than leaving it as a bare count", () => {
    const plan = planTargets(stirling, context(), 30);
    const reason = dominantSkip(plan.skipped);
    assert.ok(SKIP_ADVICE[reason], `missing advice for ${reason}`);
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
    assert.equal(plan.skipped.length + plan.ringing.length, 7);
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

/**
 * The call list: good prospects with nowhere to write to.
 *
 * The boundary matters more than the feature. "Cannot email them" must never be
 * confused with "must not contact them", so every rule that means the latter is
 * checked here by name.
 */
describe("businesses worth ringing instead", () => {
  function noEmail(partial: Partial<Lead> = {}): OutreachLead {
    return createLead({
      businessName: "Raploch Joinery Ltd",
      trade: "Joiner",
      town: "Stirling",
      phone: "01786 450002",
      email: "",
      emailConfidence: "",
      emailSource: "",
      websiteStatus: "No Website Found",
      businessStatus: "Active",
      called: "Not Called",
      ...partial,
    }) as OutreachLead;
  }

  it("keeps a strong prospect that simply has no published address", () => {
    const plan = planTargets([noEmail({ id: "a" })], context(), 10);
    assert.deepEqual(plan.leadIds, [], "it is still not emailed");
    assert.equal(plan.ringing.length, 1);
    assert.equal(plan.ringing[0].businessName, "Raploch Joinery Ltd");
    assert.equal(plan.ringing[0].band, "High");
  });

  it("carries everything a call actually needs", () => {
    const plan = planTargets([noEmail({ id: "a" })], context(), 10);
    const row = plan.ringing[0];
    assert.equal(row.phone, "01786 450002");
    assert.equal(row.town, "Stirling");
    assert.equal(row.websiteStatus, "No Website Found");
    assert.ok(row.score > 0);
    assert.match(row.reason, /no public email found — call this business instead/i);
  });

  it("does not count a CALL lead as skipped", () => {
    const plan = planTargets([noEmail({ id: "a" })], context(), 10);
    assert.equal(plan.skipped.length, 0);
    assert.equal(plan.ringing.length, 1);
  });

  it("NEVER lists someone who asked not to be contacted", () => {
    for (const patch of [
      { unsubscribed: "2026-01-01" },
      { outreachStatus: "Unsubscribed" },
      { outreachStatus: "Replied" },
      { callResult: "Not Interested" as const },
      { callResult: "Booked" as const },
      { callResult: "Won" as const },
    ]) {
      const plan = planTargets([noEmail({ id: "a", ...patch })], context(), 10);
      assert.deepEqual(plan.ringing, [], `${JSON.stringify(patch)} must never be offered as a call`);
    }
  });

  it("NEVER lists a business already emailed", () => {
    const lead = noEmail({ id: "a", lastEmailedAt: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(planTargets([lead], context(), 10).ringing, []);
  });

  it("NEVER lists a manual-review hold — those stay protected under their own filter", () => {
    const soleTrader = noEmail({ id: "a", businessName: "J Smith Joinery" });
    const plan = planTargets([soleTrader], context(), 10);
    assert.deepEqual(plan.leadIds, []);
    assert.deepEqual(plan.ringing, []);
    assert.ok(plan.skipped[0].reasons.some((r) => /manual review/i.test(r)));
  });

  it("NEVER lists a business whose website is already good", () => {
    const plan = planTargets([noEmail({ id: "a", websiteQuality: "good" })], context(), 10);
    assert.deepEqual(plan.ringing, []);
  });

  it("NEVER lists one with no number to ring", () => {
    assert.deepEqual(planTargets([noEmail({ id: "a", phone: "" })], context(), 10).ringing, []);
  });

  it("NEVER lists a weak opportunity — the list is prospects, not leftovers", () => {
    // A Companies House row with an unconfirmed website scores Low.
    const weak = noEmail({ id: "a", websiteStatus: "Unclear", phone: "" });
    assert.deepEqual(planTargets([weak], context(), 10).ringing, []);
  });

  it("does not list anyone who could simply be emailed", () => {
    const sendable = noEmail({
      id: "a",
      email: "hello@raploch.test",
      emailConfidence: "HIGH",
      emailSource: "Business contact page",
    });
    const plan = planTargets([sendable], context(), 10);
    assert.deepEqual(plan.leadIds, ["a"]);
    assert.deepEqual(plan.ringing, []);
  });

  it("puts the best opportunity at the top of the call list", () => {
    const strong = noEmail({ id: "strong", websiteStatus: "No Website Found", phone: "01786 1" });
    const weaker = noEmail({
      id: "weaker",
      businessName: "Cornton Carpentry Ltd",
      website: "https://cornton.test",
      websiteStatus: "Social Only",
      phone: "01786 2",
    });
    const plan = planTargets([weaker, strong], context(), 10);
    assert.equal(plan.ringing[0].id, "strong");
    assert.equal(plan.ringing.length, 2);
  });

  it("the Prospects filter and the call list agree, always", () => {
    const leads = [
      noEmail({ id: "ring" }),
      noEmail({ id: "sole", businessName: "J Smith Joinery" }),
      noEmail({ id: "nophone", phone: "" }),
      noEmail({ id: "gone", unsubscribed: "2026-01-01" }),
      noEmail({ id: "sendable", email: "a@b.test", emailConfidence: "HIGH", emailSource: "site" }),
    ];
    const fromPlan = new Set(planTargets(leads, context(), 10).ringing.map((r) => r.id));
    const fromFilter = new Set(
      leads
        .filter((lead) => matchesFilter(lead, checkEligibility(lead, context(), "initial"), "worth-ringing"))
        .map((lead) => lead.id),
    );
    assert.deepEqual([...fromFilter].sort(), [...fromPlan].sort());
    assert.deepEqual([...fromPlan], ["ring"]);
  });
});

describe("parseTrades", () => {
  it("keeps a single trade exactly as one trade", () => {
    assert.deepEqual(parseTrades("Joiner"), ["Joiner"]);
    assert.deepEqual(parseTrades("  Joiner  "), ["Joiner"]);
  });

  it("splits a comma list into separate trades", () => {
    assert.deepEqual(parseTrades("Joiner, Plumber, Roofer"), ["Joiner", "Plumber", "Roofer"]);
  });

  it("does not charge twice for the same trade typed twice", () => {
    assert.deepEqual(parseTrades("Joiner, joiner, JOINER"), ["Joiner"]);
  });

  it("drops blanks and stray commas rather than searching for nothing", () => {
    assert.deepEqual(parseTrades("Joiner, , ,Plumber,"), ["Joiner", "Plumber"]);
    assert.deepEqual(parseTrades(""), []);
    assert.deepEqual(parseTrades(",,,"), []);
    assert.deepEqual(parseTrades("a"), [], "one letter is not a trade");
  });

  it("refuses to fan out past the cap, so one run's cost stays predictable", () => {
    const many = parseTrades("Joiner, Plumber, Roofer, Builder, Plasterer, Electrician");
    assert.equal(many.length, MAX_TRADES);
    assert.deepEqual(many, ["Joiner", "Plumber", "Roofer", "Builder"]);
  });
});

describe("tradeBreadth", () => {
  it("gives a single trade the whole breadth", () => {
    assert.equal(tradeBreadth(48, 1), 48);
  });

  it("splits the breadth between trades rather than repeating it", () => {
    const total = 48;
    for (const count of [2, 3, 4]) {
      const each = tradeBreadth(total, count);
      assert.ok(each * count <= total + count, `${count} trades must not multiply the cost`);
    }
  });

  it("never asks for so few that a trade returns nothing", () => {
    assert.ok(tradeBreadth(12, 4) >= 6);
  });

  it("keeps the floor even when it costs more than an even split", () => {
    // searchBreadth never returns less than 12, so this is the smallest real
    // run: four trades of six rather than four trades of three that find nothing.
    assert.equal(tradeBreadth(12, 4), 6);
  });

  it("treats no trades as one trade rather than dividing by zero", () => {
    assert.equal(tradeBreadth(20, 0), tradeBreadth(20, 1));
  });
});

describe("configProblem with several trades", () => {
  const base = { ...DEFAULT_AUTO_CONFIG, location: "Perth", mode: "prepare" as const };

  it("accepts a comma list of trades", () => {
    assert.equal(configProblem({ ...base, businessType: "Joiner, Plumber" }), null);
  });

  it("still refuses a run with no usable trade", () => {
    assert.equal(configProblem({ ...base, businessType: "" }), "Choose a business type.");
    assert.equal(configProblem({ ...base, businessType: " , , " }), "Choose a business type.");
  });
});

describe("planTargets names the real reason an email was not found", () => {
  const ctx = {
    settings: { includeLow: true },
    suppressed: new Set<string>(),
    alreadyContacted: new Set<string>(),
    contactedAddresses: new Set<string>(),
  };

  function noEmailLead(id: string) {
    return {
      id,
      businessName: `Business ${id}`,
      trade: "Joiner",
      town: "Perth",
      phone: "01738 700000",
      email: "",
      emailConfidence: "" as const,
      emailSource: "",
      address: "1 High Street, Perth PH1 5AB",
      website: "",
      websiteStatus: "No Website Found" as const,
      websiteQuality: "" as const,
      websiteAnalysis: "",
      websiteScore: "" as const,
      websiteCheckedAt: "",
      businessStatus: "Active",
      rating: 4.6,
      reviews: 40,
      called: "Not Called" as const,
      callResult: "" as const,
      outreachStatus: "",
      unsubscribed: "",
      lastEmailedAt: "",
      followUpDate: "",
      notes: "",
      mapsLink: "",
      foundAt: "",
      source: "research",
      updatedAt: "",
    };
  }

  it("still says something useful when discovery recorded nothing", () => {
    const plan = planTargets([noEmailLead("a")], ctx, 10);
    const all = [...plan.skipped, ...plan.ringing.map((r) => ({ reasons: [r.reason] }))];
    assert.ok(all.length === 1, "the lead goes somewhere");
    assert.ok(all[0]!.reasons[0]!.length > 0);
  });

  it("replaces the generic no-email line with the cause discovery found", () => {
    const why = new Map([["a", "No search key configured — only the listing and domain guesses were tried"]]);
    // A lead with no phone cannot be rung, so it lands in skipped where the
    // reason text is shown.
    const lead = { ...noEmailLead("a"), phone: "" };
    const plan = planTargets([lead], ctx, 10, undefined, why);
    assert.equal(plan.skipped.length, 1);
    assert.ok(
      plan.skipped[0]!.reasons.some((reason) => reason.includes("No search key configured")),
      `expected the real cause, got ${plan.skipped[0]!.reasons.join(", ")}`,
    );
    assert.ok(
      !plan.skipped[0]!.reasons.includes("No public email found"),
      "the generic line should have been replaced, not added to",
    );
  });

  it("leaves every other refusal reason exactly as it was", () => {
    const why = new Map([["a", "Contact page had no address"]]);
    const unsubscribed = { ...noEmailLead("a"), phone: "", unsubscribed: "2026-01-01" };
    const plan = planTargets([unsubscribed], ctx, 10, undefined, why);
    assert.ok(
      plan.skipped[0]!.reasons.some((reason) => /contact/i.test(reason)),
      "the no-email line is still replaced",
    );
    assert.ok(
      plan.skipped[0]!.reasons.length > 1,
      "the unsubscribe reason must still be listed alongside it",
    );
  });

  it("does not invent a reason for a lead discovery said nothing about", () => {
    const why = new Map([["someone-else", "Contact page had no address"]]);
    const lead = { ...noEmailLead("a"), phone: "" };
    const plan = planTargets([lead], ctx, 10, undefined, why);
    assert.ok(plan.skipped[0]!.reasons.includes("No public email found"));
  });
});
