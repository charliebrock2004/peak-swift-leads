import { type Priority } from "./leads.ts";
import { findDuplicate, type LeadIdentity } from "./identity.ts";
import {
  createProspectPool,
  DISCOVERY_SAFETY,
  type PoolDiagnostics,
  type ProspectPool,
} from "./prospect-pool.ts";
import { planSearch, type ResearchPlan } from "./scotland-places.ts";
import type { Prospect, ResearchResult } from "./research.ts";

export type SearchInput = {
  location: string;
  businessType: string;
  limit: number;
  excludeNames: string[];
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
    rawTotal: number;
    /** Rows each source contributed, so a dead source is visible as a zero. */
    rawBySource: { nominatim: number; photon: number; bizdata: number; companiesHouse: number };
    unique: number;
    duplicatesMerged: number;
    droppedToFetchBudget: number;
    withWebsite: number;
    withoutWebsite: number;
    withListedEmail: number;
  };
  /** Cross-area dedupe, existing-lead removal, ranking and the target. */
  pool: PoolDiagnostics;
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
  known?: readonly LeadIdentity[];
  suppressed?: readonly LeadIdentity[];
  contacted?: readonly LeadIdentity[];
  /** Test hook. Production uses DISCOVERY_SAFETY.poolCeiling. */
  ceiling?: number;
}): Promise<PlannedSearchResult> {
  const target = Math.min(DISCOVERY_SAFETY.targetMax, Math.max(1, Math.round(options.limit) || 8));
  const plan = planSearch(options.location, target);
  const areas = plan.areas.slice(0, DISCOVERY_SAFETY.maxAreas);
  const errors: string[] = [];
  let cancelled = false;

  const pool: ProspectPool = createProspectPool({
    target,
    known: options.known,
    suppressed: options.suppressed,
    contacted: options.contacted,
    tradeTerms: [options.businessType],
    townTerms: areas.map((area) => area.name),
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
    rawTotal: 0,
    rawBySource: { nominatim: 0, photon: 0, bizdata: 0, companiesHouse: 0 },
    unique: 0,
    duplicatesMerged: 0,
    droppedToFetchBudget: 0,
    withWebsite: 0,
    withoutWebsite: 0,
    withListedEmail: 0,
  };
  let nextIndex = 0;
  let pauseUntil = 0;
  const active = new Set<string>();
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

  const collect = (prospects: readonly Prospect[]) => {
    pool.offer(prospects);
    for (const prospect of prospects) {
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
      emit(area.name, index + 1);
      try {
        const result = await options.research({
          location: area.name,
          businessType: options.businessType,
          // A fetch budget, not the target. Every row this returns joins the
          // pool; none of it is thrown away before cross-area dedupe.
          limit: area.quota,
          excludeNames: [...pooledNames],
        });
        if (options.shouldCancel?.()) {
          cancelled = true;
          if (result.ok) collect(result.prospects);
          return;
        }
        if (!result.ok) {
          errors.push(`${area.name}: ${result.error}`);
          if (/rate limit|429/i.test(result.error)) pauseUntil = Date.now() + rateLimitPauseMs;
        } else {
          collect(result.prospects);
          if (result.funnel) {
            totals.areas += 1;
            totals.queriesSent += result.funnel.queriesSent;
            totals.rawTotal += result.funnel.rawTotal;
            for (const key of Object.keys(totals.rawBySource) as (keyof typeof totals.rawBySource)[]) {
              totals.rawBySource[key] += result.funnel.rawBySource[key];
            }
            totals.unique += result.funnel.unique;
            totals.duplicatesMerged += result.funnel.duplicatesMerged;
            totals.droppedToFetchBudget += result.funnel.droppedToFetchBudget;
            totals.withWebsite += result.funnel.withWebsite;
            totals.withoutWebsite += result.funnel.withoutWebsite;
            totals.withListedEmail += result.funnel.withListedEmail;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search failed";
        errors.push(`${area.name}: ${message}`);
        if (/rate limit|429|too many/i.test(message)) pauseUntil = Date.now() + rateLimitPauseMs;
      } finally {
        active.delete(area.name);
        emit(area.name, index + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  const { prospects, knownMatches, diagnostics } = pool.result();
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
  return { prospects, knownMatches, errors, plan, cancelled, funnel: totals, pool: diagnostics };
}
