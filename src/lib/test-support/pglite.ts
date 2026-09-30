/**
 * A real Postgres for tests: PGLite with every migration in `migrations/`
 * applied, in order, exactly as `scripts/migrate.mjs` applies them on deploy.
 *
 * Integration tests use this rather than a mock so that the constraints the
 * product relies on — the one-live-email-per-recipient index, the sent-row
 * invariants, the monotonic sync rules — are exercised as SQL, not as a
 * description of SQL. Test-only; nothing in the app imports it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

export type TestDb = { sql: Sql; pg: PGlite; close: () => Promise<void> };

/** Wrap PGLite in the app's `Sql` surface, with an optional fault injector. */
export function sqlFrom(pg: PGlite, intercept?: (text: string, params: unknown[]) => void): Sql {
  const run = async <T>(text: string, params: unknown[] = []): Promise<T[]> => {
    intercept?.(text, params);
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const sql = (async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = run;
  return sql;
}

export async function createTestDb(options: { intercept?: (text: string, params: unknown[]) => void } = {}): Promise<TestDb> {
  const pg = new PGlite({ parsers: { 20: Number, 1082: (v: string) => v, 1186: (v: string) => v } });
  await pg.waitReady;
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) {
    await pg.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  }
  return { sql: sqlFrom(pg, options.intercept), pg, close: () => pg.close() };
}
