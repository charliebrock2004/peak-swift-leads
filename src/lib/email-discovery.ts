/**
 * Finding a business's published email address.
 *
 * Pure: no network, no database, no environment. Everything here works on
 * strings a caller has already fetched, so the whole discovery policy — what
 * counts as a candidate, what it is worth, and why a search failed — is
 * unit-testable without a website. `qualify-server.ts` does the fetching and
 * drives these functions; it adds no new server function, because the SSR
 * bundle splits and takes production down past roughly fifteen of them.
 *
 * ONE RULE ABOVE ALL: an address is only ever reported if it was actually
 * present in a page we fetched. Nothing here builds `info@<domain>` from a
 * naming pattern. A business with no published address stays NOT_FOUND, and
 * NOT_FOUND is a useful answer — it routes the lead to the call list.
 */
import { hostnameOf } from "./leads.ts";

// ── The shape an agent reads ─────────────────────────────────────────────────

export const DISCOVERY_STATUSES = [
  "FOUND",
  "NOT_FOUND",
  "LOW_CONFIDENCE",
  "INVALID",
  "BLOCKED",
  "REQUIRES_REVIEW",
] as const;
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/** Why a search ended without a usable address. Never just "no email found". */
export const DISCOVERY_REASONS = [
  "NO_WEBSITE",
  "WEBSITE_UNREACHABLE",
  "NO_CONTACT_PAGE",
  "CONTACT_PAGE_NO_EMAIL",
  "EMAIL_OBFUSCATED_UNREADABLE",
  "PUBLIC_PROFILE_NO_EMAIL",
  "DIRECTORY_NO_EMAIL",
  "EMAIL_INVALID",
  "EMAIL_LOW_CONFIDENCE",
  "RATE_LIMITED",
  "BLOCKED_BY_SITE",
  /** Candidates were found and every one failed identity corroboration. */
  "WEBSITE_NOT_VERIFIED",
  /** No search key is configured, so only the listing and guesses were tried. */
  "SEARCH_PROVIDER_UNAVAILABLE",
  /**
   * The next three split what used to be one catch-all.
   *
   * They need different responses from the person reading them — a rejected key
   * is a settings problem, a rate limit is a wait, and an exhausted quota is a
   * bill — so collapsing them into "search unavailable" left the only useful
   * part of the answer out.
   */
  "SEARCH_AUTH_FAILED",
  "SEARCH_RATE_LIMITED",
  "SEARCH_QUOTA_EXHAUSTED",
  /** Candidates were all directories, socials or parked domains. */
  "ONLY_DIRECTORY_LISTINGS_FOUND",
] as const;
export type DiscoveryReason = (typeof DISCOVERY_REASONS)[number];

/** Where an address came from, strongest first. Order is the ranking. */
export const SOURCE_KINDS = [
  "OFFICIAL_CONTACT_PAGE",
  "OFFICIAL_WEBSITE",
  "STRUCTURED_DATA",
  "PUBLIC_BUSINESS_PROFILE",
  "PUBLIC_DIRECTORY",
  "EXISTING_LISTING",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** How the address was spotted on the page. Part of the evidence trail. */
export type DiscoveryMethod =
  | "MAILTO_LINK"
  | "JSON_LD"
  | "META_TAG"
  | "INLINE_PAYLOAD"
  | "PAGE_TEXT"
  | "DEOBFUSCATED"
  | "LISTING_FIELD";

export type EmailCandidate = {
  email: string;
  source: SourceKind;
  sourceUrl: string;
  method: DiscoveryMethod;
  /** One sentence a person can check. */
  evidence: string;
};

export type ScoredCandidate = EmailCandidate & {
  score: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Why it scored what it did — shown in the test view. */
  notes: string[];
};

export type DiscoveryResult = {
  status: DiscoveryStatus;
  email: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  score: number | null;
  source: SourceKind | null;
  sourceUrl: string;
  evidence: string;
  reason: DiscoveryReason | null;
  /** Every page actually fetched. */
  sourcesChecked: string[];
  attempts: number;
  alternatives: ScoredCandidate[];
  /** What to do with this lead now. */
  nextAction: "SEND" | "REVIEW" | "CALL";
};

// ── Paths worth trying ───────────────────────────────────────────────────────

/**
 * Where a small business puts its address when nothing links to it.
 *
 * Ordered by how often it pays off, because the crawl budget stops early. These
 * are probed only when the pages we were actually linked to yielded nothing.
 */
export const CANDIDATE_PATHS = [
  "/contact",
  "/contact-us",
  "/contactus",
  "/get-in-touch",
  "/enquiries",
  "/enquiry",
  "/about",
  "/about-us",
  "/quote",
  "/request-a-quote",
  "/book",
  "/team",
  "/staff",
] as const;

/** Link text or href worth following, beyond the well-known paths above. */
const CONTACT_HREF =
  /contact|get-?in-?touch|enquir|quote|book|about|team|staff|reach-?us|services?|find-?us|where-?to-?find/i;

/** Junk that is never a business mailbox. */
const SKIP_LOCAL = /^(noreply|no-reply|no_reply|donotreply|privacy|legal|webmaster|hostmaster|postmaster|mailer-daemon|abuse|sentry|test|example|user|username|email|your|name)$/i;
const SKIP_HOSTS = [
  "sentry.io", "wixpress.com", "wordpress.com", "example.com", "example.org",
  "schema.org", "google.com", "gstatic.com", "w3.org", "cloudflare.com",
  "jquery.com", "github.com", "googleapis.com", "wix.com", "squarespace.com",
  "godaddy.com", "shopify.com", "sentry-cdn.com", "yourdomain.com", "domain.com",
  "test.com", "email.com", "mysite.com", "site.com",
];
const BAD_TLD = /^(png|jpe?g|gif|svg|webp|css|js|mjs|json|woff2?|ttf|eot|html?|php|aspx?|xml|ico)$/i;
/** Throwaway mailboxes. A business does not publish one. */
const DISPOSABLE = [
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "yopmail.com", "trashmail.com", "sharklasers.com", "throwawaymail.com",
];
/** General business mailboxes — preferred over a named individual. */
const ROLE_LOCAL = /^(info|hello|hi|enquiries|enquiry|enquire|contact|office|sales|admin|mail|bookings|booking|reception|accounts|quotes|quote|team|support|help)$/i;
/** Consumer mail providers. Legitimate for a sole trader; just not domain-matched. */
const PERSONAL_HOSTS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com",
  "live.co.uk", "yahoo.com", "yahoo.co.uk", "btinternet.com", "aol.com",
  "icloud.com", "me.com", "sky.com", "talktalk.net", "virginmedia.com",
]);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;

// ── Obfuscation ──────────────────────────────────────────────────────────────

/**
 * Turn `info [at] example [dot] co.uk` back into an address.
 *
 * Only rewrites the separators a human would read as "at" and "dot" in a string
 * that already looks like an address. It never assembles an address from parts
 * that were not both present — the local part and the domain both have to be
 * there, in that order, in the text.
 */
export function deobfuscate(text: string): string {
  return (
    text
      .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, "@")
      .replace(/\s+(?:at)\s+/gi, "@")
      .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/gi, ".")
      .replace(/\s+(?:dot)\s+/gi, ".")
      .replace(/&#0?64;/g, "@")
      .replace(/&#0?46;/g, ".")
      .replace(/&commat;/gi, "@")
      .replace(/&period;/gi, ".")
      // "info @ clarkjoinery . co . uk" — spacing alone, no words. Only closed
      // up between word characters, so ordinary prose ("call us . We are")
      // is untouched and no address is invented from unrelated text.
      .replace(/(\w)\s+@\s+(\w)/g, "$1@$2")
      .replace(/(\w)\s+\.\s+(\w)/g, "$1.$2")
  );
}

/**
 * Addresses a page builds in JavaScript from adjacent string literals.
 *
 * `"info" + "@" + "example.co.uk"` is a real and common way of hiding an
 * address from scrapers, and the whole address is present in the source — this
 * only joins literals that are already there. It deliberately does NOT try to
 * resolve variables: reassembling `var u="info", d="example.co.uk"` would be
 * constructing an address rather than reading one, and a constructed address
 * is a guess however plausible it looks.
 */
export function joinScriptLiterals(html: string): string {
  const out: string[] = [];
  for (const block of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const code = block[1] ?? "";
    // Runs of quoted literals joined by +, e.g. "a" + "@" + "b.co.uk".
    for (const run of code.matchAll(/(["'])(?:(?!\1)[^\\\r\n]|\\.)*\1(?:\s*\+\s*(["'])(?:(?!\2)[^\\\r\n]|\\.)*\2)+/g)) {
      const joined = (run[0].match(/(["'])((?:(?!\1)[^\\\r\n]|\\.)*)\1/g) ?? [])
        .map((literal) => literal.slice(1, -1))
        .join("");
      if (joined.includes("@")) out.push(joined);
    }
  }
  return out.join(" ");
}

// ── Extraction ───────────────────────────────────────────────────────────────

function cleanEmail(raw: string): string {
  return raw.trim().replace(/^[<("']+/, "").replace(/[.,;:)>"']+$/, "").toLowerCase();
}

function hostOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

function localOf(email: string): string {
  return email.slice(0, email.lastIndexOf("@"));
}

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/** Is this a plausible business mailbox at all? Cheap structural rejection. */
export function looksUsable(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const local = localOf(email);
  const host = hostOf(email);
  if (!local || local.length > 64 || host.length > 80) return false;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return false;
  if (/\.\./.test(host) || host.startsWith("-")) return false;
  if (SKIP_LOCAL.test(local)) return false;
  if (BAD_TLD.test(host.split(".").pop() ?? "")) return false;
  if (hostMatches(host, SKIP_HOSTS)) return false;
  if (hostMatches(host, DISPOSABLE)) return false;
  if (/^[a-z0-9._%+-]+$/i.test(local) === false) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host);
}

function push(
  out: EmailCandidate[],
  seen: Set<string>,
  email: string,
  candidate: Omit<EmailCandidate, "email">,
): void {
  const clean = cleanEmail(email);
  if (!looksUsable(clean) || seen.has(clean)) return;
  seen.add(clean);
  out.push({ email: clean, ...candidate });
}

/**
 * Every address a page publishes, with how it was found.
 *
 * Deliberately several passes over the same HTML: a `mailto:` is much stronger
 * evidence than the same address appearing in body text, and the method is what
 * the score is built from. First sighting of an address wins, and the passes run
 * strongest-first, so an address that is both a mailto and body text is recorded
 * as the mailto.
 */
export function extractCandidates(
  html: string,
  pageUrl: string,
  source: SourceKind,
): EmailCandidate[] {
  const out: EmailCandidate[] = [];
  const seen = new Set<string>();
  if (!html) return out;

  // 1. mailto: — the business explicitly linking its own address.
  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"'?]+)/gi)) {
    push(out, seen, decodeURIComponent(m[1] ?? ""), {
      source, sourceUrl: pageUrl, method: "MAILTO_LINK",
      evidence: "Published as a mailto: link on the page",
    });
  }

  // 2. JSON-LD / structured data.
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of (block[1] ?? "").matchAll(EMAIL_RE)) {
      push(out, seen, m[0], {
        source: source === "OFFICIAL_WEBSITE" ? "STRUCTURED_DATA" : source,
        sourceUrl: pageUrl, method: "JSON_LD",
        evidence: "Listed in the page's structured business data",
      });
    }
  }

  // 3. Meta tags.
  for (const tag of html.matchAll(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    for (const m of (tag[1] ?? "").matchAll(EMAIL_RE)) {
      push(out, seen, m[0], {
        source, sourceUrl: pageUrl, method: "META_TAG",
        evidence: "Declared in a page meta tag",
      });
    }
  }

  // 4. Inline script payloads — how a rendered site ships its contact details
  //    without putting them in the served markup. This is the fallback that
  //    avoids needing a headless browser.
  for (const block of html.matchAll(/<script(?![^>]+application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of (block[1] ?? "").matchAll(EMAIL_RE)) {
      push(out, seen, m[0], {
        source, sourceUrl: pageUrl, method: "INLINE_PAYLOAD",
        evidence: "Found in the page's inline data payload",
      });
    }
  }

  // 5. Visible text.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  for (const m of text.matchAll(EMAIL_RE)) {
    push(out, seen, m[0], {
      source, sourceUrl: pageUrl, method: "PAGE_TEXT",
      evidence: "Written out on the page",
    });
  }

  // 6. Obfuscated forms, last — only what the earlier passes did not already find.
  const decoded = deobfuscate(text.replace(/<[^>]+>/g, " "));
  for (const m of decoded.matchAll(EMAIL_RE)) {
    push(out, seen, m[0], {
      source, sourceUrl: pageUrl, method: "DEOBFUSCATED",
      evidence: "Written with [at]/[dot] separators on the page",
    });
  }

  // 7. Addresses assembled from adjacent string literals in a script. The whole
  //    address is in the source; this only closes up the joins.
  //    Reads `html`, not `text`: step 5 strips script blocks out of `text`, so
  //    passing that here would hand the joiner a page with no scripts in it.
  for (const m of joinScriptLiterals(html).matchAll(EMAIL_RE)) {
    push(out, seen, m[0], {
      source, sourceUrl: pageUrl, method: "DEOBFUSCATED",
      evidence: "Built from adjacent string literals in the page's own script",
    });
  }

  return out;
}

/** Internal links worth following, best first, de-duplicated. */
export function contactLinks(html: string, pageUrl: string, max = 4): string[] {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const scored: { url: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const raw of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = raw[1] ?? "";
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) continue;
    if (!CONTACT_HREF.test(href)) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (absolute.origin !== origin) continue;
    absolute.hash = "";
    const url = absolute.toString();
    const path = absolute.pathname.replace(/\/+$/, "");
    if (path === "" || seen.has(url)) continue;
    seen.add(url);
    // A page called "contact" beats one called "about".
    const rank = /contact|get-?in-?touch|enquir/i.test(path) ? 0 : /quote|book/i.test(path) ? 1 : 2;
    scored.push({ url, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, max).map((entry) => entry.url);
}

/** Contact-ish URLs from a sitemap, best first. Finds pages nothing links to. */
export function sitemapContactUrls(xml: string, origin: string, max = 4): string[] {
  const out: { url: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const raw = m[1] ?? "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (origin && url.origin !== origin) continue;
    const path = url.pathname.toLowerCase();
    if (!CONTACT_HREF.test(path)) continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, rank: /contact|get-?in-?touch|enquir/i.test(path) ? 0 : 1 });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, max).map((entry) => entry.url);
}

/** Nested sitemap index files, so a sitemap-of-sitemaps still resolves. */
export function sitemapIndexUrls(xml: string, origin: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi)) {
    try {
      const url = new URL(m[1] ?? "");
      if (!origin || url.origin === origin) out.push(url.toString());
    } catch {
      /* skip */
    }
    if (out.length >= max) break;
  }
  return out;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export type ScoreContext = {
  /** The business's own website, for domain matching. */
  websiteUrl: string;
  businessName: string;
};

const METHOD_POINTS: Record<DiscoveryMethod, number> = {
  MAILTO_LINK: 30,
  JSON_LD: 26,
  META_TAG: 22,
  PAGE_TEXT: 20,
  INLINE_PAYLOAD: 16,
  DEOBFUSCATED: 16,
  LISTING_FIELD: 14,
};

const SOURCE_POINTS: Record<SourceKind, number> = {
  OFFICIAL_CONTACT_PAGE: 40,
  OFFICIAL_WEBSITE: 34,
  STRUCTURED_DATA: 32,
  PUBLIC_BUSINESS_PROFILE: 26,
  PUBLIC_DIRECTORY: 22,
  // An address a mapper or registrar recorded against this business. Weaker
  // than reading it off the company's own site, but it is still a published
  // address tied to this business by whoever maintains the listing.
  //
  // Calibrated so a bare listing address lands at exactly MEDIUM (36 + 14):
  // that is what it is — good enough to write to, never good enough to call
  // HIGH, and a domain match still leaves it below the HIGH threshold. Scoring
  // it any lower silently discarded every `contact:email` OpenStreetMap
  // supplied, which is the single commonest address the search ever sees.
  EXISTING_LISTING: 36,
};

/** Loose token overlap between a mailbox and the business's name. */
function nameOverlap(email: string, businessName: string): boolean {
  const words = businessName.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const blob = email.toLowerCase().replace(/[^a-z]/g, "");
  return words.some((word) => blob.includes(word));
}

/**
 * What one candidate is worth, and why.
 *
 * A domain match with the business's own website is the strongest single
 * signal, but its absence is NOT disqualifying: plenty of real sole traders
 * publish a Gmail address on their own contact page, and refusing those would
 * throw away good prospects. What that costs is the domain-match points, not
 * eligibility.
 */
export function scoreCandidate(candidate: EmailCandidate, context: ScoreContext): ScoredCandidate {
  const notes: string[] = [];
  let score = SOURCE_POINTS[candidate.source] + METHOD_POINTS[candidate.method];
  notes.push(`source ${candidate.source}`, `method ${candidate.method}`);

  const host = hostOf(candidate.email);
  const local = localOf(candidate.email);
  const siteHost = hostnameOf(context.websiteUrl);
  const domainMatch = Boolean(
    siteHost && (host === siteHost || host.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${host}`)),
  );

  if (domainMatch) {
    score += 22;
    notes.push("matches the website's own domain");
  } else if (PERSONAL_HOSTS.has(host)) {
    if (nameOverlap(candidate.email, context.businessName)) {
      score += 6;
      notes.push("consumer mailbox, but the name matches the business");
    } else {
      notes.push("consumer mailbox on a different domain");
    }
  } else if (siteHost && candidate.source !== "EXISTING_LISTING") {
    // Only a penalty when we actually read the address off a site whose domain
    // disagrees with it. A listing address is not published on the website at
    // all, so there is no disagreement to penalise.
    score -= 8;
    notes.push("different domain from the website");
  }

  if (ROLE_LOCAL.test(local)) {
    score += 10;
    notes.push("general business mailbox");
  }

  score = Math.max(0, Math.min(100, score));
  const confidence = score >= 75 ? "HIGH" : score >= 50 ? "MEDIUM" : "LOW";
  return { ...candidate, score, confidence, notes };
}

/** Best first: score, then a role mailbox, then the shorter address. */
export function rankCandidates(
  candidates: readonly EmailCandidate[],
  context: ScoreContext,
): ScoredCandidate[] {
  const scored = candidates.map((candidate) => scoreCandidate(candidate, context));
  const byEmail = new Map<string, ScoredCandidate>();
  for (const entry of scored) {
    const existing = byEmail.get(entry.email);
    if (!existing || entry.score > existing.score) byEmail.set(entry.email, entry);
  }
  return [...byEmail.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aRole = ROLE_LOCAL.test(localOf(a.email)) ? 0 : 1;
    const bRole = ROLE_LOCAL.test(localOf(b.email)) ? 0 : 1;
    return aRole - bRole || a.email.length - b.email.length;
  });
}

// ── The verdict ──────────────────────────────────────────────────────────────

export type DecideInput = {
  candidates: readonly EmailCandidate[];
  context: ScoreContext;
  sourcesChecked: string[];
  attempts: number;
  /** Set when fetching failed rather than merely finding nothing. */
  failure?: DiscoveryReason | null;
  /** True when at least one page that should hold contact details was read. */
  sawContactPage?: boolean;
  /** True when text looked like an obfuscated address but would not decode. */
  sawUnreadableObfuscation?: boolean;
};

/**
 * Turn what was found into an answer, with the reason attached.
 *
 * "No email found" on its own is useless to whoever reads it next, so every
 * unsuccessful outcome names what stopped it — and every outcome says what to
 * do with the lead, because a business with no published address is a phone
 * call, not a failure.
 */
export function decide(input: DecideInput): DiscoveryResult {
  const ranked = rankCandidates(input.candidates, input.context);
  const base = {
    sourcesChecked: input.sourcesChecked,
    attempts: input.attempts,
    alternatives: ranked.slice(1, 5),
  };

  if (ranked.length === 0) {
    const reason: DiscoveryReason =
      input.failure ??
      (input.sawUnreadableObfuscation
        ? "EMAIL_OBFUSCATED_UNREADABLE"
        : input.sawContactPage
          ? "CONTACT_PAGE_NO_EMAIL"
          : "NO_CONTACT_PAGE");
    return {
      status: input.failure === "BLOCKED_BY_SITE" || input.failure === "RATE_LIMITED" ? "BLOCKED" : "NOT_FOUND",
      email: null, confidence: null, score: null, source: null, sourceUrl: "",
      evidence: "", reason, nextAction: "CALL", ...base,
    };
  }

  const best = ranked[0];
  const shared = {
    email: best.email,
    confidence: best.confidence,
    score: best.score,
    source: best.source,
    sourceUrl: best.sourceUrl,
    evidence: best.evidence,
    ...base,
  };

  if (best.confidence === "LOW") {
    // Weak evidence is kept and shown, never sent to. The lead is a call.
    return { status: "LOW_CONFIDENCE", reason: "EMAIL_LOW_CONFIDENCE", nextAction: "CALL", ...shared };
  }
  return { status: "FOUND", reason: null, nextAction: "SEND", ...shared };
}

/** Nothing to search: the lead has no website and no listing address. */
export function noWebsiteResult(): DiscoveryResult {
  return {
    status: "NOT_FOUND", email: null, confidence: null, score: null, source: null,
    sourceUrl: "", evidence: "", reason: "NO_WEBSITE", sourcesChecked: [], attempts: 0,
    alternatives: [], nextAction: "CALL",
  };
}

/** Absolute ceiling on pages fetched for one lead. */
export const MAX_PAGES = 8;
/** Stop as soon as something this good is in hand. */
export const GOOD_ENOUGH_SCORE = 75;

// ── Caching ──────────────────────────────────────────────────────────────────

/** How long a discovery result is trusted before the site is read again. */
export const DISCOVERY_FRESH_DAYS = 30;

/**
 * Has this lead been searched recently enough to skip?
 *
 * Only when a search actually resolved: a lead with a recent timestamp AND an
 * address is settled. One that was searched and found nothing is retried, since
 * a business that had no address in March may have published one by May — just
 * not on every run.
 */
export function discoveryIsFresh(
  lead: { email: string; emailFoundAt: string },
  now: Date = new Date(),
  withinDays = DISCOVERY_FRESH_DAYS,
): boolean {
  if (!lead.email.trim()) return false;
  const at = Date.parse(lead.emailFoundAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at < withinDays * 24 * 60 * 60 * 1000;
}

// ── Run statistics ───────────────────────────────────────────────────────────

/** What a run's email discovery achieved, and where the addresses came from. */
export type DiscoveryTally = {
  searched: number;
  found: number;
  cached: number;
  /** Found, by where the address came from. */
  bySource: Record<SourceKind, number>;
  /** Not found, by why. */
  byReason: Record<string, number>;
  high: number;
  medium: number;
  low: number;
};

export function emptyTally(): DiscoveryTally {
  return {
    searched: 0, found: 0, cached: 0,
    bySource: {
      OFFICIAL_CONTACT_PAGE: 0, OFFICIAL_WEBSITE: 0, STRUCTURED_DATA: 0,
      PUBLIC_BUSINESS_PROFILE: 0, PUBLIC_DIRECTORY: 0, EXISTING_LISTING: 0,
    },
    byReason: {}, high: 0, medium: 0, low: 0,
  };
}

/** Fold one lead's result into the run's tally. Mutates, and returns it. */
export function tallyDiscovery(tally: DiscoveryTally, result: DiscoveryResult): DiscoveryTally {
  tally.searched += 1;
  if (result.status === "FOUND" && result.source) {
    tally.found += 1;
    tally.bySource[result.source] += 1;
  } else if (result.reason) {
    tally.byReason[result.reason] = (tally.byReason[result.reason] ?? 0) + 1;
  }
  if (result.confidence === "HIGH") tally.high += 1;
  else if (result.confidence === "MEDIUM") tally.medium += 1;
  else if (result.confidence === "LOW") tally.low += 1;
  return tally;
}

/** Human wording for a failure reason, for the dashboard. */
export const REASON_LABELS: Record<DiscoveryReason, string> = {
  NO_WEBSITE: "No website to search",
  WEBSITE_UNREACHABLE: "Website would not load",
  NO_CONTACT_PAGE: "No contact page found",
  CONTACT_PAGE_NO_EMAIL: "Contact page had no address",
  EMAIL_OBFUSCATED_UNREADABLE: "Address was scrambled beyond reading",
  PUBLIC_PROFILE_NO_EMAIL: "Public profile listed no address",
  DIRECTORY_NO_EMAIL: "Directory listing had no address",
  EMAIL_INVALID: "The address found was not valid",
  EMAIL_LOW_CONFIDENCE: "Only weak evidence for the address",
  RATE_LIMITED: "Site asked us to slow down",
  BLOCKED_BY_SITE: "Site blocked the request",
  WEBSITE_NOT_VERIFIED: "Found possible sites, none provably this business",
  SEARCH_PROVIDER_UNAVAILABLE: "No search key configured — only the listing and domain guesses were tried",
  SEARCH_AUTH_FAILED: "The search provider rejected the API key — check it in the deployment settings",
  SEARCH_RATE_LIMITED: "The search provider asked us to slow down — try again shortly",
  SEARCH_QUOTA_EXHAUSTED: "The search provider's quota is used up — no more searches until it resets",
  ONLY_DIRECTORY_LISTINGS_FOUND: "Only directory and social listings were found, never the business's own site",
};

/** Where most of this run's addresses came from, for the one-line summary. */
export function bestSource(tally: DiscoveryTally): { source: SourceKind; count: number } | null {
  const entries = (Object.entries(tally.bySource) as [SourceKind, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return entries[0] ? { source: entries[0][0], count: entries[0][1] } : null;
}

/** The reason blocking the most leads — the thing worth fixing next. */
export function biggestBottleneck(tally: DiscoveryTally): { reason: string; count: number } | null {
  const entries = Object.entries(tally.byReason).sort((a, b) => b[1] - a[1]);
  return entries[0] ? { reason: entries[0][0], count: entries[0][1] } : null;
}
