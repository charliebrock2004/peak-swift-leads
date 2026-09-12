/**
 * Running a real-world validation batch.
 *
 * Unit tests prove the rules behave as written. They cannot tell you whether a
 * real hairdresser in Perth publishes an address the crawler can reach, and no
 * number derived from a fixture should ever be presented as if they could.
 * This module is the bridge: it turns a pasted list of real businesses into a
 * run, and a run into a table that can be read, checked by hand and pasted back.
 *
 * Pure. The caller does the fetching, one business at a time, through the
 * existing `findLeadEmail` server function — no new server function, and
 * nothing here sends anything to anyone.
 *
 * The most important thing in this file is what it refuses to compute. A row is
 * only a success when a person has confirmed the website and the address are
 * genuinely that business's, so `websiteCorrect` and `emailCorrect` start
 * UNKNOWN and no accuracy figure is reported until they are filled in.
 */

/** One business to test, as parsed from a pasted line. */
export type BatchInput = {
  businessName: string;
  town: string;
  trade: string;
  phone: string;
  address: string;
  /** Optional: a site you already know, to test the crawl rather than the search. */
  website: string;
};

/**
 * Parse a pasted batch.
 *
 * One business per line, fields separated by `|`, in the order shown in
 * `BATCH_TEMPLATE`. Forgiving about spacing and missing trailing fields,
 * because the list will be typed by hand and a format that punishes a missing
 * postcode is a format nobody completes.
 */
export function parseBatch(text: string): BatchInput[] {
  const out: BatchInput[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Skip a pasted header row rather than searching for a business called "Business".
    if (/^business\s*\|/i.test(line)) continue;
    const parts = line.split("|").map((part) => part.trim());
    const businessName = parts[0] ?? "";
    if (businessName.length < 2) continue;
    out.push({
      businessName,
      town: parts[1] ?? "",
      trade: parts[2] ?? "",
      phone: parts[3] ?? "",
      address: parts[4] ?? "",
      website: parts[5] ?? "",
    });
  }
  return out;
}

export const BATCH_TEMPLATE =
  "# Business | Town | Trade | Phone | Address incl. postcode | Known website (optional)\n" +
  "Clark Joinery | Perth | Joiner | 01738 445566 | 22 South Street, Perth PH2 8PG |\n";

/** Whether a person has confirmed a result. Never inferred. */
export const VERDICTS = ["UNKNOWN", "CORRECT", "WRONG"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type BatchRow = {
  input: BatchInput;
  /** The website the run verified, or "" when it verified none. */
  website: string;
  identityScore: number | null;
  email: string;
  confidence: string;
  reason: string;
  pagesFetched: number;
  elapsedMs: number;
  /** Filled in by the person checking the run, never by the run itself. */
  websiteCorrect: Verdict;
  emailCorrect: Verdict;
  /** Set when the run itself failed rather than finding nothing. */
  error: string;
};

export function blankRow(input: BatchInput): BatchRow {
  return {
    input,
    website: "",
    identityScore: null,
    email: "",
    confidence: "",
    reason: "",
    pagesFetched: 0,
    elapsedMs: 0,
    websiteCorrect: "UNKNOWN",
    emailCorrect: "UNKNOWN",
    error: "",
  };
}

/**
 * What the batch actually established.
 *
 * Every rate has an explicit denominator, and the two that depend on human
 * judgement report how many rows are still unchecked. A run where nobody has
 * confirmed anything reports `checked: 0` rather than a flattering accuracy.
 */
export type BatchSummary = {
  tested: number;
  /** Runs that completed, whatever they found. */
  completed: number;
  websitesVerified: number;
  emailsFound: number;
  /** Rows a person has marked CORRECT or WRONG. */
  websitesChecked: number;
  websitesConfirmedCorrect: number;
  /** A verified website a person marked WRONG: the failure that matters most. */
  falsePositiveWebsites: number;
  emailsChecked: number;
  emailsConfirmedCorrect: number;
  falsePositiveEmails: number;
  /** No email found AND no website wrongly attached — an honest miss. */
  honestNotFound: number;
  averageMs: number;
  /** Named failure reasons and how often each occurred, commonest first. */
  reasons: { reason: string; count: number }[];
};

export function summariseBatch(rows: readonly BatchRow[]): BatchSummary {
  const done = rows.filter((row) => !row.error);
  const reasons = new Map<string, number>();
  for (const row of done) {
    if (!row.email && row.reason) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  }
  const websitesChecked = rows.filter((row) => row.websiteCorrect !== "UNKNOWN").length;
  const emailsChecked = rows.filter((row) => row.emailCorrect !== "UNKNOWN").length;
  const elapsed = done.reduce((total, row) => total + row.elapsedMs, 0);

  return {
    tested: rows.length,
    completed: done.length,
    websitesVerified: done.filter((row) => row.website).length,
    emailsFound: done.filter((row) => row.email).length,
    websitesChecked,
    websitesConfirmedCorrect: rows.filter((row) => row.websiteCorrect === "CORRECT").length,
    falsePositiveWebsites: rows.filter((row) => row.websiteCorrect === "WRONG").length,
    emailsChecked,
    emailsConfirmedCorrect: rows.filter((row) => row.emailCorrect === "CORRECT").length,
    falsePositiveEmails: rows.filter((row) => row.emailCorrect === "WRONG").length,
    honestNotFound: done.filter((row) => !row.email && row.websiteCorrect !== "WRONG").length,
    averageMs: done.length === 0 ? 0 : Math.round(elapsed / done.length),
    reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/**
 * A rate, or null when the denominator is too small to mean anything.
 *
 * Five is the same floor the dashboard uses. A percentage computed from two
 * businesses is noise wearing a number, and the whole point of this exercise is
 * to stop treating numbers as evidence when they are not.
 */
export const RATE_MIN = 5;

export function rate(numerator: number, denominator: number): string {
  if (denominator < RATE_MIN) return `${numerator}/${denominator} (too few to rate)`;
  return `${numerator}/${denominator} (${Math.round((numerator / denominator) * 100)}%)`;
}

/** The validation table, as pasteable text. */
export function batchTable(rows: readonly BatchRow[]): string {
  const header =
    "Business | Website Found | Correct Website | Email Found | Correct Email | Confidence | Failure Reason";
  const lines = rows.map((row) =>
    [
      row.input.businessName,
      row.error ? "ERROR" : row.website || "—",
      row.websiteCorrect,
      row.error ? "ERROR" : row.email || "—",
      row.emailCorrect,
      row.confidence || "—",
      row.error || row.reason || (row.email ? "—" : "unknown"),
    ].join(" | "),
  );
  return [header, ...lines].join("\n");
}

/**
 * The whole batch as plain text, table and honest summary together.
 *
 * Labels every figure as REAL and states plainly which ones nobody has checked
 * yet, so this report can never be mistaken for a set of test results.
 */
export function batchReport(rows: readonly BatchRow[]): string {
  const summary = summariseBatch(rows);
  const lines: string[] = [];
  const add = (text = "") => lines.push(text);

  add("PEAKSWIFT REAL-WORLD VALIDATION BATCH");
  add("=====================================");
  add(`Run at: ${new Date().toISOString()}`);
  add(`Businesses tested: ${summary.tested}  (completed: ${summary.completed})`);
  add();
  add(batchTable(rows));
  add();
  add("MEASURED BY THE RUN");
  add(`  websites verified: ${rate(summary.websitesVerified, summary.completed)}`);
  add(`  emails found:      ${rate(summary.emailsFound, summary.completed)}`);
  add(`  average time:      ${(summary.averageMs / 1000).toFixed(1)}s`);
  add();
  add("NEEDS A HUMAN TO CONFIRM (marked UNKNOWN until then)");
  add(
    `  websites checked: ${summary.websitesChecked} of ${summary.websitesVerified} verified` +
      ` — correct ${summary.websitesConfirmedCorrect}, WRONG ${summary.falsePositiveWebsites}`,
  );
  add(
    `  emails checked:   ${summary.emailsChecked} of ${summary.emailsFound} found` +
      ` — correct ${summary.emailsConfirmedCorrect}, WRONG ${summary.falsePositiveEmails}`,
  );
  if (summary.websitesChecked < summary.websitesVerified || summary.emailsChecked < summary.emailsFound) {
    add("  NOTE: accuracy cannot be reported until every row above is marked.");
  }
  add();
  add("FAILURE REASONS");
  if (summary.reasons.length === 0) add("  (none — every completed run produced an email)");
  for (const entry of summary.reasons) add(`  ${entry.count}x  ${entry.reason}`);

  return lines.join("\n");
}
