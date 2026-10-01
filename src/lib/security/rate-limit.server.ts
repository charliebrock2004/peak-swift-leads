/**
 * A per-account rate limit for writes: a runaway client loop or a stolen
 * session cannot hammer the database. Paid calls (search, AI, audits,
 * Companies House, verification) have their own daily budgets; sending has
 * its own daily limit — this is the floor under everything else.
 *
 * One conditional upsert into `usage_counters` per request, keyed by the
 * window (`rl:<bucket>:<seconds>` × window start), so concurrent requests
 * cannot both take the last slot. The retention job prunes old windows. If
 * the counter cannot be written at all (a database mid-migration), the
 * request is allowed: a limiter must never be the outage.
 */
import type { Sql } from "@/lib/db";
import { log } from "../log.server.ts";

export type RateBucket = { name: string; limit: number; windowSeconds: number };

export const RATE = {
  /** Calls, notes, stages, tasks, time reports. */
  sales: { name: "sales", limit: 120, windowSeconds: 60 },
  /** Adding, editing, removing and marking businesses. */
  business: { name: "business", limit: 60, windowSeconds: 60 },
  /** Spreadsheet imports — each can carry thousands of rows. */
  import: { name: "import", limit: 20, windowSeconds: 3600 },
  /** Saving the business profile. */
  profile: { name: "profile", limit: 30, windowSeconds: 60 },
} satisfies Record<string, RateBucket>;

export const RATE_LIMITED = "Too many changes in a short time — wait a minute and try again.";

/** True if this request fits in the bucket's current window (and counts it). */
export async function withinRate(sql: Sql, userId: string, bucket: RateBucket, now: Date = new Date()): Promise<boolean> {
  const windowMs = bucket.windowSeconds * 1000;
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString().slice(0, 16);
  try {
    const rows = await sql.query(
      `insert into usage_counters (user_id, day, kind, used) values ($1, $2, $3, 1)
       on conflict (user_id, day, kind) do update set used = usage_counters.used + 1
         where usage_counters.used + 1 <= $4
       returning used`,
      [userId, start, `rl:${bucket.name}:${bucket.windowSeconds}`, bucket.limit],
    );
    if (rows.length > 0) return true;
  } catch {
    return true;
  }
  log.warn("rate_limited", { userId, bucket: bucket.name, limit: bucket.limit, windowSeconds: bucket.windowSeconds });
  return false;
}
