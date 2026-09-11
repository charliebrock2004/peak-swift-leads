#!/usr/bin/env node
/**
 * Prove the built server can actually be loaded, before it is deployed.
 *
 * A green `vite build` says the bundle was WRITTEN, not that Node can link it.
 * That gap shipped a production outage: the bundler split the SSR graph and
 * emitted `export { … ssr_exports as s }` from a circular `ssr.mjs` / `ssr2.mjs`
 * pair. Rollup was happy, the build was green, every deployed route answered
 *
 *   {"error":true,"status":500,"unhandled":true}
 *
 * and the only clue — `SyntaxError: Export 'ssr_exports' is not defined in
 * module` — lived in the runtime logs of a site that could not serve a page.
 *
 * Vercel runs `__server.func/index.mjs`. Importing THAT file is the test.
 * Importing every `_ssr` chunk in isolation is not: Nitro's circular pair
 * throws the same `ssr_exports` error on a solo import even when the real
 * entry links them in an order that works. A green entry is a startable
 * server; a red isolated chunk is often a false positive.
 */
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = join(root, ".vercel/output/functions/__server.func/index.mjs");

function isLinkFault(error) {
  return (
    error instanceof SyntaxError ||
    error?.cause instanceof SyntaxError ||
    /is not defined in module|does not provide an export|Cannot find module/.test(
      String(error?.message ?? ""),
    )
  );
}

async function main() {
  try {
    await access(entryPath);
  } catch {
    console.log("[ssr-check] no .vercel/output — nothing built, skipping.");
    return;
  }

  try {
    await import(pathToFileURL(entryPath).href);
  } catch (error) {
    // A module can legitimately throw while EVALUATING (env, database).
    // Only a link/syntax error means the bundle itself is malformed.
    if (isLinkFault(error)) {
      console.error("[ssr-check] the built server cannot be loaded:");
      console.error(`  index.mjs: ${error?.message ?? error}`);
      console.error(
        "[ssr-check] deploying this would answer 500 on every route. " +
          "This is usually a bundler chunk split — reduce dynamic imports across " +
          "the server graph, or pin the chunking, then rebuild.",
      );
      process.exit(1);
    }
  }

  console.log("[ssr-check] production entry (index.mjs) loads.");
}

await main();
