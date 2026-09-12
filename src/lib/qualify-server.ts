/**
 * Phase 2 server functions: one website check or one email lookup per request.
 *
 * Bulk actions run on the client in small concurrent batches so a Vercel Hobby
 * function never has to inspect 20 sites in one 10-second window.
 *
 * Nothing here sends email.
 */
import { createServerFn } from "@tanstack/react-start";
import { classifyWebsiteUrl, hasWebsite, websiteHref } from "@/lib/leads";
import {
  CANDIDATE_PATHS,
  contactLinks,
  decide,
  extractCandidates,
  type RejectedEmail,
  GOOD_ENOUGH_SCORE,
  MAX_PAGES,
  noWebsiteResult,
  rankCandidates,
  sitemapContactUrls,
  sitemapIndexUrls,
  type DiscoveryReason,
  type DiscoveryResult,
  type EmailCandidate,
} from "@/lib/email-discovery";

import {
  buildQueries,
  classifySearchFailure,
  isRetryable,
  looksLikeJson,
  MAX_SEARCH_BYTES,
  parseRetryAfter,
  type SearchFailureKind,
  type SearchOutcome,
  candidatesFromResults,
  parseProvider,
  providerRequest,
  SEARCH_PROVIDERS,
  type SearchProviderName,
  type SearchResult,
  type WebsiteLead,
} from "@/lib/search-provider";
import {
  bestWebsite,
  candidateDomains,
  pageText,
  pageTitle,
  scoreWebsiteMatch,
  WEBSITE_MIN_SCORE,
  type WebsiteMatch,
} from "@/lib/website-discovery";
import {
  scoreWebsitePage,
  type FoundEmail,
  type WebsiteCheck,
} from "@/lib/qualify";

const USER_AGENT = "PeakSwiftLeads/1.0 (public website check)";

function asString(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : value == null ? "" : String(value).trim().slice(0, max);
}

async function fetchPage(
  url: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; finalUrl: string; html: string }> {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    const type = response.headers.get("content-type") ?? "";
    const html = /html|xml|text/i.test(type) || !type ? (await response.text()).slice(0, 400_000) : "";
    return { ok: response.ok, status: response.status, finalUrl: response.url || href, html };
  } finally {
    clearTimeout(timer);
  }
}

export type CheckWebsiteResult =
  | { ok: true; check: WebsiteCheck; checkedAt: string }
  | { ok: false; error: string };

export type FindEmailResult =
  | {
      ok: true;
      found: FoundEmail | null;
      foundAt: string;
      message: string;
      /**
       * The full discovery record: what was tried, what was found, and why it
       * ended where it did. `found` stays alongside it so every existing caller
       * keeps working unchanged.
       */
      discovery: DiscoveryResult;
      /** Set when the website was found by us rather than carried on the listing. */
      website?: WebsiteMatch | null;
      /** How the website was arrived at. */
      discoveryVia?: "LISTING" | "SEARCH" | "DOMAIN_GUESS";
      /** Which provider answered, or null when none is configured. */
      searchProvider?: string | null;
      searchesRun?: number;
      /** Named reason the search layer produced nothing, when it failed. */
      searchFailure?: SearchFailureKind | null;
      /** Provider-supplied page extracts mined for addresses, on the verified site only. */
      providerExtracts?: number;
      /** Sites considered and turned down, so a miss can be understood. */
      rejectedCandidates?: { url: string; why: string }[];
      /**
       * The full diagnostic trail, for the test panel.
       *
       * Present on every call because the cost is a handful of strings, and a
       * real failed lead has to be diagnosable without anyone attaching a
       * debugger to production. Nothing here is inferred: the queries are the
       * ones actually sent, the results the ones actually returned, and the
       * candidate scores the ones the identity check actually produced.
       */
      queriesUsed?: string[];
      searchResults?: { title: string; url: string }[];
      candidates?: {
        url: string;
        score: number;
        accepted: boolean;
        signals: string[];
        /** BUSINESS | DIRECTORY | SOCIAL | PARKED — why a perfect match was refused. */
        character?: string;
      }[];
      /** Wall-clock milliseconds for the whole discovery, including every fetch. */
      elapsedMs?: number;
      /** Addresses found on a page and discarded, with the reason for each. */
      rejectedEmails?: { email: string; why: string; sourceUrl: string }[];
    }
  | { ok: false; error: string };

export const checkLeadWebsite = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing website");
    const website = asString((input as { website?: unknown }).website, 500);
    const businessName = asString((input as { businessName?: unknown }).businessName, 160);
    if (!hasWebsite(website)) throw new Error("No website to check");
    return { website, businessName };
  })
  .handler(async ({ data }): Promise<CheckWebsiteResult> => {
    const href = websiteHref(data.website) ?? data.website;
    const classified = classifyWebsiteUrl(href);
    if (classified === "Social Only" || classified === "Directory Only") {
      return {
        ok: true,
        check: scoreWebsitePage({ url: href, finalUrl: href, businessName: data.businessName, html: "", status: 200 }),
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      const page = await fetchPage(href, 5000);
      return {
        ok: true,
        check: scoreWebsitePage({
          url: href,
          finalUrl: page.finalUrl,
          status: page.status,
          html: page.html,
          businessName: data.businessName,
        }),
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        ok: true,
        check: scoreWebsitePage({
          url: href,
          businessName: data.businessName,
          unreachable: true,
        }),
        checkedAt: new Date().toISOString(),
      };
    }
  });

/**
 * One page fetch, tolerant of the ways a small business site is set up wrong.
 *
 * Tries the address as given, then the www/non-www sibling, then http. A site
 * that only answers on one of those is common enough that giving up after the
 * first attempt loses real prospects.
 */
async function fetchWithFallbacks(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; finalUrl: string; html: string } | null> {
  const attempts = [url];
  try {
    const parsed = new URL(url);
    const swapped = parsed.host.startsWith("www.")
      ? parsed.host.slice(4)
      : `www.${parsed.host}`;
    attempts.push(`${parsed.protocol}//${swapped}${parsed.pathname}${parsed.search}`);
    if (parsed.protocol === "https:") attempts.push(`http://${parsed.host}${parsed.pathname}`);
  } catch {
    /* the single attempt is all we have */
  }
  for (const attempt of attempts) {
    try {
      const page = await fetchPage(attempt, timeoutMs);
      if (page.ok && page.html) return page;
      // A 4xx/5xx on the canonical host is still information; keep it if the
      // siblings also fail.
      if (page.status >= 400 && attempt === attempts[attempts.length - 1]) return page;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/**
 * How many candidate domains one lead may cost.
 *
 * Four, fetched at once with a short timeout, so a lead with no website adds a
 * couple of seconds rather than twenty. They are guesses; the budget is
 * deliberately small because the corroboration check, not the breadth of the
 * guessing, is what makes this safe.
 */
const WEBSITE_PROBES = 4;


/**
 * The configured search provider, or null.
 *
 * Server-only: the key is read here and never leaves. With no key the whole
 * search layer reports itself unavailable and discovery runs exactly as it did
 * before — search is an upgrade, not a dependency.
 */
function searchProvider(): { name: SearchProviderName; key: string } | null {
  const keys: Record<SearchProviderName, string | undefined> = {
    tavily: process.env.TAVILY_API_KEY,
    brave: process.env.BRAVE_SEARCH_API_KEY,
    bing: process.env.BING_SEARCH_API_KEY,
  };
  for (const name of SEARCH_PROVIDERS) {
    const key = keys[name]?.trim();
    if (key) return { name, key };
  }
  return null;
}

/**
 * One search call, hardened for a live API.
 *
 * Never throws. Returns either results or a named failure, because the two
 * things a caller must be able to tell apart are "this business has no website"
 * and "your key is wrong" — which look identical if every failure is an empty
 * array. Retries once on a transient fault and gives up on anything structural.
 */
async function runSearch(
  provider: { name: SearchProviderName; key: string },
  query: string,
): Promise<SearchOutcome> {
  const { url, method, headers, body: requestBody } = providerRequest(provider.name, provider.key, query);

  const once = async (): Promise<SearchOutcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url, {
        method, headers, body: requestBody, signal: controller.signal,
      });
      const body = (await response.text()).slice(0, MAX_SEARCH_BYTES);

      if (!response.ok) {
        const { kind, detail } = classifySearchFailure(response.status, body);
        return {
          ok: false, kind, detail,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) ?? undefined,
        };
      }
      // A WAF or error page answering 200 with HTML is common enough that the
      // status alone cannot be trusted.
      if (!looksLikeJson(response.headers.get("content-type"), body)) {
        return { ok: false, kind: "BAD_RESPONSE", detail: "200 but the body was not JSON" };
      }
      try {
        return { ok: true, results: parseProvider(provider.name, JSON.parse(body)) };
      } catch {
        return { ok: false, kind: "BAD_RESPONSE", detail: "the JSON body could not be parsed" };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return aborted
        ? { ok: false, kind: "TIMEOUT", detail: "no answer within 6s" }
        : { ok: false, kind: "NETWORK", detail: error instanceof Error ? error.message : "request failed" };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await once();
  if (first.ok || !isRetryable(first.kind)) return first;
  return once();
}

/** Absolute URLs for the well-known contact paths on this origin. */
function wellKnownPaths(origin: string): string[] {
  return CANDIDATE_PATHS.map((path) => `${origin}${path}`);
}

export const findLeadEmail = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing lead");
    const source = input as Record<string, unknown>;
    return {
      website: asString(source.website, 500),
      existingEmail: asString(source.existingEmail, 160).toLowerCase(),
      existingSource: asString(source.existingSource, 80),
      businessName: asString(source.businessName, 160),
      // Identity signals, for corroborating a website we had to go looking for.
      town: asString(source.town, 80),
      trade: asString(source.trade, 80),
      phone: asString(source.phone, 40),
      address: asString(source.address, 200),
    };
  })
  .handler(async ({ data }): Promise<FindEmailResult> => {
    const foundAt = new Date().toISOString();
    const context = { websiteUrl: data.website, businessName: data.businessName };
    const candidates: EmailCandidate[] = [];
    const sourcesChecked: string[] = [];
    let attempts = 0;
    let failure: DiscoveryReason | null = null;
    let sawContactPage = false;

    /** The address already on the row, if the listing carried one. */
    const listingCandidate = (): EmailCandidate[] =>
      data.existingEmail.includes("@")
        ? [{
            email: data.existingEmail,
            source: "EXISTING_LISTING" as const,
            sourceUrl: "",
            method: "LISTING_FIELD" as const,
            evidence: data.existingSource || "Carried on the business listing",
          }]
        : [];

    const best = () => rankCandidates(candidates, context)[0]?.score ?? 0;

    const readPage = async (url: string, isContact: boolean, timeout = 5000) => {
      if (attempts >= MAX_PAGES) return;
      attempts += 1;
      const page = await fetchWithFallbacks(url, timeout);
      sourcesChecked.push(url);
      if (!page) return;
      if (page.status === 403 || page.status === 401) { failure ??= "BLOCKED_BY_SITE"; return; }
      if (page.status === 429) { failure ??= "RATE_LIMITED"; return; }
      if (!page.html) return;
      if (isContact) sawContactPage = true;
      candidates.push(
        ...extractCandidates(page.html, page.finalUrl || url, isContact ? "OFFICIAL_CONTACT_PAGE" : "OFFICIAL_WEBSITE", rejectedEmails),
      );
      return page;
    };

    let href = websiteHref(data.website);
    let discoveredSite: WebsiteMatch | null = null;
    let discoveryVia: "LISTING" | "SEARCH" | "DOMAIN_GUESS" = "LISTING";
    let searchUsed: SearchProviderName | null = null;
    let searchesRun = 0;
    let searchFailure: SearchFailureKind | null = null;
    /** Results kept so a verified site's provider-extracted text can be read. */
    const collectedResults: SearchResult[] = [];
    /** How many provider page-extracts were mined for addresses. */
    let providerExtracts = 0;
    /** Candidates looked at and turned down, with the reason. */
    const rejected: { url: string; why: string }[] = [];
    /** Every query actually sent, in order, for the test panel. */
    const queriesUsed: string[] = [];
    /** Every candidate site scored, kept or not, with the signals behind it. */
    const siteCandidates: {
      url: string;
      score: number;
      accepted: boolean;
      signals: string[];
      character?: string;
    }[] = [];
    /** Origins already fetched, so the waterfall never pays for one twice. */
    const probedOrigins = new Set<string>();
    /** Addresses seen on a page and discarded, with why. Never silently dropped. */
    const rejectedEmails: RejectedEmail[] = [];
    const startedAt = Date.now();

    // No usable website on the listing? Go and find one before giving up.
    //
    // Eight of twelve leads in a live Perth run died here, never reaching email
    // discovery at all. OSM and Companies House record a URL for a minority of
    // small businesses, so an empty field is not evidence that none exists.
    //
    // Candidate hostnames are guesses and are treated as such: each is fetched
    // and kept ONLY if the page carries this business's own phone number, or
    // its name together with its town. Anything less is discarded, because a
    // wrongly attached site yields a confident, evidenced, wrong address.
    const socialOrDirectory =
      href && (classifyWebsiteUrl(href) === "Social Only" || classifyWebsiteUrl(href) === "Directory Only");
    if ((!href || socialOrDirectory) && data.businessName) {
      const identity = {
        businessName: data.businessName, town: data.town, trade: data.trade,
        phone: data.phone, address: data.address,
      };

      // ── Search first ────────────────────────────────────────────────────
      //
      // Domain guessing only reaches businesses whose domain resembles their
      // name, which is a minority. Search finds the rest — a salon trading as
      // "Salon T.Elle" at perthhairstudio.co.uk is invisible to a guess and
      // obvious to a query. Results are candidates, never truth: each is
      // fetched and put through the same corroboration as a guessed domain.
      const provider = searchProvider();
      const probeMatches: WebsiteMatch[] = [];

      /**
       * Fetch a candidate and decide whether it is this business.
       *
       * Returns true once something has verified, which is the waterfall's
       * stop condition. Every candidate is recorded either way, so a miss can
       * be read afterwards rather than guessed at.
       */
      const probeCandidate = async (lead: WebsiteLead): Promise<boolean> => {
        if (attempts >= MAX_PAGES) return false;
        if (probedOrigins.has(lead.origin)) return false;
        probedOrigins.add(lead.origin);
        attempts += 1;
        sourcesChecked.push(lead.origin);
        const page = await fetchWithFallbacks(lead.origin, 3000);
        if (!page?.ok || !page.html) {
          rejected.push({ url: lead.origin, why: "unreachable" });
          siteCandidates.push({ url: lead.origin, score: 0, accepted: false, signals: ["unreachable"] });
          return false;
        }
        // The search layer already knows a Yell or Checkatrade result is a
        // directory profile. Passing that through is what stops a listing page
        // being attached as the business's own website — it used to be
        // discarded here, and a Yell page scored a perfect 100.
        const match = scoreWebsiteMatch(
          { url: page.finalUrl || lead.origin, text: pageText(page.html), title: pageTitle(page.html) },
          identity,
          { kind: lead.kind },
        );
        const accepted = match.score >= WEBSITE_MIN_SCORE;
        siteCandidates.push({
          url: page.finalUrl || lead.origin,
          score: match.score,
          accepted,
          signals: match.evidence.length > 0 ? match.evidence : ["no identity signals matched"],
          character: match.character,
        });
        if (accepted) probeMatches.push(match);
        else rejected.push({ url: lead.origin, why: match.evidence.join("; ") || "identity not corroborated" });
        return accepted;
      };

      if (provider) {
        searchUsed = provider.name;
        const collected: SearchResult[] = collectedResults;

        // ── The waterfall ──────────────────────────────────────────────────
        //
        // Strongest query first, then *evaluate before paying for the next
        // one*. The previous version fired queries until any non-directory URL
        // appeared anywhere in the results and then stopped — which could stop
        // on a completely unrelated business and never run the query that
        // would have found the right one. Verification is the stop condition
        // now, not the mere presence of a plausible-looking link.
        for (const query of buildQueries(identity)) {
          searchesRun += 1;
          queriesUsed.push(query.text);
          sourcesChecked.push(`search:${query.text}`);
          const answer = await runSearch(provider, query.text);
          if (!answer.ok) {
            searchFailure = answer.kind;
            // Auth, quota and rate limits fail identically on every remaining
            // query, so stop rather than burning the budget re-proving it.
            if (answer.kind === "AUTH" || answer.kind === "QUOTA" || answer.kind === "RATE_LIMIT") break;
            continue;
          }
          collected.push(...answer.results);

          // Probe what this query produced before deciding to buy another.
          let verified = false;
          for (const candidate of candidatesFromResults(collected)) {
            if (await probeCandidate(candidate)) {
              verified = true;
              break;
            }
            if (attempts >= MAX_PAGES) break;
          }
          if (verified || attempts >= MAX_PAGES) break;
        }
      }
      discoveredSite = bestWebsite(probeMatches);
      if (discoveredSite) {
        href = discoveredSite.url;
        discoveryVia = "SEARCH";

        // Tavily returns the text of pages it fetched. Read addresses out of it
        // for the site we just VERIFIED — and only that site. The provider
        // already fetched the page, so this is still an address observed in a
        // public source, and on a site that blocks our crawler but not theirs
        // it is the only way we will ever see it.
        //
        // Scoping to the verified origin is the whole safety of this: raw text
        // from an unverified result would harvest a different business's
        // address and attach it here with full confidence.
        let verifiedOrigin = "";
        try {
          verifiedOrigin = new URL(discoveredSite.url).origin;
        } catch {
          verifiedOrigin = "";
        }
        if (verifiedOrigin) {
          for (const result of collectedResults) {
            if (!result.rawContent) continue;
            let sameSite = false;
            try {
              sameSite = new URL(result.url).origin === verifiedOrigin;
            } catch {
              sameSite = false;
            }
            if (!sameSite) continue;
            providerExtracts += 1;
            candidates.push(
              ...extractCandidates(result.rawContent, result.url, "OFFICIAL_WEBSITE", rejectedEmails),
            );
          }
        }
      }
      // Concurrently: most candidate domains do not resolve, and waiting out
      // four DNS failures one after another would add twenty seconds to every
      // lead that has no website — which is most of them.
      if (!discoveredSite) {
      const probes = candidateDomains(data.businessName, data.town, data.trade, WEBSITE_PROBES);
      attempts += probes.length;
      sourcesChecked.push(...probes.map((host) => `https://${host}`));
      const settled = await Promise.all(
        probes.map(async (host): Promise<WebsiteMatch | null> => {
          const probe = `https://${host}`;
          const page = await fetchWithFallbacks(probe, 2500);
          if (!page?.ok || !page.html) return null;
          return scoreWebsiteMatch(
            { url: page.finalUrl || probe, text: pageText(page.html), title: pageTitle(page.html) },
            identity,
          );
        }),
      );
      const guessed = settled.filter((match): match is WebsiteMatch => match !== null);
      for (const match of guessed) {
        if (match.score < 75) rejected.push({ url: match.url, why: match.evidence.join("; ") || "identity not corroborated" });
      }
      discoveredSite = bestWebsite(guessed);
      if (discoveredSite) { href = discoveredSite.url; discoveryVia = "DOMAIN_GUESS"; }
      }
    }

    const scrapable = href && classifyWebsiteUrl(href) !== "Social Only" && classifyWebsiteUrl(href) !== "Directory Only";

    if (!href) {
      const ranked = listingCandidate();
      // Say WHICH kind of nothing this is. "No website" when we never had a
      // candidate; "not verified" when we had some and none proved itself;
      // "no search key" when the one source that would have found it is off.
      // Say WHICH kind of nothing this is, in the order the causes matter.
      // A search that never ran explains everything downstream, so a provider
      // failure is reported ahead of "nothing verified" — otherwise a rejected
      // API key reads as forty businesses that happen to have no website.
      const noSiteReason: DiscoveryReason =
        searchFailure === "AUTH"
          ? "SEARCH_AUTH_FAILED"
          : searchFailure === "QUOTA"
            ? "SEARCH_QUOTA_EXHAUSTED"
            : searchFailure === "RATE_LIMIT"
              ? "SEARCH_RATE_LIMITED"
              : searchUsed === null
                ? "SEARCH_PROVIDER_UNAVAILABLE"
                : siteCandidates.some((candidate) => candidate.character && candidate.character !== "BUSINESS")
                  ? "ONLY_DIRECTORY_LISTINGS_FOUND"
                  : rejected.length > 0
                    ? "WEBSITE_NOT_VERIFIED"
                    : "NO_WEBSITE";
      const result = ranked.length
        ? decide({ candidates: ranked, context, sourcesChecked, attempts })
        : { ...noWebsiteResult(), reason: noSiteReason, sourcesChecked, attempts };
      return {
        ok: true, found: toFoundEmail(result), foundAt, message: result.reason ?? "", discovery: result,
        website: null, discoveryVia, searchProvider: searchUsed, searchesRun,
        searchFailure, providerExtracts, rejectedCandidates: rejected,
        queriesUsed, candidates: siteCandidates, elapsedMs: Date.now() - startedAt,
        rejectedEmails,
        searchResults: collectedResults.slice(0, 20).map((result) => ({
          title: result.title, url: result.url,
        })),
      };
    }

    if (scrapable) {
      let origin = "";
      try {
        origin = new URL(href).origin;
      } catch {
        origin = "";
      }

      const home = await readPage(href, false);
      if (!home && !failure) failure = "WEBSITE_UNREACHABLE";

      // Linked contact pages first — a link the business chose to publish is
      // better evidence than a path we guessed at.
      if (best() < GOOD_ENOUGH_SCORE && home?.html) {
        for (const link of contactLinks(home.html, home.finalUrl || href)) {
          if (best() >= GOOD_ENOUGH_SCORE || attempts >= MAX_PAGES) break;
          await readPage(link, true, 4500);
        }
      }

      // Then the sitemap, which finds pages nothing links to.
      if (best() < GOOD_ENOUGH_SCORE && origin && attempts < MAX_PAGES) {
        attempts += 1;
        sourcesChecked.push(`${origin}/sitemap.xml`);
        const map = await fetchWithFallbacks(`${origin}/sitemap.xml`, 4000);
        if (map?.html) {
          let urls = sitemapContactUrls(map.html, origin);
          if (urls.length === 0) {
            for (const nested of sitemapIndexUrls(map.html, origin, 1)) {
              const child = await fetchWithFallbacks(nested, 4000);
              if (child?.html) urls = sitemapContactUrls(child.html, origin);
              break;
            }
          }
          for (const url of urls) {
            if (best() >= GOOD_ENOUGH_SCORE || attempts >= MAX_PAGES) break;
            await readPage(url, true, 4500);
          }
        }
      }

      // Finally the well-known paths, for sites that link to nothing at all.
      if (best() < GOOD_ENOUGH_SCORE && origin && attempts < MAX_PAGES) {
        const tried = new Set(sourcesChecked);
        for (const url of wellKnownPaths(origin)) {
          if (best() >= GOOD_ENOUGH_SCORE || attempts >= MAX_PAGES) break;
          if (tried.has(url)) continue;
          await readPage(url, true, 3500);
        }
      }
    }

    // The listing address is a real source, just a weak one — it only wins if
    // nothing better turned up.
    candidates.push(...listingCandidate());

    const result = decide({ candidates, context, sourcesChecked, attempts, failure, sawContactPage });
    return {
      ok: true,
      found: toFoundEmail(result),
      foundAt,
      message: result.reason ?? "",
      discovery: result,
      website: discoveredSite,
      discoveryVia,
      searchProvider: searchUsed,
      searchesRun,
      queriesUsed,
      candidates: siteCandidates,
      elapsedMs: Date.now() - startedAt,
      rejectedEmails,
      searchResults: collectedResults.slice(0, 20).map((result) => ({
        title: result.title,
        url: result.url,
      })),
      searchFailure,
      providerExtracts,
      rejectedCandidates: rejected,
    };
  });

/**
 * The old shape, kept so every existing caller works untouched.
 *
 * A LOW-confidence address is deliberately NOT returned here: the eligibility
 * gate refuses it anyway, and handing it back as `found` would put a weak
 * address on the lead row where it looks like a real one.
 */
function toFoundEmail(result: DiscoveryResult): FoundEmail | null {
  if (result.status !== "FOUND" || !result.email || !result.confidence) return null;
  return {
    email: result.email,
    source: describeSource(result),
    confidence: result.confidence === "LOW" ? "LOW" : result.confidence,
  };
}

function describeSource(result: DiscoveryResult): string {
  switch (result.source) {
    case "OFFICIAL_CONTACT_PAGE":
      return "Business contact page";
    case "OFFICIAL_WEBSITE":
      return "Business website";
    case "STRUCTURED_DATA":
      return "Business website (structured data)";
    case "PUBLIC_BUSINESS_PROFILE":
      return "Public business profile";
    case "PUBLIC_DIRECTORY":
      return "Public business directory";
    case "EXISTING_LISTING":
      return result.evidence || "Existing listing";
    default:
      return "Business website";
  }
}
