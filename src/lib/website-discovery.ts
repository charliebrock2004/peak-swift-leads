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
  /**
   * Search snippet / result title for THIS candidate only.
   *
   * Used for unique identity signals (phone, postcode) when the fetched page
   * does not print them — common on JS-rendered homepages. Never used for
   * name/town/trade (those echo the query) and never for contradiction or
   * page-character detection. A snippet phone is ignored when the page itself
   * prints a different number.
   */
  extraText?: string;
};

export type BusinessIdentity = {
  businessName: string;
  town: string;
  trade: string;
  phone: string;
  /** Street address as the listing recorded it; usually carries the postcode. */
  address?: string;
};

/**
 * A UK postcode out of a free-text address.
 *
 * Worth isolating because it is the most specific identity signal there is: two
 * businesses sharing a name, a town and a trade will not share a postcode.
 */
export function extractPostcode(address: string): string {
  const match = address
    .toUpperCase()
    .match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return match ? `${match[1]} ${match[2]}` : "";
}

/** Postcodes compare without spacing, since pages write them both ways. */
export function samePostcode(a: string, b: string): boolean {
  const norm = (value: string) => value.toUpperCase().replace(/\s+/g, "");
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Does the page carry this postcode, however it is spaced? */
export function pageHasPostcode(text: string, postcode: string): boolean {
  if (!postcode) return false;
  const wanted = postcode.toUpperCase().replace(/\s+/g, "");
  return text.toUpperCase().replace(/\s+/g, "").includes(wanted);
}

export type WebsiteMatch = {
  url: string;
  score: number;
  confidence: "STRONG" | "POSSIBLE" | "REJECTED";
  /** Every signal that fired, in words. This is the audit trail. */
  evidence: string[];
  /** What kind of page this turned out to be. */
  character: PageCharacter;
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

/**
 * Every UK-shaped phone number printed on a page.
 *
 * At most one separator between digits, deliberately. A looser class runs
 * straight through a sentence end — "Call 01738 999111. 9 Mill Street" was
 * being read as one twelve-digit number and then discarded for being too long,
 * which silently lost the contradiction evidence this exists to provide.
 */
export function phonesOnPage(text: string): string[] {
  // Brackets are cosmetic in a printed number — "(01738) 999111" — and removing
  // them first keeps the one-separator rule that fixes the sentence-end bug.
  const found = text.replace(/[()]/g, "").match(/(?:\+44\s?|0)\d(?:[\s.-]?\d){8,12}/g) ?? [];
  const out = new Set<string>();
  for (const raw of found) {
    const norm = normalisePhone(raw);
    if (norm.length >= 10 && norm.length <= 11) out.add(norm);
  }
  return [...out];
}

/** Every UK postcode printed on a page. */
export function postcodesOnPage(text: string): string[] {
  const found = text.toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g) ?? [];
  return [...new Set(found.map((code) => code.replace(/\s+/g, "")))];
}

/**
 * What sort of page this is.
 *
 * The single most important thing the old scorer did not know. It measured
 * whether a page *mentioned* the business, which a Yell listing, a Facebook
 * page and a forty-firm trade directory all do — and all three were being
 * attached as the business's own website with a perfect score.
 */
export const PAGE_CHARACTERS = ["BUSINESS", "DIRECTORY", "SOCIAL", "PARKED"] as const;
export type PageCharacter = (typeof PAGE_CHARACTERS)[number];

const SOCIAL_HOSTS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "tiktok.com", "youtube.com", "pinterest.com",
];

const KNOWN_DIRECTORY_HOSTS = [
  "yell.com", "yelp.com", "yelp.co.uk", "thomsonlocal.com", "cylex-uk.co.uk",
  "freeindex.co.uk", "scoot.co.uk", "192.com", "checkatrade.com", "trustpilot.com",
  "tripadvisor.com", "tripadvisor.co.uk", "mybuilder.com", "ratedpeople.com",
  "bark.com", "trustatrader.com", "which.co.uk", "gumtree.com", "treatwell.co.uk",
  "fresha.com", "booksy.com", "companieshouse.gov.uk",
  "find-and-update.company-information.service.gov.uk",
];

/** Language that only appears on a domain nobody is trading from. */
const PARKED_PHRASES = [
  "domain is for sale", "this domain is for sale", "buy this domain",
  "domain for sale", "domain parking", "parked domain", "this webpage is parked",
  "coming soon", "under construction", "website coming soon",
  "godaddy.com/domains", "sedo.com", "hugedomains", "afternic",
  "default web site page", "if you are the owner of this website",
];

/** Language that marks a page as a listing of many businesses, not one. */
const DIRECTORY_PHRASES = [
  "businesses found", "results found", "search results", "find a ", "compare quotes",
  "get quotes from", "browse ", "listings in", "directory of", "trusted traders",
  "read reviews and", "add your business", "claim this listing", "claim your profile",
  "advertise with us", "write a review", "sponsored listing", "nearby businesses",
  "similar businesses", "related businesses", "view profile", "show number",
];

/** "40 more joiners in Perth", "127 results", "1-20 of 340" — list-page counting. */
const LIST_COUNT_PATTERNS = [
  /\b\d{2,}\s+(?:more\s+)?(?:results|listings|businesses|companies|traders|firms)\b/i,
  /\b\d+\s*[-–]\s*\d+\s+of\s+\d+\b/i,
  /\b\d{2,}\s+more\s+\w+s?\s+in\b/i,
];

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Decide what a fetched page actually is.
 *
 * Host lists catch the directories we know; the phrase and shape tests are what
 * catch the ones we do not, which is the case that mattered — an unknown
 * `tradesdirectory.co.uk` listing forty joiners was scoring 100 because it
 * printed our business's real phone number among the other thirty-nine.
 */
export function detectPageCharacter(
  url: string,
  title: string,
  text: string,
): PageCharacter {
  const host = hostname(url);
  if (host && hostMatches(host, SOCIAL_HOSTS)) return "SOCIAL";

  const body = `${title} ${text}`.toLowerCase();

  // Parked first: a for-sale page can otherwise look like a thin business site.
  if (PARKED_PHRASES.some((phrase) => body.includes(phrase))) return "PARKED";
  // Only a genuinely empty page counts as parked on length alone. Thin is not
  // parked: plenty of real one-page sites for sole traders are a paragraph and
  // a phone number, and plenty of real sites push contact details to their
  // contact page. Calling either parked would lose exactly the small businesses
  // this product exists to find, so the phrase list above does the real work.
  if (text.trim().length < 40) return "PARKED";

  if (host && hostMatches(host, KNOWN_DIRECTORY_HOSTS)) return "DIRECTORY";

  const phrases = DIRECTORY_PHRASES.filter((phrase) => body.includes(phrase)).length;
  // Result-counting language ("1-20 of 340", "40 more joiners in Perth") is on
  // its own decisive: a single business's own site has no reason to count other
  // businesses, and a page that does is a list whatever its host.
  if (LIST_COUNT_PATTERNS.some((pattern) => pattern.test(body))) return "DIRECTORY";
  // A page printing many different businesses' phone numbers is a list of
  // businesses, whatever its host. One business publishes one or two numbers.
  const phones = phonesOnPage(text).length;
  const postcodes = postcodesOnPage(text).length;
  if (phones >= 5 || postcodes >= 5) return "DIRECTORY";
  if (phrases >= 1 && (phones >= 3 || postcodes >= 3)) return "DIRECTORY";
  if (phrases >= 2) return "DIRECTORY";

  return "BUSINESS";
}

/**
 * Does the domain itself carry the business name?
 *
 * Real evidence that was being thrown away: the URL was passed into the scorer
 * and never read. `clarkjoinery.co.uk` titled "Clark Joinery" is the business;
 * `tradesdirectory.co.uk` with the same title is not, and only the domain
 * separates them.
 */
export function domainMatchesName(url: string, businessName: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  const domain = host.split(".")[0] ?? "";
  if (domain.length < 4) return false;
  const parts = words(businessName);
  if (parts.length === 0) return false;
  const joined = parts.join("");
  if (joined.length >= 5 && domain.includes(joined)) return true;
  // Every significant word present in the domain, in any arrangement.
  const significant = parts.filter((word) => word.length >= 4);
  if (significant.length === 0) return false;
  return significant.every((word) => domain.includes(word));
}

/** The threshold below which a candidate is never attached to a lead. */
export const WEBSITE_MIN_SCORE = 75;
/** High enough to crawl for emails, too low to attach as the official site. */
export const WEBSITE_POSSIBLE_MIN = 55;

/**
 * Is this page the business we were looking for?
 *
 * Corroboration, not resemblance — and now contradiction as well as agreement.
 * The rules, in the order they matter:
 *
 * 1. A page that is not a single business's own site can never be that
 *    business's website. A directory, a social profile and a parked domain are
 *    rejected outright however perfectly they match, because all three
 *    routinely print the business's real name, town, phone and postcode.
 *
 * 2. Contradiction counts against. A page that prints UK phone numbers, none of
 *    them ours, is positive evidence of a different business — not merely an
 *    absence of evidence. The same goes for postcodes. This is what stops the
 *    other "Clark Joinery" in the same town being attached.
 *
 * 3. Soft signals can never carry a verdict on their own. Name, town and trade
 *    together reach 60 against a bar of 75, deliberately: those three agree for
 *    every same-named competitor in the same town. Something specific — the
 *    phone, the postcode, the domain, or the title being the business itself —
 *    has to be present.
 *
 * False negatives are the acceptable failure here. Finding nothing costs one
 * lead; attaching the wrong site produces a confident, evidenced email to
 * somebody else's business.
 */
export function scoreWebsiteMatch(
  evidence: SiteEvidence,
  identity: BusinessIdentity,
  options: { kind?: "OWN_WEBSITE" | "PUBLIC_PROFILE" } = {},
): WebsiteMatch {
  const notes: string[] = [];
  let score = 0;
  const haystack = `${evidence.title} ${evidence.text}`.toLowerCase();

  const character = detectPageCharacter(evidence.url, evidence.title, evidence.text);

  // ── 1. Disqualify anything that is not one business's own site ────────────
  if (character !== "BUSINESS" || options.kind === "PUBLIC_PROFILE") {
    const why =
      character === "PARKED"
        ? "the domain is parked or the page is empty — not a trading website"
        : character === "SOCIAL"
          ? "this is a social media profile, not the business's own website"
          : "this is a directory or listing page, not the business's own website";
    return { url: evidence.url, score: 0, confidence: "REJECTED", evidence: [why], character };
  }

  const nameWords = words(identity.businessName);
  const matchedWords = nameWords.filter((word) => haystack.includes(word));
  const nameRatio = nameWords.length === 0 ? 0 : matchedWords.length / nameWords.length;
  const fullName = nameWords.join(" ");
  const titleHasName = fullName.length > 0 && words(evidence.title).join(" ").includes(fullName);

  // extraText is the search snippet for THIS result. Unique signals only.
  const extraHaystack = (evidence.extraText ?? "").toLowerCase();

  // ── 2. Hard signals: specific enough to identify one business ─────────────
  const pagePhone = Boolean(identity.phone) && pageHasPhone(haystack, identity.phone);
  const pageOtherPhones = Boolean(identity.phone) && !pagePhone && phonesOnPage(evidence.text).length > 0;
  const extraPhone =
    Boolean(identity.phone) && !pageOtherPhones && pageHasPhone(extraHaystack, identity.phone);
  const phoneMatches = pagePhone || extraPhone;
  if (pagePhone) {
    score += 55;
    notes.push("the listing's phone number is printed on the page");
  } else if (extraPhone) {
    score += 55;
    notes.push("the listing's phone number appears in the search listing for this page");
  }

  const postcode = extractPostcode(identity.address ?? "");
  const pagePostcode = Boolean(postcode) && pageHasPostcode(haystack, postcode);
  const pageOtherPostcodes = Boolean(postcode) && !pagePostcode && postcodesOnPage(evidence.text).length > 0;
  const extraPostcode =
    Boolean(postcode) && !pageOtherPostcodes && pageHasPostcode(extraHaystack, postcode);
  const postcodeMatches = pagePostcode || extraPostcode;
  if (pagePostcode) {
    score += 45;
    notes.push(`the listing's postcode (${postcode}) is on the page`);
  } else if (extraPostcode) {
    score += 45;
    notes.push(`the listing's postcode (${postcode}) appears in the search listing for this page`);
  }

  // ── 3. Medium signals: the page is *about* this business ──────────────────
  if (domainMatchesName(evidence.url, identity.businessName)) {
    score += 30;
    notes.push("the domain is the business name");
  }
  if (titleHasName) {
    score += 30;
    notes.push("the page title is the business name");
  }

  // ── 4. Soft signals: true of every competitor too ─────────────────────────
  if (!titleHasName && nameRatio >= 0.99) {
    score += 15;
    notes.push("every word of the business name appears on the page");
  } else if (!titleHasName && nameRatio >= 0.5) {
    score += 8;
    notes.push("part of the business name appears on the page");
  }
  const townWord = words(identity.town)[0];
  const townMatches = Boolean(townWord) && haystack.includes(townWord!);
  if (townMatches) {
    score += 12;
    notes.push("the town matches");
  }
  const tradeWord = words(identity.trade)[0];
  if (tradeWord && haystack.includes(tradeWord.replace(/er$/, ""))) {
    score += 8;
    notes.push("the trade matches");
  }
  if (titleHasName && townMatches) {
    score += 10;
    notes.push("the business name and the town agree");
  }

  // Distinctive street/building tokens ("Bonnygate", "Reform Street") are more
  // specific than a town and less specific than a postcode. Common words
  // (High, South, Street) are ignored so they cannot carry a verdict.
  const addressTokens = distinctiveAddressTokens(identity.address ?? "", identity.town);
  const addressHit = addressTokens.find((token) => haystack.includes(token));
  if (addressHit) {
    score += 18;
    notes.push(`the listing's street (${addressHit}) is on the page`);
  }

  // ── 5. Contradiction: evidence of a DIFFERENT business ────────────────────
  //
  // Absence of our phone number proves nothing; the presence of somebody
  // else's, on a page claiming our business name, proves a great deal.
  if (identity.phone && !phoneMatches) {
    const others = phonesOnPage(evidence.text);
    if (others.length > 0) {
      score -= 30;
      notes.push(`the page publishes a different phone number (${others[0]}) — counted against`);
    }
  }
  if (postcode && !postcodeMatches) {
    const others = postcodesOnPage(evidence.text);
    if (others.length > 0) {
      score -= 25;
      notes.push(`the page publishes a different postcode (${others[0]}) — counted against`);
    }
  }

  // A page that does not name the business at all is not the business, however
  // many other words happen to line up.
  if (nameRatio < 0.5 && !titleHasName) {
    score = Math.min(score, 40);
    notes.push("the business name is largely absent — held back");
  }

  score = Math.max(0, Math.min(100, score));
  const confidence = score >= WEBSITE_MIN_SCORE ? "STRONG" : score >= WEBSITE_POSSIBLE_MIN ? "POSSIBLE" : "REJECTED";
  return { url: evidence.url, score, confidence, evidence: notes, character };
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

/**
 * The strongest site that looks like this business but does not clear the
 * attach-as-official-website bar. Callers may crawl it for emails; they must
 * not record it as the lead's website.
 */
export function bestPossibleWebsite(matches: readonly WebsiteMatch[]): WebsiteMatch | null {
  const possible = matches
    .filter(
      (match) =>
        match.character === "BUSINESS" &&
        match.score >= WEBSITE_POSSIBLE_MIN &&
        match.score < WEBSITE_MIN_SCORE,
    )
    .sort((a, b) => b.score - a.score);
  return possible[0] ?? null;
}

/** May we harvest addresses from this page? STRONG and POSSIBLE business sites only. */
export function emailsAllowedFromMatch(match: WebsiteMatch): boolean {
  return match.character === "BUSINESS" && match.confidence !== "REJECTED";
}

/**
 * A directory or profile page that is clearly THIS business, not a list of many.
 *
 * Name overlap alone is not enough — every "Clark Joinery" listing in the
 * country would pass. The listing's phone or postcode has to agree, and the
 * page must not be a directory-of-many (several numbers).
 */
export function listingClearlyMatches(text: string, identity: BusinessIdentity): boolean {
  const haystack = text.toLowerCase();
  const nameWords = words(identity.businessName);
  if (nameWords.length === 0) return false;
  const matched = nameWords.filter((word) => haystack.includes(word));
  if (matched.length / nameWords.length < 0.5) return false;
  const phoneOk = Boolean(identity.phone) && pageHasPhone(haystack, identity.phone);
  const postcode = extractPostcode(identity.address ?? "");
  const postcodeOk = Boolean(postcode) && pageHasPostcode(haystack, postcode);
  return phoneOk || postcodeOk;
}

/** One business's listing, not a page of many. */
export function isSingleBusinessListing(text: string): boolean {
  return phonesOnPage(text).length < 3 && postcodesOnPage(text).length < 3;
}

const ADDRESS_STOP = new Set([
  "street", "road", "lane", "avenue", "close", "drive", "way", "terrace",
  "place", "court", "gardens", "grove", "crescent", "row", "hill", "end",
  "gate", "wynd", "brae", "south", "north", "east", "west", "upper", "lower",
  "great", "little", "new", "old", "the", "and",
]);

/**
 * Street or building words distinctive enough to identify one address.
 *
 * "Bonnygate" and "Reform" count; "High", "South" and "Street" do not.
 */
export function distinctiveAddressTokens(address: string, town: string): string[] {
  if (!address.trim()) return [];
  const withoutPc = address.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, " ");
  const townWords = new Set(words(town));
  const out: string[] = [];
  for (const token of words(withoutPc)) {
    if (token.length < 6) continue;
    if (ADDRESS_STOP.has(token) || townWords.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}
