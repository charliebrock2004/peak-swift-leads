/**
 * Is this the same business? One authority, for every caller.
 *
 * There used to be two. `findDuplicate` governed the sheet and the candidate
 * pool; `mergePlaces` governed de-duplication inside a discovery area and had
 * its own, weaker rules — it merged any two records whose folded names matched
 * in four characters, with no space required and no regard for town, so
 * "Tays" in Perth and "Tays" in Crieff became one business before anything
 * else in the pipeline ever saw them. Two definitions of identity is one too
 * many, so both now call this.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a shared name is not proof of a shared
 * business. Strong identifiers — a stable place id, a phone number, an address,
 * an independent domain — each identify one business and are trusted on their
 * own. A name is not one of those. It may only merge two records that agree on
 * town AND carry nothing that contradicts each other, because two firms called
 * Bell Joinery with different phone numbers are two firms called Bell Joinery.
 *
 * Deterministic throughout: exact comparisons on normalised values. No fuzzy
 * matching, no similarity scoring, no model in the loop. Precision over recall
 * on purpose — leaving two copies of one business on the sheet is a tidiness
 * problem, and merging two real businesses is a wrong email to a stranger.
 */
import {
  independentHost,
  normalizeMaps,
  normalizeName,
  normalizePhone,
  type LeadIdentity,
} from "./leads.ts";

export type { LeadIdentity };

/** How two records were shown to be the same business. */
export const MATCH_REASONS = [
  "PLACE_ID",
  "PHONE",
  "EMAIL",
  "DOMAIN",
  "MAPS_URL",
  "NAME_TOWN",
] as const;
export type MatchReason = (typeof MATCH_REASONS)[number];

/** The legacy lowercase spelling, kept because callers and tests read it. */
export const REASON_VIA: Record<MatchReason, "place" | "phone" | "email" | "website" | "maps" | "name+town"> = {
  PLACE_ID: "place",
  PHONE: "phone",
  EMAIL: "email",
  DOMAIN: "website",
  MAPS_URL: "maps",
  NAME_TOWN: "name+town",
};

/**
 * Canonical form of a place id.
 *
 * Nominatim writes OSM ids as `osm:node:123` (from `osm_type`) and Photon as
 * `osm:N:123` (from a type letter) — both produced by this codebase, in
 * `osm-discover.ts`, and both naming the same OSM object. Folding the type to
 * its first letter makes those two spellings compare equal, which recovers the
 * strongest identifier we have for a business found by both searches.
 *
 * Only the OSM namespace is folded, because only there is the equivalence
 * something this repository produces and can therefore vouch for. A Companies
 * House id (`ch:SC123456`) is lowercased and otherwise left exactly as it is.
 */
export function normalisePlaceId(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const osm = raw.match(/^osm:([a-z]+):(\d+)$/);
  if (osm) return `osm:${osm[1]![0]}:${osm[2]}`;
  return raw;
}

/** The registry a place id belongs to: two ids only disagree within one. */
export function placeIdNamespace(value: string): string {
  const at = value.indexOf(":");
  return at > 0 ? value.slice(0, at) : "";
}

/** Every comparable value a record carries, derived once. */
export type Evidence = {
  placeId: string;
  phone: string;
  email: string;
  host: string;
  maps: string;
  name: string;
  town: string;
};

export function evidenceOf(record: LeadIdentity): Evidence {
  // Every field is coalesced. Callers include CSV import, which builds partial
  // drafts where a column simply was not in the file, and a half-filled record
  // must produce weak evidence rather than throw.
  const text = (value: string | undefined) => (value ?? "").trim();
  const maps = text(record.mapsLink);
  return {
    placeId: normalisePlaceId(record.placeId),
    phone: normalizePhone(text(record.phone)),
    email: text(record.email).toLowerCase(),
    // "" for a directory or social page, so two businesses that share only a
    // Facebook presence share no evidence at all.
    host: independentHost(record.website),
    maps: maps ? normalizeMaps(maps) : "",
    name: normalizeName(text(record.businessName)),
    town: text(record.town).toLowerCase(),
  };
}

/**
 * Does the evidence positively say these are DIFFERENT businesses?
 *
 * Only comparable evidence counts. A missing field contradicts nothing — a
 * Companies House record has no phone, and that silence is not disagreement.
 * Two place ids only contradict inside one registry, because `ch:SC123456` and
 * `osm:n:101` are two ways of describing a business, not two businesses.
 *
 * Deliberately narrow. Businesses do change phone numbers and move domains, so
 * this never overrides a strong identifier — it only refuses to let a shared
 * NAME carry a merge on its own.
 */
export function contradicts(a: Evidence, b: Evidence): boolean {
  if (
    a.placeId &&
    b.placeId &&
    placeIdNamespace(a.placeId) === placeIdNamespace(b.placeId) &&
    a.placeId !== b.placeId
  ) {
    return true;
  }
  if (a.phone.length >= 10 && b.phone.length >= 10 && a.phone !== b.phone) return true;
  if (a.host && b.host && a.host !== b.host) return true;
  return false;
}

/**
 * Does a single strong identifier tie these two records together?
 *
 * Each of these identifies one business by itself, so any one of them is
 * enough and contradiction elsewhere does not veto it: a business that changed
 * its phone number still has its OSM node.
 */
export function strongMatch(a: Evidence, b: Evidence): MatchReason | null {
  if (a.placeId && b.placeId && a.placeId === b.placeId) return "PLACE_ID";
  if (a.phone.length >= 10 && b.phone.length >= 10 && a.phone === b.phone) return "PHONE";
  if (a.email && b.email && a.email === b.email) return "EMAIL";
  if (a.host && b.host && a.host === b.host) return "DOMAIN";
  if (a.maps && b.maps && a.maps === b.maps) return "MAPS_URL";
  return null;
}

/**
 * The full decision for one pair.
 *
 * Strong evidence first, then — and only then — the name, which must agree on
 * town and must not be contradicted. There is deliberately no rule that merges
 * on name alone across towns: that is what let a Companies House record in
 * Aberfeldy be absorbed into an unrelated Perth business with the same trading
 * name, and it is the defect this module was written to remove.
 */
export function matchReason(a: Evidence, b: Evidence): MatchReason | null {
  const strong = strongMatch(a, b);
  if (strong) return strong;
  if (a.name.length >= 3 && a.name === b.name && a.town && a.town === b.town) {
    return contradicts(a, b) ? null : "NAME_TOWN";
  }
  return null;
}

/** Whether two records are the same business, from the records themselves. */
export function sameBusiness(a: LeadIdentity, b: LeadIdentity): MatchReason | null {
  return matchReason(evidenceOf(a), evidenceOf(b));
}

/**
 * The matched record, in the shape callers have always received.
 *
 * `via` keeps its original lowercase spelling so the sheet, the CSV import
 * preview and the existing tests read unchanged; `reason` is the same decision
 * in the uppercase vocabulary the diagnostics use.
 */
export type DuplicateMatch<T extends LeadIdentity = LeadIdentity> = {
  lead: T;
  via: (typeof REASON_VIA)[MatchReason];
  reason: MatchReason;
};

/**
 * The first record in `leads` that is the same business as `candidate`.
 *
 * Strong identifiers are checked across the whole list before any name is
 * considered, so a phone-number match on the tenth record still beats a
 * name-and-town match on the first. Within a pass the earliest record wins,
 * which is what makes repeated runs stable.
 */
export function findDuplicate<T extends LeadIdentity>(
  candidate: LeadIdentity,
  leads: readonly T[],
): DuplicateMatch<T> | null {
  const mine = evidenceOf(candidate);
  const theirs = leads.map(evidenceOf);

  for (const [index, lead] of leads.entries()) {
    const strong = strongMatch(mine, theirs[index]!);
    if (strong) return { lead, via: REASON_VIA[strong], reason: strong };
  }
  for (const [index, lead] of leads.entries()) {
    const other = theirs[index]!;
    if (mine.name.length >= 3 && mine.name === other.name && mine.town && mine.town === other.town) {
      if (contradicts(mine, other)) continue;
      return { lead, via: REASON_VIA.NAME_TOWN, reason: "NAME_TOWN" };
    }
  }
  return null;
}
