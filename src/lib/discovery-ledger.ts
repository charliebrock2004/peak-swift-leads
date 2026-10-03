/**
 * Where every discovered listing went — one outcome each, and the arithmetic
 * that proves it.
 *
 * A run is judged by this, not by how many rows the sources returned. A run
 * that reports "138 listings" and delivers nothing has to be able to say what
 * happened to each of the 138: refused as not a business in the trade, a
 * second record of a business already found in this search, already in your
 * database, contacted, opted out, held for your decision, or a new prospect.
 * `reconcileLedger` checks the totals and every search's row, and a run whose
 * ledger does not add up says so rather than showing the figures.
 *
 * Pure and client-safe: the Find job fills it, the Find screen and the run
 * record show it.
 */
import { emptyRejectTally, REJECT_REASONS, type RejectReason, type RejectTally } from "./discovery-reasons.ts";

export const LISTING_OUTCOMES = [
  "duplicate_in_search",
  "in_database",
  "contacted",
  "suppressed",
  "invalid",
  "needs_review",
  "accepted",
  "beyond_target",
] as const;
export type ListingOutcome = (typeof LISTING_OUTCOMES)[number];
export type OutcomeCounts = Record<ListingOutcome, number>;

export const OUTCOME_LABEL: Record<ListingOutcome, string> = {
  duplicate_in_search: "Duplicate within this search",
  in_database: "Already in your database",
  contacted: "Already contacted",
  suppressed: "Suppressed, opted out or rejected by you",
  invalid: "Rejected as invalid",
  needs_review: "Needs manual review",
  accepted: "New prospect accepted",
  beyond_target: "New, over this run's target",
};

export const REJECT_LABEL: Record<RejectReason, string> = {
  chain: "national chain or merchant",
  not_a_business: "not a business (a street, a place, a building)",
  wrong_trade: "not in this trade",
  outside_area: "outside the area searched",
  inactive: "closed or not trading",
};

export function emptyOutcomes(): OutcomeCounts {
  return { duplicate_in_search: 0, in_database: 0, contacted: 0, suppressed: 0, invalid: 0, needs_review: 0, accepted: 0, beyond_target: 0 };
}

export function outcomeTotal(counts: OutcomeCounts): number {
  return LISTING_OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
}

/** One search: one town (or area) for one trade. */
export type SearchRow = {
  area: string;
  trade: string;
  /** Rows the sources returned for this search. */
  listings: number;
  outcomes: OutcomeCounts;
  /** Rows per source, so a dead source shows as a zero. */
  bySource: { nominatim: number; photon: number; companiesHouse: number; overpass: number };
  /** The search failed outright: nothing was searched. */
  error: string;
  /** How many times this town and trade had been searched before this run. */
  priorSearches: number;
};

/** What a listing held for review was possibly the same as. */
export type ReviewMatch = "database" | "contacted" | "suppressed" | "this_run";

export type ReviewItem = {
  /** Stable within a run, for the screen's buttons. */
  key: string;
  businessName: string;
  trade: string;
  town: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  source: string;
  placeId: string;
  area: string;
  match: ReviewMatch;
  matchedName: string;
  matchedTown: string;
  matchedId: string;
  /** The resolver's words: why it might be the same, and why that is not certain. */
  reason: string;
};

export type DuplicateKinds = {
  /** Two sources' records of one business in the same search, merged. */
  acrossSources: number;
  /** One business listed under several towns. */
  acrossAreas: number;
  /** One business found again under a later trade. */
  acrossTrades: number;
};

export type DiscoveryLedger = {
  listings: number;
  outcomes: OutcomeCounts;
  invalidReasons: RejectTally;
  duplicates: DuplicateKinds;
  searches: SearchRow[];
  /** Listings held for a person, with what they might be. Capped; the count is in `outcomes`. */
  review: ReviewItem[];
};

export const REVIEW_KEEP = 60;
export const SEARCH_ROWS_KEEP = 120;

export function emptyLedger(): DiscoveryLedger {
  return {
    listings: 0,
    outcomes: emptyOutcomes(),
    invalidReasons: emptyRejectTally(),
    duplicates: { acrossSources: 0, acrossAreas: 0, acrossTrades: 0 },
    searches: [],
    review: [],
  };
}

export function emptySearchRow(area: string, trade: string, priorSearches = 0): SearchRow {
  return { area, trade, listings: 0, outcomes: emptyOutcomes(), bySource: { nominatim: 0, photon: 0, companiesHouse: 0, overpass: 0 }, error: "", priorSearches };
}

/** Distinct businesses the run actually saw: every listing that was not refused or a repeat. */
export function distinctBusinesses(ledger: Pick<DiscoveryLedger, "outcomes">): number {
  const o = ledger.outcomes;
  return o.in_database + o.contacted + o.suppressed + o.needs_review + o.accepted + o.beyond_target;
}

/** New businesses found, whether or not this run took them all. */
export function newBusinesses(ledger: Pick<DiscoveryLedger, "outcomes">): number {
  return ledger.outcomes.accepted + ledger.outcomes.beyond_target;
}

/** Fold one trade's ledger into the run's. */
export function mergeLedger(into: DiscoveryLedger, from: DiscoveryLedger): DiscoveryLedger {
  const outcomes = emptyOutcomes();
  for (const outcome of LISTING_OUTCOMES) outcomes[outcome] = into.outcomes[outcome] + from.outcomes[outcome];
  const invalidReasons = emptyRejectTally();
  for (const reason of REJECT_REASONS) invalidReasons[reason] = into.invalidReasons[reason] + from.invalidReasons[reason];
  return {
    listings: into.listings + from.listings,
    outcomes,
    invalidReasons,
    duplicates: {
      acrossSources: into.duplicates.acrossSources + from.duplicates.acrossSources,
      acrossAreas: into.duplicates.acrossAreas + from.duplicates.acrossAreas,
      acrossTrades: into.duplicates.acrossTrades + from.duplicates.acrossTrades,
    },
    searches: [...into.searches, ...from.searches].slice(0, SEARCH_ROWS_KEEP),
    review: [...into.review, ...from.review].slice(0, REVIEW_KEEP),
  };
}

/**
 * Move listings from one outcome to another after the fact — when a business
 * accepted in discovery turns out, at save time, to be on the sheet after all.
 * The search row that found it moves with it, so the rows still add up.
 */
export function moveOutcome(ledger: DiscoveryLedger, from: ListingOutcome, to: ListingOutcome, count: number, area?: { area: string; trade: string }): void {
  const n = Math.min(count, ledger.outcomes[from]);
  if (n <= 0) return;
  ledger.outcomes[from] -= n;
  ledger.outcomes[to] += n;
  let left = n;
  const rows = area ? ledger.searches.filter((row) => row.area === area.area && row.trade === area.trade) : ledger.searches;
  for (const row of [...rows, ...ledger.searches]) {
    if (left <= 0) break;
    const take = Math.min(left, row.outcomes[from]);
    row.outcomes[from] -= take;
    row.outcomes[to] += take;
    left -= take;
  }
}

/**
 * Does every listing have exactly one outcome? Returns the broken equations,
 * in words; empty means the ledger is true.
 */
export function reconcileLedger(ledger: DiscoveryLedger): string[] {
  const problems: string[] = [];
  const total = outcomeTotal(ledger.outcomes);
  if (total !== ledger.listings) problems.push(`listings ${ledger.listings} ≠ sum of outcomes ${total}`);
  const invalid = REJECT_REASONS.reduce((sum, reason) => sum + ledger.invalidReasons[reason], 0);
  if (invalid !== ledger.outcomes.invalid) problems.push(`invalid ${ledger.outcomes.invalid} ≠ sum of reasons ${invalid}`);
  const dupes = ledger.duplicates.acrossSources + ledger.duplicates.acrossAreas + ledger.duplicates.acrossTrades;
  if (dupes !== ledger.outcomes.duplicate_in_search) problems.push(`duplicates ${ledger.outcomes.duplicate_in_search} ≠ sources + areas + trades ${dupes}`);
  for (const outcome of LISTING_OUTCOMES) if (ledger.outcomes[outcome] < 0) problems.push(`${OUTCOME_LABEL[outcome]} is negative`);
  // Rows are kept only up to SEARCH_ROWS_KEEP; when all are kept they must sum to the totals.
  if (ledger.searches.length < SEARCH_ROWS_KEEP) {
    const rowListings = ledger.searches.reduce((sum, row) => sum + row.listings, 0);
    if (rowListings !== ledger.listings) problems.push(`searches' listings ${rowListings} ≠ total ${ledger.listings}`);
    for (const outcome of LISTING_OUTCOMES) {
      const rowSum = ledger.searches.reduce((sum, row) => sum + row.outcomes[outcome], 0);
      if (rowSum !== ledger.outcomes[outcome]) problems.push(`searches' ${OUTCOME_LABEL[outcome].toLowerCase()} ${rowSum} ≠ total ${ledger.outcomes[outcome]}`);
    }
    for (const row of ledger.searches) {
      const sum = outcomeTotal(row.outcomes);
      if (sum !== row.listings) problems.push(`${row.trade} in ${row.area}: ${row.listings} listings ≠ ${sum} outcomes`);
    }
  }
  return problems;
}

/** Parse a stored ledger, tolerating runs from before it existed. */
export function parseLedger(value: unknown): DiscoveryLedger | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<DiscoveryLedger>;
  if (typeof raw.listings !== "number" || !raw.outcomes) return null;
  const ledger = emptyLedger();
  ledger.listings = raw.listings;
  for (const outcome of LISTING_OUTCOMES) ledger.outcomes[outcome] = Number(raw.outcomes[outcome]) || 0;
  for (const reason of REJECT_REASONS) ledger.invalidReasons[reason] = Number(raw.invalidReasons?.[reason]) || 0;
  ledger.duplicates = {
    acrossSources: Number(raw.duplicates?.acrossSources) || 0,
    acrossAreas: Number(raw.duplicates?.acrossAreas) || 0,
    acrossTrades: Number(raw.duplicates?.acrossTrades) || 0,
  };
  ledger.searches = Array.isArray(raw.searches) ? raw.searches.slice(0, SEARCH_ROWS_KEEP) : [];
  ledger.review = Array.isArray(raw.review) ? raw.review.slice(0, REVIEW_KEEP) : [];
  return ledger;
}
