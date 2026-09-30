/**
 * What every screen shares: the outreach state from the server, the lead sheet
 * from the local-first store, and the one prospecting run that may be going.
 *
 * Held at the shell, so a run keeps going while you look at other screens, and
 * so every screen shows the same numbers from the same load.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getOutreachState, type OutreachState } from "@/lib/outreach/server";
import { classifySetupError, type SetupReason } from "@/lib/outreach/setup-state";
import { autoContext } from "@/lib/outreach/auto-run";
import { useLeadSync } from "@/lib/use-lead-sync";
import { useLeadsStore } from "@/store/leads-store";
import { useProspectRun } from "./use-prospect-run";
import { AppDataContext } from "./app-data";

/** Refresh when the tab comes back, but not more often than this. */
const REFRESH_AFTER_MS = 45_000;

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OutreachState | null>(null);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState<SetupReason | null>(null);
  const [error, setError] = useState("");
  const loadedAt = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  useLeadSync();

  const reload = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      try {
        const next = await getOutreachState();
        if (!next.ok) {
          setError(next.error);
          setSetup(next.setup ?? classifySetupError(next.error));
          return;
        }
        setState(next);
        setError("");
        setSetup(null);
        loadedAt.current = Date.now();
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

  useEffect(() => {
    void reload();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > REFRESH_AFTER_MS) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const prospecting = useProspectRun(() => {
    void reload();
    void useLeadsStore.getState().sync();
  });

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
