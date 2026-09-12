/**
 * Phase 2 — website quality and public email discovery.
 *
 * Rules-based, not AI. A page is fetched and scored from public HTML only.
 * Emails are extracted from that HTML (and a same-origin contact page if the
 * homepage links to one). Nothing is guessed from a domain, and nothing is sent.
 */
import {
  classifyWebsiteUrl,
  computeOpportunity,
  hasWebsite,
  hostnameOf,
  type EmailConfidence,
  type Lead,
  type WebsiteQuality,
  type WebsiteStatus,
} from "./leads.ts";

export type WebsiteCheck = {
  quality: WebsiteQuality;
  score: number | "";
  analysis: string;
  https: boolean;
  reachable: boolean;
  websiteStatus: WebsiteStatus | "";
};

export type FoundEmail = {
  email: string;
  source: string;
  confidence: EmailConfidence;
};

const PARKED =
  /coming soon|under construction|domain for sale|buy this domain|parked free|this domain is parked|website currently unavailable|account suspended/i;

const SKIP_EMAIL_HOSTS = [
  "sentry.io",
  "wixpress.com",
  "wordpress.com",
  "example.com",
  "schema.org",
  "google.com",
  "gstatic.com",
  "w3.org",
  "cloudflare.com",
  "jquery.com",
  "github.com",
  "googleapis.com",
  "wix.com",
  "squarespace.com",
  "godaddy.com",
  "shopify.com",
];

const SKIP_EMAIL_LOCAL = /^(noreply|no-reply|no_reply|privacy|legal|webmaster|hostmaster|postmaster|mailer-daemon|abuse)$/i;

const BAD_EMAIL_TLD = /^(png|jpe?g|gif|svg|webp|css|js|mjs|woff2?|ttf|eot|html?|php|aspx?)$/i;

const ROLE_LOCAL = /^(info|hello|enquiries|enquiry|contact|office|sales|bookings|booking|admin|mail)$/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&|<|>|"|&#39;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostMatches(host: string, list: string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function nameTokens(businessName: string): string[] {
  return businessName
    .toLowerCase()
    .replace(/\b(limited|ltd|llp|plc|inc|company|co)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3);
}

/**
 * SUPERSEDED by `@/lib/email-discovery`, which checks contact pages, sitemaps,
 * structured data and obfuscated forms rather than one page's plain text, and
 * reports why it failed. Kept because its tests document the extraction rules,
 * but nothing in the app calls it any more — reach for the engine instead.
 */
export function extractEmails(html: string): string[] {
  const found = html.match(EMAIL_RE) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const email = raw.replace(/[.,;:)>]+$/, "").toLowerCase();
    if (seen.has(email)) continue;
    const at = email.lastIndexOf("@");
    if (at < 1) continue;
    const local = email.slice(0, at);
    const host = email.slice(at + 1);
    const tld = host.split(".").pop() ?? "";
    if (SKIP_EMAIL_LOCAL.test(local)) continue;
    if (BAD_EMAIL_TLD.test(tld)) continue;
    if (hostMatches(host, SKIP_EMAIL_HOSTS)) continue;
    if (local.length > 64 || host.length > 80) continue;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) continue;
    seen.add(email);
    unique.push(email);
  }
  return unique;
}

export function pickBusinessEmail(
  emails: string[],
  websiteUrl: string,
): FoundEmail | null {
  if (emails.length === 0) return null;
  const siteHost = hostnameOf(websiteUrl);
  const same = emails.filter((email) => {
    const host = email.split("@")[1] ?? "";
    return siteHost && (host === siteHost || host.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${host}`));
  });
  const ranked = (same.length ? same : emails).slice().sort((a, b) => {
    const aRole = ROLE_LOCAL.test(a.split("@")[0] ?? "") ? 0 : 1;
    const bRole = ROLE_LOCAL.test(b.split("@")[0] ?? "") ? 0 : 1;
    return aRole - bRole || a.length - b.length;
  });
  const email = ranked[0];
  if (!email) return null;
  const host = email.split("@")[1] ?? "";
  const sameDomain = Boolean(
    siteHost && (host === siteHost || host.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${host}`)),
  );
  if (sameDomain) {
    return { email, source: "Business website", confidence: "HIGH" };
  }
  return { email, source: "Business website (other mailbox)", confidence: "MEDIUM" };
}

export function contactLinksFrom(html: string, pageUrl: string): string[] {
  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return "";
    }
  })();
  if (!origin) return [];
  const hrefs = html.match(/href\s*=\s*["']([^"']+)["']/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hrefs) {
    const href = raw.replace(/^href\s*=\s*["']/i, "").replace(/["']$/, "");
    if (!/contact|get-in-touch|enquire|enquiry|book/i.test(href)) continue;
    if (href.startsWith("mailto:")) continue;
    let absolute = href;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (!absolute.startsWith(origin)) continue;
    const path = absolute.replace(origin, "");
    if (path === "" || path === "/" || seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
    if (out.length >= 2) break;
  }
  return out;
}

export function scoreWebsitePage(input: {
  url: string;
  finalUrl?: string;
  status?: number;
  html?: string;
  businessName: string;
  unreachable?: boolean;
}): WebsiteCheck {
  const finalUrl = input.finalUrl || input.url;
  const classified = classifyWebsiteUrl(finalUrl);

  if (input.unreachable) {
    return {
      quality: "unable",
      score: "",
      analysis: "Could not reach this website.",
      https: /^https:/i.test(finalUrl),
      reachable: false,
      websiteStatus: "",
    };
  }

  if (classified === "Social Only") {
    return {
      quality: "poor",
      score: 28,
      analysis: "This is a social profile, not a business website.",
      https: /^https:/i.test(finalUrl),
      reachable: true,
      websiteStatus: "Social Only",
    };
  }
  if (classified === "Directory Only") {
    return {
      quality: "poor",
      score: 26,
      analysis: "This is a directory listing, not a business website.",
      https: /^https:/i.test(finalUrl),
      reachable: true,
      websiteStatus: "Directory Only",
    };
  }

  const status = input.status ?? 0;
  if (status >= 400) {
    return {
      quality: "poor",
      score: 18,
      analysis: "The site returned an error and looks broken.",
      https: /^https:/i.test(finalUrl),
      reachable: true,
      websiteStatus: "",
    };
  }

  const html = input.html ?? "";
  const text = stripHtml(html);
  const https = /^https:/i.test(finalUrl);
  const viewport = /name=["']viewport["']/i.test(html);
  const parked = PARKED.test(html) || PARKED.test(text);
  const tokens = nameTokens(input.businessName);
  const haystack = `${html} ${text}`.toLowerCase();
  const hasName = tokens.length === 0 || tokens.some((token) => haystack.includes(token));
  const hasPhone = /tel:|\+44\d{10}|0\d{3,4}\s?\d{3,4}\s?\d{3,4}/i.test(html);
  const hasMailto = /mailto:/i.test(html);
  const hasForm = /<form[\s>]/i.test(html) || /type=["']submit["']/i.test(html);
  const hasContact = hasPhone || hasMailto || hasForm || /contact us|get in touch|enquire/i.test(text);
  const hasServices =
    /our services|what we do|about us|we offer|we provide|our work|joinery|plumbing|electrical|builder|hair|menu|book now|opening hours/i.test(
      text,
    );
  const thin = text.length < 400;
  const substantial = text.length >= 1500;

  if (parked) {
    return {
      quality: "poor",
      score: 12,
      analysis: "The domain looks parked or unfinished.",
      https,
      reachable: true,
      websiteStatus: "Basic Website",
    };
  }

  if (text.length < 80) {
    return {
      quality: "poor",
      score: 22,
      analysis: "The page loaded but had almost no readable content.",
      https,
      reachable: true,
      websiteStatus: "Basic Website",
    };
  }

  let score = 42;
  if (https) score += 12;
  else score -= 8;
  if (viewport) score += 10;
  if (hasName) score += 10;
  if (hasContact) score += 12;
  if (hasServices) score += 8;
  if (!thin) score += 8;
  if (substantial) score += 6;
  if (thin) score -= 10;
  if (!hasContact && thin) score -= 12;

  // A short but complete site is "could improve", not "poor" — and not "good".
  if (thin) score = Math.min(score, 68);
  if (thin && hasName && hasContact && https) {
    score = Math.max(score, 50);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let quality: Exclude<WebsiteQuality, ""> = "improve";
  if (score >= 70) quality = "good";
  else if (score < 45) quality = "poor";

  const analysis = reasonFor({
    quality,
    https,
    viewport,
    hasName,
    hasContact,
    hasServices,
    thin,
    substantial,
  });

  const websiteStatus: WebsiteStatus =
    quality === "good" ? "Proper Website" : thin || quality === "poor" ? "Basic Website" : "Proper Website";

  return {
    quality,
    score,
    analysis,
    https,
    reachable: true,
    websiteStatus,
  };
}

function reasonFor(flags: {
  quality: Exclude<WebsiteQuality, "">;
  https: boolean;
  viewport: boolean;
  hasName: boolean;
  hasContact: boolean;
  hasServices: boolean;
  thin: boolean;
  substantial: boolean;
}): string {
  if (flags.quality === "good") {
    return "Loads cleanly with the business named, contact details, and a usable layout.";
  }
  if (flags.thin && flags.hasContact && flags.hasName) {
    return "Website works but has very little information. Contact details are present.";
  }
  const gaps: string[] = [];
  if (!flags.https) gaps.push("not on HTTPS");
  if (!flags.viewport) gaps.push("no mobile viewport tag");
  if (!flags.hasName) gaps.push("business name not obvious");
  if (!flags.hasContact) gaps.push("no clear way to get in touch");
  if (!flags.hasServices) gaps.push("services are not explained");
  if (flags.thin) gaps.push("very little content");
  if (gaps.length === 0) {
    return "Website works and could be clearer or more complete.";
  }
  return `Website works, but ${gaps.slice(0, 3).join(", ")}.`;
}

export function inventingEmailWouldBe(domain: string): string {
  return `info@${domain.replace(/^www\./i, "")}`;
}

export function hasWebsiteToCheck(website: string): boolean {
  return hasWebsite(website) && Boolean(hostnameOf(website));
}

/**
 * Turning a check result into a lead patch.
 *
 * Extracted so the lead sheet's buttons and the AI Outreach run apply *exactly*
 * the same fields in the same way. Two copies of this mapping would eventually
 * disagree, and the one that drifts would be the one deciding who gets emailed.
 */
export function websitePatch(
  lead: Pick<Lead, "website" | "websiteStatus" | "websiteQuality" | "email" | "emailConfidence" | "reviews" | "rating" | "businessStatus">,
  check: WebsiteCheck,
  checkedAt: string,
): Partial<Lead> {
  const patch: Partial<Lead> = {
    websiteQuality: check.quality,
    websiteScore: check.score,
    websiteAnalysis: check.analysis,
    websiteCheckedAt: checkedAt,
  };
  if (check.websiteStatus) patch.websiteStatus = check.websiteStatus;
  patch.opportunityScore = computeOpportunity({ ...lead, ...patch } as Lead);
  return patch;
}

/** The same, for an email lookup. `null` means looked and found nothing. */
export function emailPatch(
  lead: Pick<Lead, "website" | "websiteStatus" | "websiteQuality" | "email" | "emailConfidence" | "reviews" | "rating" | "businessStatus">,
  found: FoundEmail | null,
  foundAt: string,
): Partial<Lead> {
  if (!found) return { emailFoundAt: foundAt };
  const patch: Partial<Lead> = {
    email: found.email,
    emailSource: found.source,
    emailConfidence: found.confidence,
    emailFoundAt: foundAt,
  };
  patch.opportunityScore = computeOpportunity({ ...lead, ...patch } as Lead);
  return patch;
}

/**
 * Persist a STRONG, corroborated business website discovered during email lookup.
 *
 * Never overwrites a site the lead already has, and never records a directory,
 * social profile, or POSSIBLE (unproven) candidate. False negatives are fine;
 * attaching the wrong site is not.
 */
export function discoveredWebsitePatch(
  lead: Pick<Lead, "website" | "websiteStatus" | "websiteQuality" | "email" | "emailConfidence" | "reviews" | "rating" | "businessStatus">,
  match: { url: string; confidence: string; character: string } | null | undefined,
): Partial<Lead> {
  if (!match || match.confidence !== "STRONG" || match.character !== "BUSINESS") return {};
  const current = classifyWebsiteUrl(lead.website);
  if (current === "Proper Website" || current === "Basic Website") return {};
  const status = classifyWebsiteUrl(match.url);
  if (status !== "Proper Website" && status !== "Basic Website") return {};
  const patch: Partial<Lead> = {
    website: match.url,
    websiteStatus: status,
  };
  patch.opportunityScore = computeOpportunity({ ...lead, ...patch } as Lead);
  return patch;
}
