#!/usr/bin/env node
/**
 * Prove the built server can actually be loaded, before it is deployed.
 *
 * A green `vite build` says the bundle was WRITTEN, not that Node can link it.
 * That gap shipped a production outage: the bundler split the SSR entry into two
 * chunks and emitted `export { … ssr_exports as s }` in a file that no longer
 * defined or imported `ssr_exports`. Rollup was happy, the build was green,
 * every deployed route answered
 *
 *   {"error":true,"status":500,"unhandled":true}
 *
 * and the only clue — `SyntaxError: Export 'ssr_exports' is not defined in
 * module` — lived in the runtime logs of a site that could not serve a page.
 *
 * Importing the entry is the whole test: ESM link errors are raised on import,
 * so if this passes, the server starts. Runs as part of `npm run build`.
 */
import { access, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ssrDir = join(root, ".vercel/output/functions/__server.func/_ssr");

async function main() {
  try {
    await access(ssrDir);
  } catch {
    console.log("[ssr-check] no .vercel/output — nothing built, skipping.");
    return;
  }

  // Every chunk in the SSR entry directory, so a broken re-export is caught
  // wherever the bundler put it rather than only in the file we expect.
  const entries = (await readdir(ssrDir)).filter((name) => name.endsWith(".mjs")).sort();
  if (entries.length === 0) {
    console.error("[ssr-check] no .mjs chunks in", ssrDir);
    process.exit(1);
  }

  const failures = [];
  for (const name of entries) {
    try {
      await import(pathToFileURL(join(ssrDir, name)).href);
    } catch (error) {
      // A module can legitimately throw while EVALUATING (it may want an env var
      // or a database). Only a link/syntax error means the bundle itself is
      // malformed, which is the fault this guard exists to catch.
      const linkFault =
        error instanceof SyntaxError ||
        (error?.cause instanceof SyntaxError) ||
        /is not defined in module|does not provide an export|Cannot find module/.test(
          String(error?.message ?? ""),
        );
      if (linkFault) {
        failures.push(`${name}: ${error?.message ?? error}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("[ssr-check] the built server cannot be loaded:");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "[ssr-check] deploying this would answer 500 on every route. " +
        "This is usually a bundler chunk split — reduce dynamic imports across " +
        "the server graph, or pin the chunking, then rebuild.",
    );
    process.exit(1);
  }

  console.log(`[ssr-check] ${entries.length} server chunk(s) load cleanly.`);
}

await main();
