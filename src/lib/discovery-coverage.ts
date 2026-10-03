/**
 * Coverage memory: what searching a town for a trade last found, and when it
 * is worth searching again.
 *
 * The rules are plain and deterministic:
 *   - a search that found something new leaves the town open;
 *   - a search whose every listing was a business you already have rests the
 *     town for that trade for REST_DAYS.nothingNew;
 *   - a search that came back empty rests it for REST_DAYS.empty;
 *   - a failed search (the source was down) is not a search: nothing changes.
 * Each search also moves the town on to the next set of search words, so a
 * town that is searched again is asked different questions.
 *
 * Pure: the server store (discovery-coverage.server.ts) reads and writes it.
 */
import type { SearchRow } from "./discovery-ledger.ts";
import { areaKey, type AreaCoverage } from "./scotland-places.ts";

export const REST_DAYS = { nothingNew: 30, empty: 45 } as const;

export function tradeKey(trade: string): string {
  return trade.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export type CoverageWrite = {
  areaKey: string;
  tradeKey: string;
  area: string;
  trade: string;
  /** Listings this search returned. */
  listings: number;
  /** Businesses this search found that were new (or possibly new). */
  fresh: number;
  /** Rest until this ISO date, or "" for open. */
  exhaustedUntil: string;
};

/** What one search row teaches coverage memory; null when it teaches nothing (it failed). */
export function coverageWrite(row: SearchRow, now: Date = new Date()): CoverageWrite | null {
  if (row.error) return null;
  const fresh = row.outcomes.accepted + row.outcomes.beyond_target + row.outcomes.needs_review;
  const rest = row.listings === 0 ? REST_DAYS.empty : fresh === 0 ? REST_DAYS.nothingNew : 0;
  return {
    areaKey: areaKey(row.area),
    tradeKey: tradeKey(row.trade),
    area: row.area,
    trade: row.trade,
    listings: row.listings,
    fresh,
    exhaustedUntil: rest ? new Date(now.getTime() + rest * 86_400_000).toISOString() : "",
  };
}

/** Apply a write to what was known, as the store does (for tests and the planner). */
export function applyCoverage(previous: AreaCoverage | undefined, write: CoverageWrite, now: Date = new Date()): AreaCoverage {
  return {
    searches: (previous?.searches ?? 0) + 1,
    lastSearchedAt: now.toISOString(),
    exhaustedUntil: write.exhaustedUntil,
  };
}
