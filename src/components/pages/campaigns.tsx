import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Archive, Copy, Flag, Loader2, Pause, Play, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { Badge, Card, EmptyState, Field, InsightsTabs, PageHeader, ProgressBar, Segmented } from "@/components/app/ui";
import { campaignProgress, CAMPAIGN_STATUS_LABELS, type Campaign, type CampaignStatus } from "@/lib/outreach/campaigns";
import { saveCampaign, type OutreachState } from "@/lib/outreach/server";
import { friendlyServerError } from "@/lib/server-errors";
import { useAppData } from "@/components/app/app-data";
import { plural } from "@/components/app/format";

export function CampaignsPage() {
  return (
    <Page wide>
      <WithState>{(state) => <Campaigns state={state} />}</WithState>
    </Page>
  );
}

type Tab = "live" | "draft" | "done";

function Campaigns({ state }: { state: OutreachState }) {
  const { reload } = useAppData();
  const [tab, setTab] = useState<Tab>("live");
  const [creating, setCreating] = useState(false);
  const groups = {
    live: state.campaigns.filter((campaign) => campaign.status === "ACTIVE" || campaign.status === "PAUSED"),
    draft: state.campaigns.filter((campaign) => campaign.status === "DRAFT"),
    done: state.campaigns.filter((campaign) => campaign.status === "COMPLETED" || campaign.status === "ARCHIVED"),
  };
  const list = groups[tab];

  return (
    <>
      <PageHeader
        eyebrow="Campaigns"
        title="Campaigns"
        description="A campaign is an area, a set of trades and a daily pace. Its numbers are counted from the prospects and emails that exist — never stored, so they cannot drift."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
      <InsightsTabs current="/campaigns" />
            New campaign
          </Button>
        }
      />
      <Segmented
        label="Campaigns"
        value={tab}
        onChange={setTab}
        options={[
          { id: "live", label: "Active & paused", count: groups.live.length },
          { id: "draft", label: "Drafts", count: groups.draft.length },
          { id: "done", label: "Finished", count: groups.done.length },
        ]}
      />
      {list.length === 0 ? (
        <EmptyState
          icon={<Flag />}
          title={tab === "live" ? "No active campaigns" : tab === "draft" ? "No drafts" : "Nothing finished yet"}
          action={
            tab === "live" ? (
              <Link to="/find">
                <Button>
                  <Search />
                  Find & reach prospects
                </Button>
              </Link>
            ) : undefined
          }
        >
          {tab === "live" ? "Every Find run creates a campaign, or you can set one up yourself." : null}
        </EmptyState>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {list.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} state={state} onChanged={reload} dailyMax={state.settings.dailyLimit} />
          ))}
        </div>
      )}
      <NewCampaign open={creating} onClose={() => setCreating(false)} onCreated={reload} dailyMax={state.settings.dailyLimit} />
    </>
  );
}

function CampaignCard({ campaign, state, onChanged, dailyMax }: { campaign: Campaign; state: OutreachState; onChanged: () => Promise<void>; dailyMax: number }) {
  const [busy, setBusy] = useState("");
  const [daily, setDaily] = useState(campaign.dailyTarget);
  const progress = useMemo(() => {
    const ids = new Set(state.campaignMembers.filter((member) => member.campaignId === campaign.id).map((member) => member.leadId));
    return campaignProgress(
      campaign,
      state.leads.filter((lead) => ids.has(lead.id)),
      state.emails.filter((email) => email.kind !== ("test" as never) && (ids.has(email.leadId) || email.campaignId === campaign.id)),
    );
  }, [campaign, state]);

  const act = async (label: string, data: Record<string, unknown>, done: string) => {
    setBusy(label);
    try {
      const result = await saveCampaign({ data: { id: campaign.id, ...data } });
      if (!result.success) toast(result.error);
      else toast(done);
      await onChanged();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy("");
    }
  };
  const setStatus = (status: CampaignStatus, done: string) => act(status, { action: "status", status }, done);
  const live = campaign.status === "ACTIVE" || campaign.status === "PAUSED" || campaign.status === "DRAFT";

  const numbers = [
    { label: "Prospects", value: `${progress.found}/${progress.target}` },
    { label: "Emails found", value: progress.emailsFound },
    { label: "Emails written", value: progress.prepared },
    { label: "Sent", value: progress.sent },
    { label: "Replies", value: progress.replies },
    { label: "Interested", value: progress.interested },
    { label: "Booked", value: progress.booked },
    { label: "Won", value: progress.won },
  ];

  return (
    <Card as="article" className="flex flex-col gap-4 p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium">{campaign.name || "Untitled campaign"}</h3>
          <p className="mt-0.5 truncate text-sm text-muted">
            {campaign.locations} · {campaign.trades}
          </p>
        </div>
        <Badge tone={campaign.status === "ACTIVE" ? "good" : campaign.status === "PAUSED" ? "warn" : "neutral"}>{CAMPAIGN_STATUS_LABELS[campaign.status]}</Badge>
      </div>
      <div>
        <ProgressBar value={progress.found} max={progress.target} />
        <div className="mt-3 grid grid-cols-4 gap-y-3">
          {numbers.map((item) => (
            <div key={item.label}>
              <p className="font-display text-lg leading-none tabular">{item.value}</p>
              <p className="mt-1 text-[11px] text-muted">{item.label}</p>
            </div>
          ))}
        </div>
      </div>

      {live ? (
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <span className="text-sm text-muted">Daily emails</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" aria-label="Fewer per day" onClick={() => setDaily((value) => Math.max(0, value - 1))}>
              −
            </Button>
            <span className="w-8 text-center font-display tabular">{daily}</span>
            <Button variant="ghost" size="icon-sm" aria-label="More per day" onClick={() => setDaily((value) => Math.min(dailyMax, value + 1))}>
              +
            </Button>
            {daily !== campaign.dailyTarget ? (
              <Button
                size="sm"
                disabled={busy === "daily"}
                onClick={() =>
                  void act(
                    "daily",
                    {
                      action: "save",
                      name: campaign.name,
                      locations: campaign.locations,
                      trades: campaign.trades,
                      targetProspects: campaign.targetProspects,
                      dailyTarget: daily,
                      batchSize: campaign.batchSize,
                    },
                    `Daily limit set to ${daily}.`,
                  )
                }
              >
                Save
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {campaign.status === "ACTIVE" || campaign.status === "DRAFT" ? (
          <Link to="/find" search={{ campaign: campaign.id }}>
            <Button size="sm">
              <Search />
              Find more
            </Button>
          </Link>
        ) : null}
        {campaign.status === "ACTIVE" ? (
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void setStatus("PAUSED", "Paused — its approved emails are held until you resume.")}>
            {busy === "PAUSED" ? <Loader2 className="animate-spin" /> : <Pause />}
            Pause
          </Button>
        ) : null}
        {campaign.status === "PAUSED" || campaign.status === "DRAFT" ? (
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void setStatus("ACTIVE", "Active.")}>
            {busy === "ACTIVE" ? <Loader2 className="animate-spin" /> : <Play />}
            {campaign.status === "DRAFT" ? "Start" : "Resume"}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void act("duplicate", { action: "duplicate" }, "Duplicated as a draft.")}>
          <Copy />
          Duplicate
        </Button>
        {campaign.status !== "ARCHIVED" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => {
              if (window.confirm(`Archive "${campaign.name}"? Its history stays; it sends nothing further.`)) {
                void setStatus("ARCHIVED", "Archived.");
              }
            }}
          >
            <Archive />
            Archive
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-sm">
        <Link to="/prospects" search={{ campaign: campaign.id }} className="text-muted hover:text-fg">
          {plural(progress.found, "prospect")} →
        </Link>
        <Link to="/send" search={{ campaign: campaign.id }} className="text-muted hover:text-fg">
          Emails →
        </Link>
        <Link to="/replies" search={{ campaign: campaign.id }} className="text-muted hover:text-fg">
          {plural(progress.replies, "reply", "replies")} →
        </Link>
      </div>
    </Card>
  );
}

function NewCampaign({ open, onClose, onCreated, dailyMax }: { open: boolean; onClose: () => void; onCreated: () => Promise<void>; dailyMax: number }) {
  const [name, setName] = useState("");
  const [locations, setLocations] = useState("");
  const [trades, setTrades] = useState("");
  const [target, setTarget] = useState(50);
  const [daily, setDaily] = useState(Math.min(10, dailyMax));
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const saved = await saveCampaign({
        data: { action: "save", name, locations, trades, targetProspects: target, dailyTarget: daily, batchSize: 5, sendMode: "prepare" },
      });
      if (!saved.success) {
        toast(saved.error);
        return;
      }
      await saveCampaign({ data: { action: "status", id: saved.id, status: "ACTIVE" } });
      toast("Campaign created. Run Find against it to fill it with prospects.");
      await onCreated();
      onClose();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>Creating a campaign never sends anything. Run Find to fill it with prospects.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5 pb-4">
          <Field label="Name" htmlFor="c-name">
            <Input id="c-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Perthshire Joiners" />
          </Field>
          <Field label="Areas" htmlFor="c-areas" hint="Comma-separated.">
            <Input id="c-areas" value={locations} onChange={(event) => setLocations(event.target.value)} placeholder="Perthshire" />
          </Field>
          <Field label="Trades" htmlFor="c-trades" hint="Comma-separated, up to four per run.">
            <Input id="c-trades" value={trades} onChange={(event) => setTrades(event.target.value)} placeholder="Joiner, Builder" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Prospects" htmlFor="c-target">
              <Input id="c-target" type="number" min={1} max={500} value={target} onChange={(event) => setTarget(Number(event.target.value) || 1)} />
            </Field>
            <Field label="Emails per day" htmlFor="c-daily" hint={`Up to ${dailyMax}.`}>
              <Input
                id="c-daily"
                type="number"
                min={0}
                max={dailyMax}
                value={daily}
                onChange={(event) => setDaily(Math.max(0, Math.min(dailyMax, Number(event.target.value) || 0)))}
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
