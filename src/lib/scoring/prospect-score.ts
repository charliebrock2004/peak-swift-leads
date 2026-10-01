/**
 * THE prospect score — one model, three axes, every point explained.
 *
 *   NEED   How much would a better website help this business? Measured:
 *          a verified absence of a website, a social/directory-only presence,
 *          or audit findings. Unmeasured need is "unknown", never assumed.
 *   VALUE  How attractive is the business commercially? Trade tier (from the
 *          workspace profile where set), reviews, a confirmed active company.
 *   REACH  Can it be contacted, lawfully and practically? The same email and
 *          call verdicts the send gate and the call list enforce.
 *
 * From those: a priority (0–100), a band (STRONG / GOOD / WEAK / NONE), one
 * recommended action (CALL / EMAIL / REVIEW / SKIP / WAIT), what must happen
 * before acting (blockers), and the reasons — each with its source and date,
 * so "why is this a strong prospect?" always has an evidence-backed answer.
 *
 * A missing signal contributes nothing; it never counts against a business.
 * This replaces decideProspect, explainOpportunity/computeOpportunity and the
 * discovery pool's ranking. Client-safe and pure.
 */
import { emailContactability, type EmailStatus } from "../contactability/email.ts";
import { legalFormOf } from "../contactability/lead.ts";
import { DEFAULT_CONTACT_RULES, type ContactRules } from "../contactability/legal-form.ts";
import { callContactability, type CallStatus, type DoNotCall, type PhoneScreening } from "../contactability/phone.ts";
import { dateLabel, freshness, OPPORTUNITY_LABEL, type Freshness } from "../audit/findings.ts";
import { websiteVerificationOf } from "../audit/website-state.ts";
import type { OutreachLead } from "../outreach/types.ts";
import { tradeTier, TRADE_TIER_LABEL } from "./trade-value.ts";

export type Axis = "need" | "value" | "reach";

export type Reason = {
  axis: Axis;
  text: string;
  /** Where it came from: "website search", "website audit", "Companies House", "listing"… */
  source: string;
  /** ISO date of the observation, when there is one. */
  at: string;
  freshness: Freshness | "";
  /** What it added to its axis. */
  points: number;
};

export type AxisScore = { score: number; level: "high" | "medium" | "low" | "unknown"; reasons: Reason[] };

export type Band = "STRONG" | "GOOD" | "WEAK" | "NONE";
export type Action = "CALL" | "EMAIL" | "REVIEW" | "SKIP" | "WAIT";

export const BAND_LABEL: Record<Band, string> = {
  STRONG: "Strong prospect",
  GOOD: "Good prospect",
  WEAK: "Weak prospect",
  NONE: "Not a prospect",
};

export const ACTION_LABEL: Record<Action, string> = {
  CALL: "Call",
  EMAIL: "Email",
  REVIEW: "Review",
  SKIP: "Skip",
  WAIT: "In progress",
};

export type ProspectScore = {
  need: AxisScore;
  value: AxisScore;
  reach: AxisScore & { email: EmailStatus | "NONE"; call: CallStatus; channel: "email" | "call" | "both" | "none" };
  /** Need × value alone (0–100): how good a prospect it would be if reachable. */
  opportunity: number;
  /** Opportunity, held down when there is no way to reach them (0–100). */
  priority: number;
  band: Band;
  action: Action;
  /** One line: why this action. */
  actionReason: string;
  /** What has to happen before the action ("Screen the number against TPS/CTPS"). */
  blockers: string[];
  /** The strongest reasons across all axes, for a card. */
  why: Reason[];
  /** Freshness of the evidence behind NEED (the axis that decays). */
  freshness: Freshness | "unknown";
};

export type ScoreContext = {
  now?: Date;
  rules?: ContactRules;
  /** Screening for this lead's number (E.164 lookup done by the caller). */
  screening?: PhoneScreening | null;
  doNotCall?: DoNotCall | null;
  /** The address is on the suppression list. */
  suppressed?: boolean;
  /** A live email of the initial kind already exists for this business. */
  contacted?: boolean;
  profile?: { preferredTrades?: readonly string[]; excludedTrades?: readonly string[] };
};

function level(score: number, known: boolean): AxisScore["level"] {
  if (!known) return "unknown";
  return score >= 65 ? "high" : score >= 35 ? "medium" : "low";
}

function reason(axis: Axis, text: string, source: string, points: number, at = "", now = new Date()): Reason {
  return { axis, text, source, at, freshness: at ? freshness(at, now) : "", points };
}

// ── NEED ─────────────────────────────────────────────────────────────────────

function needOf(lead: OutreachLead, now: Date): AxisScore & { freshness: Freshness | "unknown"; measured: boolean; needsAudit: boolean; needsSearch: boolean } {
  const verified = websiteVerificationOf(lead, now);
  const audit = lead.facts?.audit ?? null;
  const reasons: Reason[] = [];
  let score = 0;
  let measured = true;
  let at = verified.checkedAt;

  switch (verified.state) {
    case "VERIFIED_NO_WEBSITE":
      score = 85;
      reasons.push(reason("need", "No independent website found", "website search", 85, verified.checkedAt, now));
      break;
    case "SOCIAL_ONLY":
      score = verified.canClaimNoWebsite ? 80 : 60;
      reasons.push(reason("need", verified.canClaimNoWebsite ? "Only a social media page — no website found" : "Social media page is the only site on record", verified.canClaimNoWebsite ? "website search" : "listing", score, verified.checkedAt, now));
      measured = verified.canClaimNoWebsite;
      break;
    case "DIRECTORY_ONLY":
      score = verified.canClaimNoWebsite ? 75 : 55;
      reasons.push(reason("need", verified.canClaimNoWebsite ? "Only directory listings — no website found" : "A directory listing is the only site on record", verified.canClaimNoWebsite ? "website search" : "listing", score, verified.checkedAt, now));
      measured = verified.canClaimNoWebsite;
      break;
    case "WEBSITE_UNREACHABLE":
      score = 60;
      reasons.push(reason("need", "Website could not be reached when audited", "website audit", 60, audit?.finishedAt ?? "", now));
      at = audit?.finishedAt ?? at;
      break;
    case "WEBSITE_FOUND":
    case "WEBSITE_NOT_CONFIRMED":
      if (audit && audit.opportunity !== "unmeasured") {
        const weights: Record<string, number> = { strong: 78, moderate: 52, low: 25, none: 5 };
        score = weights[audit.opportunity] ?? 30;
        at = audit.finishedAt;
        if (audit.opportunity === "none") reasons.push(reason("need", "Website audit found nothing worth raising", "website audit", 5, at, now));
        for (const finding of audit.keyFindings.slice(0, 3)) {
          reasons.push(reason("need", finding.title, finding.source === "pagespeed" ? "Google PageSpeed" : "website audit", finding.impact, finding.observedAt || at, now));
        }
        if (reasons.length === 0) reasons.push(reason("need", OPPORTUNITY_LABEL[audit.opportunity], "website audit", score, at, now));
      } else if (lead.websiteQuality === "good") {
        score = 5;
        reasons.push(reason("need", "Website already looks good (older check)", "website check", 5, lead.websiteCheckedAt, now));
      } else if (lead.websiteQuality === "poor" || lead.websiteQuality === "improve") {
        // The older, coarser check: counts, but at lower weight than an audit.
        score = lead.websiteQuality === "poor" ? 50 : 35;
        reasons.push(reason("need", lead.websiteQuality === "poor" ? "Website scored poorly (older check — audit for detail)" : "Website could do more (older check — audit for detail)", "website check", score, lead.websiteCheckedAt, now));
        measured = false;
      } else if (lead.website.trim()) {
        score = 30;
        measured = false;
        reasons.push(reason("need", "Has a website — not audited yet", "listing", 0));
      } else {
        // No website listed, nobody has searched: plausible, unproven.
        score = 45;
        measured = false;
        reasons.push(reason("need", "No website listed — not yet searched", "listing", 0));
      }
      break;
  }

  const fresh: Freshness | "unknown" = at ? freshness(at, now) : "unknown";
  if (fresh === "stale" && measured) {
    // Old evidence still counts, but less, and the card says so.
    score = Math.round(score * 0.8);
    reasons.push(reason("need", `Evidence from ${dateLabel(at)} is stale — re-check`, "freshness", 0, at, now));
  }
  const independent = verified.state === "WEBSITE_FOUND" || verified.state === "WEBSITE_NOT_CONFIRMED";
  return {
    score,
    level: level(score, measured || score > 0),
    reasons,
    freshness: fresh,
    measured,
    needsAudit: independent && Boolean(lead.website.trim()) && !audit,
    needsSearch: !verified.canClaimNoWebsite && (!lead.website.trim() || verified.state === "SOCIAL_ONLY" || verified.state === "DIRECTORY_ONLY"),
  };
}

// ── VALUE ────────────────────────────────────────────────────────────────────

function valueOf(lead: OutreachLead, context: ScoreContext, now: Date): AxisScore & { excluded: boolean; closed: boolean } {
  const reasons: Reason[] = [];
  let score = 35;
  const tier = tradeTier(lead.trade, context.profile);
  if (tier === "excluded") {
    return { score: 0, level: "low", reasons: [reason("value", `${lead.trade} is excluded in your profile`, "your profile", -35)], excluded: true, closed: false };
  }
  const tierPoints = { high: 25, medium: 12, low: -15, unknown: 0 }[tier];
  if (tier !== "unknown") {
    score += tierPoints;
    reasons.push(reason("value", `${lead.trade}: ${TRADE_TIER_LABEL[tier]}`, context.profile?.preferredTrades?.length ? "your profile" : "trade", tierPoints));
  }

  const reviews = typeof lead.reviews === "number" ? lead.reviews : 0;
  const rating = typeof lead.rating === "number" ? lead.rating : 0;
  if (reviews >= 20) {
    score += 15;
    reasons.push(reason("value", `${reviews} reviews${rating ? ` averaging ${rating}` : ""} — established and busy`, "listing", 15, lead.foundAt, now));
  } else if (reviews >= 5) {
    score += 8;
    reasons.push(reason("value", `${reviews} reviews${rating ? ` averaging ${rating}` : ""}`, "listing", 8, lead.foundAt, now));
  }

  const legal = legalFormOf(lead, context.rules ?? DEFAULT_CONTACT_RULES, now);
  if (legal.form === "CORPORATE" && legal.basis === "companies_house") {
    score += 10;
    reasons.push(reason("value", "Active registered company", "Companies House", 10, lead.facts?.companyCheckedAt || lead.foundAt, now));
  }

  const closed = /closed|dissolved|permanently/i.test(lead.businessStatus ?? "");
  if (closed) {
    score = 0;
    reasons.push(reason("value", `Listing says: ${lead.businessStatus}`, "listing", -35, lead.foundAt, now));
  }
  return { score: Math.max(0, Math.min(100, score)), level: level(score, true), reasons, excluded: false, closed };
}

// ── REACH ────────────────────────────────────────────────────────────────────

function reachOf(lead: OutreachLead, context: ScoreContext, now: Date): ProspectScore["reach"] {
  const reasons: Reason[] = [];
  const legal = legalFormOf(lead, context.rules ?? DEFAULT_CONTACT_RULES, now);
  const usableEmail =
    lead.email.trim() && (lead.emailConfidence === "HIGH" || lead.emailConfidence === "MEDIUM") && !/guess/i.test(lead.emailSource);
  const email = usableEmail ? emailContactability({ email: lead.email, website: lead.website, legal }) : null;
  let emailStatus: EmailStatus | "NONE" = email ? email.status : "NONE";
  if (context.suppressed && emailStatus !== "NONE") emailStatus = "BLOCKED";

  const call = callContactability(
    {
      phone: lead.phone,
      screening: context.screening ?? null,
      doNotCall: context.doNotCall ?? null,
      callResult: lead.callResult,
      called: lead.called,
      unsubscribed: lead.unsubscribed,
      outreachStatus: lead.outreachStatus,
    },
    now,
  );

  let score = 0;
  if (emailStatus === "ELIGIBLE") {
    score = 70;
    reasons.push(reason("reach", `Email ${lead.email} (${email!.address?.kind === "role" ? "business address" : "business domain"})`, lead.emailSource || "website", 70, lead.emailFoundAt ?? "", now));
  } else if (emailStatus === "HOLD") {
    score = 25;
    reasons.push(reason("reach", `Email on hold: ${email!.reasons[0]}`, "legal-form rules", 25));
  } else if (emailStatus === "BLOCKED" && email) {
    reasons.push(reason("reach", `Email not usable: ${context.suppressed ? "on your suppression list" : email.reasons[0]}`, "contact rules", 0));
  }
  if (call.status === "ELIGIBLE") {
    score = Math.max(score, 65) + (score > 0 ? 10 : 0);
    reasons.push(reason("reach", `Phone ${call.phone?.national ?? lead.phone}: ${call.reasons[0]}`, "screening", 65));
  } else if (call.status === "UNKNOWN") {
    score = Math.max(score, 45);
    reasons.push(reason("reach", `Phone ${call.phone?.national ?? lead.phone} — screen against TPS/CTPS first`, "listing", 45));
  }
  const channel = emailStatus === "ELIGIBLE" && call.status !== "BLOCKED" ? "both" : emailStatus === "ELIGIBLE" ? "email" : call.status !== "BLOCKED" ? "call" : "none";
  return { score: Math.min(100, score), level: level(score, true), reasons, email: emailStatus, call: call.status, channel };
}

// ── The whole picture ────────────────────────────────────────────────────────

const CLOSED_RESULTS = new Set(["Not Interested", "Wrong Number", "Booked", "Won"]);

export function scoreProspect(lead: OutreachLead, context: ScoreContext = {}): ProspectScore {
  const now = context.now ?? new Date();
  const need = needOf(lead, now);
  const value = valueOf(lead, context, now);
  const reach = reachOf(lead, context, now);

  const opportunity = Math.round(need.score * 0.6 + value.score * 0.4);
  const priority = reach.channel === "none" ? Math.min(opportunity, 30) : opportunity;
  let band: Band = priority >= 70 ? "STRONG" : priority >= 50 ? "GOOD" : priority >= 25 ? "WEAK" : "NONE";
  if (need.score <= 10 || value.excluded || value.closed) band = "NONE";

  const blockers: string[] = [];
  let action: Action;
  let actionReason: string;
  const outreach = lead.outreachStatus.trim().toLowerCase();

  if (lead.unsubscribed.trim() || outreach === "unsubscribed" || context.suppressed) {
    action = "SKIP";
    actionReason = "Asked not to be contacted";
    band = "NONE";
  } else if (CLOSED_RESULTS.has(lead.callResult) || lead.called === "Not Interested") {
    action = lead.callResult === "Booked" || lead.callResult === "Won" ? "WAIT" : "SKIP";
    actionReason = lead.callResult === "Booked" || lead.callResult === "Won" ? `Already ${lead.callResult.toLowerCase()}` : `Marked ${(lead.callResult || lead.called).toLowerCase()}`;
  } else if (outreach === "replied") {
    action = "WAIT";
    actionReason = "They replied — the conversation is under way";
  } else if (context.contacted || lead.lastEmailedAt.trim()) {
    action = "WAIT";
    actionReason = "Already emailed — follow-ups and replies take it from here";
  } else if (value.excluded) {
    action = "SKIP";
    actionReason = "Trade excluded in your profile";
  } else if (value.closed) {
    action = "SKIP";
    actionReason = "The listing says the business is closed";
  } else if (need.score <= 10) {
    action = "SKIP";
    actionReason = "No measured website opportunity";
  } else if (need.needsAudit) {
    action = "REVIEW";
    actionReason = "Audit the website before contacting them";
    blockers.push("Audit the website");
  } else if (reach.channel === "none") {
    if (reach.email === "HOLD") {
      action = "REVIEW";
      actionReason = "Confirm whether it is a company before emailing";
      blockers.push("Confirm the legal form (Companies House)");
    } else {
      action = "SKIP";
      actionReason = "No usable email or phone number";
    }
  } else if (reach.call === "ELIGIBLE" && (reach.email !== "ELIGIBLE" || lead.callResult === "Callback" || lead.callResult === "Interested")) {
    action = "CALL";
    actionReason = lead.callResult === "Callback" ? "They asked you to call back" : reach.email === "ELIGIBLE" ? "A call starts the conversation fastest" : "No usable email — a call is the way in";
  } else if (reach.email === "ELIGIBLE") {
    action = "EMAIL";
    actionReason = "A company with a business email address";
  } else {
    action = "CALL";
    actionReason = reach.email === "HOLD" ? "Not confirmed as a company — ring instead of emailing" : "No usable email — a call is the way in";
    blockers.push("Screen the number against TPS and CTPS");
  }
  if (need.needsSearch && (action === "CALL" || action === "EMAIL")) {
    blockers.push("Search for their website before saying they have none");
  }

  // The strongest few on each axis, so a card always shows why it is worth
  // doing (need), why it is worth it (value) and how to reach them (reach).
  const top = (reasons: Reason[], count: number, min: number) =>
    reasons.filter((item) => item.points >= min).sort((a, b) => b.points - a.points).slice(0, count);
  const why = [...top(need.reasons, 2, 0), ...top(value.reasons, 3, 1), ...top(reach.reasons, 2, 1)];

  return {
    need: { score: need.score, level: need.level, reasons: need.reasons },
    value: { score: value.score, level: value.level, reasons: value.reasons },
    reach,
    opportunity,
    priority,
    band,
    action,
    actionReason,
    blockers,
    why,
    freshness: need.freshness,
  };
}

/** Best first: actionable before waiting, then by priority. */
export function rankByScore<T>(items: readonly T[], scoreOf: (item: T) => ProspectScore): T[] {
  const order: Record<Action, number> = { CALL: 0, EMAIL: 0, REVIEW: 1, WAIT: 2, SKIP: 3 };
  return [...items]
    .map((item, index) => ({ item, index, score: scoreOf(item) }))
    .sort((a, b) => order[a.score.action] - order[b.score.action] || b.score.priority - a.score.priority || a.index - b.index)
    .map((entry) => entry.item);
}

export type ScoreTally = { strong: number; good: number; weak: number; none: number; call: number; email: number; review: number; emailsFound: number };

export function tallyScores(leads: readonly OutreachLead[], scores: readonly ProspectScore[]): ScoreTally {
  const tally: ScoreTally = { strong: 0, good: 0, weak: 0, none: 0, call: 0, email: 0, review: 0, emailsFound: 0 };
  scores.forEach((score, index) => {
    tally[score.band === "STRONG" ? "strong" : score.band === "GOOD" ? "good" : score.band === "WEAK" ? "weak" : "none"] += 1;
    if (score.action === "CALL") tally.call += 1;
    if (score.action === "EMAIL") tally.email += 1;
    if (score.action === "REVIEW") tally.review += 1;
    if (leads[index]?.email.trim()) tally.emailsFound += 1;
  });
  return tally;
}

/** What is holding back the next useful action, in one line. */
export function describeBottleneck(scores: readonly ProspectScore[]): string {
  if (scores.length === 0) return "No prospects in this set.";
  const tally = tallyScores([], scores);
  const actionable = tally.call + tally.email;
  if (actionable === 0 && tally.review > 0) return `${tally.review} prospect${tally.review === 1 ? "" : "s"} need a check (audit or legal form) before anyone is contacted.`;
  if (actionable === 0) return "Nobody here is worth contacting right now.";
  if (tally.email === 0 && tally.call > 0) return `${tally.call} prospect${tally.call === 1 ? "" : "s"} to ring — none can be emailed.`;
  return `${tally.email} to email, ${tally.call} to call${tally.review ? `, ${tally.review} to check first` : ""}.`;
}
