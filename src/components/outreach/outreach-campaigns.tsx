import { useMemo, useState } from "react";
import { ChevronLeft, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveCampaign, type OutreachState } from "@/lib/outreach/server";
import {
  CAMPAIGN_STATUS_LABELS,
  campaignLooksComplete,
  campaignProgress,
  campaignStartProblem,
  campaignSummary,
  canCampaignTransition,
  newCampaign,
  type Campaign,
  type CampaignProgress,
  type CampaignStatus,
} from "@/lib/outreach/campaigns";
import { STAGE_LABELS, lifecycleOf, tallyStages } from "@/lib/outreach/lifecycle";
import { decideProspect } from "@/lib/decision";
import type { OutreachLead } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

/**
 * Campaigns — named pieces of work, not a second way to send.
 *
 * A campaign chooses what to look for and keeps the score. Finding, qualifying,
 * writing and sending all happen on the existing screens with the existing
 * safety rules; the campaign is the label on the work and the place its funnel
 * is totted up.
 *
 * Creating one never starts anything. A new campaign is a DRAFT on drafts-only,
 * and every number shown is counted from prospects and emails that exist.
 */
export function OutreachCampaigns({
  state,
  onReload,
  onRun,
}: {
  state: OutreachState;
  onReload: () => void;
  onRun: (campaign: Campaign) => void;
}) {
  const [openId, setOpenId] = useState("");
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** Prospects and emails, grouped by the campaign they belong to. */
  const world = useMemo(() => {
    const leadsById = new Map(state.leads.map((lead) => [lead.id, lead as OutreachLead]));
    const membersOf = new Map<string, OutreachLead[]>();
    for (const member of state.campaignMembers) {
      const lead = leadsById.get(member.leadId);
      if (!lead) continue;
      const list = membersOf.get(member.campaignId);
      if (list) list.push(lead);
      else membersOf.set(member.campaignId, [lead]);
    }
    return { membersOf };
  }, [state.leads, state.campaignMembers]);

  const progressFor = (campaign: Campaign): { progress: CampaignProgress; leads: OutreachLead[] } => {
    const leads = world.membersOf.get(campaign.id) ?? [];
    const ids = new Set(leads.map((lead) => lead.id));
    const emails = state.emails.filter((email) => ids.has(email.leadId));
    const decisions = new Map(
      leads.map((lead) => {
        const decision = decideProspect(lead);
        return [lead.id, { level: decision.level, reviewRequired: decision.reviewRequired }] as const;
      }),
    );
    return { progress: campaignProgress(campaign, leads, emails, decisions), leads };
  };

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await saveCampaign({ data: payload });
      if (!result.success) {
        setError(result.error);
        return null;
      }
      onReload();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveEdits(campaign: Campaign) {
    const result = await send({
      action: "save",
      id: campaign.id,
      name: campaign.name,
      locations: campaign.locations,
      trades: campaign.trades,
      targetProspects: campaign.targetProspects,
      dailyTarget: campaign.dailyTarget,
      batchSize: campaign.batchSize,
      sendMode: campaign.sendMode,
    });
    if (result) {
      setEditing(null);
      setOpenId(result.id);
    }
  }

  async function setStatus(campaign: Campaign, status: CampaignStatus) {
    await send({ action: "status", id: campaign.id, status });
  }

  const live = state.campaigns.filter((campaign) => campaign.status !== "ARCHIVED");
  const archived = state.campaigns.filter((campaign) => campaign.status === "ARCHIVED");
  const open = state.campaigns.find((campaign) => campaign.id === openId) ?? null;

  if (editing) {
    return (
      <CampaignForm
        campaign={editing}
        busy={busy}
        error={error}
        dailyMax={state.settings.dailyLimit}
        batchMax={state.settings.batchSize}
        onChange={setEditing}
        onCancel={() => {
          setEditing(null);
          setError("");
        }}
        onSave={() => void saveEdits(editing)}
      />
    );
  }

  if (open) {
    const { progress, leads } = progressFor(open);
    return (
      <CampaignDetail
        campaign={open}
        progress={progress}
        leads={leads}
        emails={state.emails}
        busy={busy}
        error={error}
        onBack={() => {
          setOpenId("");
          setError("");
        }}
        onEdit={() => setEditing(open)}
        onStatus={(status) => void setStatus(open, status)}
        onRun={() => onRun(open)}
      />
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-xl font-medium">Campaigns</h3>
          <p className="mt-1 text-sm text-muted">
            A campaign is a named piece of work — where to look, what trade, how many. It keeps the
            score. Finding, writing and sending stay on the existing screens with the existing
            rules, and creating one never sends anything.
          </p>
        </div>
      </div>

      {error ? <p className="text-sm text-hot">{error}</p> : null}

      <Button
        className="h-11 w-full md:w-auto"
        onClick={() => setEditing(newCampaign(`camp-${Date.now().toString(36)}`, new Date().toISOString()))}
      >
        <Plus />
        New campaign
      </Button>

      {live.length === 0 ? (
        <div className="rounded-xl bg-surface px-5 py-10 text-center shadow-(--shadow-border)">
          <p className="font-medium">No campaigns yet</p>
          <p className="mt-2 text-sm text-subtle">
            Create one to group a run — a town, a trade, a target — and watch its funnel in one
            place.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {live.map((campaign) => {
            const { progress } = progressFor(campaign);
            return (
              <li key={campaign.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(campaign.id)}
                  className="w-full rounded-xl bg-surface px-4 py-3 text-left shadow-(--shadow-border) hover:bg-surface-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate font-medium">
                      {campaign.name || "Untitled campaign"}
                    </p>
                    <StatusBadge status={campaign.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted">{campaignSummary(progress)}</p>
                  <ProgressBar percent={progress.percent} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {archived.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium tracking-wide text-muted uppercase">
            {archived.length} archived
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {archived.map((campaign) => {
              const { progress } = progressFor(campaign);
              return (
                <li key={campaign.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(campaign.id)}
                    className="w-full rounded-md bg-surface px-3 py-2 text-left shadow-(--shadow-border) hover:bg-surface-2"
                  >
                    <p className="truncate text-sm font-medium">{campaign.name || "Untitled campaign"}</p>
                    <p className="text-xs text-subtle">{campaignSummary(progress)}</p>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function CampaignForm({
  campaign,
  busy,
  error,
  dailyMax,
  batchMax,
  onChange,
  onCancel,
  onSave,
}: {
  campaign: Campaign;
  busy: boolean;
  error: string;
  dailyMax: number;
  batchMax: number;
  onChange: (next: Campaign) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof Campaign>(key: K, value: Campaign[K]) =>
    onChange({ ...campaign, [key]: value });
  const number = (value: string, fallback: number) => {
    const next = Number(value);
    return Number.isFinite(next) ? Math.round(next) : fallback;
  };

  return (
    <section className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onCancel}
        className="flex items-center gap-1 self-start text-sm text-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" />
        Campaigns
      </button>

      <h3 className="font-display text-xl font-medium">
        {campaign.name ? campaign.name : "New campaign"}
      </h3>

      <Field label="Name">
        <Input
          className="h-11"
          value={campaign.name}
          onChange={(event) => set("name", event.target.value)}
          placeholder="Glasgow Joiners"
          aria-label="Campaign name"
        />
      </Field>

      <Field label="Locations" hint="One or more, separated by commas.">
        <Input
          className="h-11"
          value={campaign.locations}
          onChange={(event) => set("locations", event.target.value)}
          placeholder="Glasgow, Paisley"
          aria-label="Target locations"
        />
      </Field>

      <Field label="Trades" hint="One or more, separated by commas.">
        <Input
          className="h-11"
          value={campaign.trades}
          onChange={(event) => set("trades", event.target.value)}
          placeholder="Joiner, Roofer"
          aria-label="Target trades"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Target prospects">
          <Input
            className="h-11"
            type="number"
            inputMode="numeric"
            value={String(campaign.targetProspects)}
            onChange={(event) => set("targetProspects", number(event.target.value, 50))}
            aria-label="Target prospects"
          />
        </Field>
        <Field label="Daily target" hint={`Your account limit is ${dailyMax}/day.`}>
          <Input
            className="h-11"
            type="number"
            inputMode="numeric"
            value={String(campaign.dailyTarget)}
            onChange={(event) => set("dailyTarget", number(event.target.value, 10))}
            aria-label="Daily send target"
          />
        </Field>
        <Field label="Batch size" hint={`Your account batch is ${batchMax}.`}>
          <Input
            className="h-11"
            type="number"
            inputMode="numeric"
            value={String(campaign.batchSize)}
            onChange={(event) => set("batchSize", number(event.target.value, 5))}
            aria-label="Batch size"
          />
        </Field>
      </div>

      <Field label="Send mode">
        <div className="flex flex-wrap gap-2">
          {(["prepare", "send"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => set("sendMode", mode)}
              className={cn(
                "h-11 rounded-full px-3.5 text-sm font-medium",
                campaign.sendMode === mode
                  ? "bg-accent text-accent-fg"
                  : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
              )}
            >
              {mode === "prepare" ? "Prepare drafts only" : "Prepare and send"}
            </button>
          ))}
        </div>
      </Field>

      <p className="text-xs text-subtle">
        The daily target and batch size work inside your account limits, never around them —
        whichever is smaller applies. A campaign never bypasses eligibility, suppression, duplicate
        protection or the daily limit.
      </p>

      {error ? <p className="text-sm text-hot">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button className="h-11" disabled={busy} onClick={onSave}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Save campaign
        </Button>
        <Button variant="ghost" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function CampaignDetail({
  campaign,
  progress,
  leads,
  emails,
  busy,
  error,
  onBack,
  onEdit,
  onStatus,
  onRun,
}: {
  campaign: Campaign;
  progress: CampaignProgress;
  leads: OutreachLead[];
  emails: OutreachState["emails"];
  busy: boolean;
  error: string;
  onBack: () => void;
  onEdit: () => void;
  onStatus: (status: CampaignStatus) => void;
  onRun: () => void;
}) {
  const stages = useMemo(() => {
    const ids = new Set(leads.map((lead) => lead.id));
    const mine = emails.filter((email) => ids.has(email.leadId));
    return tallyStages(
      leads.map((lead) => {
        const decision = decideProspect(lead);
        return lifecycleOf(lead, mine, {
          level: decision.level,
          reviewRequired: decision.reviewRequired,
        });
      }),
    );
  }, [leads, emails]);

  const startProblem = campaignStartProblem(campaign);
  const complete = campaignLooksComplete(progress);

  return (
    <section className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start text-sm text-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" />
        Campaigns
      </button>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-medium">{campaign.name || "Untitled campaign"}</h3>
          <p className="mt-1 text-sm text-muted">
            {campaign.trades || "any trade"} in {campaign.locations || "anywhere"} ·{" "}
            {campaign.sendMode === "send" ? "prepare and send" : "drafts only"} ·{" "}
            {campaign.dailyTarget}/day
          </p>
        </div>
        <StatusBadge status={campaign.status} />
      </div>

      {error ? <p className="text-sm text-hot">{error}</p> : null}

      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">Progress</p>
          <p className="text-xs tabular-nums text-subtle">
            {progress.found} / {progress.target} prospects
          </p>
        </div>
        <ProgressBar percent={progress.percent} />
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          <Stat label="Found" value={progress.found} />
          <Stat label="Qualified" value={progress.qualified} />
          <Stat label="Emails found" value={progress.emailsFound} />
          <Stat label="Prepared" value={progress.prepared} />
          <Stat label="Sent" value={progress.sent} />
          <Stat label="Replies" value={progress.replies} />
          <Stat label="Interested" value={progress.interested} />
          <Stat label="Booked" value={progress.booked} />
          <Stat label="Won" value={progress.won} />
          <Stat label="To call" value={progress.call} />
          <Stat label="Skipped" value={progress.skipped} />
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Every number counts prospects and emails that exist. Nothing here is estimated.
        </p>
      </div>

      {stages.length > 0 ? (
        <div>
          <h4 className="text-xs font-medium tracking-wide text-muted uppercase">Where they are</h4>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-(--shadow-border)">
            {stages.map((entry) => (
              <li key={entry.stage} className="flex items-center justify-between gap-3 px-4 py-2">
                <p className="text-sm">{STAGE_LABELS[entry.stage]}</p>
                <p className="text-sm tabular-nums text-muted">{entry.count}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {startProblem && campaign.status === "DRAFT" ? (
        <p className="text-sm text-warm-lead">{startProblem}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canCampaignTransition(campaign.status, "ACTIVE") && campaign.status !== "ACTIVE" ? (
          <Button
            className="h-11"
            disabled={busy || Boolean(startProblem)}
            onClick={() => onStatus("ACTIVE")}
          >
            {campaign.status === "PAUSED" ? "Resume" : "Start campaign"}
          </Button>
        ) : null}
        {campaign.status === "ACTIVE" ? (
          <>
            <Button className="h-11" disabled={busy} onClick={onRun}>
              Find prospects
            </Button>
            <Button variant="secondary" className="h-11" disabled={busy} onClick={() => onStatus("PAUSED")}>
              Pause
            </Button>
          </>
        ) : null}
        {canCampaignTransition(campaign.status, "COMPLETED") ? (
          <Button
            variant="secondary"
            className="h-11"
            disabled={busy}
            onClick={() => onStatus("COMPLETED")}
          >
            Mark complete
          </Button>
        ) : null}
        {campaign.status !== "ARCHIVED" ? (
          <Button variant="ghost" className="h-11" disabled={busy} onClick={() => onStatus("ARCHIVED")}>
            Archive
          </Button>
        ) : null}
        <Button variant="ghost" className="h-11" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
      </div>

      {complete && campaign.status === "ACTIVE" ? (
        <p className="text-xs text-subtle">
          Every prospect in this campaign has been sent to, set aside to call, or skipped. You can
          mark it complete.
        </p>
      ) : null}

      {campaign.status === "ARCHIVED" ? (
        <p className="text-xs text-subtle">
          Archived campaigns are kept for their history and cannot be restarted. Create a new
          campaign to work these areas again.
        </p>
      ) : null}
    </section>
  );
}

function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        status === "ACTIVE" && "bg-accent text-accent-fg",
        status === "PAUSED" && "bg-warm-lead/15 text-warm-lead",
        status === "COMPLETED" && "bg-surface-2 text-fg",
        (status === "DRAFT" || status === "ARCHIVED") && "bg-surface-2 text-muted",
      )}
    >
      {CAMPAIGN_STATUS_LABELS[status]}
    </span>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}
