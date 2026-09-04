import { useState } from "react";
import { Check, CloudOff, Loader2, Smartphone, TriangleAlert } from "lucide-react";
import { useLeadsStore, useSyncStatus } from "@/store/leads-store";
import { cn } from "@/lib/utils";

/**
 * Where the sheet actually lives, said plainly.
 *
 * The app never pretends. If leads are only on this device — signed out, no
 * database, or the network is down — it says so, and tapping it explains what
 * that means and offers a retry. Silently working offline and losing a day of
 * calls is the one failure this tool cannot afford.
 */
export function SyncBadge() {
  const { label, state, pending } = useSyncStatus();
  const message = useLeadsStore((s) => s.syncMessage);
  const durable = useLeadsStore((s) => s.durable);
  const sync = useLeadsStore((s) => s.sync);
  const [open, setOpen] = useState(false);

  const settled = state === "synced" && pending === 0 && durable;
  const warning = state === "local-only" || state === "error" || (state === "synced" && !durable);

  const Icon =
    state === "syncing"
      ? Loader2
      : state === "error"
        ? CloudOff
        : state === "local-only"
          ? Smartphone
          : settled
            ? Check
            : TriangleAlert;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Storage: ${label}`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
          settled && "bg-surface text-muted",
          warning && "bg-warm-lead/15 text-warm-lead",
          !settled && !warning && "bg-surface text-muted",
        )}
      >
        <Icon className={cn("size-3", state === "syncing" && "animate-spin")} />
        {label}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-bg/70 p-4 sm:items-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-surface p-5 shadow-(--shadow-overlay)"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="font-display text-lg font-medium">{label}</h2>
            <p className="mt-2 text-sm text-muted">
              {state === "local-only"
                ? "Your leads are saved in this browser and work offline, but they are not on your account yet — another phone or laptop will not see them."
                : null}
              {state === "error"
                ? "Your leads are safe in this browser. They could not be copied to your account just now — this is not the same as being offline."
                : null}
              {state !== "local-only" && state !== "error" && !durable
                ? "This is a preview database — it resets when the server restarts. Your browser copy is the real one here."
                : null}
              {settled
                ? "Every lead is saved to your account, so the same sheet is on your phone and your laptop."
                : null}
              {state === "syncing" ? "Saving your latest changes." : null}
            </p>
            {message ? <p className="mt-2 text-sm text-subtle">{message}</p> : null}
            {pending > 0 ? (
              <p className="mt-2 text-sm text-subtle">
                {pending} change{pending === 1 ? "" : "s"} waiting to go up.
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="h-10 rounded-md bg-surface-2 px-3.5 text-sm font-medium"
                onClick={() => {
                  void sync();
                  setOpen(false);
                }}
              >
                Try again
              </button>
              <button
                type="button"
                className="h-10 rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
