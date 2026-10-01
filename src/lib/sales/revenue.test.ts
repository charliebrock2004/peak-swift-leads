/**
 * Revenue analytics: the funnel from found to won, money, the time between
 * steps, minutes per conversation — and the sample-size rules that keep a
 * handful of cases from being shown as a trend.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import type { OutreachEmail } from "../outreach/types.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import { logCall } from "./actions.server.ts";
import { formatDuration, journeyOf, revenueAnalytics, whatWorksLine, type RevenueInput, type RevenueInteraction, type TimeEntry } from "./revenue.ts";
import * as sales from "./store.server.ts";
import type { Opportunity } from "./types.ts";

const NOW = new Date("2026-10-20T09:00:00.000Z");
const DAY = 86_400_000;
const at = (day: number) => new Date(Date.parse("2026-10-01T09:00:00.000Z") + day * DAY).toISOString();

function lead(id: string, over: Partial<Lead> = {}): Lead {
  return createLead({ id, businessName: `Business ${id}`, trade: "Roofer", town: "Perth", foundAt: at(0), ...over });
}

function email(leadId: string, over: Partial<OutreachEmail> = {}): OutreachEmail {
  return {
    id: `e-${leadId}-${over.kind ?? "initial"}`, leadId, businessName: "", recipient: `${leadId}@example.co.uk`, subject: "Hello", body: "", status: "sent", kind: "initial",
    generatedBy: "ai", sendingAccount: "", gmailMessageId: "", gmailThreadId: "", error: "", attempts: 1, approvedAt: "", sentAt: at(1), repliedAt: "",
    createdAt: at(1), updatedAt: at(1), personalisationEvidence: "", campaignId: "", angle: "no_website", ...over,
  };
}

const opp = (leadId: string, over: Partial<Opportunity>): Opportunity => ({
  leadId, stage: "PROSPECT", valuePence: null, expectedClose: "", quoteDate: "", wonDate: "", lostReason: "", nurtureDate: "", notes: "", stageChangedAt: at(1), updatedAt: at(1), ...over,
});

function input(over: Partial<RevenueInput> = {}): RevenueInput {
  return { now: NOW, leads: [], reachable: () => true, emails: [], opportunities: new Map(), interactions: [], time: [], ...over };
}

describe("one business's journey", () => {
  it("a won customer reached every step, with the dates the evidence gives", () => {
    const journey = journeyOf(
      lead("w"),
      [email("w", { status: "replied", repliedAt: at(3), replyKind: "human", replyIntent: "positive" })],
      opp("w", { stage: "WON", valuePence: 250_000, quoteDate: "2026-10-08", wonDate: "2026-10-12" }),
      [{ leadId: "w", type: "stage_change", outcome: "MEETING", occurredAt: at(5) }],
      false,
    );
    assert.equal(journey.reached, 6);
    assert.equal(journey.channel, "email");
    assert.equal(journey.at.CONTACTED, at(1));
    assert.equal(journey.at.CONVERSATION, at(3));
    assert.equal(journey.at.MEETING, at(5));
    assert.equal(journey.at.QUOTE, "2026-10-08");
    assert.equal(journey.at.WON, "2026-10-12");
  });

  it("an out-of-office or an unsubscribe is not a conversation", () => {
    const ooo = journeyOf(lead("o"), [email("o", { status: "replied", repliedAt: at(2), replyKind: "auto_reply" })], null, [], true);
    assert.equal(ooo.reached, 2, "contacted, no further");
    const unsub = journeyOf(lead("u"), [email("u", { status: "replied", repliedAt: at(2), replyKind: "unsubscribe", replyIntent: "unsubscribe" })], null, [], true);
    assert.equal(unsub.reached, 2);
  });

  it("a call where they were interested is a phone conversation; a lost sale keeps how far it got", () => {
    const history: RevenueInteraction[] = [
      { leadId: "c", type: "call", outcome: "no_answer", occurredAt: at(1) },
      { leadId: "c", type: "call", outcome: "interested", occurredAt: at(2) },
    ];
    const journey = journeyOf(lead("c", { called: "Called", callResult: "Not Interested" }), [], opp("c", { stage: "LOST" }), history, true);
    assert.equal(journey.stage, "LOST");
    assert.equal(journey.reached, 3, "it was a conversation before it was lost");
    assert.equal(journey.channel, "call");
  });
});

describe("revenue analytics", () => {
  it("counts the funnel, money and channels from rows that exist", () => {
    const leads = [lead("a"), lead("b"), lead("c"), lead("d", { trade: "Joiner", town: "Crieff" }), lead("e")];
    const emails = [
      email("a", { status: "replied", repliedAt: at(2), replyKind: "human", replyIntent: "positive" }),
      email("b"),
      email("c", { status: "bounced" }),
    ];
    const opportunities = new Map([
      ["a", opp("a", { stage: "WON", valuePence: 300_000, wonDate: "2026-10-15" })],
      ["d", opp("d", { stage: "QUOTE_SENT", valuePence: 120_000, quoteDate: "2026-10-10" })],
    ]);
    const interactions: RevenueInteraction[] = [{ leadId: "d", type: "call", outcome: "interested", occurredAt: at(4) }];
    const revenue = revenueAnalytics(input({ leads, emails, opportunities, interactions, reachable: (item) => item.id !== "e" }));
    assert.deepEqual(
      revenue.funnel.map((step) => [step.step, step.count]),
      // A quote and a win both passed the meeting step, booked or not.
      [["FOUND", 5], ["CONTACTABLE", 4], ["CONTACTED", 4], ["CONVERSATION", 2], ["MEETING", 2], ["QUOTE", 2], ["WON", 1]],
    );
    assert.equal(revenue.money.wonPence, 300_000);
    assert.equal(revenue.money.wonThisMonthPence, 300_000);
    assert.equal(revenue.money.quotedPence, 120_000);
    assert.equal(revenue.money.averageWonPence, null, "one won job is not an average");
    const [byEmail, byPhone] = revenue.channels;
    assert.equal(byEmail!.conversations, 1);
    assert.equal(byPhone!.conversations, 1);
    assert.equal(byEmail!.touches, 3, "a bounce was still sent");
    assert.equal(revenue.trades[0]!.name, "Roofer", "most money first");
  });

  it("withholds rates, averages and timings below their minimums — and shows them above", () => {
    const few = revenueAnalytics(input({ leads: [lead("a")], emails: [email("a", { status: "replied", repliedAt: at(2), replyKind: "human" })] }));
    assert.equal(few.funnel[3]!.fromPrevious?.value, null);
    assert.equal(few.timings.find((timing) => timing.from === "CONTACTED" && timing.to === "CONVERSATION")?.medianDays, null);
    assert.equal(few.angles[0]?.replyRate.value, null);

    const ids = ["a", "b", "c", "d", "e", "f"];
    const many = revenueAnalytics(
      input({
        leads: ids.map((id) => lead(id)),
        emails: ids.map((id, index) => email(id, { status: "replied", sentAt: at(1), repliedAt: at(1 + index), replyKind: "human" })),
      }),
    );
    const gap = many.timings.find((timing) => timing.from === "CONTACTED" && timing.to === "CONVERSATION");
    assert.equal(gap?.sample, 6);
    assert.equal(gap?.medianDays, 2.5);
    assert.equal(many.funnel[3]!.fromPrevious?.value, 100);
    assert.equal(many.angles[0]?.replyRate.value, 100);
  });

  it("minutes per conversation, per customer and £ per hour use only the measured window", () => {
    const leads = ["a", "b", "c", "old"].map((id) => lead(id));
    const emails = [
      email("a", { status: "replied", repliedAt: at(10), replyKind: "human" }),
      email("b", { status: "replied", repliedAt: at(11), replyKind: "human" }),
      email("c", { status: "replied", repliedAt: at(12), replyKind: "human" }),
      // Before measuring began: not divided into the measured minutes.
      email("old", { status: "replied", repliedAt: at(2), replyKind: "human" }),
    ];
    const time: TimeEntry[] = [
      { day: "2026-10-10", kind: "app", seconds: 3600 },
      { day: "2026-10-11", kind: "call", seconds: 1800 },
      { day: "2026-10-12", kind: "app", seconds: 3600 },
    ];
    const opportunities = new Map([
      ["a", opp("a", { stage: "WON", valuePence: 200_000, wonDate: "2026-10-14" })],
      ["b", opp("b", { stage: "WON", valuePence: 300_000, wonDate: "2026-10-15" })],
      ["old", opp("old", { stage: "WON", valuePence: 900_000, wonDate: "2026-10-05" })],
    ]);
    const { north } = revenueAnalytics(input({ leads, emails, time, opportunities }));
    assert.equal(north.since, "2026-10-10");
    assert.equal(north.conversations, 3);
    assert.equal(north.minutesPerConversation, 50);
    assert.equal(north.customers, 2);
    assert.equal(north.minutesPerCustomer, 75);
    assert.equal(north.wonPence, 500_000);
    assert.equal(north.poundsPerHour, 2000);
  });

  it("before anything is measured there is no per-minute figure at all", () => {
    const { north } = revenueAnalytics(input({ leads: [lead("a")], emails: [email("a", { status: "replied", repliedAt: at(2), replyKind: "human" })] }));
    assert.equal(north.since, "");
    assert.equal(north.minutesPerConversation, null);
    assert.equal(north.conversations, 0);
  });

  it("test emails and deleted businesses are not counted", () => {
    const revenue = revenueAnalytics(input({ leads: [lead("a"), lead("x", { deletedAt: at(3) })], emails: [email("a", { status: "test_sent" })] }));
    assert.equal(revenue.funnel[0]!.count, 1);
    assert.equal(revenue.effort.emailsSent, 0);
  });

  it("names the best trade and town only once their rates mean something", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const leads = [...ids.map((id) => lead(id, { trade: "Joiner", town: "Crieff" })), lead("r", { trade: "Roofer", town: "Perth" })];
    const emails = [
      ...ids.map((id, index) => email(id, index < 2 ? { status: "replied", repliedAt: at(3), replyKind: "human" } : {})),
      email("r", { status: "replied", repliedAt: at(3), replyKind: "human" }),
    ];
    const revenue = revenueAnalytics(input({ leads, emails, opportunities: new Map([["a", opp("a", { stage: "WON", valuePence: 180_000 })]]) }));
    assert.equal(whatWorksLine(revenue.trades, revenue.towns), "Best trade so far: Joiner — 2 conversations from 5 contacted, £1,800 won. Best town: Crieff — 2 conversations from 5 contacted, £1,800 won.");
    // One roofer who replied is 100% — and still not a finding.
    assert.ok(!whatWorksLine(revenue.trades, revenue.towns).includes("Roofer"));
    const thin = revenueAnalytics(input({ leads: [lead("r")], emails: [email("r", { status: "replied", repliedAt: at(3), replyKind: "human" })] }));
    assert.equal(whatWorksLine(thin.trades, thin.towns), "");
  });

  it("formats durations plainly", () => {
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(720), "12m");
    assert.equal(formatDuration(5100), "1h 25m");
    assert.equal(formatDuration(7200), "2h");
  });
});

describe("measured time against the real schema", () => {
  const USER = "owner-1";
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("adds up per day within the caps, and is per account", async () => {
    const day = new Date("2026-10-01T10:00:00.000Z");
    assert.equal(await sales.addTime(db.sql, USER, "app", 300, day), 300);
    assert.equal(await sales.addTime(db.sql, USER, "app", 99_999, day), sales.TIME_REPORT_MAX_SECONDS, "one report is capped");
    assert.equal(await sales.addTime(db.sql, USER, "app", -50, day), 0);
    for (let index = 0; index < 80; index += 1) await sales.addTime(db.sql, USER, "app", 900, day);
    const rows = await sales.loadTime(db.sql, USER);
    assert.deepEqual(rows, [{ day: "2026-10-01", kind: "app", seconds: sales.TIME_DAY_MAX_SECONDS }]);
    assert.deepEqual(await sales.loadTime(db.sql, "someone-else"), []);
  });

  it("a logged call carries its confirmed minutes into the call total", async () => {
    const row = createLead({ id: "l1", businessName: "Tayside Roofing", trade: "Roofer", town: "Perth", phone: "01738 440011" });
    const { text, params } = buildLeadUpsert(USER, [row]);
    await db.sql.query(text, params);
    const out = await logCall(db.sql, USER, { leadId: "l1", outcome: "interested", durationSeconds: 420 });
    assert.equal(out.interaction.detail.durationSeconds, "420");
    const time = await sales.loadTime(db.sql, USER);
    assert.equal(time.find((entry) => entry.kind === "call")?.seconds, 420);
    // An implausible duration is capped at the longest call that is timed.
    await logCall(db.sql, USER, { leadId: "l1", outcome: "no_answer", durationSeconds: 100_000 });
    assert.equal((await sales.loadTime(db.sql, USER)).find((entry) => entry.kind === "call")?.seconds, 420 + sales.CALL_MAX_SECONDS);
    const history = await sales.saleHistory(db.sql, USER);
    assert.ok(history.some((item) => item.type === "call" && item.outcome === "interested"));
    assert.ok(history.some((item) => item.type === "stage_change" && item.outcome === "CONVERSATION"));
  });
});
