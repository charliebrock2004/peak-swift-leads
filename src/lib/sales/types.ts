/**
 * The sales loop's vocabulary: pipeline stages, tasks, interactions, call
 * outcomes. Client-safe; the tables are in migration 0013.
 */

export const STAGES = ["PROSPECT", "CONTACTED", "CONVERSATION", "MEETING", "QUOTE_SENT", "WON", "LOST", "NURTURE"] as const;
export type Stage = (typeof STAGES)[number];
/** The stages a sale moves forward through, in order. */
export const OPEN_STAGES = ["PROSPECT", "CONTACTED", "CONVERSATION", "MEETING", "QUOTE_SENT"] as const satisfies readonly Stage[];
export const CLOSED_STAGES = ["WON", "LOST", "NURTURE"] as const satisfies readonly Stage[];

export const STAGE_LABEL: Record<Stage, string> = {
  PROSPECT: "Prospect",
  CONTACTED: "Contacted",
  CONVERSATION: "Conversation",
  MEETING: "Meeting",
  QUOTE_SENT: "Quote sent",
  WON: "Won",
  LOST: "Lost",
  NURTURE: "Nurture",
};

export const TASK_TYPES = ["CALL", "REPLY", "FOLLOW_UP", "MEETING", "QUOTE", "CHECK_BACK", "REVIEW", "OTHER"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_LABEL: Record<TaskType, string> = {
  CALL: "Call",
  REPLY: "Reply",
  FOLLOW_UP: "Follow up",
  MEETING: "Meeting",
  QUOTE: "Quote",
  CHECK_BACK: "Check back",
  REVIEW: "Review",
  OTHER: "Other",
};
export type TaskPriority = "high" | "normal" | "low";
export type TaskStatus = "open" | "done" | "cancelled";

export type Task = {
  id: string;
  leadId: string;
  type: TaskType;
  title: string;
  contact: string;
  /** ISO timestamp, or empty for "whenever". */
  dueAt: string;
  priority: TaskPriority;
  status: TaskStatus;
  notes: string;
  /** "user", or what created it ("call", "reply", "stage"). */
  source: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
};

export type Opportunity = {
  leadId: string;
  stage: Stage;
  /** Whole pence, or null when no value has been put on it. */
  valuePence: number | null;
  /** YYYY-MM-DD, or empty. */
  expectedClose: string;
  quoteDate: string;
  wonDate: string;
  lostReason: string;
  nurtureDate: string;
  notes: string;
  stageChangedAt: string;
  updatedAt: string;
};

export const INTERACTION_TYPES = ["call", "note", "meeting", "quote", "stage_change", "email", "reply", "system"] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export type Interaction = {
  id: string;
  leadId: string;
  type: InteractionType;
  outcome: string;
  summary: string;
  detail: Record<string, string>;
  occurredAt: string;
};

export const CALL_OUTCOMES = ["no_answer", "interested", "not_interested", "call_back", "meeting_booked", "wrong_person", "wrong_number"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  no_answer: "No answer",
  interested: "Interested",
  not_interested: "Not interested",
  call_back: "Call back",
  meeting_booked: "Meeting booked",
  wrong_person: "Wrong person",
  wrong_number: "Wrong number",
};
