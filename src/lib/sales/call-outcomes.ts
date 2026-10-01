/**
 * What one call outcome means for everything else: the lead's call fields
 * (which drive the call list), the pipeline stage, the next task, and — for a
 * wrong number — the do-not-call list. One place, pure, so the call screen
 * and the server agree and every rule is tested.
 */
import { addDays, callOutcomePatch, todayIso, type Lead } from "../leads.ts";
import { CALL_OUTCOME_LABEL, type CallOutcome, type Stage, type TaskPriority, type TaskType } from "./types.ts";

export type CallEffects = {
  leadPatch: Partial<Lead>;
  /** Move the pipeline forward to this stage (never backwards; see effectiveStage). */
  stage: Stage | null;
  lostReason: string;
  task: { type: TaskType; title: string; dueAt: string; priority: TaskPriority } | null;
  /** Add the number to the internal do-not-call list (it is not theirs). */
  doNotCall: { reason: string } | null;
  summary: string;
};

/** 10:00 on a YYYY-MM-DD day, as an ISO timestamp (UK morning, close enough in either clock). */
function morning(day: string): string {
  return `${day}T10:00:00.000Z`;
}

function validIso(value: string | undefined): string {
  if (!value) return "";
  const at = Date.parse(value);
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

export function callEffects(
  outcome: CallOutcome,
  lead: Pick<Lead, "businessName" | "followUpDate">,
  options: { at?: string; today?: string } = {},
): CallEffects {
  const today = options.today ?? todayIso();
  const at = validIso(options.at);
  const name = lead.businessName || "this business";
  const base = { stage: null, lostReason: "", task: null, doNotCall: null, summary: `Called — ${CALL_OUTCOME_LABEL[outcome].toLowerCase()}` } satisfies Partial<CallEffects>;
  switch (outcome) {
    case "no_answer":
      // The call list brings them back in two days; no task needed.
      return { ...base, leadPatch: callOutcomePatch("No Answer", lead), stage: "CONTACTED" };
    case "call_back": {
      const due = at || morning(addDays(today, 1));
      return {
        ...base,
        leadPatch: { ...callOutcomePatch("Callback", lead), followUpDate: due.slice(0, 10) },
        stage: "CONTACTED",
        task: { type: "CALL", title: `Call ${name} back — they asked`, dueAt: due, priority: "high" },
      };
    }
    case "interested":
      return {
        ...base,
        leadPatch: callOutcomePatch("Interested", lead),
        stage: "CONVERSATION",
        task: { type: "FOLLOW_UP", title: `Follow up with ${name} — send what you promised`, dueAt: morning(addDays(today, 1)), priority: "high" },
      };
    case "meeting_booked": {
      const due = at || morning(addDays(today, 2));
      return {
        ...base,
        leadPatch: callOutcomePatch("Booked", lead),
        stage: "MEETING",
        task: { type: "MEETING", title: `Meeting with ${name}`, dueAt: due, priority: "high" },
      };
    }
    case "not_interested":
      return { ...base, leadPatch: callOutcomePatch("Not Interested", lead), stage: "LOST", lostReason: "Not interested (call)" };
    case "wrong_person":
      return {
        ...base,
        leadPatch: { called: "Called", followUpDate: addDays(today, 3) },
        stage: "CONTACTED",
        task: { type: "CHECK_BACK", title: `Find the right person at ${name}`, dueAt: morning(addDays(today, 3)), priority: "normal" },
      };
    case "wrong_number":
      return {
        ...base,
        leadPatch: callOutcomePatch("Wrong Number", lead),
        task: { type: "REVIEW", title: `Find a working number for ${name}`, dueAt: "", priority: "low" },
        doNotCall: { reason: "Wrong number — not this business" },
      };
  }
}
