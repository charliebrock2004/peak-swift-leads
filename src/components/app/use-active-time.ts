import { useEffect } from "react";
import { callInProgress } from "@/lib/sales/call-timer";
import { runSalesAction } from "@/lib/sales/client";

/** Counted in steps of this long. */
const TICK_MS = 15_000;
/** Without a tap, key or scroll for this long, you are not using the app. */
const IDLE_AFTER_MS = 60_000;
/** Report at least this often while counting. */
const REPORT_EVERY_S = 5 * 60;

/**
 * Measure the minutes you spend using PeakSwift, for "minutes per
 * conversation". Counted only while the tab is visible and you have touched
 * it in the last minute, and paused while a call is being timed (that time is
 * counted with the call). Totals per day are all the server keeps.
 */
export function useActiveTime(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let lastInput = Date.now();
    let pending = 0;
    const touch = () => {
      lastInput = Date.now();
    };
    const report = () => {
      if (pending < 15) return;
      const seconds = pending;
      pending = 0;
      void runSalesAction({ action: "log_time", seconds }).then((reply) => {
        if (!reply.ok) pending += seconds;
      });
    };
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastInput > IDLE_AFTER_MS || callInProgress()) return;
      pending += TICK_MS / 1000;
      if (pending >= REPORT_EVERY_S) report();
    };
    const onHidden = () => document.visibilityState === "hidden" && report();
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", report);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      for (const name of events) window.removeEventListener(name, touch, { capture: true });
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", report);
      report();
    };
  }, [enabled]);
}
