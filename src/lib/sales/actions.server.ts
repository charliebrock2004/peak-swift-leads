/**
 * The sales actions: log a call, move a sale, add a note. Each one writes the
 * interaction that records it, moves the pipeline, and leaves the right next
 * task — so the timeline, the pipeline and Today always agree.
 */
import type { Sql } from "@/lib/db";
import { addDays, todayIso } from "../leads.ts";
import { patchLead } from "../jobs/lead-writes.server.ts";
import { callEffects } from "./call-outcomes.ts";
import { isClosed, stageRank } from "./pipeline.ts";
import * as sales from "./store.server.ts";
import { STAGE_LABEL, type CallOutcome, type Interaction, type Opportunity, type Stage, type Task } from "./types.ts";

/**
 * Move a sale forward to `stage` — never backwards, and never out of a stage
 * a person closed (won, lost, nurture) — recording the change.
 */
async function advance(sql: Sql, userId: string, leadId: string, stage: Stage, extra: sales.OpportunityPatch = {}, reason = ""): Promise<Opportunity | null> {
  const current = await sales.loadOpportunity(sql, userId, leadId);
  if (current && isClosed(current.stage)) return current;
  if (!isClosed(stage) && current && stageRank(stage) <= stageRank(current.stage)) return current;
  if (!current && stage === "PROSPECT") return null;
  const { opportunity, previousStage } = await sales.saveOpportunity(sql, userId, leadId, { ...extra, stage });
  if (previousStage !== stage) {
    await sales.addInteraction(sql, userId, { leadId, type: "stage_change", outcome: stage, summary: `${previousStage ? STAGE_LABEL[previousStage] : "Prospect"} → ${STAGE_LABEL[stage]}`, detail: reason ? { reason } : {} });
  }
  return opportunity;
}

export type LogCallResult = { interaction: Interaction; task: Task | null; stage: Stage | null; leadPatch: Record<string, string>; doNotCall: boolean };

export async function logCall(
  sql: Sql,
  userId: string,
  input: { leadId: string; outcome: CallOutcome; note?: string; at?: string; today?: string; durationSeconds?: number },
): Promise<LogCallResult> {
  const store = await import("../outreach/store.server.ts");
  const lead = await store.loadLead(sql, userId, input.leadId);
  if (!lead) throw new Error("That business no longer exists.");
  const effects = callEffects(input.outcome, lead, { at: input.at, today: input.today });

  await patchLead(sql, userId, lead.id, effects.leadPatch);
  const note = (input.note ?? "").trim().slice(0, 4000);
  const seconds = Math.max(0, Math.min(sales.CALL_MAX_SECONDS, Math.round(input.durationSeconds ?? 0) || 0));
  const interaction = await sales.addInteraction(sql, userId, {
    leadId: lead.id,
    type: "call",
    outcome: input.outcome,
    summary: effects.summary,
    detail: { ...(note ? { note } : {}), ...(input.at ? { at: input.at } : {}), ...(seconds ? { durationSeconds: String(seconds) } : {}), phone: lead.phone },
  });
  // Time on the phone counts toward minutes per conversation. Best effort: a
  // missing time table must never lose the call itself.
  if (seconds) await sales.addTime(sql, userId, "call", seconds).catch(() => 0);

  // The call was made: whatever call was on the list for it is done.
  await sales.completeOpenTasks(sql, userId, lead.id, ["CALL"]);
  if (input.outcome === "meeting_booked") await sales.completeOpenTasks(sql, userId, lead.id, ["FOLLOW_UP"]);

  let opportunity: Opportunity | null = null;
  if (effects.stage) opportunity = await advance(sql, userId, lead.id, effects.stage, effects.lostReason ? { lostReason: effects.lostReason } : {}, effects.summary);

  let task: Task | null = null;
  if (effects.task && !(opportunity && isClosed(opportunity.stage) && opportunity.stage !== "NURTURE")) {
    task = await sales.createTask(sql, userId, { ...effects.task, leadId: lead.id, contact: lead.phone, source: "call", sourceKey: `call:${interaction.id}` });
  }

  let doNotCall = false;
  if (effects.doNotCall && lead.phone.trim()) {
    const contacts = await import("../contactability/store.server.ts");
    doNotCall = await contacts
      .addDoNotCall(sql, userId, { phone: lead.phone, reason: effects.doNotCall.reason, source: "internal", leadId: lead.id })
      .then(() => true)
      .catch(() => false);
  }

  const leadPatch = Object.fromEntries(Object.entries(effects.leadPatch).map(([key, value]) => [key, String(value ?? "")]));
  return { interaction, task, stage: opportunity?.stage ?? null, leadPatch, doNotCall };
}

/**
 * A person moved a sale. Closed stages and quotes carry their dates; the next
 * task follows from the stage (chase a quote, check back on a nurture), and a
 * won or lost sale closes the tasks that were for it.
 */
export async function setStage(
  sql: Sql,
  userId: string,
  input: { leadId: string; stage: Stage; valuePence?: number | null; lostReason?: string; nurtureDate?: string; quoteDate?: string; today?: string },
): Promise<{ opportunity: Opportunity; task: Task | null }> {
  const store = await import("../outreach/store.server.ts");
  const lead = await store.loadLead(sql, userId, input.leadId);
  if (!lead) throw new Error("That business no longer exists.");
  const today = input.today ?? todayIso();
  const patch: sales.OpportunityPatch = { stage: input.stage };
  if (input.valuePence !== undefined) patch.valuePence = input.valuePence;
  if (input.stage === "QUOTE_SENT") patch.quoteDate = input.quoteDate || today;
  if (input.stage === "WON") patch.wonDate = today;
  if (input.stage === "LOST") patch.lostReason = (input.lostReason ?? "").trim() || "No reason given";
  if (input.stage === "NURTURE") patch.nurtureDate = input.nurtureDate || addDays(today, 90);

  const { opportunity, previousStage } = await sales.saveOpportunity(sql, userId, lead.id, patch);
  if (previousStage !== input.stage) {
    await sales.addInteraction(sql, userId, {
      leadId: lead.id,
      type: input.stage === "QUOTE_SENT" ? "quote" : "stage_change",
      outcome: input.stage,
      summary: `${previousStage ? STAGE_LABEL[previousStage] : "Prospect"} → ${STAGE_LABEL[input.stage]}`,
      detail: {
        ...(input.stage === "LOST" ? { note: patch.lostReason ?? "" } : {}),
        ...(opportunity.valuePence != null ? { value: String(opportunity.valuePence) } : {}),
      },
    });
  }

  let task: Task | null = null;
  if (input.stage === "QUOTE_SENT") {
    await sales.completeOpenTasks(sql, userId, lead.id, ["MEETING", "FOLLOW_UP"]);
    task = await sales.createTask(sql, userId, {
      leadId: lead.id,
      type: "QUOTE",
      title: `Chase your quote with ${lead.businessName}`,
      dueAt: `${addDays(opportunity.quoteDate || today, 4)}T10:00:00.000Z`,
      priority: "high",
      source: "stage",
      sourceKey: `quote:${lead.id}:${opportunity.quoteDate || today}`,
    });
  } else if (input.stage === "WON" || input.stage === "LOST") {
    await sql.query(
      `update tasks set status = $3, completed_at = now(), updated_at = now() where user_id = $1 and lead_id = $2 and status = 'open'`,
      [userId, lead.id, input.stage === "WON" ? "done" : "cancelled"],
    );
    // A customer you won is never prospected again; the outreach gate reads this.
    if (input.stage === "WON") await store.updateLeadOutcome(sql, userId, lead.id, { called: "Called", callResult: "Won" });
  } else if (input.stage === "NURTURE") {
    task = await sales.createTask(sql, userId, {
      leadId: lead.id,
      type: "CHECK_BACK",
      title: `Check back in with ${lead.businessName}`,
      dueAt: `${opportunity.nurtureDate}T10:00:00.000Z`,
      priority: "low",
      source: "stage",
      sourceKey: `nurture:${lead.id}:${opportunity.nurtureDate}`,
    });
  }
  return { opportunity, task };
}

export async function addNote(sql: Sql, userId: string, input: { leadId: string; text: string }): Promise<Interaction> {
  const text = input.text.trim().slice(0, 4000);
  if (!text) throw new Error("Write a note first.");
  const store = await import("../outreach/store.server.ts");
  if (!(await store.loadLead(sql, userId, input.leadId))) throw new Error("That business no longer exists.");
  return sales.addInteraction(sql, userId, { leadId: input.leadId, type: "note", summary: text });
}

/**
 * A person replied: leave the next step on Today. A positive reply becomes a
 * high-priority task to answer it; "later" a check-back; a referral or a
 * wrong person a task to read who they pointed to. Nobody is contacted by
 * this — not the sender, and never the person they referred you to.
 */
export async function afterReply(
  sql: Sql,
  userId: string,
  reply: { emailId: string; leadId: string; businessName: string; intent: string; snippet: string; today?: string },
): Promise<Task | null> {
  const name = reply.businessName || "them";
  const today = reply.today ?? todayIso();
  const note = reply.snippet.slice(0, 300);
  const base = { leadId: reply.leadId, notes: note, source: "reply", sourceKey: `reply:${reply.emailId}` };
  switch (reply.intent) {
    case "positive":
      return sales.createTask(sql, userId, { ...base, type: "REPLY", title: `Reply to ${name} — they're interested`, dueAt: new Date().toISOString(), priority: "high" });
    case "later":
      return sales.createTask(sql, userId, { ...base, type: "CHECK_BACK", title: `Check back in with ${name} — they said later`, dueAt: `${addDays(today, 60)}T10:00:00.000Z`, priority: "low" });
    case "referral":
    case "wrong_person":
      return sales.createTask(sql, userId, { ...base, type: "REVIEW", title: `${name} pointed you to someone else — read their reply`, dueAt: new Date().toISOString(), priority: "normal" });
    default:
      return null;
  }
}
