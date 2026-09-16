import {
  contradicts,
  evidenceOf,
  findDuplicate,
  REASON_VIA,
  type DuplicateMatch,
  type Evidence,
  type LeadIdentity,
  type MatchReason,
} from "./identity.ts";

/**
 * `identity.ts` in index form.
 *
 * Discovery pools every area before capping, so a candidate is checked against
 * thousands of businesses rather than a dozen. Comparing each pair directly is
 * quadratic with regex normalisation in the inner loop — fine for 12 records,
 * far too slow for several thousand.
 *
 * Every strong rule is an exact equality on a derived value, so keying those
 * once on insert reaches the same decision in constant time. The name rule is
 * the one that cannot be answered by a key alone: it has to check that nothing
 * contradicts, and that needs the stored record. So weak keys hold a bucket of
 * every record sharing that name and town, and a lookup walks only that
 * bucket. Each candidate therefore compares against businesses of the same
 * name rather than against all of them, which keeps the whole pass linear.
 *
 * This file adds NO matching rules of its own. `identity-index.test.ts` checks
 * it agrees with `findDuplicate` case for case, contradictions included.
 *
 * ONE KNOWN CHARACTERISTIC, measured rather than assumed: when many records
 * share a name AND a town AND all contradict each other, they all land in one
 * bucket and the pass degrades towards quadratic — 2,000 such rows take about
 * 40ms. That is the deliberate cost of agreeing with the authority exactly
 * rather than capping the scan and quietly deciding something different, and
 * it is bounded by DISCOVERY_SAFETY.poolCeiling. `prospect-pool-scale.test.ts`
 * pins the worst case so it cannot grow unnoticed.
 */
export type IdentityKey = { via: MatchReason; key: string };

/**
 * The strong keys a record owns, in the order `findDuplicate` tests them.
 *
 * A key is emitted only when the underlying rule would actually fire, so an
 * empty phone or a social-media "website" contributes nothing and can never
 * collide with another business that is also missing it.
 */
export function strongKeys(evidence: Evidence): IdentityKey[] {
  const keys: IdentityKey[] = [];
  if (evidence.placeId) keys.push({ via: "PLACE_ID", key: `place:${evidence.placeId}` });
  if (evidence.phone.length >= 10) keys.push({ via: "PHONE", key: `phone:${evidence.phone}` });
  if (evidence.email) keys.push({ via: "EMAIL", key: `email:${evidence.email}` });
  if (evidence.host) keys.push({ via: "DOMAIN", key: `website:${evidence.host}` });
  if (evidence.maps) keys.push({ via: "MAPS_URL", key: `maps:${evidence.maps}` });
  return keys;
}

/** The one weak key: a name is only ever comparable within a town. */
export function nameKey(evidence: Evidence): string {
  if (evidence.name.length < 3 || !evidence.town) return "";
  return `nametown:${evidence.name}|${evidence.town}`;
}

/** Every key a record owns. Kept for tests and diagnostics. */
export function identityKeys(candidate: LeadIdentity): IdentityKey[] {
  const evidence = evidenceOf(candidate);
  const keys = strongKeys(evidence);
  const name = nameKey(evidence);
  if (name) keys.push({ via: "NAME_TOWN", key: name });
  return keys;
}

export type IdentityIndex<T> = {
  /** The stored entry this candidate duplicates, or null when it is new. */
  find(candidate: LeadIdentity): { entry: T; via: MatchReason } | null;
  /** Index an entry under every key it owns. */
  add(candidate: LeadIdentity, entry: T): void;
  readonly size: number;
};

export function createIdentityIndex<T>(): IdentityIndex<T> {
  const strong = new Map<string, { entry: T; via: MatchReason }>();
  /** Same name, same town — several businesses may legitimately share one. */
  const byName = new Map<string, { entry: T; evidence: Evidence }[]>();
  let size = 0;

  return {
    find(candidate) {
      const mine = evidenceOf(candidate);
      // Strong evidence first, and across every stored record, exactly as the
      // authority does: a phone match anywhere beats a name match anywhere.
      for (const { key } of strongKeys(mine)) {
        const hit = strong.get(key);
        if (hit) return hit;
      }
      const name = nameKey(mine);
      if (!name) return null;
      for (const stored of byName.get(name) ?? []) {
        // The whole point of the bucket: a shared name only merges when
        // nothing the two records carry says they are different businesses.
        if (!contradicts(mine, stored.evidence)) return { entry: stored.entry, via: "NAME_TOWN" };
      }
      return null;
    },
    add(candidate, entry) {
      size += 1;
      const evidence = evidenceOf(candidate);
      for (const { via, key } of strongKeys(evidence)) {
        // Never overwrite: the first business to claim a key owns it, which
        // mirrors the authority returning the earliest match in the array.
        if (!strong.has(key)) strong.set(key, { entry, via });
      }
      const name = nameKey(evidence);
      if (name) {
        const bucket = byName.get(name);
        if (bucket) bucket.push({ entry, evidence });
        else byName.set(name, [{ entry, evidence }]);
      }
    },
    get size() {
      return size;
    },
  };
}

/** Build an index over existing leads, where the lead itself is the entry. */
export function indexOf<T extends LeadIdentity>(leads: readonly T[]): IdentityIndex<T> {
  const index = createIdentityIndex<T>();
  for (const lead of leads) index.add(lead, lead);
  return index;
}

/**
 * The authority, for callers that need the matched lead exactly as
 * `findDuplicate` picks it (field merging, outreach history).
 */
export { findDuplicate, REASON_VIA, type DuplicateMatch };
