/**
 * Follow-ups.
 *
 * Off by default, and full of reasons not to send. The whole value of a
 * follow-up is that it is polite and finite: two at most, never after a reply,
 * never to someone who asked you to stop, and never to a business you have
 * already booked or won.
 *
 * Nothing here sends anything. It decides what is *due*, and the queue does the
 * rest through exactly the same eligibility and quality gates as a first email.
 */
import { checkEligibility, type EligibilityContext } from "./eligibility.ts";
import type { EmailKind, OutreachEmail, OutreachLead, OutreachSettings } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowUpDue = {
  lead: OutreachLead;
  kind: EmailKind;
  /** The email being followed up, so the reply lands in the same thread. */
  after: OutreachEmail;
  dueSince: string;
};

/** Delivered emails for one lead, oldest first. */
function historyFor(leadId: string, emails: readonly OutreachEmail[]): OutreachEmail[] {
  return emails
    .filter((email) => email.leadId === leadId && (email.status === "sent" || email.status === "replied"))
    .sort((a, b) => (a.sentAt || a.createdAt).localeCompare(b.sentAt || b.createdAt));
}

/**
 * Which follow-up, if any, is due for this lead right now.
 *
 * Returns null far more often than not — that is the design. A follow-up is due
 * only when: follow-ups are on, an initial email was actually delivered, enough
 * days have passed, no reply has arrived, the cap has not been reached, and the
 * lead would still be a legitimate target if we were meeting it today.
 */
export function followUpDueFor(
  lead: OutreachLead,
  emails: readonly OutreachEmail[],
  settings: OutreachSettings,
  context: EligibilityContext,
  now: Date = new Date(),
): FollowUpDue | null {
  if (!settings.followUpsOn || settings.maxFollowUps <= 0) return null;

  const history = historyFor(lead.id, emails);
  if (history.length === 0) return null;

  // A reply anywhere in the conversation ends it. So does an unsubscribe.
  if (history.some((email) => email.status === "replied")) return null;
  if (emails.some((email) => email.leadId === lead.id && email.status === "unsubscribed")) return null;
  if (lead.outreachStatus.trim().toLowerCase() === "replied") return null;

  const sentKinds = new Set(history.map((email) => email.kind));
  if (!sentKinds.has("initial")) return null;

  const alreadySent = history.length;
  if (alreadySent - 1 >= settings.maxFollowUps) return null;

  const nextKind: EmailKind = sentKinds.has("follow-up-1") ? "follow-up-2" : "follow-up-1";
  if (nextKind === "follow-up-2" && settings.maxFollowUps < 2) return null;
  if (sentKinds.has(nextKind)) return null;

  const last = history[history.length - 1];
  const lastAt = Date.parse(last.sentAt || last.createdAt);
  if (Number.isNaN(lastAt)) return null;

  const waitDays = nextKind === "follow-up-1" ? settings.followUp1Days : settings.followUp2Days;
  const dueAt = lastAt + waitDays * DAY_MS;
  if (now.getTime() < dueAt) return null;

  // The same rules as a first email, minus "already contacted" — which is the
  // entire premise of a follow-up.
  const eligibility = checkEligibility(lead, context, nextKind);
  if (!eligibility.eligible) return null;

  return { lead, kind: nextKind, after: last, dueSince: new Date(dueAt).toISOString() };
}

/** Every follow-up due across the sheet, soonest-due first. */
export function followUpsDue(
  leads: readonly OutreachLead[],
  emails: readonly OutreachEmail[],
  settings: OutreachSettings,
  context: EligibilityContext,
  now: Date = new Date(),
): FollowUpDue[] {
  return leads
    .map((lead) => followUpDueFor(lead, emails, settings, context, now))
    .filter((due): due is FollowUpDue => due !== null)
    .sort((a, b) => a.dueSince.localeCompare(b.dueSince));
}
