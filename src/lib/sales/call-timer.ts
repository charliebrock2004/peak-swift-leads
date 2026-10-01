/**
 * Time on a call: from tapping Call to logging what happened. One call at a
 * time, held in this tab only. The person confirms the minutes before they
 * are saved, so a call logged an hour later is not counted as an hour.
 */
const KEY = "peakswift:call-start";
/** A call started longer ago than this is not timed — it was never logged. */
export const CALL_TIMER_MAX_MS = 90 * 60 * 1000;

type Started = { leadId: string; at: number };

function read(): Started | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Started>;
    if (typeof value.leadId !== "string" || typeof value.at !== "number") return null;
    if (Date.now() - value.at > CALL_TIMER_MAX_MS || value.at > Date.now()) return null;
    return { leadId: value.leadId, at: value.at };
  } catch {
    return null;
  }
}

export function markCallStarted(leadId: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ leadId, at: Date.now() }));
  } catch {
    // Private mode: the call just is not timed.
  }
}

/** Whole minutes since Call was tapped for this business (at least 1), or null. */
export function callMinutes(leadId: string): number | null {
  const started = read();
  if (!started || started.leadId !== leadId) return null;
  return Math.max(1, Math.round((Date.now() - started.at) / 60_000));
}

/** A call is under way (tapped within the last 20 minutes and not yet logged). */
export function callInProgress(): boolean {
  const started = read();
  return Boolean(started && Date.now() - started.at < 20 * 60 * 1000);
}

export function clearCallStart(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
