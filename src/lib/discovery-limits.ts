/**
 * Explicit technical safety limits, deliberately separate from the user's
 * target.
 *
 * The bug this file exists to fix was a safety limit masquerading as a target:
 * a hard-coded 12 rows per town meant asking for 60 prospects across 14 towns
 * silently became "keep the nearest 12 of each, bin the other 428". The target
 * is now the only thing that decides how many prospects come back, and these
 * are the only things that can stop it — each one named, and each one reported
 * in diagnostics when it actually bites, so the run log can never again say
 * "raise your target" about a limit the target does not control.
 */
export const DISCOVERY_SAFETY = {
  /** Largest target the UI will honour in one run. */
  targetMax: 500,
  /**
   * Rows a single area is asked for. A fetch budget, not a cap on results:
   * every row an area returns joins the shared pool, and the pool is what the
   * target is applied to. Raising this widens each page the sources return; it
   * does not send more requests.
   */
  fetchPerArea: 60,
  /** Hard ceiling on the candidate pool, so a huge target cannot storm the APIs. */
  poolCeiling: 2000,
  /** Hard ceiling on areas searched in one run. */
  maxAreas: 40,
} as const;
