/**
 * Public web search, as a pluggable source of business websites.
 *
 * Domain guessing only reaches businesses whose domain resembles their name.
 * A salon trading as "Salon T.Elle" at `perthhairstudio.co.uk` is invisible to
 * it, and that is most of the leads a real run turns up. Search is how you find
 * those — but only through a provider's own API. Scraping a results page is
 * against every major engine's terms and breaks the moment they change markup,
 * so this module talks to APIs or does nothing at all.
 *
 * Pure: no network, no keys. It builds the queries, normalises whatever a
 * provider returns, and decides which results are worth fetching. The server
 * makes the call, because the key must never reach a browser.
 *
 * With no key configured the whole layer reports itself unavailable and the
 * existing discovery path runs unchanged. Search is an upgrade, not a
 * dependency.
 */

/** Providers this app knows how to talk to, in the order they are preferred. */
export const SEARCH_PROVIDERS = ["tavily", "brave", "bing"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

export type SearchResult = {
  title: string;
  url: string;
  /** The provider's snippet. Often carries the address or phone number. */
  snippet: string;
  /**
   * The page's extracted text, when the provider returns it.
   *
   * Tavily does; Brave and Bing do not. It matters more than it sounds: the
   * provider has already fetched the page, so an address published there can be
   * read without spending one of our own page budget on it — and on a site that
   * blocks our crawler but not theirs, it is the only way we will ever see it.
   * Still an address observed in a fetched public source, which is the rule.
   */
  rawContent?: string;
};

export type SearchQuery = {
  text: string;
  /** What this query is trying to establish, for the evidence trail. */
  intent: "website" | "contact" | "email";
  /**
   * How specific this query is, 0–100.
   *
   * A postcode or a phone number pins one business; a name and a town pin one
   * business in most towns; a name and a trade pin a category. The waterfall
   * runs them strongest first and stops as soon as something is verified, so
   * the weak ones usually cost nothing at all.
   */
  strength: number;
};

export type BusinessIdentity = {
  businessName: string;
  town: string;
  trade: string;
  phone: string;
  address: string;
};

/**
 * How many searches one lead may ever cost.
 *
 * Search APIs are billed per call and rate limited. The waterfall almost never
 * reaches this: it stops the moment a candidate is verified, so a business
 * whose site is findable on the first query costs exactly one call. This is the
 * ceiling for the hard cases, not the expected spend.
 */
export const MAX_SEARCHES_PER_LEAD = 5;

/**
 * Extra searches, after a crawl found no address, looking specifically for a
 * published email. One is enough: these queries are expensive and the
 * identity check still has to pass.
 */
export const MAX_EMAIL_SEARCHES = 1;

/** Results worth fetching from one query. */
export const MAX_RESULTS_PER_QUERY = 5;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Suffixes that add nothing to a search and cost specificity. */
const NAME_NOISE = /\b(ltd|limited|llp|plc|cic|co|company|the)\b/gi;

/**
 * Alternative spellings of a trading name worth searching.
 *
 * A business registered as "Smith & Sons Joinery Ltd" trades as "Smith and
 * Sons", and a search for one does not reliably return the other. These are
 * spellings of the same name, never a different business.
 */
export function nameVariations(businessName: string): string[] {
  const base = clean(businessName);
  if (!base) return [];
  const out: string[] = [base];
  const add = (value: string) => {
    const next = clean(value);
    if (next.length >= 3 && !out.some((entry) => entry.toLowerCase() === next.toLowerCase())) {
      out.push(next);
    }
  };
  // Ltd/Limited and similar carry no search value and split the results.
  add(base.replace(NAME_NOISE, " "));
  if (/&/.test(base)) add(base.replace(/&/g, "and"));
  else if (/\band\b/i.test(base)) add(base.replace(/\band\b/gi, "&"));
  if (/['’]/.test(base)) add(base.replace(/['’]/g, ""));
  return out.slice(0, 3);
}

/**
 * The queries to run for one business, strongest first.
 *
 * The order is the whole design. A postcode or a phone number identifies one
 * business and nothing else, so those go first and usually settle it in a
 * single call. Name-and-town comes next because it pins the business in most
 * towns. The weaker variations exist for the hard case — a business whose
 * domain bears no resemblance to its trading name — and are only reached when
 * everything above has failed to produce a verified site.
 *
 * The caller stops as soon as a candidate verifies, so this is a plan, not a
 * batch: returning five queries does not mean five searches will be run.
 */
export function buildQueries(identity: BusinessIdentity): SearchQuery[] {
  const name = clean(identity.businessName);
  const town = clean(identity.town);
  const trade = clean(identity.trade);
  const postcode = extractPostcodeFrom(identity.address ?? "");
  const phone = clean(identity.phone ?? "");
  if (name.length < 2) return [];

  const queries: SearchQuery[] = [];
  const add = (text: string, intent: SearchQuery["intent"], strength: number) => {
    const value = clean(text);
    if (value && !queries.some((q) => q.text === value)) queries.push({ text: value, intent, strength });
  };

  const [primary, ...variants] = nameVariations(name);

  // Strongest: a postcode belongs to one address, a phone number to one line.
  if (postcode) add(`"${primary}" ${postcode}`, "website", 95);
  if (phone.replace(/\D/g, "").length >= 10) add(`"${primary}" "${phone}"`, "website", 90);

  // Strong: the business in its town.
  add(`"${primary}" ${town}`.trim(), "website", 70);
  if (trade) add(`"${primary}" ${town} ${trade}`.trim(), "website", 60);

  // Weaker, for a business whose domain looks nothing like its name. These are
  // only reached when nothing above verified.
  for (const variant of variants) add(`"${variant}" ${town}`.trim(), "website", 50);
  add(`"${primary}" ${town} contact email`.trim(), "contact", 40);

  return queries.sort((a, b) => b.strength - a.strength).slice(0, MAX_SEARCHES_PER_LEAD);
}

/**
 * Queries that look for a published address rather than a website.
 *
 * Run AFTER a crawl has failed, never instead of it: a snippet containing
 * `info@` is evidence to verify, not an address to store. The caller still
 * has to show the address belongs to this business.
 */
export function buildEmailQueries(identity: BusinessIdentity): SearchQuery[] {
  const name = clean(identity.businessName);
  const town = clean(identity.town);
  if (name.length < 2) return [];
  const [primary] = nameVariations(name);
  const queries: SearchQuery[] = [];
  const add = (text: string, strength: number) => {
    const value = clean(text);
    if (value && !queries.some((q) => q.text === value)) {
      queries.push({ text: value, intent: "email", strength });
    }
  };
  if (town) {
    add(`"${primary}" ${town} email`, 50);
    add(`"${primary}" ${town} "info@"`, 45);
    add(`"${primary}" ${town} contact email`, 40);
  } else {
    add(`"${primary}" email`, 40);
  }
  return queries.slice(0, 2);
}

/** A UK postcode out of free text. Duplicated deliberately: this module is pure. */
function extractPostcodeFrom(address: string): string {
  const match = address.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return match ? `${match[1]} ${match[2]}` : "";
}

/** Hosts whose pages are never the business's own website. */
const NOT_A_WEBSITE = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "tiktok.com", "youtube.com", "pinterest.com",
  "yell.com", "yelp.com", "yelp.co.uk", "thomsonlocal.com", "cylex-uk.co.uk",
  "freeindex.co.uk", "scoot.co.uk", "192.com", "bing.com", "google.com",
  "tripadvisor.com", "tripadvisor.co.uk", "checkatrade.com", "trustpilot.com",
  "companieshouse.gov.uk", "find-and-update.company-information.service.gov.uk",
  "gumtree.com", "indeed.com", "wikipedia.org", "amazon.co.uk", "ebay.co.uk",
  "treatwell.co.uk", "fresha.com", "booksy.com",
];

/** Directory and profile hosts that may still legitimately publish an address. */
const PUBLIC_PROFILE_HOSTS = [
  "yell.com", "freeindex.co.uk", "cylex-uk.co.uk", "scoot.co.uk",
  "thomsonlocal.com", "checkatrade.com", "mybuilder.com", "ratedpeople.com",
  "trustatrader.com", "bark.com",
  "facebook.com", "instagram.com", "linkedin.com",
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostIn(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Is this result plausibly the business's OWN site, rather than a listing of it? */
export function looksLikeOwnWebsite(url: string): boolean {
  const host = hostOf(url);
  if (!host || !host.includes(".")) return false;
  if (hostIn(host, NOT_A_WEBSITE)) return false;
  // Blog and marketplace subpaths are not a business's front door.
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/^\/(blog|news|jobs|products?|search|tag|category)\//.test(path)) return false;
  } catch {
    return false;
  }
  return true;
}

/** A public directory or profile page, which may still publish an address. */
export function looksLikePublicProfile(url: string): boolean {
  return hostIn(hostOf(url), PUBLIC_PROFILE_HOSTS);
}

export type WebsiteLead = {
  url: string;
  /** The origin, which is what gets crawled. */
  origin: string;
  title: string;
  snippet: string;
  kind: "OWN_WEBSITE" | "PUBLIC_PROFILE";
};

/**
 * Turn raw results into the short list worth fetching.
 *
 * One entry per host: five pages of the same site are one candidate, and
 * fetching all five to discover that is wasted budget. Own-website results come
 * before directory profiles, because an address on a business's own site is
 * stronger evidence than the same address on a listing someone else maintains.
 */
export function candidatesFromResults(results: readonly SearchResult[], max = 4): WebsiteLead[] {
  const seen = new Set<string>();
  const own: WebsiteLead[] = [];
  const profiles: WebsiteLead[] = [];

  for (const result of results) {
    const host = hostOf(result.url);
    if (!host || seen.has(host)) continue;
    let origin = "";
    try {
      origin = new URL(result.url).origin;
    } catch {
      continue;
    }
    seen.add(host);
    const entry = { url: result.url, origin, title: clean(result.title), snippet: clean(result.snippet) };
    if (looksLikeOwnWebsite(result.url)) own.push({ ...entry, kind: "OWN_WEBSITE" });
    else if (looksLikePublicProfile(result.url)) profiles.push({ ...entry, kind: "PUBLIC_PROFILE" });
  }
  // Own sites first (they can be attached). Profiles ride along so we can
  // still mine a matching Yell/Facebook page for an address when the site
  // itself never verified — without spending the own-site budget on them.
  return [...own.slice(0, max), ...profiles.slice(0, 2)];
}

// ── Provider response shapes ─────────────────────────────────────────────────

/**
 * Brave's `/res/v1/web/search` payload, reduced to what we use.
 *
 * Parsing lives here, in the pure module, so a provider's response shape can be
 * tested against a recorded payload without a key or a network.
 */
export function parseBrave(payload: unknown): SearchResult[] {
  const web = (payload as { web?: { results?: unknown } })?.web?.results;
  if (!Array.isArray(web)) return [];
  return web
    .map((entry) => {
      const row = entry as { title?: unknown; url?: unknown; description?: unknown };
      return {
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        snippet: typeof row.description === "string" ? row.description : "",
      };
    })
    .filter((row) => row.url !== "")
    .slice(0, MAX_RESULTS_PER_QUERY);
}

/** Bing's `/v7.0/search` payload, reduced to what we use. */
export function parseBing(payload: unknown): SearchResult[] {
  const pages = (payload as { webPages?: { value?: unknown } })?.webPages?.value;
  if (!Array.isArray(pages)) return [];
  return pages
    .map((entry) => {
      const row = entry as { name?: unknown; url?: unknown; snippet?: unknown };
      return {
        title: typeof row.name === "string" ? row.name : "",
        url: typeof row.url === "string" ? row.url : "",
        snippet: typeof row.snippet === "string" ? row.snippet : "",
      };
    })
    .filter((row) => row.url !== "")
    .slice(0, MAX_RESULTS_PER_QUERY);
}

/** Where to send the request, and how to authenticate it. */
export type ProviderRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** Present for providers that take a JSON body. */
  body?: string;
};

/**
 * Where to send the request, and how to authenticate it.
 *
 * Each provider's own documented endpoint — never a results page, which would
 * break their terms and their markup at the same time. The key always travels
 * in a header or a JSON body, never in the URL, so it cannot end up in a log,
 * a redirect chain or a referrer.
 */
export function providerRequest(
  provider: SearchProviderName,
  key: string,
  query: string,
): ProviderRequest {
  if (provider === "tavily") {
    return {
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        // "basic" is one credit per search; "advanced" is two and re-ranks more
        // aggressively. Basic is enough to find a business's own site, and the
        // identity check does the discriminating either way.
        search_depth: "basic",
        max_results: MAX_RESULTS_PER_QUERY,
        // The page text, so a published address can be read without spending
        // one of our own page fetches on it.
        include_raw_content: true,
        include_answer: false,
        include_images: false,
      }),
    };
  }
  if (provider === "brave") {
    return {
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS_PER_QUERY}&country=gb`,
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    };
  }
  return {
    url: `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS_PER_QUERY}&mkt=en-GB`,
    method: "GET",
    headers: { Accept: "application/json", "Ocp-Apim-Subscription-Key": key },
  };
}

/**
 * Tavily's `/search` payload.
 *
 * `content` is the snippet and `raw_content` the extracted page text, which is
 * null unless `include_raw_content` was set and the page could be read.
 */
export function parseTavily(payload: unknown): SearchResult[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) => {
      const row = entry as { title?: unknown; url?: unknown; content?: unknown; raw_content?: unknown };
      return {
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        snippet: typeof row.content === "string" ? row.content : "",
        rawContent: typeof row.raw_content === "string" ? row.raw_content : undefined,
      };
    })
    .filter((row) => row.url !== "")
    .slice(0, MAX_RESULTS_PER_QUERY);
}

export function parseProvider(provider: SearchProviderName, payload: unknown): SearchResult[] {
  if (provider === "tavily") return parseTavily(payload);
  return provider === "brave" ? parseBrave(payload) : parseBing(payload);
}


// ── Failure classification ───────────────────────────────────────────────────

/**
 * Why a search call did not return results.
 *
 * The distinction that matters most is AUTH. A rejected key returns no results,
 * exactly like a business that genuinely has no website — and without naming
 * it, a mistyped key looks like months of poor discovery rather than a
 * five-second fix. Every other kind exists so a failure can be acted on rather
 * than absorbed.
 */
export const SEARCH_FAILURES = [
  "AUTH",
  "QUOTA",
  "RATE_LIMIT",
  "TIMEOUT",
  "BAD_RESPONSE",
  "SERVER",
  "NETWORK",
] as const;
export type SearchFailureKind = (typeof SEARCH_FAILURES)[number];

export type SearchOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; kind: SearchFailureKind; detail: string; retryAfterMs?: number };

/** Worth trying once more: transient by nature. Auth and quota are not. */
export function isRetryable(kind: SearchFailureKind): boolean {
  return kind === "TIMEOUT" || kind === "SERVER" || kind === "NETWORK";
}

export const SEARCH_FAILURE_LABELS: Record<SearchFailureKind, string> = {
  AUTH: "The search API key was rejected. Check it in the deployment's environment variables.",
  QUOTA: "The search plan's quota is used up. Discovery fell back to domain candidates.",
  RATE_LIMIT: "The search provider asked us to slow down.",
  TIMEOUT: "The search provider did not answer in time.",
  BAD_RESPONSE: "The search provider returned something this app could not read.",
  SERVER: "The search provider returned an error.",
  NETWORK: "The search provider could not be reached.",
};

/**
 * What an HTTP status and body mean.
 *
 * Both providers signal quota exhaustion differently and neither is a clean
 * status code: Brave uses 429 with a quota message, Azure a 403. Reading the
 * body is what separates "you are going too fast" from "you have run out",
 * which are a wait and a bill respectively.
 */
export function classifySearchFailure(status: number, body = ""): { kind: SearchFailureKind; detail: string } {
  const text = body.slice(0, 400);
  // "exceeded" alone is not a quota signal: "Rate limit exceeded" is a request
  // to slow down, and reporting it as an exhausted plan sends someone to their
  // billing page over a problem that clears itself in a second.
  const quotaish =
    /\bquota\b|out of credits|call volume|plan limit|usage limit|credit(?:s)? (?:limit|exceeded|exhausted)|subscription (?:has )?(?:expired|inactive|is inactive)/i.test(text);

  // Quota first, whatever the code. Providers do not agree on one: Brave uses
  // 429, Azure 403, and Tavily a non-standard 432. Reading the body is the only
  // thing that works across all three, and getting it wrong sends someone to
  // their billing page over a rate limit — or the reverse.
  if (status >= 400 && status < 500 && quotaish) {
    return { kind: "QUOTA", detail: `${status} — quota or credits exhausted` };
  }
  if (status === 401) return { kind: "AUTH", detail: "401 — key rejected" };
  if (status === 403) {
    return quotaish
      ? { kind: "QUOTA", detail: "403 — quota or subscription exhausted" }
      : { kind: "AUTH", detail: "403 — key not accepted for this endpoint" };
  }
  if (status === 429) {
    return quotaish
      ? { kind: "QUOTA", detail: "429 — quota exhausted" }
      : { kind: "RATE_LIMIT", detail: "429 — rate limited" };
  }
  if (status === 422) return { kind: "BAD_RESPONSE", detail: "422 — the query was rejected" };
  if (status >= 500) return { kind: "SERVER", detail: `${status} — provider error` };
  return { kind: "BAD_RESPONSE", detail: `${status} — unexpected response` };
}

/** `Retry-After` in seconds or as a date, in milliseconds. Bounded. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.min(60_000, Math.max(0, at - now.getTime()));
}

/**
 * Is this actually a search payload?
 *
 * A WAF or an error page answers 200 with HTML often enough that trusting the
 * status alone is how a parser starts throwing in production.
 */
export function looksLikeJson(contentType: string | null, body: string): boolean {
  if (contentType && /json/i.test(contentType)) return true;
  const head = body.trimStart().slice(0, 1);
  return head === "{" || head === "[";
}

/** Cap on a response body. A provider should never send more than this. */
export const MAX_SEARCH_BYTES = 512 * 1024;
