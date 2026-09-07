/**
 * Who may be emailed, and why not.
 *
 * This is the safety core of outreach. Everything downstream — generation, the
 * queue, the sender — asks this module first, and the sender asks it again
 * immediately before handing anything to Gmail. Two checks, because a lead can
 * change between being queued and being sent: they might reply, or unsubscribe,
 * or you might mark them Not Interested after a phone call.
 *
 * The rules are deliberately conservative. Every "no" is a named reason the UI
 * can show, so nothing is ever silently dropped.
 */
import { computeOpportunity, opportunityBand, type Lead } from "../leads.ts";
import type { EmailKind, OutreachLead, OutreachSettings } from "./types.ts";

export const INELIGIBLE_REASONS = [
  "no-email",
  "low-confidence",
  "guessed-email",
  "unsubscribed",
  "suppressed",
  "already-contacted",
  "not-interested",
  "booked",
  "won",
  "replied",
  "no-opportunity",
  "low-opportunity",
  "manual-review",
  "invalid-email",
] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

export const REASON_LABELS: Record<IneligibleReason, string> = {
  "no-email": "No public email found",
  "low-confidence": "Email confidence too low",
  "guessed-email": "Email was guessed, not found on the site",
  unsubscribed: "Asked not to be contacted",
  suppressed: "On the suppression list",
  "already-contacted": "Already emailed",
  "not-interested": "Marked Not Interested",
  booked: "Already booked",
  won: "Already a customer",
  replied: "They have replied — over to you",
  "no-opportunity": "Their website is already good",
  "low-opportunity": "Low opportunity",
  "manual-review": "Manual review required",
  "invalid-email": "Email address does not look valid",
};

export type Eligibility =
  | { eligible: true; band: "High" | "Medium" | "Low"; score: number; manualReview: false }
  /** `manualReview` is a hold, not a refusal: you can send it by hand after looking. */
  | { eligible: false; reasons: IneligibleReason[]; band: "High" | "Medium" | "Low"; score: number; manualReview: boolean };

/** Conservative: this is a gate, not a parser. Anything odd is rejected. */
export function looksLikeEmail(value: string): boolean {
  const email = value.trim();
  if (email.length < 6 || email.length > 254) return false;
  if (/\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64) return false;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.startsWith("-") || /\.\./.test(domain)) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain);
}

/**
 * Addresses that are a person rather than a business, or a role we should not
 * cold-email. Public business contact only — see the compliance note in
 * ARCHITECTURE.md.
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "btinternet.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "sky.com",
  "talktalk.net",
  "virginmedia.com",
]);

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

/**
 * UK direct marketing rules treat a sole trader or an unincorporated partnership
 * like an individual, so a blanket "it was on their website" is not a good
 * enough basis to send automatically.
 *
 * We cannot know a business's legal form from a listing, so this is a heuristic
 * that only ever *adds* caution: it holds the lead for you to look at, and never
 * lets one through that another rule refused.
 */
export function needsManualReview(lead: OutreachLead): boolean {
  const domain = emailDomain(lead.email);
  // A personal mailbox is the strongest signal of a sole trader.
  if (domain && PERSONAL_DOMAINS.has(domain)) return true;
  const name = lead.businessName.toLowerCase();
  // "Ltd", "Limited", "PLC", "LLP" mean a company, which is fair game.
  const incorporated = /\b(ltd|limited|plc|llp|cic|c\.i\.c)\b/.test(name);
  if (incorporated) return false;
  // A person's name as the business name — "J Smith Joinery", "Gavin Brock
  // Joinery" — usually means a sole trader.
  const personalName = /^(mr|mrs|ms|miss)\b/.test(name) || /^[a-z]\s+[a-z]{2,}\s/.test(name);
  return personalName;
}

export type EligibilityContext = {
  settings: Pick<OutreachSettings, "includeLow">;
  /** Lowercased addresses that must never be contacted again. */
  suppressed: ReadonlySet<string>;
  /** Lead ids that already have a live email of the kind being considered. */
  alreadyContacted: ReadonlySet<string>;
  /** Lowercased recipient addresses that already have a live email of this kind. */
  contactedAddresses: ReadonlySet<string>;
};

export function emptyContext(
  overrides: Partial<EligibilityContext> = {},
): EligibilityContext {
  return {
    settings: { includeLow: false },
    suppressed: new Set(),
    alreadyContacted: new Set(),
    contactedAddresses: new Set(),
    ...overrides,
  };
}

/**
 * May we email this lead?
 *
 * `kind` matters: an initial email is refused once one has been sent, but a
 * follow-up is *expected* to go to someone already contacted. Follow-up
 * scheduling itself lives in `follow-ups.ts`; this only says the lead is still
 * a legitimate target at all.
 */
export function checkEligibility(
  lead: OutreachLead,
  context: EligibilityContext = emptyContext(),
  kind: EmailKind = "initial",
): Eligibility {
  const score = computeOpportunity(lead as Lead);
  const band = opportunityBand(score);
  const reasons: IneligibleReason[] = [];
  const email = lead.email.trim().toLowerCase();

  if (!email) reasons.push("no-email");
  else if (!looksLikeEmail(email)) reasons.push("invalid-email");

  // Phase 2 only ever records an email it actually saw on a page. Anything
  // marked LOW is weak evidence, and a guess is never sendable.
  const confidence = lead.emailConfidence;
  if (email && confidence !== "HIGH" && confidence !== "MEDIUM") reasons.push("low-confidence");
  if (/guess/i.test(lead.emailSource)) reasons.push("guessed-email");

  if (lead.unsubscribed.trim()) reasons.push("unsubscribed");
  if (email && context.suppressed.has(email)) reasons.push("suppressed");

  const outreach = lead.outreachStatus.trim().toLowerCase();
  if (outreach === "replied") reasons.push("replied");
  if (outreach === "unsubscribed" && !reasons.includes("unsubscribed")) reasons.push("unsubscribed");

  if (kind === "initial") {
    const contacted =
      context.alreadyContacted.has(lead.id) ||
      (email !== "" && context.contactedAddresses.has(email)) ||
      Boolean(lead.lastEmailedAt.trim());
    if (contacted) reasons.push("already-contacted");
  }

  const result = lead.callResult;
  if (result === "Not Interested" || lead.called === "Not Interested") reasons.push("not-interested");
  if (result === "Booked") reasons.push("booked");
  if (result === "Won") reasons.push("won");

  // A business whose site is already good has nothing honest to offer them.
  if (lead.websiteQuality === "good") reasons.push("no-opportunity");
  if (band === "Low" && !context.settings.includeLow) reasons.push("low-opportunity");

  const manualReview = needsManualReview(lead);

  if (reasons.length > 0) return { eligible: false, reasons, band, score, manualReview };
  if (manualReview) return { eligible: false, reasons: ["manual-review"], band, score, manualReview: true };
  return { eligible: true, band, score, manualReview: false };
}

/**
 * Eligible leads, best first.
 *
 * High opportunity before Medium before Low, and within a band the higher score
 * first — the order you would work the list in if you were doing it by hand.
 */
export function rankEligible<T extends OutreachLead>(
  leads: readonly T[],
  context: EligibilityContext = emptyContext(),
  kind: EmailKind = "initial",
): { lead: T; eligibility: Eligibility }[] {
  const rank = { High: 0, Medium: 1, Low: 2 };
  return leads
    .map((lead) => ({ lead, eligibility: checkEligibility(lead, context, kind) }))
    .filter((entry) => entry.eligibility.eligible)
    .sort((a, b) => {
      const byBand = rank[a.eligibility.band] - rank[b.eligibility.band];
      if (byBand !== 0) return byBand;
      return b.eligibility.score - a.eligibility.score;
    });
}

/** The filters offered above the outreach list. */
export const OUTREACH_FILTERS = [
  "all",
  "high",
  "medium",
  "no-website",
  "poor-website",
  "needs-improvement",
  "email-found",
  "never-contacted",
  "manual-review",
] as const;
export type OutreachFilter = (typeof OUTREACH_FILTERS)[number];

export const FILTER_LABELS: Record<OutreachFilter, string> = {
  all: "All",
  high: "High opportunity",
  medium: "Medium opportunity",
  "no-website": "No website",
  "poor-website": "Poor website",
  "needs-improvement": "Needs improvement",
  "email-found": "Email found",
  "never-contacted": "Never contacted",
  "manual-review": "Manual review",
};

export function matchesFilter(
  lead: OutreachLead,
  eligibility: Eligibility,
  filter: OutreachFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "high":
      return eligibility.band === "High";
    case "medium":
      return eligibility.band === "Medium";
    case "no-website":
      return lead.websiteStatus === "No Website Found";
    case "poor-website":
      return lead.websiteQuality === "poor";
    case "needs-improvement":
      return lead.websiteQuality === "improve" || lead.websiteStatus === "Basic Website";
    case "email-found":
      return lead.email.trim() !== "";
    case "never-contacted":
      return !lead.lastEmailedAt.trim();
    case "manual-review":
      return eligibility.manualReview;
    default:
      return true;
  }
}
