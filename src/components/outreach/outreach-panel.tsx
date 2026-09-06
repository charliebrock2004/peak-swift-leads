import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOutreach } from "@/components/outreach/use-outreach";
import { OutreachDashboard } from "@/components/outreach/outreach-dashboard";
import { OutreachProspects } from "@/components/outreach/outreach-prospects";
import { OutreachQueue } from "@/components/outreach/outreach-queue";
import { OutreachLists } from "@/components/outreach/outreach-lists";
import { OutreachSettingsTab } from "@/components/outreach/outreach-settings";
import { checkEligibility, emptyContext, type EligibilityContext } from "@/lib/outreach/eligibility";
import type { OutreachLead } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "dashboard", label: "Overview" },
  { id: "prospects", label: "Prospects" },
  { id: "review", label: "Review" },
  { id: "replies", label: "Replies" },
  { id: "settings", label: "Settings" },
] as const;
export type OutreachTab = (typeof TABS)[number]["id"];

/**
 * Outreach, as a full-screen overlay over the lead sheet.
 *
 * Same shape as Find leads and Import: the sheet stays exactly as it was, and
 * this is a place you go and come back from. Five tabs, because six was one too
 * many to read on a phone — suppression lives with Replies, and templates with
 * Settings.
 */
export function OutreachPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<OutreachTab>("dashboard");
  const [mounted, setMounted] = useState(false);
  const { state, loading, busy, error, setError, actions } = useOutreach();

  useEffect(() => setMounted(true), []);

  /** The eligibility context, built once from what the server sent. */
  const context: EligibilityContext = useMemo(() => {
    if (!state) return emptyContext();
    const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
    const alreadyContacted = new Set<string>();
    const contactedAddresses = new Set<string>();
    for (const email of state.emails) {
      if (email.kind !== "initial" || !live.has(email.status)) continue;
      alreadyContacted.add(email.leadId);
      if (email.recipient) contactedAddresses.add(email.recipient.toLowerCase());
    }
    return {
      settings: { includeLow: state.settings.includeLow },
      suppressed: new Set(state.suppression.map((entry) => entry.email)),
      alreadyContacted,
      contactedAddresses,
    };
  }, [state]);

  const leads = useMemo(() => (state?.leads ?? []) as OutreachLead[], [state]);

  const eligible = useMemo(
    () =>
      leads
        .map((lead) => ({ lead, eligibility: checkEligibility(lead, context) }))
        .filter((entry) => entry.eligibility.eligible || entry.eligibility.manualReview),
    [leads, context],
  );

  const panel = (
    <div className="find-overlay flex flex-col bg-bg text-fg">
      <header className="shrink-0 border-b border-border pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3 px-4 pb-2 md:px-6">
          <button
            type="button"
            className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            onClick={onClose}
            aria-label="Back to lead sheet"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift</p>
            <h2 className="font-display text-lg leading-tight font-medium tracking-tight">Outreach</h2>
          </div>
          {state ? (
            <span className="shrink-0 text-xs tabular-nums text-subtle">
              {state.allowance.sent} / {state.allowance.limit} today
            </span>
          ) : null}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:px-5" aria-label="Outreach sections">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={tab === entry.id ? "page" : undefined}
              onClick={() => setTab(entry.id)}
              className={cn(
                "h-9 shrink-0 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
                tab === entry.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6 md:py-8">
          {error ? (
            <div className="mb-4 flex items-start gap-3 rounded-md bg-hot/10 px-4 py-3">
              <p className="min-w-0 flex-1 text-sm text-hot">{error}</p>
              <button type="button" className="shrink-0 text-xs text-hot underline" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          ) : null}

          {loading ? (
            <div className="rounded-xl bg-surface px-5 py-16 text-center shadow-(--shadow-border)">
              <Loader2 className="mx-auto size-6 animate-spin text-muted" />
              <p className="mt-4 text-sm text-muted">Loading outreach…</p>
            </div>
          ) : !state ? (
            <div className="rounded-xl bg-surface px-5 py-14 text-center shadow-(--shadow-border)">
              <p className="font-medium">Outreach needs the database</p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
                Sending, the queue and the suppression list all live on the server. Your lead sheet is
                unaffected and still works exactly as it did.
              </p>
              <Button className="mt-5" onClick={onClose}>
                Back to leads
              </Button>
            </div>
          ) : (
            <>
              {tab === "dashboard" ? (
                <OutreachDashboard
                  state={state}
                  context={context}
                  busy={busy}
                  onGoTo={setTab}
                  onCheckReplies={() => void actions.checkReplies()}
                />
              ) : null}
              {tab === "prospects" ? (
                <OutreachProspects state={state} eligible={eligible} busy={busy} actions={actions} />
              ) : null}
              {tab === "review" ? <OutreachQueue state={state} busy={busy} actions={actions} /> : null}
              {tab === "replies" ? <OutreachLists state={state} busy={busy} actions={actions} /> : null}
              {tab === "settings" ? <OutreachSettingsTab state={state} busy={busy} actions={actions} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (!mounted) return null;
  return createPortal(panel, document.body);
}

export type OutreachActions = ReturnType<typeof useOutreach>["actions"];
