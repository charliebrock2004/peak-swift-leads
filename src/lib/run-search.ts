import { addRejects, emptyRejectTally, rejectTotal, type RejectTally } from "./discovery-reasons.ts";
import { emptyLedger, emptySearchRow, LISTING_OUTCOMES, REVIEW_KEEP, SEARCH_ROWS_KEEP, type DiscoveryLedger, type SearchRow } from "./discovery-ledger.ts";
import { findDuplicate } from "./identity-index.ts";
import type { Priority } from "./leads.ts";
import {
  createProspectPool,
  DISCOVERY_SAFETY,
  type KnownBusiness,
  type PoolDiagnostics,
  type ProspectPool,
  type ProspectPoolOptions,
} from "./prospect-pool.ts";
import { planSearch, type ResearchPlan } from "./scotland-places.ts";
import type { Prospect, ResearchResult } from "./research.ts";

export type SearchInput = {
  location: string;
  businessType: string;
  limit: number;
  excludeNames: string[];
  /** This area's radius, when the plan narrowed it; otherwise the run's. */
  radiusMiles?: number;
  /** Companies House towns for this area, when the plan chose them. */
  chTowns?: string[];
  /** Earlier searches of this area for this trade (rotates the search words). */
  variant?: number;
};

export type SearchProgress = {
  phase: "searching" | "done";
  area: string;
  index: number;
  total: number;
  found: number;
  target: number;
  errors: string[];
  active: string[];
};

export type PlannedSearchResult = {
  prospects: Prospect[];
  /** Rediscovered copies of leads already on the sheet, for field-filling only. */
  knownMatches: Prospect[];
  errors: string[];
  plan: ResearchPlan;
  cancelled: boolean;
  /**
   * Every area's funnel, summed — what the *sources* returned.
   *
   * These are raw-discovery numbers: queries sent, rows back, duplicates the
   * source itself merged. They say how much the engine found. What survives
   * to become a prospect is the pool's business, and lives in `pool`.
   */
  funnel: {
    areas: number;
    queriesSent: number;
    /** Every row the sources returned: refused ones and kept ones. */
    listings: number;
    /** Rows refused as not a business in the trade, by reason. */
    rejected: RejectTally;
    rawTotal: number;
    /** Rows each source contributed, so a dead source is visible as a zero. */
    rawBySource: { nominatim: number; photon: number; companiesHouse: number; overpass: number };
    unique: number;
    duplicatesMerged: number;
    withWebsite: number;
    withoutWebsite: number;
    withListedEmail: number;
  };
  /** Cross-area dedupe, existing-lead removal, ranking and the target. */
  pool: PoolDiagnostics;
  /** Every listing's one outcome, per search. Reconciles (`reconcileLedger`). */
  ledger: DiscoveryLedger;
  /** Every new candidate kept, best first, including any beyond the target. */
  kept: Prospect[];
};

export type ResearchFn = (input: SearchInput) => Promise<ResearchResult>;

const RANK: Record<Priority, number> = { HOT: 0, WARM: 1, COLD: 2 };

export function sortProspects(list: Prospect[]): Prospect[] {
  return [...list].sort((a, b) => {
    if (RANK[a.priority] !== RANK[b.priority]) return RANK[a.priority] - RANK[b.priority];
    const aReviews = typeof a.reviews === "number" ? a.reviews : -1;
    const bReviews = typeof b.reviews === "number" ? b.reviews : -1;
    return bReviews - aReviews;
  });
}

export function mergeProspects(existing: Prospect[], incoming: Prospect[], limit: number): Prospect[] {
  const next = [...existing];
  for (const item of incoming) {
    if (next.length >= limit) break;
    if (findDuplicate(item, next)) continue;
    next.push(item);
  }
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fan a location into town batches and pool everything they find.
 *
 * The order here is the whole point, and it used to be wrong. Each town was
 * previously capped at a hard-coded twelve rows *before* anything looked across
 * towns, so fourteen towns around Perth each kept their nearest twelve — mostly
 * the same firms — and 428 distinct businesses were binned by a constant the
 * user's target could not reach. A run asking for 60 delivered 31, of which 0
 * were new.
 *
 * Now every area feeds one pool at a generous fetch budget, the pool dedupes
 * across areas and drops anything already on the sheet, and only then is the
 * target applied — to genuinely new businesses, ranked best-first. The target
 * is the only thing that decides how many come back; the named limits in
 * DISCOVERY_SAFETY are the only things that can stop it, and each one reports
 * itself when it bites.
 */
export async function runPlannedSearch(options: {
  location: string;
  businessType: string;
  limit: number;
  research: ResearchFn;
  shouldCancel?: () => boolean;
  onProgress?: (progress: SearchProgress) => void;
  concurrency?: number;
  rateLimitPauseMs?: number;
  /** Leads already on the sheet. Excluded before the target is applied. */
  known?: readonly KnownBusiness[];
  suppressed?: readonly KnownBusiness[];
  contacted?: readonly KnownBusiness[];
  /** Taken by an earlier trade of this run: a repeat is a duplicate within the search. */
  inRun?: readonly KnownBusiness[];
  /** The areas to search, when the caller planned them (coverage memory). */
  plan?: ResearchPlan;
  /** Ranking points per source, from your prospect-quality marks. */
  sourceWeights?: ProspectPoolOptions["sourceWeights"];
  /** Test hook. Production uses DISCOVERY_SAFETY.poolCeiling. */
  ceiling?: number;
}): Promise<PlannedSearchResult> {
  const target = Math.min(DISCOVERY_SAFETY.targetMax, Math.max(1, Math.round(options.limit) || 8));
  const plan = options.plan ?? planSearch(options.location, target);
  const areas = plan.areas.slice(0, DISCOVERY_SAFETY.maxAreas);
  /** One row per area searched, for the ledger; filled as each search returns. */
  const rows = new Map<string, SearchRow>(areas.map((area) => [area.name, emptySearchRow(area.name, options.businessType, area.variant ?? 0)]));
  const rejected = emptyRejectTally();
  let acrossSources = 0;
  const errors: string[] = [];
  let cancelled = false;

  const pool: ProspectPool = createProspectPool({
    target,
    known: options.known,
    suppressed: options.suppressed,
    contacted: options.contacted,
    inRun: options.inRun,
    tradeTerms: [options.businessType],
    townTerms: areas.map((area) => area.name),
    sourceWeights: options.sourceWeights,
    ceiling: options.ceiling,
  });
  /**
   * Names already pooled, offered to later towns so a source can skip them.
   * A courtesy to the source only — dedupe is the pool's job, and correctness
   * never depends on this list being complete.
   */
  const pooledNames: string[] = [];

  /** Summed across every area, so the whole run can be diagnosed at once. */
  const totals = {
    areas: 0,
    queriesSent: 0,
    listings: 0,
    rejected,
    rawTotal: 0,
    rawBySource: { nominatim: 0, photon: 0, companiesHouse: 0, overpass: 0 },
    unique: 0,
    duplicatesMerged: 0,
    withWebsite: 0,
    withoutWebsite: 0,
    withListedEmail: 0,
  };
  let nextIndex = 0;
  let pauseUntil = 0;
  const active = new Set<string>();
  /** Areas a search was started for: each gets a ledger row, even if it found nothing. */
  const attempted = new Set<string>();
  const total = areas.length;
  const workers = Math.max(1, Math.min(options.concurrency ?? 1, total));
  const rateLimitPauseMs = options.rateLimitPauseMs ?? 8000;

  const emit = (area: string, index: number) => {
    options.onProgress?.({
      phase: "searching",
      area,
      index,
      total,
      found: pool.size,
      target,
      errors: [...errors],
      active: [...active],
    });
  };

  const originOf = (area: string) => `${area}|${options.businessType}`;

  /**
   * Count one area's search: what its sources returned and refused, what they
   * merged as one business, and then hand the businesses to the pool, which
   * decides the outcome of each.
   */
  const collect = (area: string, result: Extract<ResearchResult, { ok: true }>) => {
    const row = rows.get(area)!;
    const funnel = result.funnel;
    // A source without a funnel (a test double, an older adapter) is counted
    // by what it returned: each business one listing.
    const listings = funnel?.listings ?? result.prospects.length;
    const refused = rejectTotal(funnel?.rejected);
    const merged = funnel ? funnel.duplicatesMerged : 0;
    row.listings += listings;
    row.outcomes.invalid += refused;
    row.outcomes.duplicate_in_search += merged;
    addRejects(rejected, funnel?.rejected);
    acrossSources += merged;
    // Anything a funnel cannot account for (a source that trimmed its own
    // list) is still a listing that reached the pool: counted by the pool.
    const unaccounted = listings - refused - merged - result.prospects.length;
    if (unaccounted !== 0) row.listings -= unaccounted;
    if (funnel) {
      row.bySource.nominatim += funnel.rawBySource.nominatim;
      row.bySource.photon += funnel.rawBySource.photon;
      row.bySource.companiesHouse += funnel.rawBySource.companiesHouse;
      row.bySource.overpass += funnel.rawBySource.overpass ?? 0;
    }
    pool.offer(result.prospects, originOf(area));
    for (const prospect of result.prospects) {
      if (pooledNames.length >= 40) break;
      pooledNames.push(prospect.businessName);
    }
  };

  async function worker() {
    while (true) {
      if (options.shouldCancel?.()) {
        cancelled = true;
        return;
      }
      // The only reason to stop early. Reaching the target is NOT a reason:
      // a later town may hold a better prospect than one already pooled, and
      // ranking can only choose between candidates it has actually seen.
      if (pool.full) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= areas.length) return;
      const area = areas[index]!;
      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      if (options.shouldCancel?.()) {
        cancelled = true;
        return;
      }
      if (pool.full) return;
      active.add(area.name);
      attempted.add(area.name);
      emit(area.name, index + 1);
      try {
        const result = await options.research({
          location: area.name,
          businessType: options.businessType,
          // A fetch budget, not the target. Every row this returns joins the
          // pool; none of it is thrown away before cross-area dedupe.
          limit: area.quota,
          excludeNames: [...pooledNames],
          ...(area.radiusMiles ? { radiusMiles: area.radiusMiles } : {}),
          ...(area.chTowns ? { chTowns: area.chTowns } : {}),
          variant: area.variant ?? 0,
        });
        if (options.shouldCancel?.()) {
          cancelled = true;
          if (result.ok) collect(area.name, result);
          return;
        }
        if (!result.ok) {
          errors.push(`${area.name}: ${result.error}`);
          rows.get(area.name)!.error = result.error.slice(0, 200);
          if (/rate limit|429/i.test(result.error)) pauseUntil = Date.now() + rateLimitPauseMs;
        } else {
          collect(area.name, result);
          totals.areas += 1;
          if (result.funnel) {
            totals.queriesSent += result.funnel.queriesSent;
            totals.listings += result.funnel.listings;
            totals.rawTotal += result.funnel.rawTotal;
            for (const key of Object.keys(totals.rawBySource) as (keyof typeof totals.rawBySource)[]) {
              totals.rawBySource[key] += result.funnel.rawBySource[key] ?? 0;
            }
            totals.unique += result.funnel.unique;
            totals.duplicatesMerged += result.funnel.duplicatesMerged;
            totals.withWebsite += result.funnel.withWebsite;
            totals.withoutWebsite += result.funnel.withoutWebsite;
            totals.withListedEmail += result.funnel.withListedEmail;
          } else {
            totals.listings += result.prospects.length;
            totals.rawTotal += result.prospects.length;
            totals.unique += result.prospects.length;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search failed";
        errors.push(`${area.name}: ${message}`);
        rows.get(area.name)!.error = message.slice(0, 200);
        if (/rate limit|429|too many/i.test(message)) pauseUntil = Date.now() + rateLimitPauseMs;
      } finally {
        active.delete(area.name);
        emit(area.name, index + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  const { prospects, knownMatches, diagnostics, byOrigin, review, kept } = pool.result();

  // The ledger: each area's row gets the pool's verdict on every business it
  // offered; areas never reached (stopped early) keep a zero row only if they
  // were started.
  for (const [area, row] of rows) {
    const counted = byOrigin.get(originOf(area));
    if (counted) for (const outcome of LISTING_OUTCOMES) row.outcomes[outcome] += counted[outcome];
  }
  const ledger = emptyLedger();
  const searched = [...rows.values()].filter((row) => row.listings > 0 || row.error || byOrigin.has(originOf(row.area)) || attempted.has(row.area));
  ledger.searches = searched.slice(0, SEARCH_ROWS_KEEP);
  ledger.listings = searched.reduce((sum, row) => sum + row.listings, 0);
  for (const row of searched) for (const outcome of LISTING_OUTCOMES) ledger.outcomes[outcome] += row.outcomes[outcome];
  ledger.invalidReasons = addRejects(emptyRejectTally(), rejected);
  ledger.duplicates = { acrossSources, acrossAreas: diagnostics.duplicatesAcrossAreas, acrossTrades: diagnostics.duplicatesAcrossTrades };
  ledger.review = review.slice(0, REVIEW_KEEP);
  options.onProgress?.({
    phase: "done",
    area: "",
    index: total,
    total,
    found: prospects.length,
    target,
    errors: [...errors],
    active: [],
  });
  return { prospects, knownMatches, errors, plan, cancelled, funnel: totals, pool: diagnostics, ledger, kept };
}
