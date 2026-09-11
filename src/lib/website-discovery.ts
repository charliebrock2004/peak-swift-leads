/**
 * Finding a business's website when the listing did not carry one.
 *
 * This is the real bottleneck. A live run for hairdressers around Perth found
 * twelve businesses and one address, and the blocker was not parsing: eight of
 * the twelve had no website on their listing, so email discovery never ran at
 * all. OpenStreetMap and Companies House simply do not record a URL for most
 * small businesses, and "No Website Found" on a listing is not evidence that
 * the business has no site.
 *
 * Pure: no network. The caller fetches; this module decides what is worth
 * fetching and, crucially, whether what came back actually belongs to the
 * business we were looking for.
 *
 * THE SAFETY PROPERTY THAT MATTERS: a candidate domain is a guess, and a guess
 * is only ever allowed to become a lead's website after a page has been fetched
 * and shown to carry that business's own details. Attaching the wrong site
 * would produce a confident, evidenced, completely wrong email — worse than
 * finding nothing. `scoreWebsiteMatch` is what stands between those two
 * outcomes, and it demands corroboration rather than resemblance.
 */

/** UK-first, because that is where the leads are. Order is what gets tried. */
const TLDS = [".co.uk", ".com", ".uk", ".scot"] as const;

/** Words that carry no identity and only dilute a domain guess. */
const STOPWORDS = new Set([
  "the", "and", "ltd", "limited", "llp", "plc", "cic", "co", "company",
  "services", "service", "group", "uk", "scotland",
]);

/** Trade words worth appending, since many small firms include them. */
const TRADE_SUFFIXES: Record<string, string[]> = {
  hairdresser: ["hair", "hairdressing", "salon"],
  barber: ["barbers", "barbershop"],
  joiner: ["joinery"],
  plumber: ["plumbing"],
  electrician: ["electrical"],
  builder: ["builders", "construction"],
  roofer: ["roofing"],
  painter: ["decorating"],
  landscaper: ["landscaping", "gardens"],
};

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    // Single letters are kept: "Salon T.Elle" is salontelle, not salonelle.
    // The length floor on the joined stem is what keeps initials-only names out.
    .filter((word) => word.length >= 1 && !STOPWORDS.has(word));
}

/** How many candidate domains one lead may ever cost. */
export const MAX_WEBSITE_CANDIDATES = 6;

/**
 * Plausible hostnames for this business, best first.
 *
 * These are guesses and are treated as such — nothing here is ever recorded
 * against the lead. They exist only to give `scoreWebsiteMatch` something to
 * check, and a candidate that cannot be corroborated is discarded.
 */
export function candidateDomains(
  businessName: string,
  town: string,
  trade = "",
  max = MAX_WEBSITE_CANDIDATES,
): string[] {
  const parts = words(businessName);
  if (parts.length === 0) return [];
  const joined = parts.join("");
  if (joined.length < 4 || joined.length > 40) return [];

  const stems: string[] = [joined];
  if (parts.length > 1) stems.push(parts.join("-"));
  const townWord = words(town)[0];
  if (townWord && !joined.includes(townWord)) stems.push(`${joined}${townWord}`);
  for (const suffix of TRADE_SUFFIXES[trade.trim().toLowerCase()] ?? []) {
    if (!joined.includes(suffix)) stems.push(`${joined}${suffix}`);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  // Breadth-first across TLDs: the .co.uk of every stem before any .com, since
  // a UK trade business is far likelier to hold the former.
  for (const tld of TLDS) {
    for (const stem of stems) {
      const host = `${stem}${tld}`;
      if (seen.has(host) || host.length > 60) continue;
      seen.add(host);
      out.push(host);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** What a fetched page showed, for deciding whether it is the right business. */
export type SiteEvidence = {
  url: string;
  /** The page's own text, already stripped of markup by the caller. */
  text: string;
  title: string;
};

export type BusinessIdentity = {
  businessName: string;
  town: string;
  trade: string;
  phone: string;
};

export type WebsiteMatch = {
  url: string;
  score: number;
  confidence: "STRONG" | "POSSIBLE" | "REJECTED";
  /** Every signal that fired, in words. This is the audit trail. */
  evidence: string[];
};

/** Digits only, so `01334 652000` and `+44 1334 652000` compare equal. */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("44")) return `0${digits.slice(2)}`;
  return digits;
}

/** Does the page carry this phone number, in any of the usual spellings? */
export function pageHasPhone(text: string, phone: string): boolean {
  const want = normalisePhone(phone);
  if (want.length < 9) return false;
  const onPage = text.replace(/\D/g, "");
  if (onPage.includes(want)) return true;
  // Also match without the leading zero, and the +44 form.
  const trunk = want.replace(/^0/, "");
  return trunk.length >= 9 && (onPage.includes(trunk) || onPage.includes(`44${trunk}`));
}

/** The threshold below which a candidate is never attached to a lead. */
export const WEBSITE_MIN_SCORE = 75;

/**
 * Is this page the business we were looking for?
 *
 * Corroboration, not resemblance. The phone number is the decisive signal: a
 * site that prints the same number the listing holds is almost certainly the
 * same business, and almost nothing else gives that confidence on its own.
 * Name and town agreement together can carry a candidate, but a name match
 * alone never can — "Cutting Edge" is a hairdresser in a dozen towns, and
 * attaching the wrong one would produce a confident, evidenced, wrong email.
 */
export function scoreWebsiteMatch(evidence: SiteEvidence, identity: BusinessIdentity): WebsiteMatch {
  const notes: string[] = [];
  let score = 0;
  const haystack = `${evidence.title} ${evidence.text}`.toLowerCase();

  const nameWords = words(identity.businessName);
  const matchedWords = nameWords.filter((word) => haystack.includes(word));
  const nameRatio = nameWords.length === 0 ? 0 : matchedWords.length / nameWords.length;
  const fullName = nameWords.join(" ");
  const titleHasName = fullName.length > 0 && words(evidence.title).join(" ").includes(fullName);

  if (identity.phone && pageHasPhone(haystack, identity.phone)) {
    score += 55;
    notes.push("the listing's phone number is printed on the page");
  }
  if (titleHasName) {
    // The site is *about* this business, not merely mentioning it.
    score += 35;
    notes.push("the page title is the business name");
  } else if (nameRatio >= 0.99) {
    score += 20;
    notes.push("every word of the business name appears on the page");
  } else if (nameRatio >= 0.5) {
    score += 10;
    notes.push("part of the business name appears on the page");
  }
  const townWord = words(identity.town)[0];
  if (townWord && haystack.includes(townWord)) {
    score += 15;
    notes.push("the town matches");
  }
  const tradeWord = words(identity.trade)[0];
  if (tradeWord && haystack.includes(tradeWord.replace(/er$/, ""))) {
    score += 10;
    notes.push("the trade matches");
  }

  // Name and town together are far more specific than either alone: a business
  // name repeats across the country, but this name in this town usually does
  // not. Without the pairing, the same name in a different town scores well
  // below the bar — which is the failure this bonus exists to keep out.
  if (titleHasName && townWord && haystack.includes(townWord)) {
    score += 15;
    notes.push("the business name and the town agree");
  }

  // A page that does not name the business at all is not the business, however
  // many other words happen to line up.
  if (nameRatio < 0.5 && !titleHasName) {
    score = Math.min(score, 40);
    notes.push("the business name is largely absent — held back");
  }

  score = Math.max(0, Math.min(100, score));
  const confidence = score >= WEBSITE_MIN_SCORE ? "STRONG" : score >= 55 ? "POSSIBLE" : "REJECTED";
  return { url: evidence.url, score, confidence, evidence: notes };
}

/** Strip markup to the text `scoreWebsiteMatch` reads. */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitle(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** Best corroborated candidate, or null when none clears the bar. */
export function bestWebsite(matches: readonly WebsiteMatch[]): WebsiteMatch | null {
  const strong = matches
    .filter((match) => match.score >= WEBSITE_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  return strong[0] ?? null;
}
