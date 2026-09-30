/**
 * The funnel of one prospecting run — every number traceable, every loss named.
 *
 * A run is a sequence of narrowing steps: listings found → unique businesses →
 * genuinely new → checked → qualified → written → ready today. At each step a
 * business either continues or leaves through exactly one named door, and
 * `reconcileFunnel` proves the arithmetic holds. A funnel that does not add up
 * is a number on screen that is lying, so the Find screen shows the problem
 * rather than the figure.
 *
 * Pure and client-safe: the Find screen builds it as the run goes, and the run
 * record stores it so "View run" can show exactly the same thing later.
 */
import { checkEligibility, isWorthRinging, type EligibilityContext } from "./eligibility.ts";
import type { OutreachLead } from "./types.ts";

export type RunFunnel = {
  // ── Discovery (from the sources) ──────────────────────────────────────────
  /** Listings returned by every source, before anything was merged. */
  rawFound: number;
  /** Distinct businesses once the same business across sources was merged. */
  unique: number;
  /** Cut by the per-area fetch budget (an area held more than one page). */
  beyondFetchBudget: number;
  /** Offered to the run's candidate pool: unique minus the fetch-budget cut. */
  offered: number;
  // ── De-duplication and exclusions (the pool) ──────────────────────────────
  duplicatesAcrossAreas: number;
  /** Already on your sheet — or found under an earlier trade in this run. */
  alreadyKnown: number;
  alreadyContacted: number;
  suppressed: number;
  beyondSafetyCeiling: number;
  newCandidates: number;
  /** New, but not needed: the run's target was already met. */
  notNeeded: number;
  /** New prospects this run took on. */
  selected: number;
  // ── Checks, per prospect ──────────────────────────────────────────────────
  checked: number;
  checkErrors: number;
  websiteVerified: number;
  websiteListed: number;
  websiteSocialOrDirectory: number;
  websiteNone: number;
  /** Candidate sites looked at and refused as not this business. Not per business. */
  websitesRejected: number;
  emailsFound: number;
  emailsHigh: number;
  emailsMedium: number;
  noEmail: number;
  /** Addresses seen on pages and refused (noreply@, platform addresses…). Not per business. */
  emailsRejected: number;
  // ── Qualification (sums to `checked`) ─────────────────────────────────────
  eligible: number;
  call: number;
  manualReview: number;
  goodWebsite: number;
  lowOpportunity: number;
  alreadyInTouch: number;
  optedOut: number;
  closed: number;
  noWayToContact: number;
  otherSkipped: number;
  // ── Writing ───────────────────────────────────────────────────────────────
  prepared: number;
  prepareFailed: number;
  /** Eligible but not written because the run was stopped first. */
  notWritten: number;
  readyToday: number;
  heldForTomorrow: number;
};

export function emptyFunnel(): RunFunnel {
  return {
    rawFound: 0,
    unique: 0,
    beyondFetchBudget: 0,
    offered: 0,
    duplicatesAcrossAreas: 0,
    alreadyKnown: 0,
    alreadyContacted: 0,
    suppressed: 0,
    beyondSafetyCeiling: 0,
    newCandidates: 0,
    notNeeded: 0,
    selected: 0,
    checked: 0,
    checkErrors: 0,
    websiteVerified: 0,
    websiteListed: 0,
    websiteSocialOrDirectory: 0,
    websiteNone: 0,
    websitesRejected: 0,
    emailsFound: 0,
    emailsHigh: 0,
    emailsMedium: 0,
    noEmail: 0,
    emailsRejected: 0,
    eligible: 0,
    call: 0,
    manualReview: 0,
    goodWebsite: 0,
    lowOpportunity: 0,
    alreadyInTouch: 0,
    optedOut: 0,
    closed: 0,
    noWayToContact: 0,
    otherSkipped: 0,
    prepared: 0,
    prepareFailed: 0,
    notWritten: 0,
    readyToday: 0,
    heldForTomorrow: 0,
  };
}

/** Where one checked prospect ended up. Exactly one of these, always. */
export type RunOutcome =
  | "eligible"
  | "call"
  | "manualReview"
  | "goodWebsite"
  | "lowOpportunity"
  | "alreadyInTouch"
  | "optedOut"
  | "closed"
  | "noWayToContact"
  | "otherSkipped";

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  eligible: "Ready to email",
  call: "Call list — good prospect, no public email",
  manualReview: "Held for you — not confirmed as a company",
  goodWebsite: "Already has a good website",
  lowOpportunity: "Low opportunity",
  alreadyInTouch: "Already emailed or replied",
  optedOut: "Opted out",
  closed: "Closed — not interested, booked or won",
  noWayToContact: "No public email and no phone",
  otherSkipped: "Not eligible",
};

/**
 * One prospect's outcome, from the same eligibility gate sending uses.
 *
 * Priority matters when a business fails several rules: an opt-out or a closed
 * deal is the reason that must be shown, ahead of "no email".
 */
export function classifyRunLead(lead: OutreachLead, context: EligibilityContext): RunOutcome {
  const verdict = checkEligibility(lead, context, "initial");
  if (verdict.eligible) return "eligible";
  const reasons = new Set(verdict.reasons);
  if (reasons.has("suppressed") || reasons.has("unsubscribed")) return "optedOut";
  if (reasons.has("not-interested") || reasons.has("booked") || reasons.has("won")) return "closed";
  if (reasons.has("already-contacted") || reasons.has("replied")) return "alreadyInTouch";
  if (verdict.manualReview && (reasons.has("manual-review") || verdict.reasons.length === 0)) return "manualReview";
  if (isWorthRinging(lead, verdict)) return "call";
  if (reasons.has("no-opportunity")) return "goodWebsite";
  if (reasons.has("low-opportunity")) return "lowOpportunity";
  if (verdict.manualReview) return "manualReview";
  if (
    (reasons.has("no-email") ||
      reasons.has("low-confidence") ||
      reasons.has("guessed-email") ||
      reasons.has("invalid-email") ||
      reasons.has("individual-subscriber") ||
      reasons.has("personal-mailbox") ||
      reasons.has("undeliverable")) &&
    !lead.phone.trim()
  ) {
    return "noWayToContact";
  }
  return "otherSkipped";
}

/** Count outcomes for a set of prospects. The counts always sum to `leads.length`. */
export function tallyOutcomes(
  leads: readonly OutreachLead[],
  context: EligibilityContext,
): Record<RunOutcome, number> & { byLead: Map<string, RunOutcome> } {
  const counts: Record<RunOutcome, number> = {
    eligible: 0,
    call: 0,
    manualReview: 0,
    goodWebsite: 0,
    lowOpportunity: 0,
    alreadyInTouch: 0,
    optedOut: 0,
    closed: 0,
    noWayToContact: 0,
    otherSkipped: 0,
  };
  const byLead = new Map<string, RunOutcome>();
  for (const lead of leads) {
    const outcome = classifyRunLead(lead, context);
    counts[outcome] += 1;
    byLead.set(lead.id, outcome);
  }
  return { ...counts, byLead };
}

/** How a checked lead's website ended up, for the website counters. */
export function websiteOutcome(lead: Pick<OutreachLead, "website" | "websiteStatus">, verified: boolean): "verified" | "listed" | "socialOrDirectory" | "none" {
  if (lead.websiteStatus === "Social Only" || lead.websiteStatus === "Directory Only") return "socialOrDirectory";
  if (verified) return "verified";
  if (lead.website.trim() && (lead.websiteStatus === "Proper Website" || lead.websiteStatus === "Basic Website" || lead.websiteStatus === "Unclear" || !lead.websiteStatus)) {
    return "listed";
  }
  return "none";
}

/**
 * Does every stage add up? Returns the broken equations, in words.
 *
 * Only checks what the run has reached: a run stopped after discovery is not
 * "missing" its qualification numbers.
 */
export function reconcileFunnel(f: RunFunnel): string[] {
  const problems: string[] = [];
  const expect = (label: string, left: number, right: number) => {
    if (left !== right) problems.push(`${label}: ${left} ≠ ${right}`);
  };
  if (f.offered > 0 || f.newCandidates > 0) {
    expect(
      "offered = duplicates + known + contacted + suppressed + ceiling + new",
      f.offered,
      f.duplicatesAcrossAreas + f.alreadyKnown + f.alreadyContacted + f.suppressed + f.beyondSafetyCeiling + f.newCandidates,
    );
    expect("new candidates = selected + not needed", f.newCandidates, f.selected + f.notNeeded);
  }
  if (f.checked > 0) {
    expect(
      "checked = websites verified + listed + social/directory + none",
      f.checked,
      f.websiteVerified + f.websiteListed + f.websiteSocialOrDirectory + f.websiteNone,
    );
    expect("checked = emails found + no email", f.checked, f.emailsFound + f.noEmail);
    expect("emails found = HIGH + MEDIUM", f.emailsFound, f.emailsHigh + f.emailsMedium);
    const qualified =
      f.eligible + f.call + f.manualReview + f.goodWebsite + f.lowOpportunity + f.alreadyInTouch + f.optedOut + f.closed + f.noWayToContact + f.otherSkipped;
    if (qualified > 0) expect("checked = every qualification outcome", f.checked, qualified);
  }
  if (f.prepared + f.prepareFailed + f.notWritten > 0) {
    expect("eligible = written + failed + not written", f.eligible, f.prepared + f.prepareFailed + f.notWritten);
    expect("written = ready today + held for tomorrow", f.prepared, f.readyToday + f.heldForTomorrow);
  }
  return problems;
}

/** The headline steps, in order, for the progress view and the run record. */
export function funnelHeadline(f: RunFunnel): { label: string; value: number }[] {
  return [
    { label: "Listings found", value: f.rawFound },
    { label: "Unique businesses", value: f.unique },
    { label: "New to you", value: f.selected },
    { label: "Website opportunities", value: f.checked - f.goodWebsite },
    { label: "Verified public emails", value: f.emailsFound },
    { label: "Eligible to email", value: f.eligible },
    { label: "Personalised emails", value: f.prepared },
    { label: "Ready to send today", value: f.readyToday },
  ];
}

/** Parse a stored funnel, tolerating older runs that stored none. */
export function parseFunnel(stored: string): RunFunnel | null {
  if (!stored.trim()) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<RunFunnel>;
    const out = emptyFunnel();
    for (const key of Object.keys(out) as (keyof RunFunnel)[]) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}
