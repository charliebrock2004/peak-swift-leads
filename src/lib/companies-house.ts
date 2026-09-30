/**
 * Companies House — the official public data API.
 *
 * https://developer-specs.company-information.service.gov.uk/
 *
 * Replaces the earlier scraping of the public search *web pages*, which was
 * brittle (any markup change silently returned zero) and not how Companies
 * House asks developers to read its data. The API needs a free key
 * (`COMPANIES_HOUSE_API_KEY`, sent as the HTTP Basic username). Without one this
 * source is switched off and says so — it never falls back to scraping.
 *
 * What it is used for:
 *   - discovery: active companies by SIC code whose registered office is in or
 *     near the target towns (the advanced search), plus a name search for
 *     trades with no clear SIC code;
 *   - legal form: company type, status and number — the facts contactability
 *     rules rest on (a limited company is a corporate subscriber);
 *   - officers: the current directors' names, so a call can ask for a person.
 *
 * Rate limit: 600 requests per 5 minutes per key, enforced by Companies House
 * with a 429 for the rest of the window and bans for applications that keep
 * exceeding it. Every request goes through a limiter supplied by the caller
 * (a database-backed counter shared by every serverless instance in
 * production), and requests are sent with low concurrency.
 */

export type CompanyHit = {
  businessName: string;
  /** The registered name, exactly as Companies House holds it. */
  legalName: string;
  companyNumber: string;
  /** e.g. "ltd", "llp", "plc", "limited-partnership" — Companies House codes. */
  companyType: string;
  companyStatus: string;
  sicCodes: string[];
  incorporatedOn: string;
  address: string;
  town: string;
  postcode: string;
  lat: number | "";
  lng: number | "";
  notes: string;
};

export type CompanyProfile = {
  companyNumber: string;
  legalName: string;
  companyType: string;
  companyStatus: string;
  sicCodes: string[];
  incorporatedOn: string;
  dissolvedOn: string;
  address: string;
  postcode: string;
  /** Whether the company's filings are overdue — a small signal of activity. */
  accountsOverdue: boolean;
};

export type CompanyOfficer = {
  name: string;
  role: string;
  appointedOn: string;
};

export const CH_API_BASE = "https://api.company-information.service.gov.uk";
/** Companies House's own limit: 600 requests per 5-minute window, per key. */
export const CH_RATE_LIMIT = { requests: 600, windowSeconds: 300 } as const;
/** What this app allows itself — headroom under the real limit for bursts and other callers. */
export const CH_SAFE_BUDGET = 450;
const CH_CONCURRENCY = 3;
const EARTH_MILES = 3958.8;
const USER_AGENT = "PeakSwiftLeads/1.0 (+https://peak-swift-leads.vercel.app)";

/**
 * Bounded calls per discovery run: one advanced search per nearby town (SIC
 * codes are sent together in one request) plus a few name searches.
 */
const MAX_REQUESTS_PER_SEARCH = 14;

const SKIP_STATUS = /dissolved|liquidation|administration|converted|closed|receivership|insolvency|removed|wound.?up/i;

/** Company types that are never a small local business worth prospecting. */
const SKIP_TYPES = new Set([
  "charitable-incorporated-organisation",
  "scottish-charitable-incorporated-organisation",
  "industrial-and-provident-society",
  "registered-society-non-jurisdictional",
  "uk-establishment",
  "oversea-company",
  "royal-charter",
  "investment-company-with-variable-capital",
  "protected-cell-company",
  "assurance-company",
  "registered-overseas-entity",
]);

const REJECT_NAME =
  /\b(consultant|consultancy|consultants|management|advisory|holdings|society|church|museum|community|charity|academy|gymnastics|taxi|accountan|tourist|bearings|removal|residents|rtm company|men'?s shed|baptist|housing association|trustees?|nominees?|investments?|properties limited|property holdings)\b/i;

type TradeSpec = {
  /** Words for the name search (trades without a reliable SIC code). */
  queries: string[];
  /** Name tokens that confirm a name-search hit is in the trade. */
  tokens: string[];
  /** UK SIC 2007 codes for the advanced search. Empty = name search only. */
  sic: string[];
};

/**
 * Trades → UK SIC 2007 codes. Only codes that name the trade itself: a broad
 * code ("other specialised construction") would return every builder for a
 * roofing search. Where no code fits, the name search is used instead.
 */
const TRADE_SPECS: Array<{ match: RegExp; spec: TradeSpec }> = [
  {
    match: /join|carpent|cabinet/,
    spec: {
      queries: ["joinery", "joiners", "carpentry"],
      tokens: ["joinery", "joiner", "joiners", "carpenter", "carpentry", "cabinet"],
      sic: ["43320", "16230"],
    },
  },
  { match: /plumb|heating|gas engineer/, spec: { queries: ["plumbing", "heating"], tokens: ["plumbing", "plumber", "plumbers", "heating"], sic: ["43220"] } },
  { match: /electric/, spec: { queries: ["electrical", "electricians"], tokens: ["electrical", "electrician", "electricians", "electrics"], sic: ["43210"] } },
  { match: /roof/, spec: { queries: ["roofing", "roofers"], tokens: ["roofing", "roofer", "roofers"], sic: ["43910"] } },
  {
    match: /build/,
    spec: { queries: ["builders", "construction"], tokens: ["construction", "builder", "builders", "building"], sic: ["41202", "41201"] },
  },
  { match: /plaster/, spec: { queries: ["plastering"], tokens: ["plastering", "plasterer", "plasterers"], sic: ["43310"] } },
  { match: /paint|decorat/, spec: { queries: ["decorators", "painters"], tokens: ["decorator", "decorators", "painter", "painters", "decorating"], sic: ["43341"] } },
  { match: /tile|tiler|floor/, spec: { queries: ["flooring", "tiling"], tokens: ["tiling", "tiler", "tilers", "flooring", "floorer"], sic: ["43330"] } },
  { match: /glaz|window/, spec: { queries: ["glazing", "windows"], tokens: ["glazing", "glazier", "windows"], sic: ["43342"] } },
  { match: /landscap|garden/, spec: { queries: ["landscaping", "gardening"], tokens: ["landscaping", "landscaper", "landscapes", "gardener", "gardeners", "gardening"], sic: ["81300"] } },
  { match: /tree|arbor/, spec: { queries: ["tree surgeons", "arborist"], tokens: ["arborist", "arboriculture", "tree"], sic: [] } },
  { match: /clean/, spec: { queries: ["cleaning", "cleaners"], tokens: ["cleaning", "cleaner", "cleaners"], sic: ["81210", "81229"] } },
  { match: /mechan|garage|mot\b|car repair/, spec: { queries: ["motors", "garage"], tokens: ["mechanic", "mechanics", "motors", "garage", "autos"], sic: ["45200"] } },
  { match: /barber/, spec: { queries: ["barbers"], tokens: ["barber", "barbers"], sic: ["96020"] } },
  { match: /hair|salon/, spec: { queries: ["hair", "salon"], tokens: ["hairdresser", "hairdressers", "hair", "salon"], sic: ["96020"] } },
  { match: /beaut|nail/, spec: { queries: ["beauty"], tokens: ["beauty", "beautician", "aesthetics", "nails"], sic: ["96020"] } },
  { match: /restaurant/, spec: { queries: ["restaurant"], tokens: ["restaurant", "restaurants", "kitchen", "bistro"], sic: ["56101"] } },
  { match: /cafe|café|coffee/, spec: { queries: ["cafe", "coffee"], tokens: ["cafe", "café", "coffee"], sic: ["56102"] } },
  { match: /takeaway|fast food/, spec: { queries: ["takeaway"], tokens: ["takeaway", "fish", "pizza", "kebab"], sic: ["56103"] } },
  { match: /\bpub\b|\bbar\b|inn\b/, spec: { queries: ["inn", "bar"], tokens: ["inn", "bar", "tavern", "arms"], sic: ["56302"] } },
  { match: /hotel|b&b|bed and breakfast|guest ?house/, spec: { queries: ["hotel", "guest house"], tokens: ["hotel", "guest", "lodge", "house"], sic: ["55100", "55201"] } },
  { match: /\bgym\b|fitness|personal train/, spec: { queries: ["fitness"], tokens: ["fitness", "gym", "training"], sic: ["93130"] } },
  { match: /dentist|dental/, spec: { queries: ["dental"], tokens: ["dental", "dentist", "dentistry"], sic: ["86230"] } },
  { match: /physio|chiropract|osteopath/, spec: { queries: ["physiotherapy"], tokens: ["physio", "physiotherapy", "chiropractic", "osteopathy", "osteopath"], sic: ["86900"] } },
  { match: /account|bookkeep/, spec: { queries: ["accountants", "bookkeeping"], tokens: ["accountants", "accountancy", "accounting", "bookkeeping"], sic: ["69201", "69202"] } },
  { match: /solicitor|law firm|lawyer/, spec: { queries: ["solicitors"], tokens: ["solicitors", "law", "legal"], sic: ["69102"] } },
  { match: /estate agent|letting/, spec: { queries: ["estate agents", "lettings"], tokens: ["estate", "lettings", "property"], sic: ["68310"] } },
  { match: /vet/, spec: { queries: ["veterinary"], tokens: ["veterinary", "vets", "vet"], sic: ["75000"] } },
  { match: /photograph/, spec: { queries: ["photography"], tokens: ["photography", "photographer", "photographic"], sic: ["74201", "74209"] } },
  { match: /florist|flower/, spec: { queries: ["florist", "flowers"], tokens: ["florist", "flowers", "floral"], sic: ["47760"] } },
  { match: /architect/, spec: { queries: ["architects"], tokens: ["architects", "architecture", "architectural"], sic: ["71111"] } },
  { match: /driving/, spec: { queries: ["driving school"], tokens: ["driving", "school"], sic: ["85530"] } },
];

export function foldTrade(value: string): string {
  return value.trim().toLowerCase();
}

export function specForTrade(trade: string): TradeSpec {
  const key = foldTrade(trade);
  const found = TRADE_SPECS.find((entry) => entry.match.test(key));
  if (found) return found.spec;
  const word = key.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)[0] || "";
  return word.length >= 3 ? { queries: [word], tokens: [word], sic: [] } : { queries: [], tokens: [], sic: [] };
}

export function nameMatchesTrade(name: string, tokens: string[]): boolean {
  const key = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return tokens.some((token) => key.includes(` ${token} `));
}

export function isRejectedCompanyName(name: string): boolean {
  return REJECT_NAME.test(name);
}

export function isActiveCompany(status: string, companyType = ""): boolean {
  const st = status.trim().toLowerCase();
  if (SKIP_STATUS.test(st)) return false;
  if (SKIP_TYPES.has(companyType.trim().toLowerCase())) return false;
  return !st || st === "active" || st === "open";
}

export function displayCompanyName(name: string): string {
  const stripped = name
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+\b(LIMITED|LTD|L\.?T\.?D\.?|PLC|LLP|CIC)\b\.?$/i, "")
    .trim();
  return stripped
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/^\(.*\)$/.test(word)) {
        const inner = word.slice(1, -1);
        return `(${titleWord(inner)})`;
      }
      return titleWord(word);
    })
    .join(" ");
}

function titleWord(word: string): string {
  if (word.length <= 3 && /^[A-Z0-9&]+$/i.test(word)) return word.toUpperCase();
  if (/^[A-Z0-9]&[A-Z0-9]$/i.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

export function extractUkPostcode(address: string): string {
  const match = address.toUpperCase().match(UK_POSTCODE);
  return match ? `${match[1]} ${match[2]}` : "";
}

function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

type ChAddress = {
  premises?: string;
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

function addressParts(addr: ChAddress | undefined, snippet = "") {
  const a = addr ?? {};
  const postcode = asText(a.postal_code) || extractUkPostcode(snippet);
  const town = asText(a.locality) || asText(a.address_line_2) || asText(a.region);
  const address =
    snippet ||
    [asText(a.premises), asText(a.address_line_1), asText(a.address_line_2), town, postcode].filter(Boolean).join(", ");
  return { postcode, town, address };
}

function hitFrom(fields: {
  name: string;
  number: string;
  status: string;
  type: string;
  sic: unknown;
  created: unknown;
  address: ChAddress | undefined;
  snippet?: string;
}): CompanyHit | null {
  if (fields.name.length < 3 || !fields.number) return null;
  if (!isActiveCompany(fields.status, fields.type)) return null;
  const { postcode, town, address } = addressParts(fields.address, fields.snippet ?? "");
  return {
    businessName: displayCompanyName(fields.name),
    legalName: fields.name,
    companyNumber: fields.number,
    companyType: fields.type,
    companyStatus: fields.status || "active",
    sicCodes: Array.isArray(fields.sic) ? fields.sic.map(asText).filter(Boolean) : [],
    incorporatedOn: asText(fields.created),
    address,
    town,
    postcode,
    lat: "",
    lng: "",
    notes: `Companies House ${fields.number}${fields.type ? ` (${fields.type})` : ""}`,
  };
}

/** `GET /search/companies` — the name search. */
export function parseCompaniesHouseJson(payload: unknown): CompanyHit[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const hits: CompanyHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const hit = hitFrom({
      name: asText(item.title),
      number: asText(item.company_number),
      status: asText(item.company_status),
      type: asText(item.company_type),
      sic: undefined,
      created: item.date_of_creation,
      address: item.address as ChAddress | undefined,
      snippet: asText(item.address_snippet),
    });
    if (hit) hits.push(hit);
  }
  return hits;
}

/** `GET /advanced-search/companies` — by SIC code and location. */
export function parseAdvancedSearch(payload: unknown): CompanyHit[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const hits: CompanyHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const hit = hitFrom({
      name: asText(item.company_name),
      number: asText(item.company_number),
      status: asText(item.company_status),
      type: asText(item.company_type),
      sic: item.sic_codes,
      created: item.date_of_creation,
      address: item.registered_office_address as ChAddress | undefined,
    });
    if (hit) hits.push(hit);
  }
  return hits;
}

/** `GET /company/{number}`. */
export function parseCompanyProfile(payload: unknown): CompanyProfile | null {
  if (!payload || typeof payload !== "object") return null;
  const item = payload as Record<string, unknown>;
  const number = asText(item.company_number);
  if (!number) return null;
  const { postcode, address } = addressParts(item.registered_office_address as ChAddress | undefined);
  const accounts = (item.accounts ?? {}) as { overdue?: unknown };
  return {
    companyNumber: number,
    legalName: asText(item.company_name),
    companyType: asText(item.type),
    companyStatus: asText(item.company_status),
    sicCodes: Array.isArray(item.sic_codes) ? item.sic_codes.map(asText).filter(Boolean) : [],
    incorporatedOn: asText(item.date_of_creation),
    dissolvedOn: asText(item.date_of_cessation),
    address,
    postcode,
    accountsOverdue: accounts.overdue === true,
  };
}

/**
 * `GET /company/{number}/officers` — current directors and members only.
 *
 * Only the name, role and appointment date are kept: enough to ask for a person
 * on a call. Dates of birth, nationality and addresses are deliberately dropped.
 */
export function parseOfficers(payload: unknown): CompanyOfficer[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const officers: CompanyOfficer[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (asText(item.resigned_on)) continue;
    const role = asText(item.officer_role);
    if (!/director|member|partner/i.test(role)) continue;
    const name = asText(item.name);
    if (!name) continue;
    officers.push({ name: personName(name), role, appointedOn: asText(item.appointed_on) });
  }
  return officers.slice(0, 6);
}

/** "SMITH, John Andrew" → "John Andrew Smith". */
export function personName(registered: string): string {
  const [surname, given] = registered.split(",").map((part) => part.trim());
  if (!given) return titleCase(registered);
  return `${titleCase(given)} ${titleCase(surname ?? "")}`.trim();
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("");
}

/** Name-search queries for a trade across a ring of towns (bounded). */
export function chSearchQueries(trade: string, towns: string[]): string[] {
  const spec = specForTrade(trade);
  const queries: string[] = [];
  const uniqueTowns = [...new Set(towns.map((town) => town.trim()).filter((town) => town.length >= 2))];
  const primary = spec.queries[0];
  for (const [index, town] of uniqueTowns.entries()) {
    const words = index === 0 ? spec.queries : primary ? [primary] : [];
    for (const word of words) {
      queries.push(`${word} ${town}`);
      if (queries.length >= MAX_REQUESTS_PER_SEARCH) return queries;
    }
  }
  return queries;
}

function keepHit(hit: CompanyHit, spec: TradeSpec, bySic: boolean): boolean {
  if (isRejectedCompanyName(hit.legalName || hit.businessName)) return false;
  if (/\bconstruction consultants?\b|\bconstruction management\b/i.test(hit.businessName)) return false;
  // A SIC-code hit is in the trade by its own filing; a name hit must say so.
  return bySic ? true : nameMatchesTrade(hit.businessName, spec.tokens);
}

export function filterCompanyHits(hits: CompanyHit[], trade: string, bySic = false): CompanyHit[] {
  const spec = specForTrade(trade);
  if (!bySic && spec.tokens.length === 0) return [];
  const seen = new Set<string>();
  const next: CompanyHit[] = [];
  for (const hit of hits) {
    if (!keepHit(hit, spec, bySic)) continue;
    const key = hit.companyNumber || hit.businessName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(hit);
  }
  return next;
}

export function hitInArea(
  hit: CompanyHit,
  center: { lat: number; lng: number },
  radiusMiles: number,
  nearbyTowns: string[],
  searchTown: string,
): boolean {
  if (typeof hit.lat === "number" && typeof hit.lng === "number") {
    return milesBetween(center, { lat: hit.lat, lng: hit.lng }) <= radiusMiles + 2;
  }
  const blob = `${hit.town} ${hit.address} ${hit.businessName}`.toLowerCase();
  const names = [searchTown, ...nearbyTowns].map((town) => town.trim().toLowerCase()).filter(Boolean);
  return names.some((town) => town.length >= 3 && blob.includes(town));
}

// ── Transport ────────────────────────────────────────────────────────────────

/** Asks for permission to spend `n` requests; false = over budget this window. */
export type ChLimiter = (n: number) => Promise<boolean>;

export type ChClientOptions = {
  apiKey?: string;
  limiter?: ChLimiter;
  fetchImpl?: typeof fetch;
  base?: string;
  timeoutMs?: number;
};

export type ChResponse = { ok: true; json: unknown } | { ok: false; status: number; error: string; kind: "no-key" | "rate-limited" | "not-found" | "http" | "network" | "budget" };

export function companiesHouseKey(): string {
  return (process.env.COMPANIES_HOUSE_API_KEY ?? "").trim().replace(/^["']+|["']+$/g, "");
}

/** A per-process limiter: the fallback when no shared counter is supplied (tests, scripts). */
export function memoryLimiter(budget = CH_SAFE_BUDGET, windowSeconds: number = CH_RATE_LIMIT.windowSeconds): ChLimiter {
  let windowStart = 0;
  let used = 0;
  return async (n: number) => {
    const now = Date.now();
    if (now - windowStart >= windowSeconds * 1000) {
      windowStart = now;
      used = 0;
    }
    if (used + n > budget) return false;
    used += n;
    return true;
  };
}

const defaultLimiter = memoryLimiter();

export async function chGet(path: string, params: Record<string, string>, options: ChClientOptions = {}): Promise<ChResponse> {
  const apiKey = options.apiKey ?? companiesHouseKey();
  if (!apiKey) {
    return { ok: false, status: 0, kind: "no-key", error: "Companies House is off — set COMPANIES_HOUSE_API_KEY (free key from developer.company-information.service.gov.uk)." };
  }
  const limiter = options.limiter ?? defaultLimiter;
  if (!(await limiter(1))) {
    return { ok: false, status: 0, kind: "budget", error: "Companies House request budget for this 5-minute window is used up. Try again shortly." };
  }
  const query = new URLSearchParams(params).toString();
  const url = `${(options.base ?? CH_API_BASE).replace(/\/+$/, "")}${path}${query ? `?${query}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "User-Agent": USER_AGENT,
      },
    });
    if (response.status === 429) return { ok: false, status: 429, kind: "rate-limited", error: "Companies House rate limit reached. Try again in a few minutes." };
    if (response.status === 404) return { ok: false, status: 404, kind: "not-found", error: "Not found at Companies House." };
    if (response.status === 401) return { ok: false, status: 401, kind: "http", error: "Companies House rejected the API key (401). Check COMPANIES_HOUSE_API_KEY." };
    if (!response.ok) return { ok: false, status: response.status, kind: "http", error: `Companies House HTTP ${response.status}` };
    return { ok: true, json: await response.json() };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, status: 0, kind: "network", error: aborted ? "Companies House timed out" : error instanceof Error ? error.message : "Companies House failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** Run tasks with at most `limit` in flight — never a burst that invites a ban. */
async function pooled<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function getCompanyProfile(number: string, options: ChClientOptions = {}): Promise<{ profile: CompanyProfile | null; error?: string; kind?: string }> {
  const answer = await chGet(`/company/${encodeURIComponent(number.trim().toUpperCase())}`, {}, options);
  if (!answer.ok) return { profile: null, error: answer.error, kind: answer.kind };
  return { profile: parseCompanyProfile(answer.json) };
}

export async function getCompanyOfficers(number: string, options: ChClientOptions = {}): Promise<{ officers: CompanyOfficer[]; error?: string }> {
  const answer = await chGet(`/company/${encodeURIComponent(number.trim().toUpperCase())}/officers`, { items_per_page: "35" }, options);
  if (!answer.ok) return { officers: [], error: answer.error };
  return { officers: parseOfficers(answer.json) };
}

/** Name search at Companies House (for matching a business found elsewhere). */
export async function searchCompanyByName(name: string, options: ChClientOptions = {}): Promise<{ hits: CompanyHit[]; error?: string }> {
  const answer = await chGet("/search/companies", { q: name, items_per_page: "10" }, options);
  if (!answer.ok) return { hits: [], error: answer.error };
  return { hits: parseCompaniesHouseJson(answer.json) };
}

async function geocodePostcodes(postcodes: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, { lat: number; lng: number }>> {
  const unique = [...new Set(postcodes.map((code) => code.toUpperCase()).filter(Boolean))].slice(0, 100);
  const map = new Map<string, { lat: number; lng: number }>();
  if (unique.length === 0) return map;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetchImpl("https://api.postcodes.io/postcodes", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ postcodes: unique }),
    });
    if (!response.ok) return map;
    const payload = (await response.json()) as {
      result?: Array<{ query?: string; result?: { latitude?: number; longitude?: number } | null }>;
    };
    for (const row of payload.result ?? []) {
      const lat = row.result?.latitude;
      const lng = row.result?.longitude;
      if (typeof lat === "number" && typeof lng === "number" && row.query) {
        map.set(row.query.toUpperCase(), { lat, lng });
      }
    }
  } catch {
    // Radius filter falls back to town-name matching.
  } finally {
    clearTimeout(timer);
  }
  return map;
}

export type ChSearchResult = { hits: CompanyHit[]; error?: string; disabled?: boolean; requests: number };

/**
 * Companies in a trade near a place.
 *
 * SIC-coded trades use the advanced search (`sic_codes` + `location`, one
 * request per town); others fall back to the name search. Either way a hit
 * must be active, of a real trading company type, and in the area — by
 * postcode distance where postcodes.io can place it, by town name otherwise.
 */
export async function searchCompaniesHouse(
  options: {
    trade: string;
    location: string;
    towns: string[];
    center: { lat: number; lng: number };
    radiusMiles: number;
    limit: number;
  },
  client: ChClientOptions = {},
): Promise<ChSearchResult> {
  const apiKey = client.apiKey ?? companiesHouseKey();
  if (!apiKey) {
    return { hits: [], disabled: true, requests: 0, error: "Companies House is off — set COMPANIES_HOUSE_API_KEY." };
  }
  const spec = specForTrade(options.trade);
  const towns = [...new Set([options.location, ...options.towns].map((town) => town.trim()).filter((town) => town.length >= 2))];
  const bySic = spec.sic.length > 0;

  const requests: Array<{ path: string; params: Record<string, string> }> = bySic
    ? towns.slice(0, MAX_REQUESTS_PER_SEARCH).map((town) => ({
        path: "/advanced-search/companies",
        params: { sic_codes: spec.sic.join(","), location: town, company_status: "active", size: "100" },
      }))
    : chSearchQueries(options.trade, towns).map((q) => ({ path: "/search/companies", params: { q, items_per_page: "50" } }));
  if (requests.length === 0) return { hits: [], requests: 0 };

  const answers = await pooled(requests, CH_CONCURRENCY, (request) => chGet(request.path, request.params, { ...client, apiKey }));
  const errors = answers.filter((answer): answer is Extract<ChResponse, { ok: false }> => !answer.ok && answer.kind !== "not-found");
  const raw = answers.flatMap((answer) => (answer.ok ? (bySic ? parseAdvancedSearch(answer.json) : parseCompaniesHouseJson(answer.json)) : []));
  const merged = filterCompanyHits(raw, options.trade, bySic);

  const geo = await geocodePostcodes(merged.map((hit) => hit.postcode).filter(Boolean), client.fetchImpl ?? fetch);
  for (const hit of merged) {
    const point = hit.postcode ? geo.get(hit.postcode.toUpperCase()) : undefined;
    if (point) {
      hit.lat = point.lat;
      hit.lng = point.lng;
    }
  }

  const inArea = merged.filter((hit) => hitInArea(hit, options.center, options.radiusMiles, options.towns, options.location));
  const ranked = inArea.sort((a, b) => {
    const dist = (hit: CompanyHit) =>
      typeof hit.lat === "number" && typeof hit.lng === "number" ? milesBetween(options.center, { lat: hit.lat, lng: hit.lng }) : Number.POSITIVE_INFINITY;
    return dist(a) - dist(b);
  });

  const allFailed = errors.length === answers.length;
  return {
    hits: ranked.slice(0, Math.max(options.limit, 20)),
    requests: requests.length,
    error: allFailed ? errors[0]?.error : ranked.length === 0 && errors.length ? errors[0]?.error : undefined,
  };
}
