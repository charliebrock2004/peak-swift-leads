/**
 * What we actually know about a business's website — and what may be said.
 *
 * "No website" is the claim most likely to embarrass a cold email: the
 * business has a site we failed to find, and the salesperson looks careless.
 * So it is never inferred from a listing that simply lacked a website field.
 * It is VERIFIED_NO_WEBSITE only when a search really ran, found candidate
 * sites and rejected each for a recorded reason (or found none), recently, and
 * no website is on record now. Everything short of that is NOT_CONFIRMED.
 *
 * Client-safe and pure.
 */
import { classifyWebsiteUrl, hasWebsite } from "../leads.ts";
import type { WebsiteEvidenceRecord } from "../outreach/evidence-record.ts";
import { dateLabel } from "./findings.ts";

export const WEBSITE_STATES = [
  "VERIFIED_NO_WEBSITE",
  "WEBSITE_FOUND",
  "WEBSITE_NOT_CONFIRMED",
  "SOCIAL_ONLY",
  "DIRECTORY_ONLY",
  "WEBSITE_UNREACHABLE",
] as const;
export type WebsiteState = (typeof WEBSITE_STATES)[number];

export const WEBSITE_STATE_LABEL: Record<WebsiteState, string> = {
  VERIFIED_NO_WEBSITE: "No independent website found",
  WEBSITE_FOUND: "Website found",
  WEBSITE_NOT_CONFIRMED: "Website not confirmed",
  SOCIAL_ONLY: "Social media only",
  DIRECTORY_ONLY: "Directory listings only",
  WEBSITE_UNREACHABLE: "Website unreachable",
};

/** A search older than this no longer supports a "no website" claim. */
export const NO_WEBSITE_MAX_AGE_DAYS = 90;

export type WebsiteVerification = {
  state: WebsiteState;
  /** Why, in order, each with its source and date where there is one. */
  reasons: string[];
  /** True only when "I couldn't find an independent website" is supported. */
  canClaimNoWebsite: boolean;
  /** When the evidence behind the state was gathered. */
  checkedAt: string;
  search: { provider: string; queries: string[]; candidates: number; rejections: { url: string; why: string }[] } | null;
};

export type LatestAudit = { status: "ok" | "unreachable" | "error"; httpStatus: number; finishedAt: string; url: string } | null;

export function websiteVerification(
  lead: { website: string; websiteStatus?: string; businessName?: string },
  evidence: WebsiteEvidenceRecord | undefined | null,
  audit: LatestAudit = null,
  now: Date = new Date(),
): WebsiteVerification {
  const search =
    evidence && evidence.searchesRun > 0 && evidence.searchProvider
      ? { provider: evidence.searchProvider, queries: evidence.queries ?? [], candidates: evidence.candidatesChecked, rejections: evidence.rejections ?? [] }
      : null;
  const website = (lead.website ?? "").trim();

  if (website && hasWebsite(website)) {
    const kind = classifyWebsiteUrl(website);
    if (kind === "Social Only" || kind === "Directory Only") {
      const searchedClean = searchSupportsAbsence(evidence, now);
      return {
        state: kind === "Social Only" ? "SOCIAL_ONLY" : "DIRECTORY_ONLY",
        reasons: [
          `The only web address on record is ${kind === "Social Only" ? "a social media page" : "a directory listing"} (${website}).`,
          ...(searchedClean ? [searchSentence(evidence!)] : ["Not yet searched for an independent website."]),
        ],
        canClaimNoWebsite: searchedClean,
        checkedAt: evidence?.checkedAt ?? "",
        search,
      };
    }
    if (audit && audit.status !== "ok") {
      return {
        state: "WEBSITE_UNREACHABLE",
        reasons: [
          audit.httpStatus
            ? `${audit.url || website} returned HTTP ${audit.httpStatus} when audited on ${dateLabel(audit.finishedAt)}.`
            : `${audit.url || website} could not be reached when audited on ${dateLabel(audit.finishedAt)}.`,
        ],
        canClaimNoWebsite: false,
        checkedAt: audit.finishedAt,
        search,
      };
    }
    if (audit || evidence?.verified) {
      const reasons: string[] = [];
      if (evidence?.verified) {
        reasons.push(
          `${evidence.url || website} was confirmed as this business's site${evidence.via === "SEARCH" ? ` by a ${evidence.searchProvider ?? "web"} search` : ""}${evidence.checkedAt ? ` on ${dateLabel(evidence.checkedAt)}` : ""}.`,
        );
      }
      if (audit) reasons.push(`Audited on ${dateLabel(audit.finishedAt)}.`);
      return { state: "WEBSITE_FOUND", reasons, canClaimNoWebsite: false, checkedAt: audit?.finishedAt || evidence?.checkedAt || "", search };
    }
    return {
      state: "WEBSITE_NOT_CONFIRMED",
      reasons: [`${website} is on record (from a listing) but has not been checked to be this business's own site.`],
      canClaimNoWebsite: false,
      checkedAt: "",
      search,
    };
  }

  if (searchSupportsAbsence(evidence, now)) {
    return { state: "VERIFIED_NO_WEBSITE", reasons: [searchSentence(evidence!)], canClaimNoWebsite: true, checkedAt: evidence!.checkedAt, search };
  }
  const reasons = ["No website is on record."];
  if (evidence?.searchFailure) reasons.push(`The web search failed (${evidence.searchFailure}), so absence proves nothing.`);
  else if (search && evidence && !recent(evidence.checkedAt, now)) reasons.push(`The last search was on ${dateLabel(evidence.checkedAt)} — too long ago to rely on.`);
  else reasons.push("No web search has been run for it yet — a listing without a website field is not proof there is none.");
  return { state: "WEBSITE_NOT_CONFIRMED", reasons, canClaimNoWebsite: false, checkedAt: evidence?.checkedAt ?? "", search };
}

function recent(iso: string, now: Date): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && now.getTime() - at <= NO_WEBSITE_MAX_AGE_DAYS * 86_400_000;
}

function searchSupportsAbsence(evidence: WebsiteEvidenceRecord | undefined | null, now: Date): boolean {
  return Boolean(
    evidence &&
      !evidence.verified &&
      evidence.searchesRun > 0 &&
      evidence.searchProvider &&
      !evidence.searchFailure &&
      recent(evidence.checkedAt, now),
  );
}

function searchSentence(evidence: WebsiteEvidenceRecord): string {
  const candidates = evidence.candidatesChecked;
  return `Searched ${evidence.searchProvider} on ${dateLabel(evidence.checkedAt)} (${evidence.searchesRun} quer${evidence.searchesRun === 1 ? "y" : "ies"}); ${
    candidates === 0 ? "no candidate sites came back" : `${candidates} candidate site${candidates === 1 ? " was" : "s were"} checked and none was this business's`
  }.`;
}

/** How a salesperson (or an email) may describe it — only what the state supports. */
export function websitePhrase(verification: WebsiteVerification, businessName: string): string {
  switch (verification.state) {
    case "VERIFIED_NO_WEBSITE":
      return `I couldn't find an independent website for ${businessName}.`;
    case "SOCIAL_ONLY":
      return verification.canClaimNoWebsite ? `I could only find ${businessName} on social media, not an independent website.` : `${businessName} has a social media page on record.`;
    case "DIRECTORY_ONLY":
      return verification.canClaimNoWebsite ? `I could only find ${businessName} in directory listings, not an independent website.` : `${businessName} appears in directory listings.`;
    default:
      return "";
  }
}

/**
 * The verification for a lead as the server reads it (facts attached). A bare
 * lead with no facts is judged on its website field alone — which can never
 * support a "no website" claim.
 */
export function websiteVerificationOf(
  lead: { website: string; websiteStatus?: string; facts?: { websiteEvidence?: WebsiteEvidenceRecord | null; audit?: { status: "ok" | "unreachable" | "error"; httpStatus: number; finishedAt: string; url: string } | null } },
  now: Date = new Date(),
): WebsiteVerification {
  const audit = lead.facts?.audit;
  return websiteVerification(
    lead,
    lead.facts?.websiteEvidence ?? null,
    audit ? { status: audit.status, httpStatus: audit.httpStatus, finishedAt: audit.finishedAt, url: audit.url } : null,
    now,
  );
}
