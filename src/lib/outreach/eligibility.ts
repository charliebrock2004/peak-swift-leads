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
import { emailOnWrongSite, scoreProspect, websiteMarkedWrong } from "../scoring/prospect-score.ts";
import { rejection } from "../feedback/verdicts.ts";
import { emailContactability, type EmailContactability, type VerificationResult } from "../contactability/email.ts";
import { DEFAULT_CONTACT_RULES, type ContactRules, type LegalFormResult } from "../contactability/legal-form.ts";
import { legalFormOf } from "../contactability/lead.ts";

export { legalFormOf, legalInputOf } from "../contactability/lead.ts";
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
  /** The website has not been audited, so there is no measured reason to write. */
  "unaudited",
  "manual-review",
  "invalid-email",
  /** A sole trader or partnership: an individual subscriber, who needs to have consented. */
  "individual-subscriber",
  /** gmail.com and friends: the subscriber is the person holding the mailbox. */
  "personal-mailbox",
  /** An email verifier says the mailbox does not exist. */
  "undeliverable",
  /** You marked the business bad, irrelevant, a duplicate, the wrong business or not in the trade. */
  "rejected-by-you",
  /** You marked the contact details wrong and have not corrected them. */
  "wrong-contact",
  /** You marked the website on record as not theirs and have not corrected it. */
  "wrong-website",
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
  "no-opportunity": "No measured website opportunity",
  "low-opportunity": "Low opportunity",
  unaudited: "Website not audited yet",
  "manual-review": "Not confirmed as a company",
  "invalid-email": "Email address does not look valid",
  "individual-subscriber": "Sole trader or partnership — call instead",
  "personal-mailbox": "Personal mailbox — call instead",
  undeliverable: "Email address does not exist",
  "rejected-by-you": "You marked it as not a prospect",
  "wrong-contact": "You marked the contact details wrong",
  "wrong-website": "You marked the website as not theirs",
};

export type Eligibility = (
  | { eligible: true; band: "High" | "Medium" | "Low"; score: number; manualReview: false }
  /**
   * `manualReview` is a hold, not a refusal: the business is not confirmed as a
   * company. Confirming its legal form (or a Companies House check) releases it.
   */
  | { eligible: false; reasons: IneligibleReason[]; band: "High" | "Medium" | "Low"; score: number; manualReview: boolean }
) & {
  /** Who the subscriber is, and why the product thinks so. */
  legal: LegalFormResult;
  /** The address-level verdict, with notes worth knowing even when eligible. */
  contact: EmailContactability;
};

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

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

/**
 * Held for a person to confirm: the business is not confirmed as a company.
 *
 * UK PECR lets a company be emailed without prior consent, but not a sole
 * trader or a partnership (individual subscribers). When the product cannot
 * tell, it treats the business as an individual (ICO) — so the lead is held,
 * and never emailed, until its legal form is confirmed.
 */
export function needsManualReview(lead: OutreachLead, rules: ContactRules = DEFAULT_CONTACT_RULES): boolean {
  const form = legalFormOf(lead, rules).form;
  return form === "UNKNOWN" || form === "REVIEW_REQUIRED";
}

export type EligibilityContext = {
  settings: Pick<OutreachSettings, "includeLow">;
  /** Lowercased addresses that must never be contacted again. */
  suppressed: ReadonlySet<string>;
  /** Lead ids that already have a live email of the kind being considered. */
  alreadyContacted: ReadonlySet<string>;
  /** Lowercased recipient addresses that already have a live email of this kind. */
  contactedAddresses: ReadonlySet<string>;
  /** The configurable legal-form rules. Defaults are the conservative ones. */
  rules?: ContactRules;
  /** Verifier results by lowercased address, when a verifier is configured. */
  verifications?: ReadonlyMap<string, VerificationResult>;
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
 * The send queue's three bands, from the prospect score's opportunity (need ×
 * value). Reach is judged by the rules below, so "no way to contact" is
 * reported as that — never disguised as a low opportunity.
 */
export function bandOf(score: { opportunity?: number; priority: number }): "High" | "Medium" | "Low" {
  const value = score.opportunity ?? score.priority;
  return value >= 70 ? "High" : value >= 45 ? "Medium" : "Low";
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
  // The one prospect score (scoring/prospect-score.ts) decides opportunity;
  // the rules below decide permission.
  const prospect = scoreProspect(lead, { rules: context.rules });
  const score = prospect.opportunity;
  const band = bandOf(prospect);
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

  // What you said about the business stands until you change it — for
  // follow-ups as much as first emails.
  const feedback = lead.facts?.feedback ?? [];
  if (rejection(feedback)) reasons.push("rejected-by-you");
  if (feedback.includes("wrong_contact")) reasons.push("wrong-contact");
  if (websiteMarkedWrong(lead) || emailOnWrongSite(lead)) reasons.push("wrong-website");

  const result = lead.callResult;
  if (result === "Not Interested" || lead.called === "Not Interested") reasons.push("not-interested");
  if (result === "Booked") reasons.push("booked");
  if (result === "Won") reasons.push("won");

  // A business whose site is already good has nothing honest to offer them.
  if (prospect.need.score <= 10) reasons.push("no-opportunity");
  else if (prospect.blockers.includes("Audit the website")) reasons.push("unaudited");
  else if (band === "Low" && !context.settings.includeLow) reasons.push("low-opportunity");

  // Who the subscriber is. The legal rules only ever add caution: they can
  // hold or refuse a lead, never let through one another rule refused.
  const legal = legalFormOf(lead, context.rules ?? DEFAULT_CONTACT_RULES);
  const verification = email ? context.verifications?.get(email) : undefined;
  const contact = emailContactability({
    email: lead.email,
    website: lead.website,
    legal,
    verification: verification ? { result: verification } : null,
  });
  if (email && looksLikeEmail(email)) {
    if (contact.address?.kind === "personal_mailbox") reasons.push("personal-mailbox");
    else if (verification === "invalid") reasons.push("undeliverable");
    else if (legal.form === "INDIVIDUAL") reasons.push("individual-subscriber");
  }
  const manualReview = email !== "" && contact.status === "HOLD";

  if (reasons.length > 0) return { eligible: false, reasons, band, score, manualReview, legal, contact };
  if (manualReview) return { eligible: false, reasons: ["manual-review"], band, score, manualReview: true, legal, contact };
  return { eligible: true, band, score, manualReview: false, legal, contact };
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

/**
 * The refusals that mean "we have no way to write to them", as opposed to
 * "do not write to them".
 *
 * The difference is the whole point of the worth-ringing list. A business with
 * no published address has done nothing to disqualify itself; a business that
 * unsubscribed, replied, or was already contacted has, and must never appear on
 * a list suggesting you ring them.
 */
const NO_WAY_TO_WRITE = new Set<IneligibleReason>([
  "no-email",
  "low-confidence",
  "guessed-email",
  "invalid-email",
  // Not "must not contact": email is the wrong channel for them. A phone call
  // (screened against TPS/CTPS) is how a sole trader is approached.
  "individual-subscriber",
  "personal-mailbox",
  "undeliverable",
]);

/**
 * Is this refusal "cannot email them" rather than "must not contact them"?
 *
 * Deliberately narrow, and it never overrides a rule. A lead qualifies only if
 * *every* reason it was refused is about the address, it is not held for manual
 * review, there is a number to ring, and the opportunity is real. Anything
 * suppressed, unsubscribed, already contacted, replied, booked, won, marked Not
 * Interested, or with a website that is already good fails the first test and
 * is simply not on the list.
 *
 * Manual-review holds are excluded too. They are protected from automation, and
 * they stay under their own filter where the reason for the hold is spelled
 * out — not folded into a list that reads like a to-do.
 *
 * This lives here, beside the rules it reads, because both the AI Outreach call
 * list and the Prospects filter ask it. Two copies would eventually disagree.
 */
export function isWorthRinging(lead: Pick<OutreachLead, "phone">, verdict: Eligibility): boolean {
  if (verdict.eligible) return false;
  if (verdict.manualReview) return false;
  if (verdict.reasons.length === 0) return false;
  if (!verdict.reasons.every((reason) => NO_WAY_TO_WRITE.has(reason))) return false;
  if (!lead.phone.trim()) return false;
  return verdict.band !== "Low";
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
  "worth-ringing",
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
  "worth-ringing": "Worth ringing",
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
    case "worth-ringing":
      return isWorthRinging(lead, eligibility);
    default:
      return true;
  }
}
