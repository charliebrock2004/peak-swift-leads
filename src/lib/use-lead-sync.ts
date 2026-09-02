import { useEffect } from "react";
import { useLeadsStore } from "@/store/leads-store";

/** Catch-up pass while the app is open and something is still queued. */
const RETRY_MS = 60_000;

/**
 * Keep the sheet talking to the server while the app is open.
 *
 * Mutations already schedule their own push (see the store). This adds the three
 * moments a phone actually needs: opening the app, coming back to the tab after
 * it was backgrounded, and regaining signal. Everything is best-effort — a sync
 * that cannot run leaves the local copy exactly as it was.
 */
export function useLeadSync(): void {
  useEffect(() => {
    const sync = () => void useLeadsStore.getState().sync();

    sync();

    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    const retry = setInterval(() => {
      const { dirty, syncState } = useLeadsStore.getState();
      if (dirty.length > 0 || syncState === "error") sync();
    }, RETRY_MS);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", sync);
    return () => {
      clearInterval(retry);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", sync);
    };
  }, []);
}
