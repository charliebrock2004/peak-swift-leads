/**
 * Coverage memory in the database (search_coverage, migration 0017).
 * Every statement is scoped to the account.
 */
import type { Sql } from "@/lib/db";
import type { SearchRow } from "./discovery-ledger.ts";
import { coverageWrite, tradeKey } from "./discovery-coverage.ts";
import type { AreaCoverage } from "./scotland-places.ts";

/** Every town searched for this trade, keyed by `areaKey`. */
export async function loadCoverage(sql: Sql, userId: string, trade: string): Promise<Map<string, AreaCoverage>> {
  const rows = await sql.query<Record<string, unknown>>(
    `select area_key, searches, last_searched_at, exhausted_until
       from search_coverage
      where user_id = $1 and trade_key = $2
      limit 5000`,
    [userId, tradeKey(trade)],
  );
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : "");
  return new Map(
    rows.map((row) => [
      String(row.area_key),
      { searches: Number(row.searches) || 0, lastSearchedAt: iso(row.last_searched_at), exhaustedUntil: iso(row.exhausted_until) },
    ]),
  );
}

/** Record what each search of a run found. Failed searches are not recorded. */
export async function recordCoverage(sql: Sql, userId: string, rows: readonly SearchRow[], now: Date = new Date()): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const write = coverageWrite(row, now);
    if (!write) continue;
    await sql.query(
      `insert into search_coverage (user_id, area_key, trade_key, area, trade, searches, last_searched_at, listings, new_found, last_listings, last_new, exhausted_until)
       values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $7, $8, $9)
       on conflict (user_id, area_key, trade_key) do update set
         area = excluded.area,
         trade = excluded.trade,
         searches = search_coverage.searches + 1,
         last_searched_at = excluded.last_searched_at,
         listings = search_coverage.listings + excluded.listings,
         new_found = search_coverage.new_found + excluded.new_found,
         last_listings = excluded.last_listings,
         last_new = excluded.last_new,
         exhausted_until = excluded.exhausted_until`,
      [userId, write.areaKey, write.tradeKey, write.area, write.trade, now.toISOString(), write.listings, write.fresh, write.exhaustedUntil || null],
    );
    written += 1;
  }
  return written;
}
