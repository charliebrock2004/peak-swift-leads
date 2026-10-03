/**
 * Why a Find run produced nothing worth working — said plainly, at the stage
 * where it happened.
 *
 * A run that finds 138 listings and delivers no prospects has not succeeded,
 * and showing it as READY hides the one thing the user needs to know: which
 * step lost everything. There are four places it can happen, and each needs a
 * different response:
 *
 *   discovery       — the sources returned nothing usable (down, empty, or
 *                     every row refused);
 *   deduplication   — everything found is a business you already have, have
 *                     contacted or have ruled out: the area is worked out for
 *                     these trades, and searching it again finds the same;
 *   contactability  — new businesses, but none with a public email or phone;
 *   scoring         — new and reachable, but none needs what you sell.
 *
 * Pure and client-safe. The server adds the concrete next searches (it holds
 * coverage memory and the workspace profile); this module only reads counts.
 */
import { REJECT_REASONS } from "./discovery-reasons.ts";
import { distinctBusinesses, newBusinesses, REJECT_LABEL, type DiscoveryLedger } from "./discovery-ledger.ts";
import type { RunFunnel } from "./outreach/run-funnel.ts";

export type RunStage = "discovery" | "deduplication" | "contactability" | "scoring";

/** A search the user can start from the diagnosis in one tap. */
export type SearchSuggestion = { location: string; trades: string[]; why: string };

export type RunDiagnosis = {
  stage: RunStage;
  headline: string;
  details: string[];
  /** Town × trade searches that returned listings but nothing new: worked out for now. */
  exhausted: { area: string; trade: string; listings: number }[];
  /** Searches that failed outright (nothing was searched). */
  failed: { area: string; trade: string; error: string }[];
  /** Where to look next. Filled by the server from coverage memory and the profile. */
  suggestions: SearchSuggestion[];
  /** Towns automatically searched in a widening round this run, if any. */
  widenedTo: string[];
};

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/**
 * The diagnosis, or null when the run did its job (new businesses that can be
 * reached and are worth reaching).
 */
export function diagnoseRun(
  ledger: DiscoveryLedger,
  funnel: Pick<RunFunnel, "checked" | "eligible" | "call" | "manualReview" | "goodWebsite" | "lowOpportunity" | "noWayToContact">,
  context: { location: string; trades: readonly string[]; widenedTo?: readonly string[] },
): RunDiagnosis | null {
  const o = ledger.outcomes;
  const trades = context.trades.join(", ").toLowerCase() || "businesses";
  const exhausted = ledger.searches
    .filter((row) => !row.error && row.listings > 0 && row.outcomes.accepted + row.outcomes.beyond_target + row.outcomes.needs_review === 0)
    .map((row) => ({ area: row.area, trade: row.trade, listings: row.listings }));
  const failed = ledger.searches.filter((row) => row.error).map((row) => ({ area: row.area, trade: row.trade, error: row.error }));
  const base = { exhausted, failed, suggestions: [], widenedTo: [...(context.widenedTo ?? [])] };
  const searchedCount = ledger.searches.length;
  const distinct = distinctBusinesses(ledger);
  const fresh = newBusinesses(ledger);

  if (ledger.listings === 0) {
    if (searchedCount > 0 && failed.length === searchedCount) {
      return {
        ...base,
        stage: "discovery",
        headline: "Nothing was searched — every search failed.",
        details: [`All ${plural(searchedCount, "search", "searches")} failed before returning anything (first error: ${failed[0]!.error}). This is a source problem, not your area: try again shortly.`],
      };
    }
    return {
      ...base,
      stage: "discovery",
      headline: `The sources returned no ${trades} around ${context.location}.`,
      details: [
        `${plural(searchedCount, "search", "searches")} ran and came back empty${failed.length ? `; ${plural(failed.length, "search", "searches")} failed outright` : ""}.`,
        "Try a different trade name, or a wider or different area.",
      ],
    };
  }

  if (distinct === 0) {
    const reasons = REJECT_REASONS.filter((reason) => ledger.invalidReasons[reason] > 0).map((reason) => `${ledger.invalidReasons[reason]} ${REJECT_LABEL[reason]}`);
    return {
      ...base,
      stage: "discovery",
      headline: `All ${ledger.listings} listings were refused or repeats — no real ${trades} businesses among them.`,
      details: [
        reasons.length ? `Refused: ${reasons.join(", ")}.` : "",
        o.duplicate_in_search ? `${o.duplicate_in_search} were second records of the same few businesses.` : "",
      ].filter(Boolean),
    };
  }

  if (fresh === 0) {
    const known = o.in_database + o.contacted + o.suppressed;
    const details = [
      `${plural(ledger.listings, "listing")} → ${plural(distinct, "distinct business", "distinct businesses")} → none new.`,
      `${o.in_database} already in your database, ${o.contacted} already contacted, ${o.suppressed} opted out or rejected by you.`,
    ];
    if (o.needs_review > 0) details.push(`${plural(o.needs_review, "business", "businesses")} might be new — they look like one you have but the evidence does not settle it. Check them below.`);
    if (exhausted.length > 0) details.push(`${plural(exhausted.length, "town and trade search", "town and trade searches")} returned only businesses you already have; they will be rested for a few weeks rather than searched again.`);
    if (o.duplicate_in_search > 0) details.push(`${o.duplicate_in_search} listings were repeats of businesses already counted (same business from two sources, towns or trades).`);
    return {
      ...base,
      stage: "deduplication",
      headline:
        o.needs_review > 0
          ? `No certain new prospects: ${known} of the ${distinct} businesses found are already yours, and ${o.needs_review} need your decision.`
          : `Every one of the ${distinct} businesses found is already yours — this area is worked out for ${trades}.`,
      details,
    };
  }

  // New businesses were found; did any survive the checks?
  if (funnel.checked > 0 && funnel.eligible + funnel.call === 0) {
    const unreachable = funnel.noWayToContact;
    const notNeeded = funnel.goodWebsite + funnel.lowOpportunity;
    if (unreachable >= notNeeded) {
      return {
        ...base,
        stage: "contactability",
        headline: `${plural(fresh, "new business", "new businesses")} found, but none can be reached yet.`,
        details: [
          `${unreachable} have no public email and no phone number on record.`,
          funnel.manualReview ? `${funnel.manualReview} are held for your check before contact.` : "",
          "They are saved: a phone number or email you add makes them workable.",
        ].filter(Boolean),
      };
    }
    return {
      ...base,
      stage: "scoring",
      headline: `${plural(fresh, "new business", "new businesses")} found, but none shows a need for what you sell.`,
      details: [
        `${funnel.goodWebsite} already have a good website, ${funnel.lowOpportunity} are low opportunity.`,
        "Trades with fewer established websites, or smaller towns, tend to have more need.",
      ],
    };
  }
  return null;
}
