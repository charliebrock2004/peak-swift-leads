/**
 * The sales loop: pipeline stages, call outcomes, Today's order, the call
 * brief's honesty, the timeline — and the actions against the real schema.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import type { OutreachEmail, OutreachLead } from "../outreach/types.ts";
import { scoreProspect, type ProspectScore } from "../scoring/prospect-score.ts";
import { factsWith, searchedNoWebsite } from "../test-support/facts.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import * as outreach from "../outreach/store.server.ts";
import { loadDoNotCall } from "../contactability/store.server.ts";
import { callEffects } from "./call-outcomes.ts";
import { buildCallBrief } from "./call-brief.ts";
import { derivedStage, effectiveStage, formatPence, parsePounds, pipelineTotals } from "./pipeline.ts";
import { buildTimeline } from "./timeline.ts";
import { buildToday } from "./today.ts";
import * as sales from "./store.server.ts";
import { addNote, afterReply, logCall, setStage } from "./actions.server.ts";
import type { Opportunity, Task } from "./types.ts";

const NOW = new Date("2026-10-01T09:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function lead(over: Partial<Lead> = {}, facts = factsWith()): OutreachLead {
  return { ...(createLead({ businessName: "Tayside Roofing", trade: "Roofer", town: "Perth", foundAt: ago(10), ...over }) as OutreachLead), facts };
}

function email(over: Partial<OutreachEmail>): OutreachEmail {
  return {
    id: "e1", leadId: "l1", businessName: "Tayside Roofing", recipient: "info@t.co.uk", subject: "Hello", body: "", status: "sent", kind: "initial",
    generatedBy: "ai", sendingAccount: "", gmailMessageId: "", gmailThreadId: "", error: "", attempts: 1, approvedAt: "", sentAt: ago(3), repliedAt: "",
    createdAt: ago(4), updatedAt: ago(3), personalisationEvidence: "", campaignId: "", ...over,
  };
}

const opp = (over: Partial<Opportunity>): Opportunity => ({
  leadId: "l1", stage: "PROSPECT", valuePence: null, expectedClose: "", quoteDate: "", wonDate: "", lostReason: "", nurtureDate: "", notes: "", stageChangedAt: ago(1), updatedAt: ago(1), ...over,
});

describe("pipeline stage", () => {
  it("moves forward from what happened", () => {
    assert.equal(derivedStage(lead()).stage, "PROSPECT");
    assert.equal(derivedStage(lead({ lastEmailedAt: ago(2) })).stage, "CONTACTED");
    assert.equal(derivedStage(lead({ called: "No Answer" })).stage, "CONTACTED");
    assert.equal(derivedStage(lead(), [email({ status: "replied", replyKind: "human" })]).stage, "CONVERSATION");
    assert.equal(derivedStage(lead(), [email({ status: "replied", replyKind: "auto_reply" })]).stage, "CONTACTED", "an out-of-office is not a conversation");
    assert.equal(derivedStage(lead({ callResult: "Booked" })).stage, "MEETING");
    assert.equal(derivedStage(lead({ callResult: "Won" })).stage, "WON");
    assert.equal(derivedStage(lead({ unsubscribed: ago(1) })).stage, "LOST");
  });

  it("never moves backwards by itself, and a person's closing decision stands", () => {
    assert.equal(effectiveStage(opp({ stage: "QUOTE_SENT" }), "CONVERSATION"), "QUOTE_SENT");
    assert.equal(effectiveStage(opp({ stage: "CONTACTED" }), "MEETING"), "MEETING");
    assert.equal(effectiveStage(opp({ stage: "NURTURE" }), "CONVERSATION"), "NURTURE");
    assert.equal(effectiveStage(null, "LOST"), "LOST");
    assert.equal(effectiveStage(opp({ stage: "WON" }), "LOST"), "WON");
  });

  it("money is whole pence and reads like money", () => {
    assert.equal(parsePounds("£4,200"), 420_000);
    assert.equal(parsePounds("4.2k"), 420_000);
    assert.equal(parsePounds("1,250.50"), 125_050);
    assert.equal(parsePounds("lots"), null);
    assert.equal(parsePounds("-5"), null);
    assert.equal(formatPence(420_000), "£4,200");
    assert.equal(formatPence(125_050), "£1,250.50");
    const totals = pipelineTotals([{ stage: "QUOTE_SENT", valuePence: 420_000 }, { stage: "WON", valuePence: 180_000, wonDate: "2026-10-01" }, { stage: "WON", valuePence: 99_000, wonDate: "2026-08-01" }], NOW);
    assert.equal(totals.quotedPence, 420_000);
    assert.equal(totals.wonThisMonthPence, 180_000);
    assert.equal(totals.wonPence, 279_000);
  });
});

describe("call outcomes", () => {
  const today = "2026-10-01";
  it("each outcome moves the right things", () => {
    const callBack = callEffects("call_back", { businessName: "X", followUpDate: "" }, { today, at: "2026-10-03T14:00:00.000Z" });
    assert.equal(callBack.task?.type, "CALL");
    assert.equal(callBack.task?.dueAt, "2026-10-03T14:00:00.000Z");
    assert.equal(callBack.leadPatch.followUpDate, "2026-10-03");
    const interested = callEffects("interested", { businessName: "X", followUpDate: "" }, { today });
    assert.equal(interested.stage, "CONVERSATION");
    assert.equal(interested.task?.type, "FOLLOW_UP");
    assert.equal(callEffects("meeting_booked", { businessName: "X", followUpDate: "" }, { today }).stage, "MEETING");
    const no = callEffects("not_interested", { businessName: "X", followUpDate: "" }, { today });
    assert.equal(no.stage, "LOST");
    assert.equal(no.task, null);
    assert.equal(no.leadPatch.callResult, "Not Interested");
    const wrong = callEffects("wrong_number", { businessName: "X", followUpDate: "" }, { today });
    assert.ok(wrong.doNotCall, "a wrong number goes on the do-not-call list");
    assert.equal(wrong.stage, null);
    assert.equal(callEffects("no_answer", { businessName: "X", followUpDate: "" }, { today }).task, null, "the call list brings no-answers back; no task clutter");
  });
});

describe("Today", () => {
  const scores = (leads: OutreachLead[]) => new Map<string, ProspectScore>(leads.map((item) => [item.id, scoreProspect(item, { now: NOW })]));
  const task = (over: Partial<Task>): Task => ({ id: "t", leadId: "", type: "OTHER", title: "Task", contact: "", dueAt: NOW.toISOString(), priority: "normal", status: "open", notes: "", source: "user", createdAt: ago(1), updatedAt: ago(1), completedAt: "", ...over });

  it("orders by the sale, not by score: replies, hot, quotes, meetings, calls, emails, prospecting", () => {
    const a = lead({ id: "a", businessName: "Replied Ltd" });
    const b = lead({ id: "b", businessName: "Quoted Ltd" });
    const c = lead({ id: "c", businessName: "Meeting Ltd" });
    const d = lead({ id: "d", businessName: "Callback Ltd", phone: "01738 440011" });
    const e = lead({ id: "e", businessName: "Warm Ltd", callResult: "Interested", called: "Interested" });
    const leads = [a, b, c, d, e];
    const plan = buildToday({
      now: NOW,
      leads,
      scores: scores(leads),
      emails: [email({ id: "r1", leadId: "a", businessName: "Replied Ltd", status: "replied", replyKind: "human", repliedAt: ago(1), replySnippet: "Yes please, call me" })],
      tasks: [task({ id: "m", leadId: "c", type: "MEETING", title: "Meeting with Meeting Ltd" }), task({ id: "cb", leadId: "d", type: "CALL", title: "Call Callback Ltd back", dueAt: ago(1) })],
      opportunities: new Map([["b", opp({ leadId: "b", stage: "QUOTE_SENT", valuePence: 120_000, quoteDate: "2026-09-24" })]]),
      sendReady: 3,
      draftsToReview: 2,
      followUpEmailsDue: 1,
      calls: [{ leadId: "d", reason: "Callback due" }],
    });
    assert.deepEqual(plan.steps.map((step) => step.kind), ["reply", "hot", "quote", "meeting", "call", "email", "email", "email", "prospect"]);
    assert.equal(plan.steps[2]!.title, "Chase your £1,200 quote with Quoted Ltd");
    assert.equal(plan.steps.filter((step) => step.leadId === "d").length, 1, "the callback appears once, as its task");
    assert.ok(plan.steps.find((step) => step.leadId === "d")!.overdue);
    assert.equal(plan.counts.replies, 1);
    assert.equal(plan.counts.emailsReady, 5);
    assert.equal(plan.counts.quotes, 1);
    assert.equal(plan.pipeline.quotedPence, 120_000);
  });

  it("a quote is only chased once it has gone quiet, and not if a chase is already booked", () => {
    const b = lead({ id: "b" });
    const base = { now: NOW, leads: [b], scores: scores([b]), emails: [], sendReady: 0, draftsToReview: 0, followUpEmailsDue: 0, calls: [] };
    const fresh = buildToday({ ...base, tasks: [], opportunities: new Map([["b", opp({ leadId: "b", stage: "QUOTE_SENT", quoteDate: "2026-09-30" })]]) });
    assert.equal(fresh.steps.filter((step) => step.kind === "quote").length, 0);
    const booked = buildToday({ ...base, tasks: [task({ leadId: "b", type: "QUOTE", dueAt: new Date(NOW.getTime() + 3 * DAY).toISOString() })], opportunities: new Map([["b", opp({ leadId: "b", stage: "QUOTE_SENT", quoteDate: "2026-09-20" })]]) });
    assert.equal(booked.steps.filter((step) => step.kind === "quote").length, 0);
  });

  it("with nothing on, the day is prospecting", () => {
    const plan = buildToday({ now: NOW, leads: [], scores: new Map(), emails: [], tasks: [], opportunities: new Map(), sendReady: 0, draftsToReview: 0, followUpEmailsDue: 0, calls: [] });
    assert.deepEqual(plan.steps.map((step) => step.title), ["Find 20 new prospects"]);
  });
});

describe("call brief", () => {
  const profile = { senderName: "Charlie", businessName: "Peak Swift", areasServed: "Perthshire", location: "Crieff", cta: "Happy to mock something up first." };

  it("says 'couldn't find a website' only after a search failed to find one", () => {
    const searched = lead({ phone: "01738 440011" }, factsWith({ websiteEvidence: searchedNoWebsite({ checkedAt: ago(2) }) }));
    const brief = buildCallBrief(searched, scoreProspect(searched, { now: NOW }), profile, { now: NOW });
    assert.match(brief.opening, /couldn't find a website for you/);
    assert.ok(brief.why.some((line) => /No independent website found/.test(line.text)));
    assert.ok(brief.why.every((line) => line.source), "every reason has a source");

    const unsearched = lead({ phone: "01738 440011", websiteStatus: "No Website Found" });
    const honest = buildCallBrief(unsearched, scoreProspect(unsearched, { now: NOW }), profile, { now: NOW });
    assert.doesNotMatch(honest.opening, /couldn't find a website/);
  });

  it("names a measured audit finding, and nothing else", () => {
    const audited = lead(
      { website: "https://tayside.co.uk", websiteStatus: "Proper Website", phone: "01738 440011" },
      factsWith({ audit: { id: "a", status: "ok", httpStatus: 200, url: "https://tayside.co.uk", finishedAt: ago(3), opportunity: "strong", points: 20, keyFindings: [{ kind: "no_viewport", title: "Not set up for phones", evidence: "No viewport.", impact: 7, observedAt: ago(3), source: "homepage" }] } }),
    );
    const brief = buildCallBrief(audited, scoreProspect(audited, { now: NOW }), profile, { now: NOW });
    assert.match(brief.opening, /noticed one thing — not set up for phones/);
    assert.match(brief.objections[0]!.response, /not set up for phones/);
    assert.equal(brief.fallback, profile.cta);
  });
});

describe("timeline", () => {
  it("merges every record, newest first", () => {
    const item = lead({ id: "l1", foundAt: ago(10), source: "OpenStreetMap" }, factsWith({ companyCheckedAt: ago(9), companyNumber: "SC1", companyStatus: "active" }));
    const events = buildTimeline({
      lead: item,
      emails: [email({ id: "e1", sentAt: ago(5), status: "replied", repliedAt: ago(4), replySnippet: "Sounds good" })],
      audits: [{ id: "a1", finishedAt: ago(8), status: "ok", opportunity: "strong" }],
      interactions: [{ id: "i1", leadId: "l1", type: "call", outcome: "no_answer", summary: "Called — no answer", detail: {}, occurredAt: ago(1) }],
    });
    assert.deepEqual(events.map((event) => event.title), ["Called — no answer", "They replied", "Email sent", "Website audit completed", "Companies House: SC1 (active)", "Prospect discovered"]);
  });
});

// ── Against the real schema ──────────────────────────────────────────────────

const USER = "owner-1";
let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

async function seed(over: Partial<Lead> = {}) {
  const row = createLead({ id: "l1", businessName: "Tayside Roofing", trade: "Roofer", town: "Perth", phone: "01738 440011", ...over });
  const { text, params } = buildLeadUpsert(USER, [row]);
  await db.sql.query(text, params);
  return row;
}

describe("sales actions", () => {
  it("logging 'call back' records the call, updates the call list, and books the call", async () => {
    await seed();
    const out = await logCall(db.sql, USER, { leadId: "l1", outcome: "call_back", note: "Ring after 3", at: "2026-10-03T15:00:00.000Z", today: "2026-10-01" });
    assert.equal(out.task?.type, "CALL");
    const lead = await outreach.loadLead(db.sql, USER, "l1");
    assert.equal(lead?.callResult, "Callback");
    assert.equal(lead?.followUpDate, "2026-10-03");
    const interactions = await sales.interactionsForLead(db.sql, USER, "l1");
    assert.equal(interactions.find((item) => item.type === "call")?.detail.note, "Ring after 3");
    assert.equal((await sales.loadOpportunity(db.sql, USER, "l1"))?.stage, "CONTACTED");
    // Calling them back closes that task and opens the next one.
    await logCall(db.sql, USER, { leadId: "l1", outcome: "interested", today: "2026-10-03" });
    const tasks = await sales.tasksForLead(db.sql, USER, "l1");
    assert.equal(tasks.find((task) => task.type === "CALL")?.status, "done");
    assert.equal(tasks.find((task) => task.type === "FOLLOW_UP")?.status, "open");
    assert.equal((await sales.loadOpportunity(db.sql, USER, "l1"))?.stage, "CONVERSATION");
  });

  it("a wrong number goes on the do-not-call list; not interested closes the sale as lost", async () => {
    await seed();
    await logCall(db.sql, USER, { leadId: "l1", outcome: "wrong_number" });
    assert.ok((await loadDoNotCall(db.sql, USER)).has("+441738440011"));
    await logCall(db.sql, USER, { leadId: "l1", outcome: "not_interested" });
    const opportunity = await sales.loadOpportunity(db.sql, USER, "l1");
    assert.equal(opportunity?.stage, "LOST");
    assert.match(opportunity?.lostReason ?? "", /Not interested/);
  });

  it("a quote carries its value and date and books its own chase — once", async () => {
    await seed();
    await setStage(db.sql, USER, { leadId: "l1", stage: "QUOTE_SENT", valuePence: 120_000, today: "2026-10-01" });
    await setStage(db.sql, USER, { leadId: "l1", stage: "QUOTE_SENT", today: "2026-10-01" });
    const opportunity = await sales.loadOpportunity(db.sql, USER, "l1");
    assert.equal(opportunity?.valuePence, 120_000, "a second save without a value keeps the value");
    assert.equal(opportunity?.quoteDate, "2026-10-01");
    const chases = (await sales.tasksForLead(db.sql, USER, "l1")).filter((task) => task.type === "QUOTE");
    assert.equal(chases.length, 1);
    assert.equal(chases[0]!.dueAt, "2026-10-05T10:00:00.000Z");
    // Won: open tasks close, and the lead is marked won so outreach never writes to them again.
    await setStage(db.sql, USER, { leadId: "l1", stage: "WON", today: "2026-10-08" });
    assert.equal((await sales.tasksForLead(db.sql, USER, "l1")).filter((task) => task.status === "open").length, 0);
    assert.equal((await outreach.loadLead(db.sql, USER, "l1"))?.callResult, "Won");
    // A later call cannot pull a won sale back.
    await logCall(db.sql, USER, { leadId: "l1", outcome: "no_answer" });
    assert.equal((await sales.loadOpportunity(db.sql, USER, "l1"))?.stage, "WON");
  });

  it("everything is per account", async () => {
    await seed();
    await addNote(db.sql, USER, { leadId: "l1", text: "Owner is Dave" });
    await assert.rejects(addNote(db.sql, "someone-else", { leadId: "l1", text: "x" }), /no longer exists/);
    await assert.rejects(logCall(db.sql, "someone-else", { leadId: "l1", outcome: "interested" }), /no longer exists/);
    assert.equal((await sales.interactionsForLead(db.sql, "someone-else", "l1")).length, 0);
    assert.equal((await sales.loadOpportunities(db.sql, "someone-else")).size, 0);
  });

  it("a reply leaves the right next step — once — and contacts nobody", async () => {
    await seed();
    const reply = { emailId: "e1", leadId: "l1", businessName: "Tayside Roofing", snippet: "Yes please, give me a ring", today: "2026-10-01" };
    const task = await afterReply(db.sql, USER, { ...reply, intent: "positive" });
    assert.equal(task?.type, "REPLY");
    assert.equal(task?.priority, "high");
    await afterReply(db.sql, USER, { ...reply, intent: "positive" });
    assert.equal((await sales.tasksForLead(db.sql, USER, "l1")).length, 1, "polling the same reply twice makes one task");
    const later = await afterReply(db.sql, USER, { ...reply, emailId: "e2", intent: "later" });
    assert.equal(later?.type, "CHECK_BACK");
    assert.equal(later?.dueAt, "2026-11-30T10:00:00.000Z");
    assert.equal(await afterReply(db.sql, USER, { ...reply, emailId: "e3", intent: "negative" }), null);
    const sent = await db.sql.query<{ n: number }>(`select count(*)::int as n from outreach_emails where user_id = $1`, [USER]);
    assert.equal(sent[0]?.n, 0);
  });
});
