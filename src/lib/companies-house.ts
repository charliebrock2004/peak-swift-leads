/**
 * Free UK company discovery via the public Companies House search pages.
 * No API key. Used for trades OSM barely maps (joiners, plumbers, builders).
 */

export type CompanyHit = {
  businessName: string;
  companyNumber: string;
  address: string;
  town: string;
  postcode: string;
  lat: number | "";
  lng: number | "";
  notes: string;
};

const USER_AGENT = "PeakSwiftLeads/1.0 (https://peak-swift-leads.vercel.app)";
const CH_SEARCH = "https://find-and-update.company-information.service.gov.uk/search/companies";
const EARTH_MILES = 3958.8;
const MAX_QUERIES = 4;

const SKIP_STATUS = /dissolved|liquidation|administration|converted|closed|receivership|insolvency|removed|wound.?up/i;

const SKIP_TYPES = new Set([
  "charitable-incorporated-organisation",
  "scottish-charitable-incorporated-organisation",
  "industrial-and-provident-society",
  "registered-society-non-jurisdictional",
  "uk-establishment",
  "oversea-company",
  "royal-charter",
]);

const REJECT_NAME =
  /\b(consultant|consultancy|consultants|management|advisory|holdings|society|church|museum|community|charity|academy|gymnastics|taxi|accountan|tourist|bearings|removal|residents|rtm company|men'?s shed|baptist|housing association)\b/i;

type TradeSpec = {
  queries: string[];
  tokens: string[];
};

const TRADE_SPECS: Array<{ match: RegExp; spec: TradeSpec }> = [
  { match: /join|carpent/, spec: { queries: ["joinery"], tokens: ["joinery", "joiner", "joiners", "carpenter", "carpentry"] } },
  { match: /plumb/, spec: { queries: ["plumbing"], tokens: ["plumbing", "plumber", "plumbers"] } },
  { match: /electric/, spec: { queries: ["electrical"], tokens: ["electrical", "electrician", "electricians"] } },
  {
    match: /build/,
    spec: { queries: ["construction", "builders"], tokens: ["construction", "builder", "builders"] },
  },
  { match: /roof/, spec: { queries: ["roofing"], tokens: ["roofing", "roofer", "roofers"] } },
  { match: /paint|decorat/, spec: { queries: ["decorator", "painter"], tokens: ["decorator", "decorators", "painter", "painters", "decorating"] } },
  { match: /landscap|garden/, spec: { queries: ["landscaping", "gardener"], tokens: ["landscaping", "landscaper", "gardener", "gardeners"] } },
  { match: /tree/, spec: { queries: ["arborist"], tokens: ["arborist", "tree surgeon", "treesurgeon"] } },
  { match: /clean/, spec: { queries: ["cleaning"], tokens: ["cleaning", "cleaner", "cleaners"] } },
  { match: /mechan/, spec: { queries: ["mechanic"], tokens: ["mechanic", "mechanics"] } },
  { match: /barber/, spec: { queries: ["barber"], tokens: ["barber", "barbers"] } },
  { match: /hair/, spec: { queries: ["hairdresser"], tokens: ["hairdresser", "hairdressers", "salon"] } },
  { match: /restaurant/, spec: { queries: ["restaurant"], tokens: ["restaurant", "restaurants"] } },
  { match: /cafe|café/, spec: { queries: ["cafe"], tokens: ["cafe", "café"] } },
];

export function foldTrade(value: string): string {
  return value.trim().toLowerCase();
}

export function specForTrade(trade: string): TradeSpec {
  const key = foldTrade(trade);
  const found = TRADE_SPECS.find((entry) => entry.match.test(key));
  if (found) return found.spec;
  const word = key.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)[0] || "";
  return word.length >= 3 ? { queries: [word], tokens: [word] } : { queries: [], tokens: [] };
}

export function nameMatchesTrade(name: string, tokens: string[]): boolean {
  const key = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return tokens.some((token) => key.includes(` ${token} `));
}

export function isRejectedCompanyName(name: string): boolean {
  return REJECT_NAME.test(name);
}

export function isActiveCompany(status: string, companyType = "", companyNumber = ""): boolean {
  const st = status.trim().toLowerCase();
  if (SKIP_STATUS.test(status)) return false;
  if (SKIP_TYPES.has(companyType.trim().toLowerCase())) return false;
  if (/^(CS|SP|SL|IP|SO|RS|CE)/i.test(companyNumber.trim())) return false;
  if (!st) return true;
  // JSON uses a single token (active/dissolved). HTML crumbtrails are sentences.
  if (!/[\s]/.test(st) && st !== "active" && st !== "open") return false;
  return true;
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

export const UK_POSTCODE =
  /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

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

type ChJsonItem = {
  title?: string;
  company_number?: string;
  company_status?: string;
  company_type?: string;
  address_snippet?: string;
  description?: string;
  address?: {
    premises?: string;
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
};

export function parseCompaniesHouseJson(payload: unknown): CompanyHit[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  const hits: CompanyHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as ChJsonItem;
    const name = asText(item.title);
    const number = asText(item.company_number);
    if (name.length < 3 || !number) continue;
    if (!isActiveCompany(asText(item.company_status), asText(item.company_type), number)) continue;
    const addr = item.address ?? {};
    const postcode = asText(addr.postal_code) || extractUkPostcode(asText(item.address_snippet));
    const town = asText(addr.locality) || asText(addr.address_line_2) || asText(addr.region);
    const address =
      asText(item.address_snippet) ||
      [asText(addr.premises), asText(addr.address_line_1), asText(addr.address_line_2), town, postcode]
        .filter(Boolean)
        .join(", ");
    hits.push({
      businessName: displayCompanyName(name),
      companyNumber: number,
      address,
      town,
      postcode,
      lat: "",
      lng: "",
      notes: `Companies House ${number}`,
    });
  }
  return hits;
}

const LI = /<li class="type-company">([\s\S]*?)<\/li>/g;
const HREF = /href="\/company\/([A-Z0-9]+)"[^>]*>\s*([\s\S]*?)\s*<\/a>/;
const META = /class="meta crumbtrail">\s*([\s\S]*?)\s*<\/p>/;
const PARA = /<p>([^<]+)<\/p>/g;

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function parseCompaniesHouseHtml(html: string): CompanyHit[] {
  const hits: CompanyHit[] = [];
  for (const blockMatch of html.matchAll(LI)) {
    const block = blockMatch[1] ?? "";
    const href = block.match(HREF);
    if (!href) continue;
    const number = href[1] ?? "";
    const name = stripTags(href[2] ?? "");
    const meta = stripTags((block.match(META)?.[1] ?? "").replace(/<[^>]+>/g, " "));
    if (!isActiveCompany(meta, "", number)) continue;
    const paragraphs = [...block.matchAll(PARA)].map((row) => stripTags(row[1] ?? "")).filter(Boolean);
    const address = paragraphs[paragraphs.length - 1] ?? "";
    const postcode = extractUkPostcode(address);
    const town = address
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && !UK_POSTCODE.test(part))
      .filter((part) => !/^(Scotland|United Kingdom|England|Wales|Northern Ireland)$/i.test(part))
      .filter((part) => !/\b(and kinross|city of|council)\b/i.test(part))
      .slice(-1)[0] ?? "";
    if (name.length < 3) continue;
    hits.push({
      businessName: displayCompanyName(name),
      companyNumber: number,
      address,
      town,
      postcode,
      lat: "",
      lng: "",
      notes: `Companies House ${number}`,
    });
  }
  return hits;
}

export function chSearchQueries(trade: string, towns: string[]): string[] {
  const spec = specForTrade(trade);
  const queries: string[] = [];
  const uniqueTowns = [...new Set(towns.map((town) => town.trim()).filter((town) => town.length >= 2))];
  for (const word of spec.queries) {
    for (const town of uniqueTowns) {
      queries.push(`${word} ${town}`);
      if (queries.length >= MAX_QUERIES) return queries;
    }
  }
  return queries;
}

function keepHit(hit: CompanyHit, tokens: string[]): boolean {
  if (isRejectedCompanyName(hit.businessName)) return false;
  if (/\bconstruction consultants?\b|\bconstruction management\b/i.test(hit.businessName)) return false;
  return nameMatchesTrade(hit.businessName, tokens);
}

export function filterCompanyHits(hits: CompanyHit[], trade: string): CompanyHit[] {
  const tokens = specForTrade(trade).tokens;
  if (tokens.length === 0) return [];
  const seen = new Set<string>();
  const next: CompanyHit[] = [];
  for (const hit of hits) {
    if (!keepHit(hit, tokens)) continue;
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

async function fetchCh(query: string): Promise<{ hits: CompanyHit[]; error?: string }> {
  const url = `${CH_SEARCH}?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/html;q=0.8",
        "User-Agent": USER_AGENT,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      return { hits: [], error: `Companies House HTTP ${response.status}` };
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json") || text.startsWith("{")) {
      try {
        return { hits: parseCompaniesHouseJson(JSON.parse(text)) };
      } catch {
        return { hits: parseCompaniesHouseHtml(text) };
      }
    }
    return { hits: parseCompaniesHouseHtml(text) };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      hits: [],
      error: aborted ? "Companies House timed out" : error instanceof Error ? error.message : "Companies House failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function geocodePostcodes(postcodes: string[]): Promise<Map<string, { lat: number; lng: number }>> {
  const unique = [...new Set(postcodes.map((code) => code.toUpperCase()).filter(Boolean))].slice(0, 100);
  const map = new Map<string, { lat: number; lng: number }>();
  if (unique.length === 0) return map;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch("https://api.postcodes.io/postcodes", {
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

export async function searchCompaniesHouse(options: {
  trade: string;
  location: string;
  towns: string[];
  center: { lat: number; lng: number };
  radiusMiles: number;
  limit: number;
}): Promise<{ hits: CompanyHit[]; error?: string }> {
  const spec = specForTrade(options.trade);
  if (spec.queries.length === 0) return { hits: [] };

  const queries = chSearchQueries(options.trade, options.towns);
  if (queries.length === 0) return { hits: [] };

  const results = await Promise.all(queries.map((query) => fetchCh(query)));
  const errors = results.map((row) => row.error).filter(Boolean) as string[];
  const merged = filterCompanyHits(
    results.flatMap((row) => row.hits),
    options.trade,
  );

  const geo = await geocodePostcodes(merged.map((hit) => hit.postcode).filter(Boolean));
  for (const hit of merged) {
    const point = hit.postcode ? geo.get(hit.postcode.toUpperCase()) : undefined;
    if (point) {
      hit.lat = point.lat;
      hit.lng = point.lng;
    }
  }

  const nearby = options.towns;
  const inArea = merged.filter((hit) =>
    hitInArea(hit, options.center, options.radiusMiles, nearby, options.location),
  );

  const ranked = inArea.sort((a, b) => {
    const dist = (hit: CompanyHit) =>
      typeof hit.lat === "number" && typeof hit.lng === "number"
        ? milesBetween(options.center, { lat: hit.lat, lng: hit.lng })
        : Number.POSITIVE_INFINITY;
    return dist(a) - dist(b);
  });

  if (ranked.length === 0 && errors.length === results.length) {
    return { hits: [], error: errors[0] };
  }
  return { hits: ranked.slice(0, Math.max(options.limit, 20)), error: ranked.length === 0 ? errors[0] : undefined };
}
