/**
 * Narrowing the prospect list.
 *
 * The HOT / WARM / CALL / LOW / SKIP chips answer "who is worth working".
 * These answer "which of them", and they stack on top rather than replacing:
 * the existing chip still runs first and unchanged, and every refinement here
 * defaults to "any", so a list with nothing set is exactly the list that was
 * there before.
 *
 * Pure and stringly-typed on purpose. The values are whatever the sheet
 * actually contains — real towns, real trades — rather than a fixed vocabulary
 * that would go stale the first time a new trade is searched.
 */
import { computeOpportunity, opportunityBand, resolveWebsiteStatus, type Lead } from "../leads.ts";
import { lifecycleOf, type LifecycleStage } from "./lifecycle.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";

export const ANY = "any";

export type Refinement = {
  /** Campaign id, or ANY. */
  campaign: string;
  /** Lifecycle stage, or ANY. */
  stage: string;
  town: string;
  trade: string;
  /** Opportunity band: High | Medium | Low, or ANY. */
  band: string;
  /** Website status exactly as the sheet records it, or ANY. */
  websiteStatus: string;
  /** HIGH | MEDIUM | LOW | none, or ANY. */
  emailConfidence: string;
};

export const NO_REFINEMENT: Refinement = {
  campaign: ANY,
  stage: ANY,
  town: ANY,
  trade: ANY,
  band: ANY,
  websiteStatus: ANY,
  emailConfidence: ANY,
};

/** Is anything actually narrowed? Used to offer a "clear" control only when it would do something. */
export function isRefined(refinement: Refinement): boolean {
  return Object.values(refinement).some((value) => value !== ANY);
}

/** How many refinements are active, for a count beside the control. */
export function refinementCount(refinement: Refinement): number {
  return Object.values(refinement).filter((value) => value !== ANY).length;
}

function confidenceOf(lead: Pick<Lead, "email" | "emailConfidence">): string {
  if (!lead.email.trim()) return "none";
  return lead.emailConfidence || "none";
}

/**
 * Does this prospect survive the refinements?
 *
 * `stage` and `campaign` need context the lead row does not carry, so both are
 * passed in already resolved. A lead with no campaign membership is excluded by
 * a campaign filter rather than treated as belonging to every campaign.
 */
export function matchesRefinement(
  lead: Lead | OutreachLead,
  refinement: Refinement,
  context: { stage: LifecycleStage; campaigns: ReadonlySet<string> },
): boolean {
  if (refinement.campaign !== ANY && !context.campaigns.has(refinement.campaign)) return false;
  if (refinement.stage !== ANY && context.stage !== refinement.stage) return false;
  if (refinement.town !== ANY && lead.town.trim() !== refinement.town) return false;
  if (refinement.trade !== ANY && lead.trade.trim() !== refinement.trade) return false;
  if (refinement.band !== ANY && opportunityBand(computeOpportunity(lead as Lead)) !== refinement.band) {
    return false;
  }
  if (refinement.websiteStatus !== ANY && resolveWebsiteStatus(lead) !== refinement.websiteStatus) {
    return false;
  }
  if (refinement.emailConfidence !== ANY && confidenceOf(lead) !== refinement.emailConfidence) {
    return false;
  }
  return true;
}

/**
 * The values worth offering, taken from the leads actually on screen.
 *
 * Offering a town nobody is in produces an empty list and looks like a bug, so
 * the options are always drawn from real rows. Sorted so the list is stable
 * between renders rather than following insertion order.
 */
export function refinementOptions(
  leads: readonly (Lead | OutreachLead)[],
  stageOf: (lead: Lead | OutreachLead) => LifecycleStage,
): { towns: string[]; trades: string[]; websiteStatuses: string[]; stages: LifecycleStage[]; confidences: string[] } {
  const towns = new Set<string>();
  const trades = new Set<string>();
  const websiteStatuses = new Set<string>();
  const stages = new Set<LifecycleStage>();
  const confidences = new Set<string>();
  for (const lead of leads) {
    if (lead.town.trim()) towns.add(lead.town.trim());
    if (lead.trade.trim()) trades.add(lead.trade.trim());
    const status = resolveWebsiteStatus(lead);
    if (status) websiteStatuses.add(status);
    stages.add(stageOf(lead));
    confidences.add(confidenceOf(lead));
  }
  const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b));
  return {
    towns: sorted(towns),
    trades: sorted(trades),
    websiteStatuses: sorted(websiteStatuses),
    stages: [...stages].sort(),
    confidences: sorted(confidences),
  };
}

/** Which campaigns a lead belongs to, from the flat membership list. */
export function campaignsByLead(
  members: readonly { campaignId: string; leadId: string }[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const member of members) {
    const set = map.get(member.leadId);
    if (set) set.add(member.campaignId);
    else map.set(member.leadId, new Set([member.campaignId]));
  }
  return map;
}

/** The lifecycle stage of every lead, computed once for a whole list. */
export function stagesByLead(
  leads: readonly (Lead | OutreachLead)[],
  emails: readonly OutreachEmail[],
  decisions?: ReadonlyMap<string, { level: string; reviewRequired?: boolean }>,
): Map<string, LifecycleStage> {
  const byLead = new Map<string, OutreachEmail[]>();
  for (const email of emails) {
    const list = byLead.get(email.leadId);
    if (list) list.push(email);
    else byLead.set(email.leadId, [email]);
  }
  return new Map(
    leads.map((lead) => [
      lead.id,
      lifecycleOf(lead, byLead.get(lead.id) ?? [], decisions?.get(lead.id)),
    ]),
  );
}
