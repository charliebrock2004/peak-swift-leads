import { independentHost } from "./leads.ts";
import { type LeadIdentity, type MatchReason } from "./identity.ts";
import { createIdentityIndex, indexOf, type IdentityIndex } from "./identity-index.ts";
import { DISCOVERY_SAFETY } from "./discovery-limits.ts";
import type { Prospect } from "./research.ts";

export { DISCOVERY_SAFETY };

/** Why a discovered business never became a prospect. */
export type PoolExclusion = "duplicate" | "known" | "suppressed" | "contacted";

/**
 * The sources a business can come from, as diagnostic buckets.
 *
 * `other` exists so an unrecognised label is visible rather than silently
 * dropped; `source-labels.test.ts` asserts every label the discovery engine
 * actually stamps maps to one of the named keys, so `other` staying at zero is
 * a checked property and not a hope.
 */
export const SOURCE_KEYS = ["companiesHouse", "nominatim", "photon", "bizdata", "overpass", "other"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];
export type SourceTally = Record<SourceKey, number>;

export function emptySourceTally(): SourceTally {
  return { companiesHouse: 0, nominatim: 0, photon: 0, bizdata: 0, overpass: 0, other: 0 };
}

/**
 * Which source a prospect came from, from the label discovery stamped on it.
 *
 * Checked most specific first: "Companies House + OpenStreetMap" is a company
 * record that OSM later enriched, and it is the registry that found the
 * business, so it counts to Companies House.
 */
export function sourceKeyOf(source: string): SourceKey {
  const value = source.toLowerCase();
  if (value.includes("companies house")) return "companiesHouse";
  if (value.includes("bizdata")) return "bizdata";
  if (value.includes("nominatim")) return "nominatim";
  if (value.includes("overpass")) return "overpass";
  // Plain "OpenStreetMap" is what the Photon search stamps; the other OSM
  // paths all name their own provider, so they are already handled above.
  if (value.includes("openstreetmap")) return "photon";
  return "other";
}

/**
 * One duplicate decision, kept so "724 duplicates" can be explained.
 *
 * The previous funnel reported a single integer, which made it impossible to
 * tell a legitimate cross-town sighting from a false merge without re-running
 * the search. These say which rule fired and on what.
 */
export type DuplicateNote = {
  incoming: string;
  existing: string;
  incomingSource: string;
  existingSource: string;
  reason: MatchReason;
  town: string;
};

/** How many duplicate decisions are kept as samples. Counters are unbounded. */
export const DUPLICATE_SAMPLE_MAX = 40;

export type PoolDiagnostics = {
  /** Businesses offered to the pool, across every area and source. */
  collected: number;
  /** Offered twice or more — the same business listed under several towns. */
  duplicatesAcrossAreas: number;
  /** Already on the sheet. These no longer consume a target slot. */
  alreadyKnown: number;
  suppressed: number;
  alreadyContacted: number;
  /** The pool after every exclusion: genuinely new, genuinely distinct. */
  newCandidates: number;
  targetRequested: number;
  targetAchieved: number;
  /** New candidates found but not returned because the target was reached. */
  remainingAfterTarget: number;
  /**
   * True only when the pool ceiling stopped collection. This is the one case
   * where a bigger target would NOT produce more, and the run log must say so
   * rather than telling the user to raise a number that cannot help.
   */
  ceilingHit: boolean;
  /** Businesses refused entry to the pool because the ceiling was already hit. */
  droppedToSafetyCeiling: number;
  withWebsite: number;
  withoutWebsite: number;
  withListedEmail: number;
  /**
   * Genuinely new businesses each source contributed, counted after dedupe.
   *
   * Raw row counts flatter a source that returns the same firms every source
   * already had. This is the number that says whether a source is worth its
   * request budget: how many businesses reached the pool because of it and
   * would not otherwise have been there at all.
   */
  newBySource: SourceTally;
  /** Of the businesses actually delivered, which source found each. */
  deliveredBySource: SourceTally;
  /** Every duplicate decision, counted by the rule that made it. */
  duplicatesByReason: Record<MatchReason, number>;
  /**
   * A bounded sample of duplicate decisions, newest last.
   *
   * Capped at DUPLICATE_SAMPLE_MAX so a run that merges thousands of rows does
   * not carry thousands of records back to the browser. The counters above are
   * exact; this is for reading, not for arithmetic.
   */
  duplicateSamples: DuplicateNote[];
};

/**
 * Prove the funnel adds up.
 *
 * Every business offered left by exactly one door: it became a candidate, or
 * it was a duplicate, or it was excluded for a named reason, or the safety
 * ceiling refused it. If this ever returns false a number on the run report is
 * lying, so the tests assert it over every fixture.
 */
export function funnelReconciles(d: PoolDiagnostics): boolean {
  const accountedFor =
    d.newCandidates +
    d.duplicatesAcrossAreas +
    d.alreadyKnown +
    d.suppressed +
    d.alreadyContacted +
    d.droppedToSafetyCeiling;
  if (accountedFor !== d.collected) return false;
  if (d.targetAchieved + d.remainingAfterTarget !== d.newCandidates) return false;
  if (d.withWebsite + d.withoutWebsite !== d.targetAchieved) return false;
  return true;
}

export type ProspectPoolOptions = {
  /** The user's requested number of genuinely new prospects. */
  target: number;
  /** Leads already on the sheet. Removed before the target is applied. */
  known?: readonly LeadIdentity[];
  /** Suppressed businesses, by the same identity rules. Never returned. */
  suppressed?: readonly LeadIdentity[];
  /** Already contacted. Never returned, and never counted against the target. */
  contacted?: readonly LeadIdentity[];
  /** Trade words the run asked for, used for ranking only — never to exclude. */
  tradeTerms?: readonly string[];
  /** Towns the run planned, used for ranking only — never to exclude. */
  townTerms?: readonly string[];
  /** Overrides for tests. Production uses DISCOVERY_SAFETY. */
  ceiling?: number;
};

export type ProspectPoolResult = {
  prospects: Prospect[];
  /**
   * Freshly discovered copies of businesses already on the sheet.
   *
   * Excluded from `prospects` — they consume no slot — but handed back so the
   * caller can still top up empty fields on the existing lead. Rediscovering a
   * business that has since published an address is useful; letting it eat a
   * slot is not. Outreach history, call notes and unsubscribes are never
   * touched by this: it is field-filling only.
   */
  knownMatches: Prospect[];
  diagnostics: PoolDiagnostics;
};

export type ProspectPool = {
  /** Add an area's results. Order never matters; duplicates are free. */
  offer(prospects: readonly Prospect[]): void;
  /** Genuinely new, distinct candidates collected so far. */
  readonly size: number;
  /** True once the safety ceiling is reached and further areas cannot help. */
  readonly full: boolean;
  /** Rank what survived and apply the target. */
  result(): ProspectPoolResult;
};

function normaliseTerms(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !out.includes(word)) out.push(word);
    }
  }
  return out;
}

/**
 * How useful a prospect is for outreach, highest first.
 *
 * Signals only ever add. Nothing here can remove a business from the run: a
 * joiner with no website scores lowest and still comes back, because a
 * phone number and an address make a perfectly good call. Ranking decides
 * who gets written to first, never who exists.
 */
export function scoreProspect(
  prospect: Prospect,
  context: { tradeTerms?: readonly string[]; townTerms?: readonly string[] } = {},
): number {
  let score = 0;
  const name = prospect.businessName.toLowerCase();
  const trade = `${prospect.trade} ${prospect.notes}`.toLowerCase();
  const host = independentHost(prospect.website);

  // 1. Trade match — the business says it does the work we searched for.
  const tradeTerms = context.tradeTerms ?? [];
  if (tradeTerms.some((term) => trade.includes(term))) score += 30;
  if (tradeTerms.some((term) => name.includes(term))) score += 20;

  // 2. Location match — it sits in a town the run actually planned.
  const townTerms = context.townTerms ?? [];
  const town = prospect.town.toLowerCase();
  if (town && townTerms.some((term) => town.includes(term))) score += 15;
  else if (town) score += 5;

  // 3-4. An independent site of its own, not a directory or a Facebook page.
  if (host) score += 40;
  else if (prospect.website.trim()) score += 5;

  // 5. A published address is the single strongest signal for outreach.
  if (prospect.email.trim()) score += 35;

  // 6. The site looks like it belongs to this business, not to whoever the
  //    directory happened to link. A shared word between name and host is weak
  //    evidence on its own, which is why it scores far below a verified site.
  if (host) {
    const nameWords = name.split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
    if (nameWords.some((word) => host.includes(word))) score += 15;
  }

  // 7. Contact detail worth ringing.
  if (prospect.phone.trim()) score += 12;
  if (prospect.address.trim()) score += 6;

  // 8. Independent identity rather than a national chain listing.
  if (typeof prospect.reviews === "number" && prospect.reviews > 0) score += 3;
  if (prospect.priority === "HOT") score += 10;
  else if (prospect.priority === "WARM") score += 5;

  return score;
}

export function rankProspects(
  prospects: readonly Prospect[],
  context: { tradeTerms?: readonly string[]; townTerms?: readonly string[] } = {},
): Prospect[] {
  return [...prospects]
    .map((prospect, index) => ({ prospect, index, score: scoreProspect(prospect, context) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((item) => item.prospect);
}

/**
 * One candidate pool for a whole run.
 *
 * Every town contributes to this, and nothing is capped on the way in. The
 * order is the point:
 *
 *   collect → dedupe across areas → drop known/suppressed/contacted → rank → target
 *
 * The old pipeline capped first and deduped afterwards, so fourteen towns each
 * kept their nearest twelve — largely the same twelve firms — and the distinct
 * tail was thrown away before anything had a chance to notice it was new.
 */
export function createProspectPool(options: ProspectPoolOptions): ProspectPool {
  const target = Math.max(0, Math.min(DISCOVERY_SAFETY.targetMax, Math.round(options.target) || 0));
  // Deliberately NOT raised to meet the target. A ceiling that quietly grows to
  // whatever was asked for is not a safety limit at all; in production it sits
  // far above `targetMax` so it never bites, and when it does bite the run says
  // so rather than reporting a target it did not really honour.
  const ceiling = Math.max(1, options.ceiling ?? DISCOVERY_SAFETY.poolCeiling);
  const tradeTerms = normaliseTerms(options.tradeTerms);
  const townTerms = normaliseTerms(options.townTerms);

  const known = indexOf(options.known ?? []);
  const suppressed = indexOf(options.suppressed ?? []);
  const contacted = indexOf(options.contacted ?? []);
  /**
   * Every business offered, whether it was kept or excluded.
   *
   * First sighting decides which bucket a business falls into; every later
   * sighting is a duplicate. Without this, one already-known firm listed in
   * four towns reported as "4 already known" — true of the listings, wrong
   * about the businesses, and the counters exist to be read by a person.
   */
  const seen: IdentityIndex<Prospect> = createIdentityIndex<Prospect>();
  const kept: Prospect[] = [];
  const knownMatches: Prospect[] = [];
  const newBySource = emptySourceTally();
  const duplicatesByReason: Record<MatchReason, number> = {
    PLACE_ID: 0, PHONE: 0, EMAIL: 0, DOMAIN: 0, MAPS_URL: 0, NAME_TOWN: 0,
  };
  const duplicateSamples: DuplicateNote[] = [];

  const counts = {
    collected: 0,
    duplicates: 0,
    known: 0,
    suppressed: 0,
    contacted: 0,
    ceilingDropped: 0,
  };
  let ceilingHit = false;

  return {
    offer(prospects) {
      for (const prospect of prospects) {
        counts.collected += 1;
        // Cross-area dedupe first: a business listed in Perth, Scone and
        // Auchterarder is one candidate, and consumes one slot, not three.
        const already = seen.find(prospect);
        if (already) {
          counts.duplicates += 1;
          duplicatesByReason[already.via] += 1;
          if (duplicateSamples.length < DUPLICATE_SAMPLE_MAX) {
            duplicateSamples.push({
              incoming: prospect.businessName,
              existing: already.entry.businessName,
              incomingSource: prospect.source,
              existingSource: already.entry.source,
              reason: already.via,
              town: prospect.town,
            });
          }
          continue;
        }
        seen.add(prospect, prospect);
        // Then the exclusions, all before the target is anywhere near applied.
        // Suppression is checked ahead of the sheet so an unsubscribed
        // business is reported as suppressed rather than merely "known".
        if (suppressed.find(prospect)) {
          counts.suppressed += 1;
          continue;
        }
        if (contacted.find(prospect)) {
          counts.contacted += 1;
          // Already emailed, so it takes no slot — but it is still on the
          // sheet, and a phone number or address published since we wrote to
          // it is worth keeping. Field-filling only; the caller never touches
          // outreach status, notes, suppression or unsubscribe state.
          knownMatches.push(prospect);
          continue;
        }
        if (known.find(prospect)) {
          counts.known += 1;
          knownMatches.push(prospect);
          continue;
        }
        if (kept.length >= ceiling) {
          ceilingHit = true;
          counts.ceilingDropped += 1;
          continue;
        }
        kept.push(prospect);
        newBySource[sourceKeyOf(prospect.source)] += 1;
      }
    },
    get size() {
      return kept.length;
    },
    get full() {
      return kept.length >= ceiling;
    },
    result() {
      const ranked = rankProspects(kept, { tradeTerms, townTerms });
      const prospects = ranked.slice(0, target);
      return {
        prospects,
        knownMatches,
        diagnostics: {
          collected: counts.collected,
          duplicatesAcrossAreas: counts.duplicates,
          alreadyKnown: counts.known,
          suppressed: counts.suppressed,
          alreadyContacted: counts.contacted,
          newCandidates: kept.length,
          targetRequested: target,
          targetAchieved: prospects.length,
          remainingAfterTarget: Math.max(0, ranked.length - prospects.length),
          ceilingHit,
          droppedToSafetyCeiling: counts.ceilingDropped,
          withWebsite: prospects.filter((item) => independentHost(item.website)).length,
          withoutWebsite: prospects.filter((item) => !independentHost(item.website)).length,
          withListedEmail: prospects.filter((item) => item.email.trim()).length,
          newBySource,
          duplicatesByReason,
          duplicateSamples,
          deliveredBySource: prospects.reduce((tally, item) => {
            tally[sourceKeyOf(item.source)] += 1;
            return tally;
          }, emptySourceTally()),
        },
      };
    },
  };
}

/** The whole pipeline in one call, for callers that already hold every candidate. */
export function buildProspectPool(
  candidates: readonly Prospect[],
  options: ProspectPoolOptions,
): ProspectPoolResult {
  const pool = createProspectPool(options);
  pool.offer(candidates);
  return pool.result();
}

/**
 * What actually stopped discovery, in words that are true.
 *
 * Returns null when nothing did. The rule this encodes: only say "raise your
 * target" when raising the target would genuinely return more businesses.
 */
export type StopFacts = Pick<
  PoolDiagnostics,
  | "ceilingHit"
  | "droppedToSafetyCeiling"
  | "remainingAfterTarget"
  | "targetRequested"
  | "targetAchieved"
  | "alreadyKnown"
  | "duplicatesAcrossAreas"
>;

export function stopReason(diagnostics: StopFacts): string | null {
  if (diagnostics.ceilingHit) {
    return (
      `Discovery stopped at the ${DISCOVERY_SAFETY.poolCeiling}-business safety ceiling ` +
      `(${diagnostics.droppedToSafetyCeiling} more were found and not collected). ` +
      `Raising your target will not get past this — narrow the area or the trade instead.`
    );
  }
  if (diagnostics.remainingAfterTarget > 0) {
    return (
      `${diagnostics.remainingAfterTarget} more genuinely new business` +
      `${diagnostics.remainingAfterTarget === 1 ? " was" : "es were"} found and held back ` +
      `by your target of ${diagnostics.targetRequested} — raise it to keep them.`
    );
  }
  if (diagnostics.targetAchieved < diagnostics.targetRequested) {
    return (
      `Found ${diagnostics.targetAchieved} of the ${diagnostics.targetRequested} you asked for. ` +
      `The area is out of new businesses, not the search — ` +
      `${diagnostics.alreadyKnown} were already on your sheet and ` +
      `${diagnostics.duplicatesAcrossAreas} were the same business listed in several towns.`
    );
  }
  return null;
}
