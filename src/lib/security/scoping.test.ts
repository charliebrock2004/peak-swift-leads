/**
 * Every query against an account's data names the account.
 *
 * All 28 tables are per account (they carry `user_id`). This reads every
 * server-side SQL statement in the code and fails if one touches such a table
 * without `user_id` in it — the guard that keeps one account's businesses,
 * emails and settings from ever reaching another, and the seam where a
 * workspace id would be added. The handful of statements that legitimately
 * span accounts are maintenance jobs, listed below with the reason.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;

function tablesFromMigrations(): string[] {
  const dir = join(ROOT, "..", "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const match of sql.matchAll(/create table if not exists ([a-z_]+) \(([\s\S]*?)\n\);/g)) {
      if (/\buser_id\b/.test(match[2]!)) names.add(match[1]!);
    }
  }
  return [...names];
}

function serverFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) serverFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && !path.includes("test-support")) out.push(path);
  }
  return out;
}

/** Statements that span accounts on purpose: [file, a fragment of the statement, why]. */
const CROSS_ACCOUNT: [string, string, string][] = [
  ["lib/jobs/handlers.server.ts", "delete from website_audits w", "retention: old audit history, every account"],
  ["lib/jobs/handlers.server.ts", "delete from evidence_items", "retention: superseded evidence, every account"],
  ["lib/jobs/handlers.server.ts", "delete from usage_counters where kind like 'rl:%'", "retention: expired rate-limit windows"],
  ["lib/jobs/store.server.ts", "", "the job queue: the runner claims and prunes jobs for every account, then works as each job's own account"],
  ["lib/db.ts", "", "migrations and bootstrap"],
];

function allowed(file: string, statement: string): boolean {
  return CROSS_ACCOUNT.some(([path, fragment]) => file.endsWith(path) && (!fragment || statement.includes(fragment)));
}

describe("account scoping", () => {
  const tables = tablesFromMigrations();

  it("finds the per-account tables", () => {
    for (const table of ["leads", "outreach_emails", "prospect_feedback", "time_log", "jobs"]) assert.ok(tables.includes(table), table);
    assert.ok(tables.length >= 25);
  });

  it("every statement touching an account's table is scoped by user_id", () => {
    const touch = new RegExp(`\\b(from|into|update|join)\\s+(${tables.join("|")})\\b`, "i");
    const unscoped: string[] = [];
    let checked = 0;
    for (const file of serverFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/`([^`]*)`/g)) {
        const statement = match[1]!;
        if (!/\b(select|insert\s+into|update|delete\s+from)\b/i.test(statement) || !touch.test(statement)) continue;
        checked += 1;
        if (/\buser_id\b/.test(statement) || allowed(file, statement)) continue;
        unscoped.push(`${relative(ROOT, file)}: ${statement.replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    assert.ok(checked > 100, `only ${checked} statements found — is the scan still reading the code?`);
    assert.deepEqual(unscoped, [], `Queries without user_id:\n${unscoped.join("\n")}`);
  });
});
