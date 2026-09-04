/**
 * Running a large prospect search.
 *
 * One API call cannot return a hundred real businesses, so a big search is many
 * small calls swept across an area and stitched together here. This module owns
 * that: what to call next, what to throw away as a duplicate, when to stop, and
 * what to keep when something fails halfway.
 *
 * Three rules shape all of it:
 *
 * 1. **Never invent.** "100 prospects" means up to 100 real ones. If a sweep
 *    finds 63, the answer is 63. Nothing here pads a result set.
 * 2. **Never waste a call.** Batches carry the names already found so the model
 *    does not re-research them, the sweep stops the moment it has enough or
 *    stops finding anything new, and the call budget is finite.
 * 3. **Never lose what worked.** Every prospect is banked as it arrives. A
 *    failure late in a sweep returns everything found before it, not an error.
 *
 * The batch runner is injected, so all of this is testable without an API key.
 */
import { matchLeadLike, type LeadLike } from "./leads.ts";
import { batchSize, buildBatchQueue, callBudget, planSearch, type LocationType } from "./regions.ts";
import type { Prospect } from "./research-types.ts";

/** Calls in flight at once. Enough to be quick, few enough to stay under rate limits. */
export const CONCURRENCY = 3;

/** Names sent up so the model skips them. Capped so the prompt stays small. */
const MAX_EXCLUDE = 40;

/**
 * What each place has already offered up.
 *
 * Per place, not one global list: coming back to Perth for a second pass has to
 * tell the model which Perth firms it already named, or it returns the same
 * twelve and the whole call is wasted. A global recency window cannot do that —
 * by the time a twenty-town sweep comes back round, Perth's names have scrolled
 * out of it. This was the difference between a Perthshire search finding 35 and
 * finding the lot.
 */
export type SeenByArea = Map<string, string[]>;

/** Record every name a place returned — including ones dropped as duplicates. */
export function recordSeen(seen: SeenByArea, area: string, names: string[]): void {
  const key = area.toLowerCase();
  const known = seen.get(key) ?? [];
  for (const name of names) {
    const trimmed = name?.trim();
    if (trimmed && !known.includes(trimmed)) known.push(trimmed);
  }
  seen.set(key, known);
}

/** The "don't return these again" list for one place. */
export function excludeFor(seen: SeenByArea, area: string): string[] {
  return (seen.get(area.toLowerCase()) ?? []).slice(-MAX_EXCLUDE);
}

/** Consecutive waves that add nothing new before the sweep gives up. */
const BARREN_WAVES_BEFORE_STOP = 2;

/** Failures with nothing found at all — a bad key or a dead API, not thin towns. */
const FAILURES_BEFORE_ABANDON = 3;

export type BatchRequest = {
  area: string;
  /** Wider area for the prompt, e.g. "Perthshire". */
  context: string;
  businessType: string;
  limit: number;
  /** Businesses already found; the model is told not to return these again. */
  exclude: string[];
};

export type BatchResult =
  | { ok: true; prospects: Prospect[] }
  | { ok: false; error: string };

export type RunBatch = (request: BatchRequest) => Promise<BatchResult>;

export type SearchProgress = {
  /** Calls finished. */
  done: number;
  /** Calls the sweep may make at most. */
  budget: number;
  /** Unique real businesses found so far. */
  found: number;
  /** How many were asked for. */
  target: number;
  /** Places covered so far. */
  areas: string[];
  /** Batches that came back with an error. */
  failed: number;
};

export type StopReason =
  /** Got everything that was asked for. */
  | "target"
  /** Swept every place there was to sweep. */
  | "exhausted"
  /** Spent the call budget. */
  | "budget"
  /** Recent calls stopped turning up anything new. */
  | "diminishing"
  /** The API is not answering — stopped rather than burning the budget. */
  | "failed"
  /** The user pressed stop. */
  | "cancelled";

export type SearchOutcome = {
  prospects: Prospect[];
  callsMade: number;
  areasSearched: string[];
  failures: string[];
  stoppedBecause: StopReason;
};

/**
 * The next few calls to fire together — never two for the same place.
 *
 * Calls in a wave run concurrently, so they cannot see each other's results.
 * Two for the same town would therefore go out with the same exclude list and
 * come back with the same businesses: one of them paid for nothing. A one-town
 * search consequently runs one call at a time, which is exactly right.
 */
export function takeWave<T extends { area: string }>(
  queue: readonly T[],
  from: number,
  room: number,
): T[] {
  const wave: T[] = [];
  const areas = new Set<string>();
  for (let i = from; i < queue.length && wave.length < Math.min(CONCURRENCY, room); i += 1) {
    const key = queue[i].area.toLowerCase();
    if (areas.has(key)) break;
    areas.add(key);
    wave.push(queue[i]);
  }
  return wave;
}

const RANK: Record<Prospect["priority"], number> = { HOT: 0, WARM: 1, COLD: 2 };

/**
 * Best prospects first: the ones worth ringing today at the top.
 *
 * Priority, then weight of evidence (reviews, then rating) — a no-website joiner
 * with 80 reviews is a better call than one with 3, even though both are HOT.
 */
export function rankProspects(prospects: Prospect[]): Prospect[] {
  return [...prospects].sort((a, b) => {
    if (RANK[a.priority] !== RANK[b.priority]) return RANK[a.priority] - RANK[b.priority];
    const aReviews = typeof a.reviews === "number" ? a.reviews : -1;
    const bReviews = typeof b.reviews === "number" ? b.reviews : -1;
    if (aReviews !== bReviews) return bReviews - aReviews;
    const aRating = typeof a.rating === "number" ? a.rating : -1;
    const bRating = typeof b.rating === "number" ? b.rating : -1;
    if (aRating !== bRating) return bRating - aRating;
    return a.businessName.localeCompare(b.businessName, "en-GB");
  });
}

/**
 * Add a batch's results to the running set, dropping anything already held.
 *
 * Deduplication happens here rather than at import time so the sweep's own
 * "found so far" count is honest, and so the next batch can be told what to
 * skip. Returns the newly-kept prospects.
 */
export function mergeBatch(found: Prospect[], incoming: Prospect[]): Prospect[] {
  const kept: Prospect[] = [];
  for (const prospect of incoming) {
    if (!prospect?.businessName?.trim()) continue;
    const candidate: LeadLike = {
      businessName: prospect.businessName,
      town: prospect.town,
      phone: prospect.phone,
      mapsLink: prospect.mapsLink,
    };
    if (matchLeadLike(candidate, found)) continue;
    if (matchLeadLike(candidate, kept)) continue;
    kept.push(prospect);
  }
  return kept;
}


export type SearchOptions = {
  locationType: LocationType;
  location: string;
  businessType: string;
  target: number;
  runBatch: RunBatch;
  onProgress?: (progress: SearchProgress) => void;
  /** Checked between waves so a long sweep can be stopped. */
  isCancelled?: () => boolean;
};

/**
 * Sweep an area for prospects until there are enough of them, or there is
 * nothing left to find.
 */
export async function searchProspects(options: SearchOptions): Promise<SearchOutcome> {
  const { locationType, location, businessType, target, runBatch } = options;
  const plan = planSearch(locationType, location);
  const queue = buildBatchQueue(plan, target);
  const budget = callBudget(target);

  const found: Prospect[] = [];
  const seen: SeenByArea = new Map();
  const failures: string[] = [];
  const areasSearched: string[] = [];
  let callsMade = 0;
  let barrenWaves = 0;
  let stoppedBecause: StopReason = "exhausted";

  const report = (area: string) => {
    options.onProgress?.({
      done: callsMade,
      budget,
      found: found.length,
      target,
      areas: [...areasSearched],
      failed: failures.length,
    });
    void area;
  };

  if (queue.length === 0) {
    return { prospects: [], callsMade: 0, areasSearched: [], failures: [], stoppedBecause: "exhausted" };
  }

  let index = 0;
  while (index < queue.length && callsMade < budget) {
    if (options.isCancelled?.()) {
      stoppedBecause = "cancelled";
      break;
    }

    const wave = takeWave(queue, index, budget - callsMade);
    index += wave.length;

    const remaining = target - found.length;

    const results = await Promise.all(
      wave.map(async (batch): Promise<{ batch: typeof batch; result: BatchResult }> => {
        try {
          const result = await runBatch({
            area: batch.area,
            context: batch.context,
            businessType,
            limit: batchSize(remaining),
            // Batches in the same wave are in flight together, so this reflects
            // everything known about the place before the wave started.
            exclude: excludeFor(seen, batch.area),
          });
          return { batch, result };
        } catch (error) {
          // A thrown batch must never take the whole sweep down with it.
          return {
            batch,
            result: { ok: false, error: error instanceof Error ? error.message : "Batch failed" },
          };
        }
      }),
    );

    let addedThisWave = 0;
    for (const { batch, result } of results) {
      callsMade += 1;
      if (!areasSearched.includes(batch.area)) areasSearched.push(batch.area);
      if (!result.ok) {
        failures.push(`${batch.area}: ${result.error}`);
        continue;
      }
      // Everything the place named is remembered, kept or not: a name dropped
      // here as a duplicate is still one this place must not offer again.
      recordSeen(seen, batch.area, result.prospects.map((prospect) => prospect.businessName));
      const kept = mergeBatch(found, result.prospects);
      found.push(...kept);
      addedThisWave += kept.length;
    }
    report(wave[wave.length - 1]?.area ?? "");

    if (found.length >= target) {
      stoppedBecause = "target";
      break;
    }
    // A dead API looks like every call failing and nothing found. Stop rather
    // than spending the whole budget discovering the same thing 24 times.
    if (found.length === 0 && failures.length >= FAILURES_BEFORE_ABANDON) {
      stoppedBecause = "failed";
      break;
    }
    barrenWaves = addedThisWave === 0 ? barrenWaves + 1 : 0;
    if (barrenWaves >= BARREN_WAVES_BEFORE_STOP) {
      stoppedBecause = "diminishing";
      break;
    }
    if (callsMade >= budget) {
      stoppedBecause = "budget";
      break;
    }
  }

  if (stoppedBecause === "exhausted" && callsMade >= budget && found.length < target) {
    stoppedBecause = "budget";
  }

  return {
    // Never more than asked for, always ranked best-first.
    prospects: rankProspects(found).slice(0, target),
    callsMade,
    areasSearched,
    failures,
    stoppedBecause,
  };
}

/** Plain-language summary of why a sweep ended, for the results screen. */
export function describeOutcome(outcome: SearchOutcome, target: number): string {
  const n = outcome.prospects.length;
  const places = outcome.areasSearched.length;
  const where = places > 1 ? ` across ${places} places` : "";
  if (outcome.stoppedBecause === "target") return `Found ${n} prospects${where}.`;
  if (outcome.stoppedBecause === "cancelled") return `Stopped early — keeping the ${n} found${where}.`;
  if (outcome.stoppedBecause === "failed") {
    return outcome.failures[0] ?? "Research is not available just now.";
  }
  if (n === 0) return `No new businesses found${where}.`;
  return `Found ${n} real businesses${where} — fewer than the ${target} asked for, and none were invented to make up the difference.`;
}
