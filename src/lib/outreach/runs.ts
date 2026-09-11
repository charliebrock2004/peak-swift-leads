/**
 * Reading a finished run.
 *
 * Every AI Outreach run has always been recorded — location, trades, mode and
 * every counter — but nothing ever read the records back, so the question
 * "did last week's Perth run actually produce anything?" had no answer in the
 * app. These are the pure helpers for showing that history.
 *
 * Everything here describes a run that happened. Nothing projects, estimates or
 * compares against a target the user never set.
 */

/** The shape the runs server function returns. Kept structural on purpose. */
export type RunRecord = {
  id: string;
  startedAt: string;
  finishedAt: string;
  location: string;
  businessType: string;
  mode: string;
  found: number;
  qualified: number;
  hot: number;
  warm: number;
  callCount: number;
  skipped: number;
  emailsFound: number;
  prepared: number;
  sent: number;
  replies: number;
  errors: number;
  bottleneck: string;
  summary: string;
};

/**
 * A run's date, in the format the rest of the app uses.
 *
 * An unparseable or missing timestamp returns "" rather than "Invalid Date",
 * because a blank cell reads as missing data and "Invalid Date" reads as a bug.
 */
export function runDate(iso: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** How long a run took, or "" when either end of it is missing. */
export function runDuration(startedAt: string, finishedAt: string): string {
  if (!startedAt || !finishedAt) return "";
  const from = new Date(startedAt).getTime();
  const to = new Date(finishedAt).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return "";
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

/**
 * What a run was for, in one line: "Joiner, Plumber in Perth".
 *
 * The trades are whatever was actually run, including a comma list, so the
 * history matches what was typed rather than a tidied-up version of it.
 */
export function runTitle(run: Pick<RunRecord, "businessType" | "location">): string {
  const trade = run.businessType.trim();
  const place = run.location.trim();
  if (trade && place) return `${trade} in ${place}`;
  return trade || place || "Outreach run";
}

/**
 * The honest headline number for a run.
 *
 * A prepare run cannot have sent anything, so reporting "0 sent" for it invites
 * the reader to think something failed. It reports what it did produce instead.
 */
export function runOutcome(run: Pick<RunRecord, "mode" | "sent" | "prepared" | "found">): string {
  if (run.mode === "send") {
    return `${run.sent} sent`;
  }
  if (run.prepared > 0) return `${run.prepared} prepared`;
  return `${run.found} found`;
}

/** Did anything in this run go wrong enough to be worth showing? */
export function runHadTrouble(run: Pick<RunRecord, "errors">): boolean {
  return run.errors > 0;
}

/**
 * Totals across the runs on screen.
 *
 * Deliberately a sum of what is shown, not of all time: the caller decides how
 * many runs to display, and a total that silently covered more than the list
 * would not add up for anyone who checked it by hand.
 */
export function runTotals(runs: readonly RunRecord[]): {
  runs: number;
  found: number;
  emailsFound: number;
  prepared: number;
  sent: number;
  replies: number;
} {
  return runs.reduce(
    (total, run) => ({
      runs: total.runs + 1,
      found: total.found + run.found,
      emailsFound: total.emailsFound + run.emailsFound,
      prepared: total.prepared + run.prepared,
      sent: total.sent + run.sent,
      replies: total.replies + run.replies,
    }),
    { runs: 0, found: 0, emailsFound: 0, prepared: 0, sent: 0, replies: 0 },
  );
}
