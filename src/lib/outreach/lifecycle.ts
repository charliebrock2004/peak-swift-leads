/**
 * Where a prospect has got to.
 *
 * The app already records this — across `leads.outreachStatus`, the call
 * result, the unsubscribe flag, and the status of every email written for the
 * lead. What it never had was one name for the answer, so "how many are at the
 * reply stage?" had to be re-derived by hand everywhere it was asked.
 *
 * This module names the stages and derives them. It deliberately stores
 * nothing. A second stored status column would be a copy of facts that already
 * exist, and copies drift: the day the copy disagrees with the email table is
 * the day someone gets emailed twice. Deriving also means every lead that
 * predates this file already has a correct stage, with no backfill and no
 * migration touching a single existing row.
 *
 * The transition table is a separate question from the derived stage, and it
 * exists to answer one thing: is this move legitimate? It is not the thing that
 * enforces safety — `checkEligibility` is, and it runs on every send regardless
 * of what anyone believes the stage to be. The table is the second lock.
 */
import type { CallResult, Lead } from "../leads.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";

/**
 * The stages, in the order a prospect moves through them.
 *
 * DISCOVERED through WON is the happy path. The rest are exits: real outcomes
 * that end outreach rather than failures of it.
 */
export const LIFECYCLE_STAGES = [
  "DISCOVERED",
  "QUALIFIED",
  "REVIEW",
  "APPROVED",
  "PREPARED",
  "QUEUED",
  "SENT",
  "REPLIED",
  "INTERESTED",
  "BOOKED",
  "WON",
  "NOT_INTERESTED",
  "UNSUBSCRIBED",
  "CALL",
  "SKIPPED",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const STAGE_LABELS: Record<LifecycleStage, string> = {
  DISCOVERED: "Discovered",
  QUALIFIED: "Qualified",
  REVIEW: "Needs a look",
  APPROVED: "Approved",
  PREPARED: "Draft written",
  QUEUED: "Queued",
  SENT: "Emailed",
  REPLIED: "Replied",
  INTERESTED: "Interested",
  BOOKED: "Booked",
  WON: "Won",
  NOT_INTERESTED: "Not interested",
  UNSUBSCRIBED: "Unsubscribed",
  CALL: "Worth ringing",
  SKIPPED: "Skipped",
};

/**
 * Stages that end outreach for good.
 *
 * Nothing leaves these on its own. Getting a prospect out of one is a
 * deliberate manual act, which is what `canTransition` refuses and
 * `resetsNeedManualAction` explains.
 */
export const TERMINAL_STAGES: readonly LifecycleStage[] = [
  "WON",
  "NOT_INTERESTED",
  "UNSUBSCRIBED",
];

/** Stages from which an email may still legitimately be sent. */
export const CONTACTABLE_STAGES: readonly LifecycleStage[] = [
  "DISCOVERED",
  "QUALIFIED",
  "REVIEW",
  "APPROVED",
  "PREPARED",
  "QUEUED",
];

/**
 * Every move the system is allowed to make on its own.
 *
 * Read it as "from → the stages it may reach". Anything absent is refused, so
 * this is a whitelist and a new stage is unreachable until someone adds it here
 * on purpose. UNSUBSCRIBED is reachable from every live stage — a person can
 * ask to be left alone at any point — and leads nowhere at all.
 */
export const TRANSITIONS: Record<LifecycleStage, readonly LifecycleStage[]> = {
  DISCOVERED: ["QUALIFIED", "CALL", "SKIPPED", "UNSUBSCRIBED"],
  QUALIFIED: ["REVIEW", "APPROVED", "CALL", "SKIPPED", "UNSUBSCRIBED"],
  REVIEW: ["APPROVED", "SKIPPED", "CALL", "UNSUBSCRIBED"],
  APPROVED: ["PREPARED", "SKIPPED", "UNSUBSCRIBED"],
  PREPARED: ["QUEUED", "SKIPPED", "UNSUBSCRIBED"],
  QUEUED: ["SENT", "SKIPPED", "UNSUBSCRIBED"],
  SENT: ["REPLIED", "NOT_INTERESTED", "UNSUBSCRIBED"],
  REPLIED: ["INTERESTED", "NOT_INTERESTED", "BOOKED", "UNSUBSCRIBED"],
  INTERESTED: ["BOOKED", "NOT_INTERESTED", "UNSUBSCRIBED"],
  BOOKED: ["WON", "NOT_INTERESTED", "UNSUBSCRIBED"],
  WON: [],
  NOT_INTERESTED: [],
  UNSUBSCRIBED: [],
  CALL: ["QUALIFIED", "SKIPPED", "UNSUBSCRIBED", "BOOKED", "NOT_INTERESTED"],
  SKIPPED: ["QUALIFIED", "CALL", "UNSUBSCRIBED"],
};

/** Is this move one the system may make by itself? */
export function canTransition(from: LifecycleStage, to: LifecycleStage): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/**
 * Why a move was refused, in words worth showing someone.
 *
 * Returns "" when the move is allowed. The two cases the brief singles out —
 * an unsubscribed or uninterested business being emailed — are named
 * explicitly, because "invalid transition" would not tell the reader that the
 * system is protecting a person who asked to be left alone.
 */
export function transitionProblem(from: LifecycleStage, to: LifecycleStage): string {
  if (canTransition(from, to)) return "";
  if (from === "UNSUBSCRIBED") {
    return "They asked not to be contacted. Nothing moves a prospect out of unsubscribed.";
  }
  if (from === "NOT_INTERESTED") {
    return "They said no. Reopening this is a deliberate manual change, never something a run does.";
  }
  if (from === "WON") return "This one is already won. Outreach does not reopen it.";
  return `${STAGE_LABELS[from]} does not lead to ${STAGE_LABELS[to]}.`;
}

/**
 * Stages a person must leave by hand, if they leave at all.
 *
 * Nothing in this codebase performs such a move. It is here so the UI can say
 * why a prospect is stuck rather than appearing to have lost it.
 */
export function resetsNeedManualAction(stage: LifecycleStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** May an email be sent to a prospect at this stage, before eligibility runs? */
export function stageAllowsSending(stage: LifecycleStage): boolean {
  return CONTACTABLE_STAGES.includes(stage);
}

const CLOSED_RESULTS: Record<string, LifecycleStage> = {
  "Not Interested": "NOT_INTERESTED",
  "Wrong Number": "SKIPPED",
  Booked: "BOOKED",
  Won: "WON",
  Interested: "INTERESTED",
};

/**
 * The furthest an email for this lead has got.
 *
 * Furthest, not latest: a lead with a sent initial email and a fresh follow-up
 * draft is at SENT, because the draft does not un-send the email. Null means no
 * email was ever written for the lead.
 */
function furthestEmailStage(emails: readonly OutreachEmail[]): LifecycleStage | null {
  let best: LifecycleStage | null = null;
  const rank = (stage: LifecycleStage) => LIFECYCLE_STAGES.indexOf(stage);
  const consider = (stage: LifecycleStage) => {
    if (best === null || rank(stage) > rank(best)) best = stage;
  };
  for (const email of emails) {
    if (email.status === "replied" || email.repliedAt) consider("REPLIED");
    else if (email.status === "sent" || email.sentAt) consider("SENT");
    else if (email.status === "queued" || email.status === "sending") consider("QUEUED");
    else if (email.status === "approved") consider("PREPARED");
    else if (email.status === "draft") consider("PREPARED");
  }
  return best;
}

/**
 * Where this prospect actually is.
 *
 * Order matters and is the whole design: the things a person said come before
 * anything the system inferred. Unsubscribed beats everything, then an
 * explicit call outcome, then the email trail, then the lead's own summary,
 * then — only when nothing else has an opinion — the automated verdict.
 *
 * `decision` is the level from `decideProspect`, passed in rather than computed
 * so this module stays free of the scoring engine and can be tested on its own.
 */
export function lifecycleOf(
  lead: Lead | OutreachLead,
  emails: readonly OutreachEmail[] = [],
  decision?: { level: string; reviewRequired?: boolean },
): LifecycleStage {
  if (lead.unsubscribed.trim()) return "UNSUBSCRIBED";
  const outreach = lead.outreachStatus.trim().toLowerCase();
  if (outreach === "unsubscribed") return "UNSUBSCRIBED";

  // What a person recorded after speaking to them outranks any email trail:
  // a booked job is a booked job even if the last email is still a draft.
  const called = CLOSED_RESULTS[lead.callResult as CallResult] ?? CLOSED_RESULTS[lead.called];
  if (called === "NOT_INTERESTED" || called === "WON" || called === "BOOKED") return called;

  const mine = emails.filter((email) => email.leadId === lead.id);
  const fromEmail = furthestEmailStage(mine);
  if (fromEmail === "REPLIED") {
    // A reply is the start of a conversation, not the end. If a person has
    // since recorded how it went, that is the better answer.
    return called ?? "REPLIED";
  }
  if (fromEmail) return fromEmail;

  if (outreach === "replied") return "REPLIED";
  if (outreach === "sent" || outreach === "followed up") return "SENT";
  if (called) return called;

  if (decision) {
    if (decision.level === "SKIP") return "SKIPPED";
    if (decision.level === "CALL") return "CALL";
    if (decision.reviewRequired) return "REVIEW";
    if (decision.level === "HOT" || decision.level === "WARM") return "QUALIFIED";
    if (decision.level === "LOW") return "QUALIFIED";
  }
  return "DISCOVERED";
}

/** How many prospects sit at each stage. Stages with nobody in them are omitted. */
export function tallyStages(stages: readonly LifecycleStage[]): { stage: LifecycleStage; count: number }[] {
  const counts = new Map<LifecycleStage, number>();
  for (const stage of stages) counts.set(stage, (counts.get(stage) ?? 0) + 1);
  return LIFECYCLE_STAGES.filter((stage) => counts.has(stage)).map((stage) => ({
    stage,
    count: counts.get(stage)!,
  }));
}
