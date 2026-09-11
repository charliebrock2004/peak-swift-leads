/**
 * What we actually know about a prospect, and which of it is worth writing.
 *
 * Pure and testable, because this is where a cold email either earns a reply or
 * becomes the thing people delete. Every item carries the field it came from,
 * so a claim in a sent email can be traced back to the row that justified it —
 * and so the Review screen can show WHY an email said what it said.
 *
 * THE RULE: an observation only exists here if a field actually holds it.
 * Nothing infers that a site is slow, dated, badly designed or poorly ranked
 * unless something measured that. A model handed only these facts cannot
 * flatter, guess, or invent a compliment, because there is nothing to invent
 * from.
 */
import { computeOpportunity, opportunityBand, type Lead } from "../leads.ts";
import type { OutreachLead } from "./types.ts";

/** How much a piece of evidence earns its place in a short email. */
export type EvidenceStrength = "STRONG" | "USEFUL" | "CONTEXT";

export type Evidence = {
  /** Machine-readable, so the UI can group and the tests can assert. */
  kind:
    | "NO_WEBSITE"
    | "SOCIAL_ONLY"
    | "DIRECTORY_ONLY"
    | "THIN_WEBSITE"
    | "POOR_WEBSITE"
    | "SITE_OBSERVATION"
    | "WELL_REVIEWED"
    | "ESTABLISHED"
    | "TRADE_AND_PLACE";
  /** One plain sentence the email may draw on. Never a claim we cannot support. */
  text: string;
  strength: EvidenceStrength;
  /** The lead field this came from, so any claim is traceable. */
  source: string;
};

const RANK: Record<EvidenceStrength, number> = { STRONG: 0, USEFUL: 1, CONTEXT: 2 };

/**
 * Everything true about this prospect that is worth saying.
 *
 * Deliberately short. A cold email that recites nine facts reads as a mail
 * merge; the value is in having the right one or two, and in being certain they
 * are true.
 */
export function gatherEvidence(lead: OutreachLead): Evidence[] {
  const out: Evidence[] = [];
  const name = lead.businessName.trim();

  // ── The website situation: the whole reason for writing ──────────────────
  if (lead.websiteStatus === "No Website Found") {
    out.push({
      kind: "NO_WEBSITE",
      text: `I could not find a website for ${name || "them"}.`,
      strength: "STRONG",
      source: "websiteStatus",
    });
  } else if (lead.websiteStatus === "Social Only") {
    out.push({
      kind: "SOCIAL_ONLY",
      text: "Their only web presence I could find is a social page, not a site of their own.",
      strength: "STRONG",
      source: "websiteStatus",
    });
  } else if (lead.websiteStatus === "Directory Only") {
    out.push({
      kind: "DIRECTORY_ONLY",
      text: "I could only find them on a directory listing, not on a site of their own.",
      strength: "STRONG",
      source: "websiteStatus",
    });
  } else if (lead.websiteStatus === "Basic Website" || lead.websiteQuality === "improve") {
    out.push({
      kind: "THIN_WEBSITE",
      text: "They have a site, but it is a simple one that could do more for them.",
      strength: "USEFUL",
      source: "websiteStatus/websiteQuality",
    });
  } else if (lead.websiteQuality === "poor") {
    out.push({
      kind: "POOR_WEBSITE",
      text: "Their site scored poorly on the checks this app runs.",
      strength: "USEFUL",
      source: "websiteQuality",
    });
  }

  // What the site check actually SAW. The only licence to comment on a site's
  // content — and the reason nothing here ever says "slow" or "dated" unless a
  // check recorded it.
  const analysis = lead.websiteAnalysis.trim();
  if (analysis) {
    out.push({
      kind: "SITE_OBSERVATION",
      text: `The site check noted: ${analysis}`,
      strength: "STRONG",
      source: "websiteAnalysis",
    });
  }

  // ── Signals that they are a real, going concern ──────────────────────────
  if (typeof lead.reviews === "number" && lead.reviews >= 10) {
    const rating = typeof lead.rating === "number" ? ` at ${lead.rating}` : "";
    out.push({
      kind: "WELL_REVIEWED",
      text: `They have ${lead.reviews} public reviews${rating}, so the work is clearly going well.`,
      strength: "USEFUL",
      source: "reviews/rating",
    });
  }
  if (/active/i.test(lead.businessStatus ?? "")) {
    out.push({
      kind: "ESTABLISHED",
      text: "The listing shows them as actively trading.",
      strength: "CONTEXT",
      source: "businessStatus",
    });
  }
  if (lead.trade.trim() && lead.town.trim()) {
    out.push({
      kind: "TRADE_AND_PLACE",
      text: `${lead.trade} in ${lead.town}.`,
      strength: "CONTEXT",
      source: "trade/town",
    });
  }

  return out.sort((a, b) => RANK[a.strength] - RANK[b.strength]);
}

/**
 * The one to three pieces worth building an email around.
 *
 * Strongest first, and never two observations of the same kind, so an email
 * cannot spend its whole length circling one fact.
 */
export function strongestEvidence(evidence: readonly Evidence[], limit = 3): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of evidence) {
    if (seen.has(item.kind)) continue;
    seen.add(item.kind);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The evidence as one stored line, so a sent email can be explained months
 * later without re-deriving anything from a row that may since have changed.
 */
export function evidenceSummary(evidence: readonly Evidence[]): string {
  return evidence.map((item) => `${item.kind}: ${item.text} [${item.source}]`).join(" | ").slice(0, 2000);
}

/** Read a stored summary back into something the Review screen can list. */
export function parseEvidenceSummary(stored: string): { kind: string; text: string; source: string }[] {
  if (!stored.trim()) return [];
  return stored
    .split(" | ")
    .map((part) => {
      const match = part.match(/^([A-Z_]+):\s*(.*?)\s*\[([^\]]*)\]$/);
      return match
        ? { kind: match[1], text: match[2], source: match[3] }
        : { kind: "", text: part, source: "" };
    })
    .filter((item) => item.text !== "");
}

/**
 * Is there enough here to write a genuinely personal email?
 *
 * Trade and town alone are not: an email built on nothing else is a mail merge
 * wearing a business's name, and it is better to hold it for review than to
 * send something that reads as automated.
 */
export function hasRealPersonalisation(evidence: readonly Evidence[]): boolean {
  return evidence.some((item) => item.strength === "STRONG" || item.strength === "USEFUL");
}

/** The facts a model is allowed to see. Nothing here is inferred. */
export function evidenceFacts(lead: OutreachLead): string[] {
  const facts: string[] = [`Business name: ${lead.businessName}`];
  if (lead.trade.trim()) facts.push(`Trade: ${lead.trade}`);
  if (lead.town.trim()) facts.push(`Town: ${lead.town}`);
  for (const item of strongestEvidence(gatherEvidence(lead))) {
    facts.push(`Observed (${item.source}): ${item.text}`);
  }
  const score = computeOpportunity(lead as Lead);
  facts.push(`Opportunity score: ${score} (${opportunityBand(score)})`);
  return facts;
}
