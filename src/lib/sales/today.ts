/**
 * TODAY — what to do right now, in order.
 *
 * Not a sort by score: the order is the order a sale is won in. Someone
 * waiting on your reply beats everything; a warm conversation beats a quote to
 * chase; a quote beats a meeting reminder; all of that beats ringing someone
 * new; and finding new prospects is what you do once the rest is done.
 *
 *   1 replies · 2 hot opportunities · 3 quotes · 4 meetings · 5 calls ·
 *   6 emails · 7 prospecting
 *
 * Pure: the server gathers the rows, this decides.
 */
import type { OutreachEmail, OutreachLead } from "../outreach/types.ts";
import type { ProspectScore } from "../scoring/prospect-score.ts";
import { derivedStage, effectiveStage, formatPence, pipelineTotals } from "./pipeline.ts";
import type { Opportunity, Stage, Task } from "./types.ts";

export type TodayLink = { to: "/replies" | "/calls" | "/send" | "/find" | "/pipeline" | "/businesses/$leadId"; leadId?: string };

export type TodayStep = {
  key: string;
  group: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  kind: "reply" | "hot" | "quote" | "meeting" | "call" | "task" | "email" | "prospect";
  title: string;
  detail: string;
  leadId: string;
  link: TodayLink;
  dueAt: string;
  overdue: boolean;
  taskId: string;
};

export type TodayPlan = {
  counts: { replies: number; calls: number; emailsReady: number; followUps: number; quotes: number; meetings: number };
  pipeline: { quotedPence: number; wonThisMonthPence: number; openCount: number; openPence: number };
  steps: TodayStep[];
  /** Strong or good prospects nobody has contacted yet. */
  prospectsLeft: number;
};

export type TodayInput = {
  now: Date;
  leads: readonly OutreachLead[];
  scores: ReadonlyMap<string, ProspectScore>;
  emails: readonly OutreachEmail[];
  /** Open tasks. */
  tasks: readonly Task[];
  opportunities: ReadonlyMap<string, Opportunity>;
  /** Approved emails that fit today's sending allowance. */
  sendReady: number;
  draftsToReview: number;
  followUpEmailsDue: number;
  /** Today's call list (callbacks due, then good prospects to ring), already filtered to callable numbers. */
  calls: readonly { leadId: string; reason: string }[];
  /** Your next search, from the workspace profile ("Joiners, Roofers around Perth"), or "". */
  searchHint?: string;
};

/** Quotes go quiet after this many days without a chase. */
export const QUOTE_CHASE_DAYS = 4;
/** Individual call steps before the rest are one "ring N more" step. */
const CALL_STEPS = 5;
const DAY = 86_400_000;

function endOfDay(now: Date): number {
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  return end.getTime();
}

export function buildToday(input: TodayInput): TodayPlan {
  const { now } = input;
  const leadsById = new Map(input.leads.map((lead) => [lead.id, lead]));
  const nameOf = (id: string) => leadsById.get(id)?.businessName || "a business";
  const eod = endOfDay(now);
  const startOfToday = eod - DAY + 1;
  const steps: TodayStep[] = [];
  const claimed = new Set<string>(); // `${group}:${leadId}` — one step per business per group
  const usedTasks = new Set<string>();

  const due = (task: Task) => !task.dueAt || Date.parse(task.dueAt) <= eod;
  const overdue = (iso: string) => Boolean(iso) && Date.parse(iso) < startOfToday;
  const add = (step: Omit<TodayStep, "overdue" | "taskId" | "dueAt"> & { dueAt?: string; taskId?: string }) => {
    if (step.leadId && claimed.has(`${step.group}:${step.leadId}`)) return false;
    if (step.leadId) claimed.add(`${step.group}:${step.leadId}`);
    if (step.taskId) usedTasks.add(step.taskId);
    steps.push({ dueAt: "", taskId: "", ...step, overdue: overdue(step.dueAt ?? "") });
    return true;
  };
  const openTasks = input.tasks.filter((task) => task.status === "open");
  const tasksOf = (type: Task["type"]) => openTasks.filter((task) => task.type === type && due(task)).sort((a, b) => (a.dueAt || "").localeCompare(b.dueAt || ""));

  // Emails by business, and the stage each sale is really at.
  const emailsByLead = new Map<string, OutreachEmail[]>();
  for (const email of input.emails) {
    const list = emailsByLead.get(email.leadId) ?? [];
    list.push(email);
    emailsByLead.set(email.leadId, list);
  }
  const stageOf = (lead: OutreachLead): Stage => effectiveStage(input.opportunities.get(lead.id) ?? null, derivedStage(lead, emailsByLead.get(lead.id) ?? []).stage);

  // 1 — Someone is waiting on you.
  const waiting = input.emails
    .filter((email) => email.status === "replied" && (email.replyKind === "human" || !email.replyKind) && (!email.replyStage || email.replyStage === "new"))
    .sort((a, b) => (a.repliedAt || "").localeCompare(b.repliedAt || ""));
  for (const email of waiting) {
    add({
      key: `reply-${email.id}`,
      group: 1,
      kind: "reply",
      title: `Reply to ${email.businessName || nameOf(email.leadId)}`,
      detail: email.replySnippet ? `“${email.replySnippet.slice(0, 120)}”` : "They replied to your email.",
      leadId: email.leadId,
      link: { to: "/replies" },
      dueAt: email.repliedAt,
    });
  }
  for (const task of tasksOf("REPLY")) {
    add({ key: `task-${task.id}`, group: 1, kind: "reply", title: task.title, detail: task.notes, leadId: task.leadId, link: task.leadId ? { to: "/businesses/$leadId", leadId: task.leadId } : { to: "/replies" }, dueAt: task.dueAt, taskId: task.id });
  }

  // 2 — Warm conversations that need the next step.
  for (const task of tasksOf("FOLLOW_UP")) {
    add({ key: `task-${task.id}`, group: 2, kind: "hot", title: task.title, detail: task.notes || "They showed interest — keep it moving.", leadId: task.leadId, link: { to: "/businesses/$leadId", leadId: task.leadId }, dueAt: task.dueAt, taskId: task.id });
  }
  const hasFutureTask = (leadId: string) => openTasks.some((task) => task.leadId === leadId && task.dueAt && Date.parse(task.dueAt) > eod);
  for (const lead of input.leads) {
    if (stageOf(lead) !== "CONVERSATION" || hasFutureTask(lead.id)) continue;
    const replied = (emailsByLead.get(lead.id) ?? []).some((email) => email.replyStage === "interested" || email.replyStage === "needs_follow_up");
    const interested = lead.callResult === "Interested" || lead.called === "Interested";
    if (!replied && !interested) continue;
    add({
      key: `hot-${lead.id}`,
      group: 2,
      kind: "hot",
      title: `Agree a next step with ${lead.businessName}`,
      detail: replied ? "Interested by email — nothing booked yet." : "Interested on the phone — nothing booked yet.",
      leadId: lead.id,
      link: { to: "/businesses/$leadId", leadId: lead.id },
    });
  }

  // 3 — Quotes that have gone quiet.
  for (const task of tasksOf("QUOTE")) {
    add({ key: `task-${task.id}`, group: 3, kind: "quote", title: task.title, detail: task.notes, leadId: task.leadId, link: { to: "/businesses/$leadId", leadId: task.leadId }, dueAt: task.dueAt, taskId: task.id });
  }
  for (const [leadId, opportunity] of input.opportunities) {
    if (opportunity.stage !== "QUOTE_SENT" || !leadsById.has(leadId) || hasFutureTask(leadId)) continue;
    const sent = Date.parse(opportunity.quoteDate || opportunity.stageChangedAt);
    if (!Number.isFinite(sent) || now.getTime() - sent < QUOTE_CHASE_DAYS * DAY) continue;
    const days = Math.floor((now.getTime() - sent) / DAY);
    const value = formatPence(opportunity.valuePence);
    add({
      key: `quote-${leadId}`,
      group: 3,
      kind: "quote",
      title: `Chase your ${value ? `${value} ` : ""}quote with ${nameOf(leadId)}`,
      detail: `Sent ${days} days ago.`,
      leadId,
      link: { to: "/businesses/$leadId", leadId },
    });
  }

  // 4 — Meetings today (and any missed).
  for (const task of tasksOf("MEETING")) {
    add({ key: `task-${task.id}`, group: 4, kind: "meeting", title: task.title, detail: task.notes, leadId: task.leadId, link: { to: "/businesses/$leadId", leadId: task.leadId }, dueAt: task.dueAt, taskId: task.id });
  }

  // 5 — Calls: the ones you promised first, then the best new ones.
  let callSteps = 0;
  for (const task of tasksOf("CALL")) {
    if (add({ key: `task-${task.id}`, group: 5, kind: "call", title: task.title, detail: task.notes, leadId: task.leadId, link: task.leadId ? { to: "/businesses/$leadId", leadId: task.leadId } : { to: "/calls" }, dueAt: task.dueAt, taskId: task.id })) callSteps += 1;
  }
  let extraCalls = 0;
  for (const call of input.calls) {
    if (claimed.has(`5:${call.leadId}`)) continue;
    if (callSteps < CALL_STEPS) {
      if (add({ key: `call-${call.leadId}`, group: 5, kind: "call", title: `Call ${nameOf(call.leadId)}`, detail: call.reason, leadId: call.leadId, link: { to: "/calls" } })) callSteps += 1;
    } else extraCalls += 1;
  }
  if (extraCalls > 0) {
    add({ key: "calls-more", group: 5, kind: "call", title: `Ring ${extraCalls} more ${extraCalls === 1 ? "prospect" : "prospects"}`, detail: "Your call list, best first.", leadId: "", link: { to: "/calls" } });
  }
  for (const task of openTasks.filter((item) => (item.type === "CHECK_BACK" || item.type === "REVIEW" || item.type === "OTHER") && due(item))) {
    if (usedTasks.has(task.id)) continue;
    add({ key: `task-${task.id}`, group: 5, kind: "task", title: task.title, detail: task.notes, leadId: task.leadId, link: task.leadId ? { to: "/businesses/$leadId", leadId: task.leadId } : { to: "/pipeline" }, dueAt: task.dueAt, taskId: task.id });
  }

  // 6 — Emails: send what you approved, review what is drafted.
  if (input.sendReady > 0) {
    add({ key: "send", group: 6, kind: "email", title: `Send ${input.sendReady} approved ${input.sendReady === 1 ? "email" : "emails"}`, detail: "Approved by you and within today's limit.", leadId: "", link: { to: "/send" } });
  }
  if (input.draftsToReview > 0) {
    add({ key: "review", group: 6, kind: "email", title: `Review ${input.draftsToReview} ${input.draftsToReview === 1 ? "draft" : "drafts"}`, detail: "Read, edit or skip — nothing goes until you approve it.", leadId: "", link: { to: "/send" } });
  }
  if (input.followUpEmailsDue > 0) {
    add({ key: "follow-ups", group: 6, kind: "email", title: `${input.followUpEmailsDue} follow-up ${input.followUpEmailsDue === 1 ? "email is" : "emails are"} due`, detail: "No reply yet — a short, polite nudge.", leadId: "", link: { to: "/send" } });
  }

  // 7 — Then, and only then, find more.
  let prospectsLeft = 0;
  for (const lead of input.leads) {
    const score = input.scores.get(lead.id);
    if (!score || (score.band !== "STRONG" && score.band !== "GOOD")) continue;
    if ((score.action === "EMAIL" || score.action === "CALL") && stageOf(lead) === "PROSPECT") prospectsLeft += 1;
  }
  add({
    key: "prospect",
    group: 7,
    kind: "prospect",
    title: prospectsLeft < 10 ? "Find 20 new prospects" : "Find more prospects",
    detail: `${prospectsLeft === 0 ? "No strong or good prospects are waiting." : `${prospectsLeft} strong or good ${prospectsLeft === 1 ? "prospect is" : "prospects are"} still waiting for a first contact.`}${input.searchHint ? ` Next: ${input.searchHint}.` : ""}`,
    leadId: "",
    link: { to: "/find" },
  });

  steps.sort((a, b) => a.group - b.group || Number(b.overdue) - Number(a.overdue) || (a.dueAt || "~").localeCompare(b.dueAt || "~"));

  // Values live on stored opportunities; the stage they count under is the
  // effective one, so a sale marked won on a call counts as won here too.
  const totals = pipelineTotals(
    [...input.opportunities.values()].flatMap((opportunity) => {
      const lead = leadsById.get(opportunity.leadId);
      return lead ? [{ ...opportunity, stage: stageOf(lead) }] : [];
    }),
    now,
  );
  const count = (group: number, kind?: TodayStep["kind"]) => steps.filter((step) => step.group === group && (!kind || step.kind === kind) && step.key !== "calls-more").length;
  return {
    counts: {
      replies: count(1),
      calls: count(5, "call") + extraCalls,
      emailsReady: input.sendReady + input.draftsToReview,
      followUps: input.followUpEmailsDue + count(2),
      quotes: count(3),
      meetings: count(4),
    },
    pipeline: { quotedPence: totals.quotedPence, wonThisMonthPence: totals.wonThisMonthPence, openCount: totals.openCount, openPence: totals.openPence },
    steps,
    prospectsLeft,
  };
}
