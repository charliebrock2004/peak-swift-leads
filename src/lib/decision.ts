/**
 * The sales decision for one prospect.
 *
 * Opportunity score (0–100) is still computed in `leads.ts`. This module turns
 * that score, the website evidence, the public email (or lack of one) and the
 * phone number into a single named verdict an operator or an AI agent can act
 * on: HOT, WARM, CALL, LOW or SKIP.
 *
 * It never invents an email. A strong business with no public address becomes
 * CALL, not SKIP. Directory listings and social profiles are treated as
 * evidence of a missing website, not as a reason to throw the lead away.
 */
import {
  computeOpportunity,
  opportunityBand,
  resolveWebsiteStatus,
  type Lead,
  type WebsiteQuality,
  type WebsiteStatus,
} from "./leads.ts";
import { looksLikeEmail, needsManualReview, type Eligibility } from "./outreach/eligibility.ts";
import type { OutreachLead } from "./outreach/types.ts";

export const DECISION_LEVELS = ["HOT", "WARM", "CALL", "LOW", "SKIP"] as const;
export type DecisionLevel = (typeof DECISION_LEVELS)[number];

export const WEBSITE_GRADES = [
  "NO WEBSITE",
  "POOR",
  "OUTDATED",
  "BASIC",
  "DECENT",
  "STRONG",
  "UNKNOWN",
] as const;
export type WebsiteGrade = (typeof WEBSITE_GRADES)[number];

export const NEXT_ACTIONS = ["EMAIL", "CALL", "REVIEW", "SKIP", "WAIT"] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export type ProspectDecision = {
  level: DecisionLevel;
  score: number;
  band: "High" | "Medium" | "Low";
  confidence: number;
  reasons: string[];
  evidence: string[];
  nextAction: NextAction;
  reviewRequired: boolean;
  websiteGrade: WebsiteGrade;
};

const CLOSED = new Set(["Not Interested", "Wrong Number", "Booked", "Won"]);

/** Map the stored website fields onto the grades the sales copy uses. */
export function websiteGrade(
  status: WebsiteStatus | "",
  quality: WebsiteQuality | "",
): WebsiteGrade {
  if (status === "No Website Found") return "NO WEBSITE";
  if (status === "Social Only" || status === "Directory Only") return "POOR";
  if (quality === "good") return "STRONG";
  if (quality === "poor") return "POOR";
  if (quality === "improve") return "BASIC";
  if (status === "Basic Website") return "BASIC";
  if (status === "Proper Website") return "DECENT";
  return "UNKNOWN";
}

function closedOut(lead: Pick<Lead, "called" | "callResult" | "unsubscribed" | "outreachStatus">): string | null {
  if (lead.unsubscribed.trim()) return "They asked not to be contacted.";
  const outreach = lead.outreachStatus.trim().toLowerCase();
  if (outreach === "unsubscribed") return "They asked not to be contacted.";
  if (outreach === "replied") return "They have already replied.";
  if (CLOSED.has(lead.callResult) || lead.called === "Not Interested") {
    return `This lead is closed (${lead.callResult || lead.called}).`;
  }
  return null;
}

function hasSafeEmail(lead: Pick<Lead, "email" | "emailConfidence" | "emailSource">): boolean {
  const email = lead.email.trim();
  if (!email || !looksLikeEmail(email)) return false;
  if (lead.emailConfidence !== "HIGH" && lead.emailConfidence !== "MEDIUM") return false;
  if (/guess/i.test(lead.emailSource)) return false;
  return true;
}

function hasPhone(lead: Pick<Lead, "phone">): boolean {
  return (lead.phone ?? "").replace(/\D/g, "").length >= 10;
}

/**
 * How sure we are of the verdict, 0–100.
 *
 * Confidence is about evidence quality, not commercial potential. A joinery
 * with no website and a phone number is a high-confidence CALL even if we
 * never found an email — the missing email is the point.
 */
export function decisionConfidence(lead: Lead | OutreachLead): number {
  let confidence = 48;
  const status = resolveWebsiteStatus(lead);
  if (lead.websiteCheckedAt.trim()) confidence += 14;
  if (status === "No Website Found" || status === "Social Only" || status === "Directory Only") confidence += 16;
  if (status === "Unclear") confidence -= 18;
  if (lead.websiteQuality === "unable") confidence -= 12;
  if (lead.websiteQuality === "good" || lead.websiteQuality === "poor") confidence += 10;
  if (hasSafeEmail(lead)) confidence += lead.emailConfidence === "HIGH" ? 18 : 10;
  if (hasPhone(lead)) confidence += 8;
  if (typeof lead.reviews === "number" && lead.reviews >= 8) confidence += 6;
  if (needsManualReview(lead as OutreachLead)) confidence -= 10;
  return Math.max(15, Math.min(98, Math.round(confidence)));
}

/**
 * The named sales decision for one lead.
 *
 * Pure and deterministic so it can be unit-tested without a network, and so an
 * AI agent can explain "why is this HOT?" from the same function the UI uses.
 */
export function decideProspect(
  lead: Lead | OutreachLead,
  options: { includeLow?: boolean } = {},
): ProspectDecision {
  const score = computeOpportunity(lead);
  const band = opportunityBand(score);
  const status = resolveWebsiteStatus(lead);
  const grade = websiteGrade(status, lead.websiteQuality);
  const confidence = decisionConfidence(lead);
  const reasons: string[] = [];
  const evidence: string[] = [];
  const phone = hasPhone(lead);
  const email = hasSafeEmail(lead);
  const missingWebsite =
    status === "No Website Found" ||
    status === "Social Only" ||
    status === "Directory Only" ||
    lead.websiteQuality === "poor";

  const closed = closedOut(lead);
  if (closed) {
    return {
      level: "SKIP",
      score,
      band,
      confidence: Math.max(confidence, 80),
      reasons: [closed],
      evidence: [],
      nextAction: "SKIP",
      reviewRequired: false,
      websiteGrade: grade,
    };
  }

  if (status === "No Website Found") {
    reasons.push("No website found.");
    evidence.push("Public listings did not show an independent site.");
  } else if (status === "Directory Only") {
    reasons.push("Only a directory listing — no real website.");
    evidence.push(lead.website ? `Listed at ${lead.website}` : "Directory listing, no own site.");
  } else if (status === "Social Only") {
    reasons.push("Social profile only — no business website.");
    evidence.push(lead.website ? `Profile at ${lead.website}` : "Social listing only.");
  } else if (lead.websiteQuality === "poor") {
    reasons.push("Website looks poor or unfinished.");
    if (lead.websiteAnalysis.trim()) evidence.push(lead.websiteAnalysis);
  } else if (lead.websiteQuality === "improve" || status === "Basic Website") {
    reasons.push("Website is basic and could do more.");
    if (lead.websiteAnalysis.trim()) evidence.push(lead.websiteAnalysis);
  } else if (lead.websiteQuality === "good") {
    reasons.push("They already have a strong website.");
    if (lead.websiteAnalysis.trim()) evidence.push(lead.websiteAnalysis);
  } else if (status === "Proper Website") {
    reasons.push("They appear to have a website.");
  } else {
    reasons.push("Website presence is unclear.");
  }

  if (email) {
    evidence.push(`Public email ${lead.email} (${lead.emailConfidence}, ${lead.emailSource || "found on site"}).`);
  } else {
    reasons.push("No safe public email found — never guessed.");
  }
  if (phone) evidence.push(`Phone ${lead.phone} is publicly listed.`);
  if (typeof lead.reviews === "number" && lead.reviews > 0) {
    evidence.push(
      `${lead.reviews} review${lead.reviews === 1 ? "" : "s"}${
        typeof lead.rating === "number" ? ` at ${lead.rating}` : ""
      }.`,
    );
  }
  if (lead.trade.trim() && lead.town.trim()) {
    evidence.push(`${lead.trade} in ${lead.town}.`);
  }

  if (lead.websiteQuality === "good") {
    return {
      level: "SKIP",
      score,
      band,
      confidence,
      reasons,
      evidence,
      nextAction: "SKIP",
      reviewRequired: false,
      websiteGrade: grade,
    };
  }

  const reviewRequired =
    needsManualReview(lead as OutreachLead) ||
    (status === "Unclear" && !email) ||
    lead.websiteQuality === "unable" ||
    confidence < 50;

  // Strong / medium opportunity with nowhere to write → CALL, not SKIP.
  if (!email && phone && (band !== "Low" || missingWebsite)) {
    return {
      level: "CALL",
      score,
      band,
      confidence,
      reasons,
      evidence,
      nextAction: reviewRequired ? "REVIEW" : "CALL",
      reviewRequired,
      websiteGrade: grade,
    };
  }

  if (!email) {
    return {
      level: reviewRequired ? "LOW" : "SKIP",
      score,
      band,
      confidence,
      reasons,
      evidence,
      nextAction: reviewRequired ? "REVIEW" : "SKIP",
      reviewRequired,
      websiteGrade: grade,
    };
  }

  if (band === "High") {
    return {
      level: "HOT",
      score,
      band,
      confidence,
      reasons,
      evidence,
      nextAction: reviewRequired ? "REVIEW" : "EMAIL",
      reviewRequired,
      websiteGrade: grade,
    };
  }
  if (band === "Medium") {
    return {
      level: "WARM",
      score,
      band,
      confidence,
      reasons,
      evidence,
      nextAction: reviewRequired ? "REVIEW" : "EMAIL",
      reviewRequired,
      websiteGrade: grade,
    };
  }

  if (options.includeLow) {
    return {
      level: "LOW",
      score,
      band,
      confidence,
      reasons,
      evidence,
      nextAction: reviewRequired ? "REVIEW" : "EMAIL",
      reviewRequired,
      websiteGrade: grade,
    };
  }

  return {
    level: "LOW",
    score,
    band,
    confidence,
    reasons,
    evidence,
    nextAction: "SKIP",
    reviewRequired,
    websiteGrade: grade,
  };
}

/** Bottleneck line for a set of decisions — what is blocking the next send. */
export function describeBottleneck(decisions: readonly ProspectDecision[]): string {
  if (decisions.length === 0) return "No prospects in this set.";
  const counts = { HOT: 0, WARM: 0, CALL: 0, LOW: 0, SKIP: 0 };
  let noEmail = 0;
  let review = 0;
  for (const decision of decisions) {
    counts[decision.level] += 1;
    if (decision.nextAction === "CALL") noEmail += 1;
    if (decision.reviewRequired) review += 1;
  }
  if (counts.HOT + counts.WARM === 0 && noEmail > 0) {
    return `${noEmail} strong prospect${noEmail === 1 ? "" : "s"} had no public email — call them.`;
  }
  if (review > 0 && counts.HOT + counts.WARM === 0) {
    return `${review} prospect${review === 1 ? "" : "s"} need a look before anything is sent.`;
  }
  if (counts.HOT + counts.WARM > 0) {
    return `${counts.HOT + counts.WARM} ready to email.`;
  }
  if (counts.SKIP === decisions.length) return "Nothing in this set is a website opportunity.";
  return "Most remaining prospects are low opportunity.";
}

export function decisionLabel(level: DecisionLevel): string {
  switch (level) {
    case "HOT":
      return "HOT";
    case "WARM":
      return "WARM";
    case "CALL":
      return "CALL";
    case "LOW":
      return "LOW";
    case "SKIP":
      return "SKIP";
  }
}

/** Used by filters and the AI review queue. */
export function needsAiReview(lead: Lead | OutreachLead): boolean {
  const decision = decideProspect(lead);
  return decision.reviewRequired && decision.level !== "SKIP";
}

/** Eligibility still decides who may be emailed; this is who to ring. */
export function isCallLead(lead: Lead | OutreachLead): boolean {
  return decideProspect(lead).level === "CALL";
}

/** The sales filters on the Prospects screen. */
export const PROSPECT_FILTERS = [
  "all",
  "hot",
  "warm",
  "call",
  "review",
  "ready",
  "contacted",
  "replied",
  "follow-up",
  "booked",
  "skipped",
] as const;
export type ProspectFilter = (typeof PROSPECT_FILTERS)[number];

export const PROSPECT_FILTER_LABELS: Record<ProspectFilter, string> = {
  all: "All",
  hot: "HOT",
  warm: "WARM",
  call: "CALL",
  review: "Review",
  ready: "Ready to contact",
  contacted: "Contacted",
  replied: "Replied",
  "follow-up": "Follow-up",
  booked: "Booked",
  skipped: "Skipped",
};

export function matchesProspectFilter(
  lead: Lead | OutreachLead,
  eligibility: Eligibility,
  filter: ProspectFilter,
): boolean {
  const decision = decideProspect(lead);
  const outreach = lead.outreachStatus.trim().toLowerCase();
  switch (filter) {
    case "all":
      return true;
    case "hot":
      return decision.level === "HOT";
    case "warm":
      return decision.level === "WARM";
    case "call":
      return decision.level === "CALL";
    case "review":
      return decision.reviewRequired && decision.level !== "SKIP";
    case "ready":
      return eligibility.eligible;
    case "contacted":
      return Boolean(lead.lastEmailedAt.trim()) || lead.called !== "Not Called";
    case "replied":
      return outreach === "replied";
    case "follow-up":
      return Boolean(lead.followUpDate.trim());
    case "booked":
      return lead.callResult === "Booked" || lead.callResult === "Won";
    case "skipped":
      return decision.level === "SKIP";
  }
}

/**
 * The structured record an AI agent (or a report) should read.
 *
 * Mapped from the existing lead row plus `decideProspect`. No extra columns,
 * so the sheet and outreach stay on one model.
 */
export function toProspectRecord(lead: Lead | OutreachLead) {
  const decision = decideProspect(lead);
  return {
    id: lead.id,
    businessName: lead.businessName,
    trade: lead.trade,
    location: lead.town,
    address: lead.address,
    town: lead.town,
    phone: lead.phone,
    website: lead.website,
    websiteStatus: lead.websiteStatus,
    websiteQualityScore: lead.websiteScore,
    websiteEvidence: lead.websiteAnalysis,
    websiteGrade: decision.websiteGrade,
    email: lead.email,
    emailSource: lead.emailSource,
    emailConfidence: lead.emailConfidence,
    googleBusinessProfile: lead.mapsLink,
    reviewCount: lead.reviews,
    reviewRating: lead.rating,
    opportunityScore: decision.score,
    opportunityLevel: decision.level,
    opportunityReasons: decision.reasons,
    qualificationStatus: decision.level,
    qualificationConfidence: decision.confidence,
    qualificationEvidence: decision.evidence,
    leadStatus: lead.called,
    contactStatus: lead.outreachStatus,
    lastContactedAt: lead.lastEmailedAt,
    followUpDate: lead.followUpDate,
    source: lead.source,
    discoveredAt: lead.foundAt,
    updatedAt: lead.updatedAt,
    nextAction: decision.nextAction,
    reviewRequired: decision.reviewRequired,
  };
}

/** Same numbers the dashboard and a finished run show. */
export function tallyDecisions(leads: readonly (Lead | OutreachLead)[]): {
  hot: number;
  warm: number;
  call: number;
  low: number;
  skip: number;
  review: number;
  emailsFound: number;
} {
  const tally = { hot: 0, warm: 0, call: 0, low: 0, skip: 0, review: 0, emailsFound: 0 };
  for (const row of leads) {
    const decision = decideProspect(row);
    if (decision.level === "HOT") tally.hot += 1;
    else if (decision.level === "WARM") tally.warm += 1;
    else if (decision.level === "CALL") tally.call += 1;
    else if (decision.level === "LOW") tally.low += 1;
    else tally.skip += 1;
    if (decision.reviewRequired) tally.review += 1;
    if (row.email.trim()) tally.emailsFound += 1;
  }
  return tally;
}
