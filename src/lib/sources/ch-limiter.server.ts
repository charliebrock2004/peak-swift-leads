/**
 * The Companies House request budget, shared by every serverless instance.
 *
 * Companies House allows 600 requests per 5 minutes per key and may ban keys
 * that keep exceeding it. An in-memory counter would give each instance its
 * own 600, so the count lives in Postgres: one row per 5-minute window, bumped
 * by a conditional upsert that refuses to pass the budget.
 */
import type { ChLimiter } from "../companies-house.ts";
import { CH_RATE_LIMIT, CH_SAFE_BUDGET } from "../companies-house.ts";

/** Rows are keyed to this pseudo-user: the limit is per API key, not per person. */
const SYSTEM_USER = "_system";

export function windowKey(now: Date, windowSeconds: number = CH_RATE_LIMIT.windowSeconds): string {
  const start = Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds;
  return `ch:${start}`;
}

export async function sharedChLimiter(budget = CH_SAFE_BUDGET): Promise<ChLimiter> {
  const { getSql } = await import("@/lib/db");
  const store = await import("@/lib/outreach/store.server.ts");
  const sql = await getSql();
  return async (n: number) => {
    try {
      const used = await store.consumeBudget(sql, SYSTEM_USER, "companies-house", n, budget, windowKey(new Date()));
      return used !== null;
    } catch {
      // No counter table (a deploy mid-migration): fall back to allowing a
      // single request rather than switching the source off entirely.
      return n <= 1;
    }
  };
}
