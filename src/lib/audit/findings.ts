/**
 * Website audit findings — the vocabulary.
 *
 * A finding is a MEASUREMENT, stated as one: "Homepage copyright notice says
 * 2017", "PageSpeed measured mobile performance at 42 on 30 Sep 2026", "No
 * <form> or booking widget was found on the homepage". Never a judgement like
 * "your website is outdated". Each carries the value measured, where it was
 * measured, when, and how sure the check is — so a salesperson (and later the
 * AI drafting an email) can only ever repeat what was actually observed.
 *
 * `why` is for the salesperson, not the prospect: why the finding might matter
 * to the business. It is guidance, not evidence.
 *
 * Client-safe and pure.
 */

export const AUDIT_CATEGORIES = ["performance", "conversion", "trust", "seo", "technical", "technology"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<AuditCategory, string> = {
  performance: "Performance",
  conversion: "Conversion",
  trust: "Trust",
  seo: "SEO foundations",
  technical: "Technical",
  technology: "Technology",
};

/**
 * `opportunity` — something a better website would fix (weighted by impact).
 * `ok` — the check passed; shown so the audit is balanced, never pitched.
 * `info` — context worth knowing, neither good nor bad.
 */
export type FindingStatus = "opportunity" | "ok" | "info";

export type FindingSource = "homepage" | "http" | "pagespeed" | "robots.txt" | "sitemap" | "link-check";

export type Finding = {
  /** Stable machine name, e.g. "no_contact_form". */
  kind: string;
  category: AuditCategory;
  status: FindingStatus;
  /** 0–10: how much this matters to a local business's enquiries. Only for opportunities. */
  impact: number;
  /** Short heading for the audit page: "No enquiry form". */
  title: string;
  /** The measured fact, as a sentence that can be repeated verbatim. */
  evidence: string;
  /** Why it might matter — for the salesperson. */
  why: string;
  /** The raw measured value ("2017", "42", "false"). */
  value: string;
  source: FindingSource;
  url: string;
  observedAt: string;
  confidence: "high" | "medium" | "low";
};

export function dateLabel(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
}

export type OpportunityLevel = "strong" | "moderate" | "low" | "none";

export const OPPORTUNITY_LABEL: Record<OpportunityLevel, string> = {
  strong: "Strong website opportunity",
  moderate: "Some website opportunity",
  low: "Small website opportunity",
  none: "Website already in good shape",
};

/**
 * How much measured room for improvement there is.
 *
 * Deliberately simple and explainable: the sum of the impacts of the
 * opportunities found, with the biggest few counting most. A site that could
 * not be measured is not "none" — the caller says "not measured".
 */
export function opportunityLevel(findings: readonly Finding[]): { level: OpportunityLevel; points: number } {
  const impacts = findings
    .filter((finding) => finding.status === "opportunity")
    .map((finding) => finding.impact)
    .sort((a, b) => b - a);
  // Diminishing returns: the fifth small problem adds less than the first big one.
  const points = impacts.reduce((sum, impact, index) => sum + impact * (index < 3 ? 1 : 0.5), 0);
  const level: OpportunityLevel = points >= 18 ? "strong" : points >= 9 ? "moderate" : points > 0 ? "low" : "none";
  return { level, points: Math.round(points) };
}

/** The 3–5 findings worth leading with: biggest impact first, one per kind. */
export function keyOpportunities(findings: readonly Finding[], max = 5): Finding[] {
  const seen = new Set<string>();
  return findings
    .filter((finding) => finding.status === "opportunity" && finding.impact >= 3)
    .sort((a, b) => b.impact - a.impact || (a.confidence === "high" ? -1 : 1))
    .filter((finding) => (seen.has(finding.kind) ? false : (seen.add(finding.kind), true)))
    .slice(0, max);
}

export type Freshness = "fresh" | "aging" | "stale";

/** Websites change: an audit is fresh for a month and stale after three. */
export function freshness(iso: string, now: Date = new Date()): Freshness {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "stale";
  const days = (now.getTime() - at) / 86_400_000;
  return days <= 30 ? "fresh" : days <= 90 ? "aging" : "stale";
}
