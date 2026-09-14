import {
  findDuplicate,
  independentHost,
  normalizeMaps,
  normalizeName,
  normalizePhone,
  type DuplicateMatch,
  type LeadIdentity,
} from "./leads.ts";

/**
 * `findDuplicate` in index form.
 *
 * Discovery now pools every area before capping, which means a candidate is
 * checked against thousands of businesses rather than a dozen. `findDuplicate`
 * re-normalises every stored lead on every call, so that pattern is quadratic
 * with a regex in the inner loop — fine for 12 leads, far too slow for 2,000.
 *
 * Every rule inside `findDuplicate` is an exact equality on a derived key, so
 * the same decision can be reached by keying those values once on insert and
 * looking them up in constant time. This file deliberately adds **no new
 * matching rules and no fuzzy matching**: it derives the identical keys from
 * the identical helpers, and `identity-index.test.ts` checks it agrees with
 * `findDuplicate` case for case.
 *
 * One documented difference: when a candidate collides with two different
 * stored businesses at once, `findDuplicate` returns whichever appears first
 * in the array and this returns whichever key is checked first. Both say
 * "duplicate"; only the reported `via` can differ. Dedupe cares about the
 * former, so this is safe — and it is why `findDuplicate` remains the
 * authority anywhere the matched lead itself matters.
 */
export type IdentityKey = { via: DuplicateMatch["via"]; key: string };

/**
 * Keys in the order `findDuplicate` tests them: every strong signal first,
 * then the loose whole-name rule that it only reaches in its second pass.
 *
 * A key is emitted only when the underlying rule would actually fire, so an
 * empty phone or a social-media "website" contributes nothing and can never
 * collide with another business that is also missing it.
 */
export function identityKeys(candidate: LeadIdentity): IdentityKey[] {
  const keys: IdentityKey[] = [];

  const placeId = candidate.placeId?.trim() ?? "";
  if (placeId) keys.push({ via: "place", key: `place:${placeId}` });

  const phone = normalizePhone(candidate.phone);
  if (phone.length >= 10) keys.push({ via: "phone", key: `phone:${phone}` });

  const email = (candidate.email ?? "").trim().toLowerCase();
  if (email) keys.push({ via: "email", key: `email:${email}` });

  // `independentHost` returns "" for directories and social pages, so two
  // unrelated joiners who both only have a Facebook page never collide.
  const host = independentHost(candidate.website);
  if (host) keys.push({ via: "website", key: `website:${host}` });

  const maps = candidate.mapsLink.trim() ? normalizeMaps(candidate.mapsLink) : "";
  if (maps) keys.push({ via: "maps", key: `maps:${maps}` });

  const name = normalizeName(candidate.businessName);
  const town = candidate.town.trim().toLowerCase();
  if (name.length >= 3 && town) keys.push({ via: "name+town", key: `nametown:${name}|${town}` });

  // The loose rule: a long, multi-word name is distinctive enough to match on
  // its own. "Smith" is not, which is why the length and space are required.
  if (name.length >= 8 && name.includes(" ")) keys.push({ via: "name", key: `name:${name}` });

  return keys;
}

export type IdentityIndex<T> = {
  /** The stored entry this candidate duplicates, or null when it is new. */
  find(candidate: LeadIdentity): { entry: T; via: DuplicateMatch["via"] } | null;
  /** Index an entry under every key it owns. First writer of a key keeps it. */
  add(candidate: LeadIdentity, entry: T): void;
  readonly size: number;
};

export function createIdentityIndex<T>(seed: readonly (LeadIdentity & { entry?: T })[] = []): IdentityIndex<T> {
  const byKey = new Map<string, { entry: T; via: DuplicateMatch["via"] }>();
  let size = 0;

  const index: IdentityIndex<T> = {
    find(candidate) {
      for (const { key } of identityKeys(candidate)) {
        const hit = byKey.get(key);
        if (hit) return hit;
      }
      return null;
    },
    add(candidate, entry) {
      size += 1;
      for (const { via, key } of identityKeys(candidate)) {
        // Never overwrite: the first business to claim a key owns it, which
        // mirrors `findDuplicate` returning the earliest match in the array.
        if (!byKey.has(key)) byKey.set(key, { entry, via });
      }
    },
    get size() {
      return size;
    },
  };

  for (const item of seed) index.add(item, item.entry as T);
  return index;
}

/** Build an index over existing leads, where the lead itself is the entry. */
export function indexOf<T extends LeadIdentity>(leads: readonly T[]): IdentityIndex<T> {
  const index = createIdentityIndex<T>();
  for (const lead of leads) index.add(lead, lead);
  return index;
}

/**
 * The authority, kept for callers that need the matched lead exactly as
 * `findDuplicate` would pick it (field merging, outreach history).
 */
export { findDuplicate };
