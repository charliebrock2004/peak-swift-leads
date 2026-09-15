/**
 * Phase 13, Step 1-3: the live Companies House behaviour test.
 *
 * A DIAGNOSTIC SCRIPT. It imports the app's own parsing and filtering code so
 * what it measures is this pipeline's behaviour and not a re-implementation of
 * it. It changes nothing, writes nothing, and is not part of the app or the
 * build — it exists because the agent sandbox denies outbound HTTPS to
 * Companies House, so the hypothesis behind Phase 13 cannot be proven from
 * there and must not be assumed.
 *
 * Run it from a machine with normal internet access:
 *
 *   node --experimental-strip-types scripts/ch-live-probe.mjs
 *
 * Then paste the output back. Nothing in Phase 13 should be implemented until
 * these numbers exist.
 *
 * Bounded on purpose: at most MAX_REQUESTS calls, one at a time, with a pause
 * between them. This is somebody's public service, not a load target.
 */
import {
  chSearchQueries,
  extractUkPostcode,
  filterCompanyHits,
  hitInArea,
  parseCompaniesHouseHtml,
  parseCompaniesHouseJson,
  specForTrade,
} from "../src/lib/companies-house.ts";
import { chSearchTowns, planSearch } from "../src/lib/scotland-places.ts";

const CH = "https://find-and-update.company-information.service.gov.uk/search/companies";
const UA = "PeakSwiftLeads/1.0 (https://peak-swift-leads.vercel.app)";
/** Hard ceiling on requests for the whole probe. */
const MAX_REQUESTS = 40;
/** Pause between calls. Politeness, not performance. */
const PAUSE_MS = 900;
/** Perth city centre, the same anchor the live run uses. */
const PERTH = { lat: 56.3950, lng: -3.4308 };
const RADIUS_MILES = 50;

let requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One page of a Companies House search, parsed by the app's own parsers. */
async function fetchPage(query, page = 1) {
  if (requests >= MAX_REQUESTS) return { error: "probe request ceiling reached", hits: [], status: 0 };
  requests += 1;
  const url = page > 1 ? `${CH}?q=${encodeURIComponent(query)}&page=${page}` : `${CH}?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json, text/html;q=0.8", "User-Agent": UA },
    });
    const text = await response.text();
    if (!response.ok) return { status: response.status, hits: [], error: `HTTP ${response.status}`, url };
    const type = response.headers.get("content-type") || "";
    const json = type.includes("json") || text.trim().startsWith("{");
    let hits = [];
    if (json) {
      try { hits = parseCompaniesHouseJson(JSON.parse(text)); }
      catch { hits = parseCompaniesHouseHtml(text); }
    } else {
      hits = parseCompaniesHouseHtml(text);
    }
    // The site prints a total; capture it when present so we can see how much
    // of the result set page 1 actually represents.
    const total =
      Number((text.match(/([\d,]+)\s+(?:companies|results)\s+found/i) || [])[1]?.replace(/,/g, "")) ||
      Number((text.match(/"total_results"\s*:\s*(\d+)/) || [])[1]) ||
      null;
    return { status: response.status, hits, total, url, format: json ? "json" : "html", bytes: text.length };
  } catch (error) {
    return { status: 0, hits: [], error: error?.name === "AbortError" ? "timeout" : String(error?.message || error), url };
  } finally {
    clearTimeout(timer);
    await sleep(PAUSE_MS);
  }
}

const isPerthshire = (hit) =>
  /\bPH\d/i.test(hit.postcode || "") ||
  /perth|crieff|scone|auchterarder|blairgowrie|kinross|dunkeld|methven|errol|coupar|abernethy|dunning|stanley|bridge of earn/i
    .test(`${hit.town} ${hit.address}`);

const nameHasPerth = (hit) => /\bperth/i.test(hit.businessName);

function tally(label, hits) {
  const local = hits.filter(isPerthshire);
  return {
    label,
    returned: hits.length,
    perthshire: local.length,
    withPostcode: hits.filter((h) => (h.postcode || extractUkPostcode(h.address || "")).length > 0).length,
    perthInName: hits.filter(nameHasPerth).length,
  };
}

console.log("=".repeat(78));
console.log("PHASE 13 — COMPANIES HOUSE LIVE BEHAVIOUR TEST");
console.log(`endpoint: ${CH}`);
console.log(`ceiling: ${MAX_REQUESTS} requests, ${PAUSE_MS}ms apart`);
console.log("=".repeat(78));

// ── STEP 1: does a town token help or hurt? ─────────────────────────────────
console.log("\n## STEP 1 — town token in a company-NAME search\n");
const QUERIES = [
  "joinery", "joinery Perth",
  "joiners", "joiners Perth",
  "carpentry", "carpentry Perth",
  "joinery ltd", "joinery Scotland",
];
const sets = new Map();
console.log(
  "query".padEnd(22) + "stat".padEnd(6) + "fmt".padEnd(6) + "total".padEnd(9) +
  "page1".padEnd(7) + "PH-area".padEnd(9) + "postcode".padEnd(10) + "'Perth' in name",
);
for (const query of QUERIES) {
  const page = await fetchPage(query, 1);
  if (page.error) { console.log(`${query.padEnd(22)}${String(page.status).padEnd(6)}ERROR ${page.error}`); continue; }
  const filtered = filterCompanyHits(page.hits, "Joiner");
  sets.set(query, filtered);
  const t = tally(query, filtered);
  console.log(
    query.padEnd(22) + String(page.status).padEnd(6) + String(page.format).padEnd(6) +
    String(page.total ?? "?").padEnd(9) + String(t.returned).padEnd(7) +
    String(t.perthshire).padEnd(9) + String(t.withPostcode).padEnd(10) + String(t.perthInName),
  );
}

console.log("\n### Does dropping the town token change the result set?\n");
for (const [bare, withTown] of [["joinery", "joinery Perth"], ["joiners", "joiners Perth"], ["carpentry", "carpentry Perth"]]) {
  const a = sets.get(bare) ?? [];
  const b = sets.get(withTown) ?? [];
  const ka = new Set(a.map((h) => h.companyNumber));
  const kb = new Set(b.map((h) => h.companyNumber));
  const onlyBare = [...ka].filter((n) => !kb.has(n));
  const onlyTown = [...kb].filter((n) => !ka.has(n));
  const bareLocal = a.filter(isPerthshire).length;
  const townLocal = b.filter(isPerthshire).length;
  console.log(`"${bare}" vs "${withTown}"`);
  console.log(`   only in "${bare}": ${onlyBare.length}   only in "${withTown}": ${onlyTown.length}   shared: ${[...ka].filter((n) => kb.has(n)).length}`);
  console.log(`   Perthshire companies — bare: ${bareLocal}, with town: ${townLocal}`);
  const sample = a.filter((h) => isPerthshire(h) && !kb.has(h.companyNumber)).slice(0, 5);
  if (sample.length) {
    console.log(`   Perthshire companies the town query MISSED:`);
    for (const h of sample) console.log(`      ${h.businessName} — ${h.postcode || "(no postcode)"} — ${h.town}`);
  }
  console.log("");
}

console.log("### Named check: does STRATHEARN JOINERY LTD appear anywhere?\n");
for (const [query, hits] of sets) {
  const hit = hits.find((h) => /strathearn/i.test(h.businessName));
  if (hit) console.log(`   FOUND in "${query}": ${hit.businessName} — ${h1(hit)}`);
}
function h1(h) { return `${h.companyNumber} ${h.postcode || "(no postcode)"} ${h.town}`; }
if (![...sets.values()].some((hits) => hits.some((h) => /strathearn/i.test(h.businessName)))) {
  console.log("   NOT FOUND on page 1 of any query above.");
}

// ── STEP 2: pagination ─────────────────────────────────────────────────────
console.log("\n## STEP 2 — pagination\n");
const PAGED = "joinery";
const seen = new Set();
let pagesUseful = 0;
console.log("page".padEnd(7) + "stat".padEnd(6) + "returned".padEnd(10) + "new".padEnd(6) + "PH-area new");
for (let page = 1; page <= 5; page += 1) {
  const result = await fetchPage(PAGED, page);
  if (result.error) { console.log(`${String(page).padEnd(7)}${String(result.status).padEnd(6)}ERROR ${result.error}`); break; }
  const filtered = filterCompanyHits(result.hits, "Joiner");
  const fresh = filtered.filter((h) => !seen.has(h.companyNumber));
  for (const h of filtered) seen.add(h.companyNumber);
  if (fresh.length > 0) pagesUseful = page;
  console.log(
    String(page).padEnd(7) + String(result.status).padEnd(6) + String(filtered.length).padEnd(10) +
    String(fresh.length).padEnd(6) + String(fresh.filter(isPerthshire).length),
  );
  if (result.hits.length === 0) { console.log("   (no rows parsed — pagination parameter may differ)"); break; }
}
console.log(`\n   unique companies across pages: ${seen.size}`);
console.log(`   last page that added anything new: ${pagesUseful}`);

// ── STEP 3: geographic safety, using the app's own hitInArea ───────────────
console.log("\n## STEP 3 — geographic filtering (existing hitInArea, unmodified)\n");
const towns = chSearchTowns("Perth", 12);
const pool = [...new Map([...sets.values()].flat().map((h) => [h.companyNumber, h])).values()];
console.log(`   pool: ${pool.length} distinct companies from Step 1`);

const postcodes = [...new Set(pool.map((h) => h.postcode || extractUkPostcode(h.address || "")).filter(Boolean))].slice(0, 100);
let geo = new Map();
if (postcodes.length) {
  requests += 1;
  try {
    const response = await fetch("https://api.postcodes.io/postcodes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({ postcodes }),
    });
    const payload = await response.json();
    for (const row of payload.result ?? []) {
      if (row?.result?.latitude && row.query) geo.set(row.query.toUpperCase(), { lat: row.result.latitude, lng: row.result.longitude });
    }
    console.log(`   geocoded ${geo.size} of ${postcodes.length} postcodes via postcodes.io`);
  } catch (error) {
    console.log(`   postcodes.io failed: ${String(error?.message || error)}`);
  }
}

let inside = 0, outside = 0, noPostcode = 0, keptByTownFallback = 0;
const insideSample = [], outsideSample = [], namePerthButOutside = [];
for (const hit of pool) {
  const code = (hit.postcode || extractUkPostcode(hit.address || "")).toUpperCase();
  const point = geo.get(code);
  const enriched = point ? { ...hit, lat: point.lat, lng: point.lng } : hit;
  const keep = hitInArea(enriched, PERTH, RADIUS_MILES, towns, "Perth");
  if (!code) noPostcode += 1;
  if (keep) {
    inside += 1;
    if (!point) keptByTownFallback += 1;
    if (insideSample.length < 6) insideSample.push(`${hit.businessName} — ${code || "(no postcode)"} — ${point ? "geocoded" : "town fallback"}`);
  } else {
    outside += 1;
    if (outsideSample.length < 6) outsideSample.push(`${hit.businessName} — ${code || "(no postcode)"}`);
    if (nameHasPerth(hit)) namePerthButOutside.push(hit.businessName);
  }
}
console.log(`   inside ${RADIUS_MILES}mi of Perth: ${inside}`);
console.log(`   outside: ${outside}`);
console.log(`   no usable postcode: ${noPostcode}  (of which kept by town-name fallback: ${keptByTownFallback})`);
console.log(`   reconciles: ${inside + outside === pool.length ? "yes" : "NO — " + (inside + outside) + " vs " + pool.length}`);
console.log(`\n   RETAINED (sample):`);
for (const s of insideSample) console.log(`      ${s}`);
console.log(`   REJECTED (sample):`);
for (const s of outsideSample) console.log(`      ${s}`);
console.log(`\n   companies with "Perth" in the NAME but rejected as outside: ${namePerthButOutside.length}`);
for (const n of namePerthButOutside.slice(0, 5)) console.log(`      ${n}`);
console.log(`   (a non-zero number here proves the name is not being treated as a location)`);

// ── STEP 4: the query plan, measured ───────────────────────────────────────
console.log("\n## STEP 4 — current query-plan duplication (offline, no requests)\n");
const plan = planSearch("Perth", 60);
let sent = 0;
const distinct = new Set();
for (const area of plan.areas) {
  for (const q of chSearchQueries("Joiner", chSearchTowns(area.name, 12))) { sent += 1; distinct.add(q); }
}
console.log(`   areas: ${plan.areas.length}`);
console.log(`   CH queries sent: ${sent}`);
console.log(`   distinct query strings: ${distinct.size}`);
console.log(`   byte-identical repeats: ${sent - distinct.size} (${Math.round((100 * (sent - distinct.size)) / sent)}%)`);
console.log(`   trade spec queries: ${specForTrade("Joiner").queries.join(", ")}`);

console.log(`\n${"=".repeat(78)}`);
console.log(`TOTAL LIVE REQUESTS MADE: ${requests} (ceiling ${MAX_REQUESTS})`);
console.log("=".repeat(78));
