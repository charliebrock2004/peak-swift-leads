/**
 * Is this business one we already have? — answered with evidence.
 *
 * Every duplicate decision in discovery, import and hand entry goes through
 * the entity resolver (`entity/resolve.ts`): a shared company number, source
 * record, website, phone or email that nothing contradicts, or the same name
 * at the same postcode or in the same town. A similar name alone is never
 * enough, two company numbers are never merged, and two businesses that share
 * a building (an accountant's registered office, a business centre) stay two
 * businesses.
 *
 * The previous index matched on exact keys, and three of them were unsafe:
 *   - map coordinates — every company registered at one postcode got the
 *     same postcode-centroid "maps link", so one accountant's office made a
 *     dozen unrelated companies one business;
 *   - a long name anywhere in the country ("Property Maintenance Services"
 *     in Perth = the one in Glasgow);
 *   - a website host shared by many businesses (a website builder's
 *     subdomains, a directory the host list did not know).
 *
 * The index only narrows the search (blocking keys); the resolver decides.
 * `possible` matches are reported as such, so the caller can hold them for a
 * person instead of silently dropping or silently adding them.
 */
import { compareBusinesses, distinctiveTokens, foldName, normalizePostcode, phoneKey, postcodeIn, websiteIdentity, type BusinessRecord, type Verdict } from "./entity/resolve.ts";
import type { LeadIdentity } from "./leads.ts";

/** What a duplicate check can know about a business. */
export type MatchSubject = LeadIdentity & {
  id?: string;
  address?: string;
  companyNumber?: string;
  sourceIds?: string[];
};

export type MatchVia = "company" | "source" | "website" | "phone" | "email" | "postcode" | "name+town" | "ruling";

export type Match<T> = { entry: T; verdict: Exclude<Verdict, "different">; via: MatchVia; reasons: string[] };

/** The resolver's view of a lead, a listing or a typed-in business. */
export function recordFor(subject: MatchSubject, fallbackId = ""): BusinessRecord {
  const ids = [...new Set([...(subject.sourceIds ?? []), subject.placeId ?? ""].map((id) => id.trim()).filter(Boolean))];
  const chId = ids.find((id) => id.startsWith("ch:"));
  return {
    id: subject.id || subject.placeId || fallbackId,
    name: subject.businessName,
    phone: subject.phone,
    email: subject.email,
    website: subject.website,
    postcode: postcodeIn(subject.address ?? ""),
    address: subject.address,
    town: subject.town,
    companyNumber: (subject.companyNumber || (chId ? chId.slice(3) : "")).trim().toUpperCase(),
    sourceIds: ids,
  };
}

/**
 * Where to look for possible matches. Every key is a necessary condition for
 * some resolver rule, so a business the resolver would match always shares at
 * least one key with it.
 */
export function blockingKeys(record: BusinessRecord): string[] {
  const keys: string[] = [];
  if (record.companyNumber) keys.push(`cn:${record.companyNumber}`);
  for (const id of record.sourceIds ?? []) keys.push(`src:${id}`);
  const phone = phoneKey(record.phone);
  if (phone) keys.push(`ph:${phone}`);
  const email = (record.email ?? "").trim().toLowerCase();
  if (email) keys.push(`em:${email}`);
  const site = websiteIdentity(record.website);
  if (site) keys.push(`web:${site}`);
  const postcode = normalizePostcode(record.postcode);
  if (postcode) keys.push(`pc:${postcode}`);
  // Names: the whole folded name, each distinctive word ("Tayside Roofing"
  // meets "Tayside Roofing Services"), and the first letters of the
  // distinctive part (a near-spelling — "Strathearn"/"Strathern" — meets its
  // twin). Generic trade words are not keys: "joinery" would make every
  // joiner a candidate for every other. Only candidates — the resolver decides.
  const folded = foldName(record.name);
  if (folded) {
    keys.push(`nm:${folded.replace(/ /g, "")}`);
    const distinctive = distinctiveTokens(record.name);
    // The distinctive part as a whole: "Tayside Roofing" and "Tayside Roofing
    // Services Ltd" both reduce to "tayside", however common the word is.
    if (distinctive.length) keys.push(`nd:${distinctive.join("")}`);
    for (const word of distinctive) if (word.length >= 3) keys.push(`nw:${word}`);
    const stem = distinctive.join("");
    if (stem.length >= 5) keys.push(`np:${stem.slice(0, 5)}`);
  }
  return [...new Set(keys)];
}

const VIA: [RegExp, MatchVia][] = [
  [/You marked/, "ruling"],
  [/Companies House number/, "company"],
  [/source record/, "source"],
  [/website/i, "website"],
  [/phone/i, "phone"],
  [/email/i, "email"],
  [/postcode/i, "postcode"],
];

function viaOf(reasons: string[]): MatchVia {
  const text = reasons.join(" ");
  return VIA.find(([pattern]) => pattern.test(text))?.[1] ?? "name+town";
}

export type IdentityIndex<T> = {
  /** The best match for this candidate: a `same` before any `possible`, or null. */
  find(candidate: MatchSubject): Match<T> | null;
  /** Index an entry so later candidates can be matched against it. */
  add(candidate: MatchSubject, entry: T): void;
  readonly size: number;
};

/** How many entries one blocking key may pull in before it stops narrowing anything. */
const KEY_FANOUT = 400;
/**
 * A single name word shared by more entries than this ("perth", "firm") is no
 * longer distinctive in this pool, so it is not used to find candidates. The
 * whole name, the distinctive part as a whole, and every identifier still are.
 */
const COMMON_WORD = 40;

export function createIdentityIndex<T>(): IdentityIndex<T> {
  const records: { record: BusinessRecord; entry: T }[] = [];
  const byKey = new Map<string, number[]>();

  return {
    find(candidate) {
      const record = recordFor(candidate, "candidate");
      const seen = new Set<number>();
      let possible: Match<T> | null = null;
      for (const key of blockingKeys(record)) {
        const hits = byKey.get(key);
        if (!hits) continue;
        if ((key.startsWith("nw:") || key.startsWith("np:")) && hits.length > COMMON_WORD) continue;
        for (const index of hits.slice(0, KEY_FANOUT)) {
          if (seen.has(index)) continue;
          seen.add(index);
          const other = records[index]!;
          const resolution = compareBusinesses(other.record, record);
          if (resolution.verdict === "same") return { entry: other.entry, verdict: "same", via: viaOf(resolution.reasons), reasons: resolution.reasons };
          if (resolution.verdict === "possible" && !possible) {
            possible = { entry: other.entry, verdict: "possible", via: viaOf(resolution.reasons), reasons: resolution.reasons };
          }
        }
      }
      return possible;
    },
    add(candidate, entry) {
      const index = records.length;
      const record = recordFor(candidate, `entry-${index}`);
      records.push({ record, entry });
      for (const key of blockingKeys(record)) {
        const list = byKey.get(key);
        if (list) list.push(index);
        else byKey.set(key, [index]);
      }
    },
    get size() {
      return records.length;
    },
  };
}

/** Build an index over existing leads, where the lead itself is the entry. */
export function indexOf<T extends MatchSubject>(leads: readonly T[]): IdentityIndex<T> {
  const index = createIdentityIndex<T>();
  for (const lead of leads) index.add(lead, lead);
  return index;
}

export type DuplicateMatch<T> = { lead: T; via: MatchVia; reasons: string[] };

/**
 * The one existing business this candidate certainly is, or null.
 *
 * Only a `same` verdict counts. A `possible` match is not a duplicate: use
 * `matchLead` where the caller can hold it for a person to decide.
 */
export function findDuplicate<T extends MatchSubject>(candidate: MatchSubject, leads: readonly T[]): DuplicateMatch<T> | null {
  const match = matchLead(candidate, leads);
  return match && match.verdict === "same" ? { lead: match.entry, via: match.via, reasons: match.reasons } : null;
}

/** The best match among `leads`, `same` or `possible`, for a single candidate. */
export function matchLead<T extends MatchSubject>(candidate: MatchSubject, leads: readonly T[]): Match<T> | null {
  return indexOf(leads).find(candidate);
}
