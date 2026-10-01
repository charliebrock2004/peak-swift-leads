/**
 * Feedback you can measure: how often each discovery source and each trade
 * search gave you a business you kept, and the small, rule-based adjustments
 * Find makes once there are enough marks to mean something.
 *
 * Client-safe and pure.
 */
import { RATE_MIN_SENT, rateOf, type Rate } from "../outreach/analytics.ts";
import { sourceKeyOf, type SourceKey } from "../prospect-pool.ts";
import { POSITIVE, REJECTING, type Verdict } from "./verdicts.ts";

/** A source or trade needs this many marks before its record changes anything. */
export const FEEDBACK_MIN = RATE_MIN_SENT;

export type FeedbackRow = { leadId: string; verdict: Verdict; source: string; trade: string; town: string; website?: string; createdAt?: string };

export type QualityRow = {
  key: string;
  /** Businesses marked at all. */
  marked: number;
  good: number;
  rejected: number;
  /** Rejected ÷ marked (good or rejected), withheld below FEEDBACK_MIN. */
  rejectedRate: Rate;
};

/** Per business: is the latest word good, rejected, or neither? */
function standing(rows: readonly FeedbackRow[]): Map<string, { good: boolean; rejected: boolean; row: FeedbackRow }> {
  const out = new Map<string, { good: boolean; rejected: boolean; row: FeedbackRow }>();
  for (const row of rows) {
    const entry = out.get(row.leadId) ?? { good: false, rejected: false, row };
    if (POSITIVE.includes(row.verdict)) entry.good = true;
    if (REJECTING.includes(row.verdict)) entry.rejected = true;
    out.set(row.leadId, entry);
  }
  return out;
}

function tally(rows: readonly FeedbackRow[], keyOf: (row: FeedbackRow) => string): QualityRow[] {
  const groups = new Map<string, Omit<QualityRow, "rejectedRate">>();
  for (const { good, rejected, row } of standing(rows).values()) {
    if (!good && !rejected) continue;
    const key = keyOf(row) || "Unknown";
    const group = groups.get(key) ?? { key, marked: 0, good: 0, rejected: 0 };
    group.marked += 1;
    if (good) group.good += 1;
    else group.rejected += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, rejectedRate: rateOf(group.rejected, group.marked, FEEDBACK_MIN) }))
    .sort((a, b) => b.marked - a.marked || a.key.localeCompare(b.key));
}

export const SOURCE_LABEL: Record<SourceKey, string> = {
  companiesHouse: "Companies House",
  nominatim: "OpenStreetMap (Nominatim)",
  photon: "OpenStreetMap",
  overpass: "OpenStreetMap (Overpass)",
  other: "Other / added by you",
};

/** Good vs rejected by discovery source. */
export function qualityBySource(rows: readonly FeedbackRow[]): QualityRow[] {
  return tally(rows, (row) => sourceKeyOf(row.source));
}

/** Good vs rejected by the trade the business was found under. */
export function qualityByTrade(rows: readonly FeedbackRow[]): QualityRow[] {
  return tally(rows, (row) => row.trade.trim());
}

/**
 * How much to move a source's prospects up or down Find's ranking: −10 when
 * most of its marked results were rejected, +5 when most were good, nothing
 * until FEEDBACK_MIN marks exist. Points on the 0–100 priority scale.
 */
export function sourceWeights(rows: readonly FeedbackRow[]): Partial<Record<SourceKey, number>> {
  const out: Partial<Record<SourceKey, number>> = {};
  for (const row of qualityBySource(rows)) {
    if (row.rejectedRate.value === null) continue;
    if (row.rejectedRate.value >= 60) out[row.key as SourceKey] = -10;
    else if (row.rejectedRate.value <= 25) out[row.key as SourceKey] = 5;
  }
  return out;
}

/**
 * A plain warning for a trade search whose results you have mostly rejected,
 * or "" while there are too few marks to say.
 */
export function tradeAdvice(rows: readonly FeedbackRow[], trade: string): string {
  const row = qualityByTrade(rows).find((item) => item.key.toLowerCase() === trade.trim().toLowerCase());
  if (!row || row.rejectedRate.value === null || row.rejectedRate.value < 50) return "";
  return `You rejected ${row.rejected} of ${row.marked} "${row.key}" prospects you marked — consider a more specific trade.`;
}

/** Rows for the businesses on hand, from their facts — the client's view of the same table. */
export function rowsFromLeads(leads: readonly { id: string; source: string; trade: string; town: string; facts?: { feedback?: readonly Verdict[] } }[]): FeedbackRow[] {
  return leads.flatMap((lead) => (lead.facts?.feedback ?? []).map((verdict) => ({ leadId: lead.id, verdict, source: lead.source, trade: lead.trade, town: lead.town })));
}
