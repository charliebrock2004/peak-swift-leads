import { createLead, independentHost, type LeadIdentity } from "./leads.ts";
import { scoreProspect } from "./scoring/prospect-score.ts";
import type { OutreachLead } from "./outreach/types.ts";
import { createIdentityIndex, indexOf, type IdentityIndex, type Match, type MatchSubject } from "./identity-index.ts";
import { DISCOVERY_SAFETY } from "./discovery-limits.ts";
import { emptyOutcomes, type ListingOutcome, type OutcomeCounts, type ReviewItem, type ReviewMatch } from "./discovery-ledger.ts";
import type { Prospect } from "./research.ts";

export { DISCOVERY_SAFETY };

/** A business already known, as the pool compares against it. */
export type KnownBusiness = LeadIdentity & MatchSubject;

/**
 * The sources a business can come from, as diagnostic buckets.
 *
 * `other` exists so an unrecognised label is visible rather than silently
 * dropped; `source-labels.test.ts` asserts every label the discovery engine
 * actually stamps maps to one of the named keys, so `other` staying at zero is
 * a checked property and not a hope.
 */
export const SOURCE_KEYS = ["companiesHouse", "nominatim", "photon", "overpass", "other"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];
export type SourceTally = Record<SourceKey, number>;

export function emptySourceTally(): SourceTally {
  return { companiesHouse: 0, nominatim: 0, photon: 0, overpass: 0, other: 0 };
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
  if (value.includes("nominatim")) return "nominatim";
  if (value.includes("overpass")) return "overpass";
  // Plain "OpenStreetMap" is what the Photon search stamps; the other OSM
  // paths all name their own provider, so they are already handled above.
  if (value.includes("openstreetmap")) return "photon";
  return "other";
}

export type PoolDiagnostics = {
  /** Businesses offered to the pool, across every area and source. */
  collected: number;
  /** Offered twice or more — the same business listed under several towns. */
  duplicatesAcrossAreas: number;
  /** Already taken by an earlier trade in this run. */
  duplicatesAcrossTrades: number;
  /** Already on the sheet. These no longer consume a target slot. */
  alreadyKnown: number;
  suppressed: number;
  alreadyContacted: number;
  /**
   * Possibly a business already known (or already found in this run), but the
   * evidence does not settle it: held for a person rather than dropped as a
   * duplicate or added as new.
   */
  needsReview: number;
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
    d.duplicatesAcrossTrades +
    d.alreadyKnown +
    d.suppressed +
    d.alreadyContacted +
    d.needsReview +
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
  known?: readonly KnownBusiness[];
  /** Suppressed or rejected businesses, by the same identity rules. Never returned. */
  suppressed?: readonly KnownBusiness[];
  /** Already contacted. Never returned, and never counted against the target. */
  contacted?: readonly KnownBusiness[];
  /** Businesses an earlier trade in this run already took: a repeat is a duplicate, not "known". */
  inRun?: readonly KnownBusiness[];
  /** Trade words the run asked for, used for ranking only — never to exclude. */
  tradeTerms?: readonly string[];
  /** Towns the run planned, used for ranking only — never to exclude. */
  townTerms?: readonly string[];
  /**
   * Priority points per source from your prospect-quality marks
   * (feedback/quality.ts `sourceWeights`). Ranking only — never excludes.
   */
  sourceWeights?: Partial<Record<SourceKey, number>>;
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
  /** Every offered listing's outcome, per search it came from (`offer`'s `origin`). */
  byOrigin: Map<string, OutcomeCounts>;
  /** Listings held for a person, with what each might be. */
  review: ReviewItem[];
  /** Every kept candidate, best first — the target's choice and the rest. */
  kept: Prospect[];
};

export type ProspectPool = {
  /**
   * Add a search's results. `origin` names the search (town and trade) so each
   * listing's outcome is counted against the search that found it.
   */
  offer(prospects: readonly Prospect[], origin?: string): void;
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
 * How closely a candidate matches what was searched for: the trade in its
 * name or category, and a town the run planned. A tie-breaker only.
 */
export function searchRelevance(
  prospect: Prospect,
  context: { tradeTerms?: readonly string[]; townTerms?: readonly string[] } = {},
): number {
  const name = prospect.businessName.toLowerCase();
  const trade = `${prospect.trade} ${prospect.notes}`.toLowerCase();
  const town = prospect.town.toLowerCase();
  let relevance = 0;
  if ((context.tradeTerms ?? []).some((term) => name.includes(term))) relevance += 2;
  else if ((context.tradeTerms ?? []).some((term) => trade.includes(term))) relevance += 1;
  if (town && (context.townTerms ?? []).some((term) => town.includes(term.toLowerCase()))) relevance += 1;
  return relevance;
}

/**
 * Best first, by the one prospect score (scoring/prospect-score.ts): measured
 * need and reachability, not how easy a business is to enrich. Nothing is
 * removed here — ranking decides who makes the target, never who exists.
 */
export function rankProspects(
  prospects: readonly Prospect[],
  context: { tradeTerms?: readonly string[]; townTerms?: readonly string[]; sourceWeights?: Partial<Record<SourceKey, number>> } = {},
): Prospect[] {
  return [...prospects]
    .map((prospect, index) => ({
      prospect,
      index,
      key:
        scoreProspect(createLead({ ...prospect, id: `candidate-${index}` }) as OutreachLead).priority +
        searchRelevance(prospect, context) * 5 +
        (context.sourceWeights?.[sourceKeyOf(prospect.source)] ?? 0),
    }))
    .sort((a, b) => (b.key !== a.key ? b.key - a.key : a.index - b.index))
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
  const inRun = indexOf(options.inRun ?? []);
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
  const originOf = new Map<Prospect, string>();
  const knownMatches: Prospect[] = [];
  const review: ReviewItem[] = [];
  const newBySource = emptySourceTally();
  const byOrigin = new Map<string, OutcomeCounts>();

  const counts = {
    collected: 0,
    duplicates: 0,
    acrossTrades: 0,
    known: 0,
    suppressed: 0,
    contacted: 0,
    review: 0,
    ceilingDropped: 0,
  };
  let ceilingHit = false;

  const tally = (origin: string, outcome: ListingOutcome) => {
    const row = byOrigin.get(origin) ?? emptyOutcomes();
    row[outcome] += 1;
    byOrigin.set(origin, row);
  };

  const hold = (prospect: Prospect, origin: string, match: ReviewMatch, found: Match<KnownBusiness> | Match<Prospect>) => {
    counts.review += 1;
    tally(origin, "needs_review");
    if (review.length >= 200) return;
    const entry = found.entry as KnownBusiness & { id?: string };
    review.push({
      key: `${origin}#${review.length}`,
      businessName: prospect.businessName,
      trade: prospect.trade,
      town: prospect.town,
      address: prospect.address,
      phone: prospect.phone,
      email: prospect.email,
      website: prospect.website,
      source: prospect.source,
      placeId: prospect.placeId,
      area: origin.split("|")[0] ?? "",
      match,
      matchedName: entry.businessName,
      matchedTown: entry.town,
      matchedId: entry.id ?? entry.placeId ?? "",
      reason: found.reasons.join("; "),
    });
  };

  return {
    offer(prospects, origin = "") {
      for (const prospect of prospects) {
        counts.collected += 1;
        // Cross-area dedupe first: a business listed in Perth, Scone and
        // Auchterarder is one candidate, and consumes one slot, not three.
        // Only a `same` verdict is a duplicate — a similar name in another
        // town is not evidence of anything, and is weighed below.
        const again = seen.find(prospect);
        if (again?.verdict === "same") {
          counts.duplicates += 1;
          tally(origin, "duplicate_in_search");
          continue;
        }
        const earlierTrade = inRun.find(prospect);
        if (earlierTrade?.verdict === "same") {
          seen.add(prospect, prospect);
          counts.acrossTrades += 1;
          tally(origin, "duplicate_in_search");
          continue;
        }
        seen.add(prospect, prospect);
        // Then the exclusions, all before the target is anywhere near applied,
        // each only on real evidence. Suppression is checked ahead of the
        // sheet so an unsubscribed business is reported as suppressed rather
        // than merely "known".
        const isSuppressed = suppressed.find(prospect);
        if (isSuppressed?.verdict === "same") {
          counts.suppressed += 1;
          tally(origin, "suppressed");
          continue;
        }
        const wasContacted = contacted.find(prospect);
        if (wasContacted?.verdict === "same") {
          counts.contacted += 1;
          tally(origin, "contacted");
          continue;
        }
        const onSheet = known.find(prospect);
        if (onSheet?.verdict === "same") {
          counts.known += 1;
          tally(origin, "in_database");
          knownMatches.push(prospect);
          continue;
        }
        // Possibly one of them, but nothing settles it: a person decides.
        // Neither silently dropped (it may be a new business with a familiar
        // name) nor silently added (it may be one already being worked).
        if (isSuppressed) {
          hold(prospect, origin, "suppressed", isSuppressed);
          continue;
        }
        if (wasContacted) {
          hold(prospect, origin, "contacted", wasContacted);
          continue;
        }
        if (onSheet) {
          hold(prospect, origin, "database", onSheet);
          continue;
        }
        const alike = again ?? earlierTrade;
        if (alike) {
          hold(prospect, origin, "this_run", alike);
          continue;
        }
        if (kept.length >= ceiling) {
          ceilingHit = true;
          counts.ceilingDropped += 1;
          tally(origin, "beyond_target");
          continue;
        }
        kept.push(prospect);
        originOf.set(prospect, origin);
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
      const ranked = rankProspects(kept, { tradeTerms, townTerms, sourceWeights: options.sourceWeights });
      const prospects = ranked.slice(0, target);
      const outcomes = new Map<string, OutcomeCounts>([...byOrigin].map(([key, row]) => [key, { ...row }]));
      ranked.forEach((prospect, index) => {
        const key = originOf.get(prospect) ?? "";
        const row = outcomes.get(key) ?? emptyOutcomes();
        row[index < target ? "accepted" : "beyond_target"] += 1;
        outcomes.set(key, row);
      });
      return {
        prospects,
        knownMatches,
        byOrigin: outcomes,
        review,
        kept: ranked,
        diagnostics: {
          collected: counts.collected,
          duplicatesAcrossAreas: counts.duplicates,
          duplicatesAcrossTrades: counts.acrossTrades,
          alreadyKnown: counts.known,
          suppressed: counts.suppressed,
          alreadyContacted: counts.contacted,
          needsReview: counts.review,
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
