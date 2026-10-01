#!/usr/bin/env node
/**
 * After a build: no server secret's VALUE may appear in anything the browser
 * downloads. Reads every environment variable whose name says it is secret
 * (…SECRET, …KEY, …TOKEN, …PASSWORD, DATABASE_URL), and fails the build if
 * one of those values is found in the client output. Names in help text are
 * fine; values never are. VITE_ variables are public by design and skipped.
 *
 * Exits 0 with a note when there is no client output to check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAME = /(SECRET|_KEY$|KEY_|TOKEN|PASSWORD|DATABASE_URL|PRIVATE)/i;

export function secretValues(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => !name.startsWith("VITE_") && SECRET_NAME.test(name) && typeof value === "string" && value.trim().length >= 8)
    .map(([name, value]) => ({ name, value: value.trim() }));
}

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(js|mjs|css|html|json|map|txt|webmanifest)$/.test(name)) out.push(path);
  }
  return out;
}

export function findLeaks(dir, secrets) {
  const leaks = [];
  for (const file of files(dir)) {
    const text = readFileSync(file, "utf8");
    for (const { name, value } of secrets) if (text.includes(value)) leaks.push({ name, file });
  }
  return leaks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? ".vercel/output/static";
  if (!existsSync(dir)) {
    console.log(`[client-secrets] no client output at ${dir} — nothing to check.`);
    process.exit(0);
  }
  const secrets = secretValues();
  const leaks = findLeaks(dir, secrets);
  if (leaks.length) {
    for (const leak of leaks) console.error(`[client-secrets] ${leak.name} appears in ${leak.file}`);
    console.error("[client-secrets] A server secret is in the browser bundle. The build is refused.");
    process.exit(1);
  }
  console.log(`[client-secrets] ${secrets.length} secret value(s) checked against the client output — none found.`);
}
