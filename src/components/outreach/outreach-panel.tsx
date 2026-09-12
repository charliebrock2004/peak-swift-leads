import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useOutreach } from "@/components/outreach/use-outreach";
import { OutreachDashboard } from "@/components/outreach/outreach-dashboard";
import { OutreachProspects } from "@/components/outreach/outreach-prospects";
import { OutreachAuto } from "@/components/outreach/outreach-auto";
import { OutreachCampaigns } from "@/components/outreach/outreach-campaigns";
import { OutreachQueue } from "@/components/outreach/outreach-queue";
import { OutreachLists } from "@/components/outreach/outreach-lists";
import { OutreachSettingsTab } from "@/components/outreach/outreach-settings";
import { checkEligibility, emptyContext, type EligibilityContext } from "@/lib/outreach/eligibility";
import { SETUP_COPY, type SetupReason } from "@/lib/outreach/setup-state";
import type { OutreachLead } from "@/lib/outreach/types";
import type { ProspectFilter } from "@/lib/decision";
import type { Campaign } from "@/lib/outreach/campaigns";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "dashboard", label: "Overview" },
  { id: "prospects", label: "Prospects" },
  // Campaigns group the work and keep the score. They reuse every screen
  // below rather than adding a second route to sending.
  { id: "campaigns", label: "Campaigns" },
  { id: "review", label: "Review" },
  // Automation sits beside the manual workflow, never in front of it: the
  // Prospects → Review → Send path is unchanged and is still the default.
  { id: "auto", label: "AI Outreach" },
  { id: "replies", label: "Replies" },
  { id: "settings", label: "Settings" },
] as const;
export type OutreachTab = (typeof TABS)[number]["id"];

/**
 * Outreach, as a full-screen overlay over the lead sheet.
 *
 * Same shape as Find leads and Import: the sheet stays exactly as it was, and
 * this is a place you go and come back from. Suppression lives with Replies and
 * templates with Settings, so the tab strip stays readable on a phone.
 */
export function OutreachPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<OutreachTab>("dashboard");
  const [prospectFilter, setProspectFilter] = useState<ProspectFilter>("all");
  /** The campaign a run should be recorded against, chosen from its detail page. */
  const [runCampaign, setRunCampaign] = useState<Campaign | null>(null);
  const [mounted, setMounted] = useState(false);
  const { state, loading, busy, error, setError, setup, reload, actions } = useOutreach();

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

  const rows = useMemo(
    () => leads.map((lead) => ({ lead, eligibility: checkEligibility(lead, context) })),
    [leads, context],
  );

  function goTo(next: OutreachTab, filter?: ProspectFilter) {
    setTab(next);
    if (filter) setProspectFilter(filter);
  }

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
          {/* The setup screen already explains a load failure in full — showing
              the same text again as a red banner reads as two separate faults. */}
          {error && (state || !setup) ? (
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
            <OutreachSetupState reason={setup ?? "unknown"} onClose={onClose} />
          ) : (
            <>
              {tab === "dashboard" ? (
                <OutreachDashboard
                  state={state}
                  context={context}
                  busy={busy}
                  onGoTo={goTo}
                  onCheckReplies={() => void actions.checkReplies()}
                />
              ) : null}
              {tab === "prospects" ? (
                <OutreachProspects
                  state={state}
                  rows={rows}
                  busy={busy}
                  actions={actions}
                  filter={prospectFilter}
                  onFilter={setProspectFilter}
                />
              ) : null}
              {tab === "review" ? (
                <OutreachQueue state={state} context={context} busy={busy} actions={actions} />
              ) : null}
              {tab === "campaigns" ? (
                <OutreachCampaigns
                  state={state}
                  onReload={() => void reload()}
                  onRun={(campaign) => {
                    setRunCampaign(campaign);
                    setTab("auto");
                  }}
                />
              ) : null}
              {tab === "auto" ? (
                <OutreachAuto
                  state={state}
                  campaign={runCampaign}
                  onReload={() => void reload()}
                  onClearCampaign={() => setRunCampaign(null)}
                />
              ) : null}
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

/**
 * What Outreach shows when it cannot load at all.
 *
 * Names the actual cause and the actual fix. The previous version said "needs
 * the database" whatever had happened, which sent someone whose session had
 * simply expired off to configure Postgres.
 */
function OutreachSetupState({ reason, onClose }: { reason: SetupReason; onClose: () => void }) {
  const copy = SETUP_COPY[reason];
  const navigate = useNavigate();
  const needsSignIn = reason === "signed-out" || reason === "not-owner";
  return (
    <div className="rounded-xl bg-surface px-5 py-14 text-center shadow-(--shadow-border)">
      <p className="font-medium">{copy.title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{copy.detail}</p>
      {copy.fix ? <p className="mx-auto mt-3 max-w-sm text-sm text-subtle">{copy.fix}</p> : null}
      {needsSignIn ? (
        <div className="mt-5 flex flex-col items-center gap-3">
          <Button onClick={() => void navigate({ to: "/login" })}>Sign in</Button>
          <button type="button" className="text-sm text-muted hover:text-fg" onClick={onClose}>
            Back to leads
          </button>
        </div>
      ) : (
        <Button className="mt-5" onClick={onClose}>
          Back to leads
        </Button>
      )}
    </div>
  );
}
