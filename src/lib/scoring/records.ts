/**
 * Scoring many prospects at once, and the record an agent or report reads.
 *
 * `scoreAll` builds each prospect's context (its number's TPS/CTPS screening,
 * the do-not-call list, the suppression list, the contact rules) from lookups
 * loaded once, so a list of two thousand costs two thousand pure calls and no
 * queries. Client-safe and pure.
 */
import { normalizeUkPhone, type DoNotCall, type PhoneScreening } from "../contactability/phone.ts";
import type { ContactRules } from "../contactability/legal-form.ts";
import { websiteVerificationOf } from "../audit/website-state.ts";
import type { OutreachLead } from "../outreach/types.ts";
import { scoreProspect, type ProspectScore, type ScoreContext } from "./prospect-score.ts";

export type ScoringWorld = {
  screenings?: ReadonlyMap<string, PhoneScreening> | Readonly<Record<string, PhoneScreening>>;
  doNotCall?: ReadonlyMap<string, DoNotCall> | Readonly<Record<string, DoNotCall>>;
  /** Lowercased suppressed addresses. */
  suppressed?: ReadonlySet<string>;
  /** Lead ids that already have a live initial email. */
  contacted?: ReadonlySet<string>;
  rules?: ContactRules;
  profile?: ScoreContext["profile"];
  now?: Date;
};

function lookup<T>(source: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined, key: string): T | null {
  if (!source || !key) return null;
  if (source instanceof Map) return source.get(key) ?? null;
  return (source as Record<string, T>)[key] ?? null;
}

export function contextFor(lead: OutreachLead, world: ScoringWorld = {}): ScoreContext {
  const number = normalizeUkPhone(lead.phone)?.e164 ?? "";
  return {
    now: world.now,
    rules: world.rules,
    profile: world.profile,
    screening: lookup(world.screenings, number),
    doNotCall: lookup(world.doNotCall, number),
    suppressed: Boolean(lead.email.trim() && world.suppressed?.has(lead.email.trim().toLowerCase())),
    contacted: world.contacted?.has(lead.id) ?? false,
  };
}

export function scoreLead(lead: OutreachLead, world: ScoringWorld = {}): ProspectScore {
  return scoreProspect(lead, contextFor(lead, world));
}

export function scoreAll(leads: readonly OutreachLead[], world: ScoringWorld = {}): Map<string, ProspectScore> {
  return new Map(leads.map((lead) => [lead.id, scoreLead(lead, world)]));
}

/**
 * The structured record an AI agent (or a report) should read: the business,
 * its evidence-backed score with reasons, and the recommended next action.
 */
export function toProspectRecord(lead: OutreachLead, score: ProspectScore) {
  const website = websiteVerificationOf(lead);
  return {
    id: lead.id,
    businessName: lead.businessName,
    trade: lead.trade,
    town: lead.town,
    address: lead.address,
    phone: lead.phone,
    email: lead.email,
    emailSource: lead.emailSource,
    emailConfidence: lead.emailConfidence,
    website: lead.website,
    websiteState: website.state,
    websiteEvidence: website.reasons,
    audit: lead.facts?.audit
      ? { opportunity: lead.facts.audit.opportunity, measuredAt: lead.facts.audit.finishedAt, keyFindings: lead.facts.audit.keyFindings.map((finding) => finding.evidence) }
      : null,
    reviewCount: lead.reviews,
    reviewRating: lead.rating,
    band: score.band,
    priority: score.priority,
    need: score.need.score,
    value: score.value.score,
    reach: score.reach.score,
    channel: score.reach.channel,
    emailStatus: score.reach.email,
    callStatus: score.reach.call,
    recommendedAction: score.action,
    actionReason: score.actionReason,
    blockers: score.blockers,
    why: score.why.map((reason) => ({ axis: reason.axis, text: reason.text, source: reason.source, at: reason.at })),
    evidenceFreshness: score.freshness,
    leadStatus: lead.called,
    contactStatus: lead.outreachStatus,
    lastContactedAt: lead.lastEmailedAt,
    followUpDate: lead.followUpDate,
    source: lead.source,
    discoveredAt: lead.foundAt,
    updatedAt: lead.updatedAt,
  };
}
