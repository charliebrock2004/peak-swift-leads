/**
 * The pure parts of a Find run: turning listings into leads, deciding what is
 * new, counting the funnel, and summarising the result. No I/O, so every rule
 * here is unit-tested directly, and the server job and any future caller count
 * the same way.
 */
import { fillMissingLead, findDuplicate, newLeadId, type Lead } from "../leads.ts";
import type { Prospect } from "../research.ts";
import type { PlannedSearchResult } from "../run-search.ts";
import { websiteOutcome, type RunFunnel } from "../outreach/run-funnel.ts";
import type { ProspectScore } from "../scoring/prospect-score.ts";
import type { FindEvent, FindSummary, FindTopProspect } from "./types.ts";

export const FIND_LOG_LIMIT = 150;

export function appendEvent(log: readonly FindEvent[], text: string, tone: FindEvent["tone"] = "info", at = new Date()): FindEvent[] {
  const next = [...log, { at: at.toISOString(), text: text.slice(0, 400), tone }];
  return next.length > FIND_LOG_LIMIT ? next.slice(-FIND_LOG_LIMIT) : next;
}

export function leadFromProspect(prospect: Prospect, now: string): Partial<Lead> {
  return {
    id: newLeadId(),
    businessName: prospect.businessName,
    trade: prospect.trade,
    town: prospect.town,
    phone: prospect.phone,
    email: prospect.email,
    address: prospect.address,
    rating: prospect.rating,
    reviews: prospect.reviews,
    website: prospect.website,
    mapsLink: prospect.mapsLink,
    websiteStatus: prospect.websiteStatus,
    placeId: prospect.placeId,
    foundAt: prospect.foundAt || now,
    businessStatus: prospect.businessStatus,
    source: prospect.source,
    notes: [prospect.reason, prospect.notes].filter(Boolean).join(" "),
    called: "Not Called",
    emailSource: prospect.email ? "Public listing" : "",
    emailConfidence: prospect.email ? "MEDIUM" : "",
    emailFoundAt: prospect.email ? now : "",
  };
}

/** The key one listing is known by across trades, so one business takes one slot. */
export function prospectKey(prospect: Pick<Prospect, "placeId" | "businessName" | "town">): string {
  return (prospect.placeId || `${prospect.businessName}|${prospect.town}`).toLowerCase();
}

/**
 * Fold one trade's search into the run: the funnel numbers it measured, and
 * the prospects not already taken by an earlier trade.
 */
export function absorbSearch(
  funnel: RunFunnel,
  search: Pick<PlannedSearchResult, "funnel" | "pool" | "prospects" | "knownMatches">,
  seen: Set<string>,
): { added: Prospect[]; rediscovered: Prospect[] } {
  funnel.rawFound += search.funnel.rawTotal;
  funnel.unique += search.funnel.unique;
  funnel.beyondFetchBudget += search.funnel.droppedToFetchBudget;
  funnel.offered += search.pool.collected;
  funnel.duplicatesAcrossAreas += search.pool.duplicatesAcrossAreas;
  funnel.alreadyKnown += search.pool.alreadyKnown;
  funnel.alreadyContacted += search.pool.alreadyContacted;
  funnel.suppressed += search.pool.suppressed;
  funnel.beyondSafetyCeiling += search.pool.droppedToSafetyCeiling;
  funnel.newCandidates += search.pool.newCandidates;
  funnel.notNeeded += search.pool.remainingAfterTarget;
  funnel.selected += search.pool.targetAchieved;
  const added: Prospect[] = [];
  for (const prospect of search.prospects) {
    const key = prospectKey(prospect);
    if (seen.has(key)) {
      // The same listing under two trades: one business, one slot.
      funnel.selected -= 1;
      funnel.newCandidates -= 1;
      funnel.duplicatesAcrossAreas += 1;
      continue;
    }
    seen.add(key);
    added.push(prospect);
  }
  return { added, rediscovered: [...search.knownMatches] };
}

export type SavePlan = {
  /** New leads, ids fixed now so a repeated save writes the same rows. */
  fresh: Partial<Lead>[];
  /** Blanks to fill on leads already on the sheet. */
  merges: { id: string; patch: Partial<Lead> }[];
  /** Every lead this run is about: new ones and existing ones it re-found. */
  ids: string[];
};

/** Decide, against the sheet as it stands, which prospects are new and which top up a lead. */
export function planSave(funnel: RunFunnel, prospects: readonly Prospect[], rediscovered: readonly Prospect[], sheet: readonly Lead[], now: string): SavePlan {
  const fresh: Partial<Lead>[] = [];
  const merges: { id: string; patch: Partial<Lead> }[] = [];
  const ids = new Set<string>();
  for (const prospect of prospects) {
    const duplicate = findDuplicate(prospect, sheet);
    if (duplicate) {
      ids.add(duplicate.lead.id);
      const patch = fillMissingLead(duplicate.lead, leadFromProspect(prospect, now));
      if (patch) merges.push({ id: duplicate.lead.id, patch });
      continue;
    }
    const lead = leadFromProspect(prospect, now);
    fresh.push(lead);
    ids.add(lead.id as string);
  }
  const collapsed = prospects.length - ids.size;
  if (collapsed > 0) {
    funnel.selected -= collapsed;
    funnel.newCandidates -= collapsed;
    funnel.duplicatesAcrossAreas += collapsed;
  }
  const patched = new Set(merges.map((item) => item.id));
  for (const prospect of rediscovered) {
    const duplicate = findDuplicate(prospect, sheet);
    if (!duplicate || patched.has(duplicate.lead.id)) continue;
    const patch = fillMissingLead(duplicate.lead, leadFromProspect(prospect, now));
    if (patch) {
      patched.add(duplicate.lead.id);
      merges.push({ id: duplicate.lead.id, patch });
    }
  }
  // `id` is never a fill field, so a merge cannot re-point a lead.
  for (const merge of merges) delete merge.patch.id;
  return { fresh, merges, ids: [...ids] };
}

/** Count what the website and email checks produced, from the leads as they now stand. */
export function countChecks(funnel: RunFunnel, leads: readonly Lead[], verified: ReadonlySet<string>): void {
  funnel.checked = leads.length;
  funnel.websiteVerified = 0;
  funnel.websiteListed = 0;
  funnel.websiteSocialOrDirectory = 0;
  funnel.websiteNone = 0;
  funnel.emailsFound = 0;
  funnel.emailsHigh = 0;
  funnel.emailsMedium = 0;
  funnel.noEmail = 0;
  for (const lead of leads) {
    const site = websiteOutcome(lead, verified.has(lead.id));
    if (site === "verified") funnel.websiteVerified += 1;
    else if (site === "listed") funnel.websiteListed += 1;
    else if (site === "socialOrDirectory") funnel.websiteSocialOrDirectory += 1;
    else funnel.websiteNone += 1;
    const usable = lead.email.trim() && (lead.emailConfidence === "HIGH" || lead.emailConfidence === "MEDIUM");
    if (usable) {
      funnel.emailsFound += 1;
      if (lead.emailConfidence === "HIGH") funnel.emailsHigh += 1;
      else funnel.emailsMedium += 1;
    } else funnel.noEmail += 1;
  }
}

/**
 * The run's answer in the user's terms: how many are worth it, and by which
 * channel, best first.
 */
export function summarise(
  leads: readonly Pick<Lead, "id" | "businessName" | "trade" | "town">[],
  scores: ReadonlyMap<string, ProspectScore>,
  emailReady: number,
  topCount = 5,
): { summary: FindSummary; top: FindTopProspect[] } {
  const summary: FindSummary = { found: leads.length, strong: 0, good: 0, weak: 0, rejected: 0, emailReady, callReady: 0, review: 0 };
  const ranked: FindTopProspect[] = [];
  for (const lead of leads) {
    const score = scores.get(lead.id);
    if (!score) continue;
    if (score.action === "SKIP" || score.band === "NONE") summary.rejected += 1;
    else if (score.band === "STRONG") summary.strong += 1;
    else if (score.band === "GOOD") summary.good += 1;
    else summary.weak += 1;
    if (score.action === "CALL") summary.callReady += 1;
    if (score.action === "REVIEW") summary.review += 1;
    if (score.action === "SKIP" || score.action === "WAIT") continue;
    ranked.push({
      id: lead.id,
      businessName: lead.businessName,
      trade: lead.trade,
      town: lead.town,
      band: score.band,
      action: score.action,
      priority: score.priority,
      reason: score.why[0]?.text ?? score.actionReason,
    });
  }
  ranked.sort((a, b) => b.priority - a.priority || a.businessName.localeCompare(b.businessName));
  return { summary, top: ranked.slice(0, topCount) };
}

/** The line a finished run ends on. */
export function finishLine(funnel: Pick<RunFunnel, "prepared" | "readyToday" | "heldForTomorrow" | "call">, callReady: number): string {
  if (funnel.prepared > 0) {
    return `${funnel.readyToday} emails ready to review and send today${funnel.heldForTomorrow ? ` · ${funnel.heldForTomorrow} held for tomorrow` : ""}.`;
  }
  const ring = Math.max(funnel.call, callReady);
  if (ring > 0) return `No one to email this time — but ${ring} good prospects are on your call list.`;
  return "No one in this run can be contacted right now.";
}
