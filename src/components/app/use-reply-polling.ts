import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { advanceJob, startJob } from "@/lib/jobs/server";
import type { JobView } from "@/lib/jobs/types";

/** How often replies are checked while the app is open and visible. */
const POLL_EVERY_MS = 15 * 60 * 1000;

type ReplyPollProgress = { replies: number; checked: number; bounces: number; detail: string };

/**
 * Check Gmail for replies in the background while the app is open, so nobody
 * has to remember to. The server runs it as a `reply_poll` job: one at a time
 * per account, at most every ten minutes however many tabs ask, and the daily
 * cron covers the hours the app is closed. Nothing here sends anything.
 */
export function useReplyPolling(enabled: boolean, onNewReplies: () => void) {
  const callback = useRef(onNewReplies);
  callback.current = onNewReplies;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let live = true;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const started = await startJob({ data: { type: "reply_poll", input: {} } });
        if (!started.ok) return;
        let view = JSON.parse(started.job) as JobView<ReplyPollProgress>;
        for (let step = 0; live && step < 20 && (view.status === "queued" || view.status === "running"); step += 1) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const next = await advanceJob({ data: { id: view.id } });
          if (!next.ok) return;
          view = JSON.parse(next.job) as JobView<ReplyPollProgress>;
        }
        const found = view.status === "done" && !view.cancelRequested ? (view.progress?.replies ?? 0) : 0;
        if (live && found > 0 && Date.parse(view.finishedAt) > Date.now() - 60_000) {
          toast(`${found} new ${found === 1 ? "reply" : "replies"} — they're on Today.`);
          callback.current();
        }
      } catch {
        // Offline or signed out: the next tick, or the daily cron, will catch up.
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void poll(), 5000);
    const timer = setInterval(() => void poll(), POLL_EVERY_MS);
    const onVisible = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}
