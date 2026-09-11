import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import {
  appendLog,
  appendSkips,
  autoContext,
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
    assert.match(plan.skipped[0].reason, /manual review/i);
  });

  it("never picks up a suppressed address", () => {
    const ctx = autoContext([], ["hello@strathearnjoinery.co.uk"], DEFAULT_SETTINGS);
    const plan = planTargets([sendable({ id: "a" })], ctx, 10);
    assert.deepEqual(plan.leadIds, []);
    assert.match(plan.skipped[0].reason, /suppression/i);
  });

  it("never picks up a lead that already has a live email", () => {
    const ctx = autoContext([email({ leadId: "a" })], [], DEFAULT_SETTINGS);
    const plan = planTargets([sendable({ id: "a" })], ctx, 10);
    assert.deepEqual(plan.leadIds, []);
    assert.match(plan.skipped[0].reason, /already emailed/i);
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
      reason: "x",
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
