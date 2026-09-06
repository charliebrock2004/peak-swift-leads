/**
 * The numbers on the outreach dashboard.
 *
 * All derived, none stored. Every figure can be traced back to a lead row or an
 * email row, so nothing can quietly disagree with what you see in the sheet.
 */
import { checkEligibility, type EligibilityContext } from "./eligibility.ts";
import { sentToday } from "./limits.ts";
import type { OutreachEmail, OutreachLead, OutreachSettings } from "./types.ts";
import { followUpsDue } from "./follow-ups.ts";

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
  };
}
