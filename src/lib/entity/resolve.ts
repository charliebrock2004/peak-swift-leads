/**
 * Are two business records the same business?
 *
 * Businesses arrive from several sources (Companies House, OpenStreetMap, a
 * search result, an import), each spelling them differently: a legal name
 * ("TAYSIDE ROOFING SERVICES LIMITED") beside a trading name ("Tayside
 * Roofing"), a registered office at the accountant's beside the yard. This
 * decides, with reasons, whether two records describe one business:
 *
 * - `same`      — merge them. Needs a shared identifier (company number,
 *                 source id, website, phone or email) that nothing
 *                 contradicts, or an exact name at the same premises or town.
 * - `possible`  — show them as a possible duplicate for a person to decide.
 *                 Chains, shared lines, a registered office elsewhere.
 * - `different` — keep them apart.
 *
 * Deliberately never `same` on similar names alone. Two companies with
 * different company numbers are never merged, whatever else they share. A
 * person's ruling (`overrides`) beats every rule.
 *
 * Client-safe and pure. Source records are never discarded by a merge: the
 * caller links them to the surviving business.
 */
import { independentHost } from "../leads.ts";
import { normalizeUkPhone } from "../contactability/phone.ts";
import { isPersonalMailboxDomain } from "../contactability/legal-form.ts";

export type BusinessRecord = {
  id: string;
  name: string;
  /** Other names the business is known by (a legal name beside a trading name). */
  aliases?: string[];
  phone?: string;
  email?: string;
  website?: string;
  postcode?: string;
  address?: string;
  town?: string;
  companyNumber?: string;
  /** Stable source ids, e.g. "ch:SC612222", "osm:node:123". */
  sourceIds?: string[];
};

export type Verdict = "same" | "possible" | "different";

export type Resolution = { verdict: Verdict; reasons: string[] };

export type Override = { a: string; b: string; decision: "same" | "different"; note?: string };

const LEGAL_WORDS = /\b(limited|ltd|llp|l l p|plc|inc|incorporated|company|co|cic|t\/a|trading as|the)\b\.?/g;

/** A name reduced to what identifies it: case, punctuation, "&"/"and", legal suffixes. */
export function foldName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/\+/g, " and ")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(LEGAL_WORDS, " ")
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // "J S Joinery" → "js joinery"
    .replace(/\b([a-z])\s+(?=[a-z]\b)/g, "$1");
}

function tokens(folded: string): string[] {
  return folded.split(" ").filter((token) => token.length > 0 && token !== "and");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Generic trade words: sharing only these says nothing about identity. */
const GENERIC = new Set([
  "services",
  "service",
  "solutions",
  "contractors",
  "contracts",
  "building",
  "builders",
  "joinery",
  "joiners",
  "roofing",
  "plumbing",
  "heating",
  "electrical",
  "electricians",
  "hair",
  "beauty",
  "salon",
  "barbers",
  "barber",
  "garage",
  "motors",
  "cafe",
  "restaurant",
  "scotland",
  "uk",
  "group",
  "and",
  "sons",
  "son",
  "joiner",
  "roofer",
  "roofers",
  "plumber",
  "plumbers",
  "electrician",
  "decorators",
  "decorating",
  "painter",
  "painters",
  "landscaping",
  "landscapes",
  "gardening",
  "maintenance",
  "property",
  "construction",
  "carpentry",
  "kitchens",
  "bathrooms",
  "windows",
  "home",
  "homes",
  "improvements",
]);

/**
 * The words of a name that identify it: folded, legal suffixes and generic
 * trade words removed ("Tayside Roofing Services Ltd" → ["tayside"]).
 */
export function distinctiveTokens(name: string): string[] {
  return tokens(foldName(name)).filter((token) => !GENERIC.has(token));
}

export type NameRelation = "equal" | "contains" | "similar" | "different";

/**
 * How two names relate.
 *
 * `contains` is the trading-name-vs-legal-name case: every distinctive word of
 * the shorter name appears in the longer ("Tayside Roofing" / "Tayside Roofing
 * Services Ltd"). `similar` is a small spelling difference in a name long
 * enough for that to mean something ("Strathearn" / "Strathern").
 */
export function nameRelation(a: string, b: string): NameRelation {
  const x = foldName(a);
  const y = foldName(b);
  if (!x || !y) return "different";
  if (x === y || x.replace(/ /g, "") === y.replace(/ /g, "")) return "equal";
  const tx = tokens(x);
  const ty = tokens(y);
  const [short, long] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  const distinctive = short.filter((token) => !GENERIC.has(token));
  if (distinctive.length > 0 && short.every((token) => long.includes(token))) return "contains";
  // A spelling difference only counts in the distinctive part of the name, and
  // only when that part is long enough for one letter not to be a new name.
  const distinctX = tx.filter((token) => !GENERIC.has(token)).join("");
  const distinctY = ty.filter((token) => !GENERIC.has(token)).join("");
  // Numbers are not spellings: "Unit 10 Joinery" and "Unit 11 Joinery" are two names.
  if (distinctX.replace(/\D/g, "") !== distinctY.replace(/\D/g, "")) return "different";
  const longest = Math.max(distinctX.length, distinctY.length);
  if (distinctX && distinctY && longest >= 7) {
    const distance = levenshtein(distinctX, distinctY);
    if (distance <= 2 && distance / longest <= 0.2) return "similar";
  }
  return "different";
}

function bestNameRelation(a: BusinessRecord, b: BusinessRecord): NameRelation {
  const rank: Record<NameRelation, number> = { equal: 3, contains: 2, similar: 1, different: 0 };
  let best: NameRelation = "different";
  for (const left of [a.name, ...(a.aliases ?? [])]) {
    for (const right of [b.name, ...(b.aliases ?? [])]) {
      const relation = nameRelation(left, right);
      if (rank[relation] > rank[best]) best = relation;
    }
  }
  return best;
}

export function normalizePostcode(value: string | undefined): string {
  const compact = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact) ? compact : "";
}

/** The full UK postcode in an address ("1 High St, Crieff PH7 3AA" → "PH73AA"), or "". */
export function postcodeIn(text: string): string {
  const match = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i.exec(text ?? "");
  return match ? normalizePostcode(`${match[1]}${match[2]}`) : "";
}

/**
 * Hosts where every customer gets a subdomain: "joesroofing.wixsite.com" and
 * "bobsbuilders.wixsite.com" are two businesses, so the whole host is the
 * identity, never the platform's domain.
 */
const SHARED_PLATFORMS = [
  "wixsite.com",
  "business.site",
  "square.site",
  "godaddysites.com",
  "weebly.com",
  "wordpress.com",
  "blogspot.com",
  "webs.com",
  "jimdosite.com",
  "jimdofree.com",
  "sites.google.com",
  "carrd.co",
  "netlify.app",
  "vercel.app",
  "github.io",
  "myshopify.com",
  "mystrikingly.com",
  "strikingly.com",
  "yolasite.com",
  "ueniweb.com",
  "site123.me",
  "simdif.com",
  "wix.com",
  "squarespace.com",
  "webador.co.uk",
  "webnode.page",
  "ucoz.com",
  "tradesite.co.uk",
];

function registrableDomain(host: string): string {
  const clean = host.toLowerCase().replace(/^www\./, "");
  if (SHARED_PLATFORMS.some((platform) => clean.endsWith(`.${platform}`))) return clean;
  const parts = clean.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tail = parts.slice(-2).join(".");
  return /^(co|org|ltd|plc|me|net|ac|gov|com)\.[a-z]{2}$/.test(tail) ? parts.slice(-3).join(".") : tail;
}

/**
 * What identifies a business by its website: the registrable domain of an
 * independent site, the whole host on a shared website builder, and nothing
 * for social pages, directories or a builder's bare domain (a site path on
 * "sites.google.com" says nothing about who owns it).
 */
export function websiteIdentity(url: string | undefined): string {
  const host = independentHost(url);
  if (!host) return "";
  if (SHARED_PLATFORMS.includes(host.replace(/^www\./, ""))) return "";
  return registrableDomain(host);
}

function domainOf(record: BusinessRecord): string {
  return websiteIdentity(record.website);
}

/** Phone parsing is the costly part of a comparison, and the same numbers are compared many times. */
const PHONE_CACHE = new Map<string, string>();

export function phoneKey(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const cached = PHONE_CACHE.get(value);
  if (cached !== undefined) return cached;
  const e164 = normalizeUkPhone(value)?.e164 ?? "";
  if (PHONE_CACHE.size > 20_000) PHONE_CACHE.clear();
  PHONE_CACHE.set(value, e164);
  return e164;
}

function phoneOf(record: BusinessRecord): string {
  return phoneKey(record.phone);
}

function emailOf(record: BusinessRecord): string {
  return (record.email ?? "").trim().toLowerCase();
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function compareBusinesses(a: BusinessRecord, b: BusinessRecord, overrides: readonly Override[] = []): Resolution {
  const [low, high] = orderedPair(a.id, b.id);
  const ruling = overrides.find((entry) => entry.a === low && entry.b === high);
  if (ruling) return { verdict: ruling.decision, reasons: [`You marked these as ${ruling.decision === "same" ? "the same business" : "different businesses"}${ruling.note ? `: ${ruling.note}` : ""}`] };

  const numberA = (a.companyNumber ?? "").trim().toUpperCase();
  const numberB = (b.companyNumber ?? "").trim().toUpperCase();
  if (numberA && numberB) {
    return numberA === numberB
      ? { verdict: "same", reasons: [`Same Companies House number (${numberA})`] }
      : { verdict: "different", reasons: [`Different Companies House numbers (${numberA}, ${numberB})`] };
  }

  const shared = (a.sourceIds ?? []).find((id) => id && (b.sourceIds ?? []).includes(id));
  if (shared) return { verdict: "same", reasons: [`Same source record (${shared})`] };

  const name = bestNameRelation(a, b);
  const nameAlike = name !== "different";
  const postcodeA = normalizePostcode(a.postcode);
  const postcodeB = normalizePostcode(b.postcode);
  const samePostcode = postcodeA !== "" && postcodeA === postcodeB;
  const postcodesDiffer = postcodeA !== "" && postcodeB !== "" && postcodeA !== postcodeB;
  const townA = (a.town ?? "").trim().toLowerCase();
  const townB = (b.town ?? "").trim().toLowerCase();
  const sameTown = townA !== "" && townA === townB;

  const domainA = domainOf(a);
  const domainB = domainOf(b);
  if (domainA && domainB) {
    if (domainA === domainB) {
      if (postcodesDiffer) return { verdict: "possible", reasons: [`Same website (${domainA}) at different postcodes — a chain or branches`] };
      return { verdict: "same", reasons: [`Same website (${domainA})`] };
    }
  }

  const phoneA = phoneOf(a);
  const phoneB = phoneOf(b);
  const emailA = emailOf(a);
  const emailB = emailOf(b);
  const sharedPhone = phoneA !== "" && phoneA === phoneB;
  const sharedEmail = emailA !== "" && emailA === emailB;
  if (sharedPhone || sharedEmail) {
    const what = sharedPhone ? "phone number" : isPersonalMailboxDomain(emailA.split("@")[1] ?? "") ? "personal email" : "email address";
    if (domainA && domainB) {
      return { verdict: "possible", reasons: [`Same ${what}, but different websites (${domainA}, ${domainB})`] };
    }
    if (nameAlike || samePostcode) {
      return { verdict: "same", reasons: [`Same ${what}${nameAlike ? " and a matching name" : " at the same postcode"}`] };
    }
    return { verdict: "possible", reasons: [`Same ${what} but different names — one owner with two businesses, or a shared line`] };
  }

  if (domainA && domainB) {
    return { verdict: "different", reasons: [`Different websites (${domainA}, ${domainB})`] };
  }

  if (samePostcode) {
    if (nameAlike) return { verdict: "same", reasons: [`Same postcode (${postcodeA}) and ${name === "equal" ? "the same name" : name === "contains" ? "one name contains the other" : "a near-identical name"}`] };
    return { verdict: "different", reasons: [`Same postcode (${postcodeA}) but different names — a shared building`] };
  }

  if (postcodesDiffer) {
    if (nameAlike) return { verdict: "possible", reasons: [`A matching name at different postcodes (${postcodeA}, ${postcodeB}) — a chain, a move, or a registered office elsewhere`] };
    return { verdict: "different", reasons: ["Different names and addresses"] };
  }

  if (sameTown && phoneA && phoneB) {
    // Both have numbers and they differ: a matching name is not enough on its own.
    return nameAlike
      ? { verdict: "possible", reasons: ["A matching name in the same town, but different phone numbers"] }
      : { verdict: "different", reasons: ["Different names and phone numbers"] };
  }

  if (!sameTown && townA && townB && phoneA && phoneB) {
    // Different towns and different numbers: two businesses (or two branches,
    // each its own premises) — a shared name is not evidence against that.
    return { verdict: "different", reasons: [`Different towns (${a.town}, ${b.town}) and different phone numbers`] };
  }

  if (sameTown && name === "equal") return { verdict: "same", reasons: ["The same name in the same town, and nothing contradicts it"] };
  if (sameTown && nameAlike) return { verdict: "possible", reasons: [`A ${name === "contains" ? "shorter or longer form of the name" : "similar name"} in the same town`] };
  if (nameAlike && townA && townB) {
    return { verdict: "possible", reasons: [`A matching name in different towns (${a.town}, ${b.town}) — a chain, or one listed under a nearby town`] };
  }
  if (nameAlike) return { verdict: "possible", reasons: ["A matching name, but nothing else to confirm it"] };
  return { verdict: "different", reasons: ["Nothing identifies them as one business"] };
}
