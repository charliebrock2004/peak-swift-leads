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
        ...extractCandidates(page.html, page.finalUrl || url, isContact ? "OFFICIAL_CONTACT_PAGE" : "OFFICIAL_WEBSITE"),
      );
      return page;
    };

    const href = websiteHref(data.website);
    const scrapable = href && classifyWebsiteUrl(href) !== "Social Only" && classifyWebsiteUrl(href) !== "Directory Only";

    if (!href) {
      const ranked = listingCandidate();
      const result = ranked.length
        ? decide({ candidates: ranked, context, sourcesChecked: [], attempts: 0 })
        : noWebsiteResult();
      return { ok: true, found: toFoundEmail(result), foundAt, message: result.reason ?? "", discovery: result };
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
    return { ok: true, found: toFoundEmail(result), foundAt, message: result.reason ?? "", discovery: result };
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
