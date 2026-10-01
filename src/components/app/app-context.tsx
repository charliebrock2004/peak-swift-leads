/**
 * What every screen shares: the account's data from the server (businesses,
 * emails, settings), and the one prospecting run that may be going.
 *
 * Held at the shell, so a run keeps going while you look at other screens, and
 * so every screen shows the same numbers from the same load.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getOutreachState, type OutreachState } from "@/lib/outreach/server";
import { classifySetupError, type SetupReason } from "@/lib/outreach/setup-state";
import { autoContext } from "@/lib/outreach/auto-run";
import { useLegacyLeadMigration } from "./use-legacy-leads";
import { useProspectRun } from "./use-prospect-run";
import { useReplyPolling } from "./use-reply-polling";
import { useActiveTime } from "./use-active-time";
import { AppDataContext } from "./app-data";

/** Check for changes when the tab comes back, but not more often than this. */
const REFRESH_AFTER_MS = 20_000;

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OutreachState | null>(null);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState<SetupReason | null>(null);
  const [error, setError] = useState("");
  const loadedAt = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const version = useRef("");

  /**
   * Load the account's state. `onlyIfChanged` asks the server first whether
   * anything changed since the version on screen — what coming back to the
   * tab uses, so returning from a phone call does not reload every row.
   */
  const refresh = useCallback(async (onlyIfChanged: boolean) => {
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      try {
        const next = await getOutreachState({ data: { ifChanged: onlyIfChanged ? version.current : "" } });
        if (!next.ok) {
          setError(next.error);
          setSetup(next.setup ?? classifySetupError(next.error));
          return;
        }
        loadedAt.current = Date.now();
        if ("unchanged" in next) return;
        version.current = next.version;
        setState(next);
        setError("");
        setSetup(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not load.";
        setError(message);
        setSetup(classifySetupError(message));
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = task;
    return task;
  }, []);

  const reload = useCallback(() => refresh(false), [refresh]);

  useEffect(() => {
    void reload();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > REFRESH_AFTER_MS) void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload, refresh]);

  useReplyPolling(state?.connection.status === "connected", () => void reload());

  const prospecting = useProspectRun(() => {
    void reload();
  });

  useLegacyLeadMigration(() => void reload());

  // Minutes of your time, for minutes per conversation (Insights).
  useActiveTime(state !== null);

  const context = useMemo(
    () => (state ? autoContext(state.emails, state.suppression.map((entry) => entry.email), state.settings) : null),
    [state],
  );

  const value = useMemo(
    () => ({ state, loading, setup, error, reload, context, prospecting }),
    [state, loading, setup, error, reload, context, prospecting],
  );
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
