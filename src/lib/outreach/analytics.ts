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
  /** Outcomes recorded on the leads in this segment (by phone or from a reply). */
  interested?: number;
  booked?: number;
  won?: number;
  /** Emails Gmail refused or that bounced. */
  failed?: number;
};

function blank(name: string): Segment {
  return { name, prospects: 0, withEmail: 0, sent: 0, replies: 0, replyRate: null, interested: 0, booked: 0, won: 0, failed: 0 };
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
  if (email.kind === ("test" as OutreachEmail["kind"])) return false;
  return email.status === "sent" || email.status === "replied" || email.status === "bounced";
}

function gotReply(email: OutreachEmail): boolean {
  if (email.replyKind === "auto_reply" || email.replyKind === "bounce") return false;
  return email.status === "replied" || email.repliedAt !== "";
}

function deliveryFailed(email: OutreachEmail): boolean {
  return email.status === "bounced" || (email.status === "failed" && email.failureKind === "permanent");
}

function outcomeOf(lead: Lead): "interested" | "booked" | "won" | "" {
  if (lead.callResult === "Won") return "won";
  if (lead.callResult === "Booked") return "booked";
  if (lead.callResult === "Interested" || lead.called === "Interested") return "interested";
  return "";
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
    const outcome = outcomeOf(lead);
    if (outcome) segment[outcome] = (segment[outcome] ?? 0) + 1;
    byName.set(name, segment);
  }

  for (const email of emails) {
    const name = leadName.get(email.leadId);
    if (!name) continue;
    const segment = byName.get(name);
    if (!segment) continue;
    if (wasSent(email)) segment.sent += 1;
    if (gotReply(email)) segment.replies += 1;
    if (deliveryFailed(email)) segment.failed = (segment.failed ?? 0) + 1;
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

/**
 * Performance per campaign: the campaign's prospects and the emails written
 * under it (or to its prospects). Same honesty rules as towns and trades.
 */
export function segmentsByCampaign(
  leads: readonly Lead[],
  emails: readonly OutreachEmail[],
  campaigns: readonly { id: string; name: string }[],
  members: readonly { campaignId: string; leadId: string }[],
): Segment[] {
  const out: Segment[] = [];
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
  for (const campaign of campaigns) {
    const ids = new Set(members.filter((member) => member.campaignId === campaign.id).map((member) => member.leadId));
    const theirs = [...ids].map((id) => leadsById.get(id)).filter((lead): lead is Lead => Boolean(lead));
    const segment = blank(campaign.name || "Untitled campaign");
    for (const lead of theirs) {
      segment.prospects += 1;
      if (lead.email.trim()) segment.withEmail += 1;
      const outcome = outcomeOf(lead);
      if (outcome) segment[outcome] = (segment[outcome] ?? 0) + 1;
    }
    for (const email of emails) {
      if (email.campaignId !== campaign.id && !ids.has(email.leadId)) continue;
      if (wasSent(email)) segment.sent += 1;
      if (gotReply(email)) segment.replies += 1;
      if (deliveryFailed(email)) segment.failed = (segment.failed ?? 0) + 1;
    }
    out.push(rate(segment));
  }
  return ranked(out);
}

export type Rate = { value: number | null; numerator: number; denominator: number; smallSample: boolean };

/** A percentage that knows when it is not worth showing. */
export function rateOf(numerator: number, denominator: number, minimum = RATE_MIN_SENT): Rate {
  if (denominator <= 0) return { value: null, numerator, denominator, smallSample: true };
  return {
    value: denominator >= minimum ? (numerator / denominator) * 100 : null,
    numerator,
    denominator,
    smallSample: denominator < minimum,
  };
}

export type Overview = {
  prospects: number;
  /** Real opportunities: a website problem worth writing about. */
  qualified: number;
  emailsFound: number;
  emailsPrepared: number;
  emailsSent: number;
  deliveryFailures: number;
  replies: number;
  autoReplies: number;
  interested: number;
  booked: number;
  won: number;
  replyRate: Rate;
  interestedRate: Rate;
  bookedRate: Rate;
  wonRate: Rate;
};

/**
 * The business numbers, counted from rows that exist. Rates are withheld
 * (null, flagged smallSample) until there are enough sends to mean anything.
 */
export function outreachOverview(leads: readonly Lead[], emails: readonly OutreachEmail[]): Overview {
  const real = emails.filter((email) => email.kind !== ("test" as OutreachEmail["kind"]));
  const sentLeads = new Set(real.filter(wasSent).map((email) => email.leadId));
  const repliedLeads = new Set(real.filter(gotReply).map((email) => email.leadId));
  let qualified = 0;
  let emailsFound = 0;
  let interested = 0;
  let booked = 0;
  let won = 0;
  for (const lead of leads) {
    const opportunity =
      lead.websiteQuality !== "good" &&
      (lead.websiteStatus === "No Website Found" ||
        lead.websiteStatus === "Social Only" ||
        lead.websiteStatus === "Directory Only" ||
        lead.websiteStatus === "Basic Website" ||
        lead.websiteQuality === "poor" ||
        lead.websiteQuality === "improve");
    if (opportunity) qualified += 1;
    if (lead.email.trim() && (lead.emailConfidence === "HIGH" || lead.emailConfidence === "MEDIUM")) emailsFound += 1;
    const outcome = outcomeOf(lead);
    if (outcome === "interested") interested += 1;
    if (outcome === "booked") booked += 1;
    if (outcome === "won") won += 1;
  }
  // A reply stage of interested counts, even before the lead is updated.
  for (const email of real) {
    if (email.replyStage === "interested" && !leads.some((lead) => lead.id === email.leadId && outcomeOf(lead))) interested += 1;
  }
  const sent = sentLeads.size;
  return {
    prospects: leads.length,
    qualified,
    emailsFound,
    emailsPrepared: new Set(real.map((email) => email.leadId)).size,
    emailsSent: real.filter(wasSent).length,
    deliveryFailures: real.filter(deliveryFailed).length,
    replies: repliedLeads.size,
    autoReplies: real.filter((email) => email.replyKind === "auto_reply").length,
    interested,
    booked,
    won,
    replyRate: rateOf(repliedLeads.size, sent),
    interestedRate: rateOf(interested, sent),
    bookedRate: rateOf(booked, sent),
    wonRate: rateOf(won, sent),
  };
}
