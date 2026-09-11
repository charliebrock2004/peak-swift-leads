/**
 * The numbers on the outreach dashboard.
 *
 * All derived, none stored. Every figure can be traced back to a lead row or an
 * email row, so nothing can quietly disagree with what you see in the sheet.
 */
import { checkEligibility, type EligibilityContext } from "./eligibility.ts";
import { sentToday } from "./limits.ts";
import type { GmailStatus, OutreachEmail, OutreachLead, OutreachSettings } from "./types.ts";
import { followUpsDue } from "./follow-ups.ts";
import { decideProspect, describeBottleneck, tallyDecisions } from "../decision.ts";

export type OutreachStats = {
  leads: number;
  highOpportunity: number;
  emailsAvailable: number;
  neverContacted: number;
  eligibleNow: number;
  manualReview: number;
  sentToday: number;
  dailyLimit: number;
  totalSent: number;
  queued: number;
  awaitingApproval: number;
  failed: number;
  replies: number;
  interested: number;
  booked: number;
  won: number;
  followUpsDue: number;
  unsubscribed: number;
  hot: number;
  warm: number;
  call: number;
  review: number;
  bottleneck: string;
};

export function computeStats(
  leads: readonly OutreachLead[],
  emails: readonly OutreachEmail[],
  settings: OutreachSettings,
  context: EligibilityContext,
  now: Date = new Date(),
): OutreachStats {
  let highOpportunity = 0;
  let emailsAvailable = 0;
  let neverContacted = 0;
  let eligibleNow = 0;
  let manualReview = 0;
  let interested = 0;
  let booked = 0;
  let won = 0;
  let unsubscribed = 0;

  for (const lead of leads) {
    const eligibility = checkEligibility(lead, context);
    if (eligibility.band === "High") highOpportunity += 1;
    if (lead.email.trim()) emailsAvailable += 1;
    if (!lead.lastEmailedAt.trim()) neverContacted += 1;
    if (eligibility.eligible) eligibleNow += 1;
    else if (eligibility.manualReview) manualReview += 1;
    if (lead.callResult === "Interested" || lead.called === "Interested") interested += 1;
    if (lead.callResult === "Booked") booked += 1;
    if (lead.callResult === "Won") won += 1;
    if (lead.unsubscribed.trim()) unsubscribed += 1;
  }

  const tally = tallyDecisions(leads);
  const decisions = leads.map((lead) => decideProspect(lead));

  const totalSent = emails.filter((email) => email.status === "sent" || email.status === "replied").length;

  return {
    leads: leads.length,
    highOpportunity,
    emailsAvailable,
    neverContacted,
    eligibleNow,
    manualReview,
    sentToday: sentToday(emails, now),
    dailyLimit: settings.dailyLimit,
    totalSent,
    queued: emails.filter((email) => email.status === "queued").length,
    awaitingApproval: emails.filter((email) => email.status === "draft").length,
    failed: emails.filter((email) => email.status === "failed").length,
    replies: emails.filter((email) => email.status === "replied").length,
    interested,
    booked,
    won,
    followUpsDue: followUpsDue(leads, emails, settings, context, now).length,
    unsubscribed,
    hot: tally.hot,
    warm: tally.warm,
    call: tally.call,
    review: tally.review,
    bottleneck: describeBottleneck(decisions),
  };
}

/** Human-readable labels for stored activity events. */
export const ACTIVITY_LABELS: Record<string, string> = {
  SEARCH_STARTED: "Search started",
  SEARCH_COMPLETED: "Run finished",
  LEAD_FOUND: "Lead found",
  LEAD_UPDATED: "Lead updated",
  LEAD_DUPLICATE: "Duplicate skipped",
  LEAD_QUALIFIED: "Lead qualified",
  LEAD_REVIEW_REQUIRED: "Needs a look",
  LEAD_APPROVED: "Lead approved",
  LEAD_SKIPPED: "Lead skipped",
  EMAIL_DISCOVERY_STARTED: "Looking for email",
  EMAIL_FOUND: "Email found",
  EMAIL_NOT_FOUND: "No public email",
  EMAIL_PREPARED: "Email prepared",
  EMAIL_APPROVED: "Email approved",
  EMAIL_SENT: "Email sent",
  EMAIL_FAILED: "Send failed",
  REPLY_RECEIVED: "Reply received",
  FOLLOW_UP_CREATED: "Follow-up created",
  FOLLOW_UP_DUE: "Follow-up due",
  ERROR: "Error",
};

/** One sentence for the top of the dashboard: what to do next. */
export function nextMove(
  stats: OutreachStats,
  connectionStatus: GmailStatus | "disconnected" | "connected" | "needs_attention",
): string {
  if (connectionStatus === "needs_attention") {
    return "Gmail needs reconnecting before anything can go out.";
  }
  if (stats.failed > 0) {
    return `${stats.failed} email${stats.failed === 1 ? "" : "s"} failed — open Review.`;
  }
  if (stats.awaitingApproval > 0) {
    return `${stats.awaitingApproval} draft${stats.awaitingApproval === 1 ? "" : "s"} waiting in Review.`;
  }
  if (stats.followUpsDue > 0) {
    return `${stats.followUpsDue} follow-up${stats.followUpsDue === 1 ? "" : "s"} due.`;
  }
  if (stats.call > 0 && stats.eligibleNow === 0) {
    return `${stats.call} worth ringing — no public email.`;
  }
  if (stats.eligibleNow > 0) {
    return `${stats.eligibleNow} ready to email.`;
  }
  if (connectionStatus !== "connected") {
    return "Connect Gmail in Settings when you are ready to send.";
  }
  if (stats.replies > 0) {
    return "Replies are waiting — answer them from Gmail.";
  }
  return "Find more leads, or run a dry run from AI Outreach.";
}
