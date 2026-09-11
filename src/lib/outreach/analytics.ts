/**
 * Which places and trades are actually worth working.
 *
 * The dashboard answers "how is outreach going" in aggregate. This answers the
 * question that changes what you do next: of the towns and trades you have
 * already worked, which ones reply? A 12% reply rate in Perth and 0% in
 * Aberdeen is a reason to run more Perth searches, and no aggregate number can
 * tell you that.
 *
 * Pure, and deliberately conservative about rates. A percentage computed from
 * three sent emails is noise dressed as a number, so segments below
 * `RATE_MIN_SENT` report their counts and decline to report a rate rather than
 * inviting the user to chase a coin flip. Nothing here estimates, projects or
 * annualises: every number is a count of rows that exist.
 */
import type { Lead } from "../leads.ts";
import type { OutreachEmail } from "./types.ts";

/** Below this many sent emails a reply rate is noise, so we do not show one. */
export const RATE_MIN_SENT = 5;

export type Segment = {
  /** Town or trade, exactly as the leads spell it. */
  name: string;
  /** Leads in this segment, whether or not they were ever emailed. */
  prospects: number;
  /** Leads here with a public email address on file. */
  withEmail: number;
  sent: number;
  replies: number;
  /**
   * Replies ÷ sent as a percentage, or null when too few emails have been sent
   * for the number to mean anything. Null is not zero and must not render as 0%.
   */
  replyRate: number | null;
};

function blank(name: string): Segment {
  return { name, prospects: 0, withEmail: 0, sent: 0, replies: 0, replyRate: null };
}

function rate(segment: Segment): Segment {
  return {
    ...segment,
    replyRate: segment.sent >= RATE_MIN_SENT ? (segment.replies / segment.sent) * 100 : null,
  };
}

/**
 * Sent means it left the building: a queued or failed email proves nothing
 * about a town. A replied email was also sent, so it counts in both.
 */
function wasSent(email: OutreachEmail): boolean {
  return email.status === "sent" || email.status === "replied";
}

function gotReply(email: OutreachEmail): boolean {
  return email.status === "replied" || email.repliedAt !== "";
}

function keyOf(value: string): string {
  return value.trim();
}

/**
 * Group leads and their emails by one lead field.
 *
 * Leads whose field is blank are left out entirely rather than collected into
 * an "" bucket: an unnamed town is missing data, and showing it as a segment
 * would imply a place that does not exist.
 */
function segmentBy(
  leads: readonly Lead[],
  emails: readonly OutreachEmail[],
  field: (lead: Lead) => string,
): Segment[] {
  const byName = new Map<string, Segment>();
  const leadName = new Map<string, string>();

  for (const lead of leads) {
    const name = keyOf(field(lead));
    if (!name) continue;
    leadName.set(lead.id, name);
    const segment = byName.get(name) ?? blank(name);
    segment.prospects += 1;
    if (lead.email.trim()) segment.withEmail += 1;
    byName.set(name, segment);
  }

  for (const email of emails) {
    const name = leadName.get(email.leadId);
    if (!name) continue;
    const segment = byName.get(name);
    if (!segment) continue;
    if (wasSent(email)) segment.sent += 1;
    if (gotReply(email)) segment.replies += 1;
  }

  return [...byName.values()].map(rate);
}

/**
 * Best first, where "best" is what you would act on: the segments you have
 * actually worked, ordered by replies, then by how much you sent, then by size.
 * A segment you have never emailed sorts last however many prospects it holds,
 * because its silence is not evidence.
 */
function ranked(segments: Segment[]): Segment[] {
  return segments.sort((a, b) => {
    if (b.replies !== a.replies) return b.replies - a.replies;
    if (b.sent !== a.sent) return b.sent - a.sent;
    if (b.prospects !== a.prospects) return b.prospects - a.prospects;
    return a.name.localeCompare(b.name);
  });
}

export function segmentsByTown(leads: readonly Lead[], emails: readonly OutreachEmail[]): Segment[] {
  return ranked(segmentBy(leads, emails, (lead) => lead.town));
}

export function segmentsByTrade(leads: readonly Lead[], emails: readonly OutreachEmail[]): Segment[] {
  return ranked(segmentBy(leads, emails, (lead) => lead.trade));
}

/**
 * One plain sentence about where to search next, or "" when the data cannot
 * support one.
 *
 * Silence is the honest answer more often than not. Until something has
 * replied there is no evidence that any segment beats any other, and inventing
 * a recommendation from thin data is how you end up working the wrong town for
 * a month.
 */
export function whereToSearchNext(towns: readonly Segment[], trades: readonly Segment[]): string {
  const bestTown = towns.find((segment) => segment.replyRate !== null && segment.replies > 0);
  const bestTrade = trades.find((segment) => segment.replyRate !== null && segment.replies > 0);
  if (!bestTown && !bestTrade) return "";
  if (bestTown && bestTrade) {
    return `${bestTrade.name} in ${bestTown.name} replies most often so far — ${bestTown.replies} ${
      bestTown.replies === 1 ? "reply" : "replies"
    } from ${bestTown.sent} sent.`;
  }
  const best = (bestTown ?? bestTrade)!;
  return `${best.name} replies most often so far — ${best.replies} ${
    best.replies === 1 ? "reply" : "replies"
  } from ${best.sent} sent.`;
}

/** A reply rate for display. Never invents a number it does not have. */
export function formatRate(replyRate: number | null): string {
  return replyRate === null ? "—" : `${Math.round(replyRate)}%`;
}
