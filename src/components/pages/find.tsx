import { rowsFromLeads, tradeAdvice } from "@/lib/feedback/quality";
import { profileList } from "@/lib/outreach/profile";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  Loader2,
  Phone,
  Plus,
  Search,
  Send,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { Card, Field, Notice, PageHeader, ProgressBar, SectionTitle } from "@/components/app/ui";
import type { ProspectRunState, RunConfig } from "@/components/app/use-prospect-run";
import { FIND_STAGES, FIND_STAGE_TITLES, type FindStage } from "@/lib/jobs/types";
import { ACTION_LABEL, type Band } from "@/lib/scoring/prospect-score";
import { TRADE_SUGGESTIONS } from "@/lib/leads";
import { MAX_TRADES } from "@/lib/outreach/auto-run";
import { reconcileFunnel, type RunFunnel } from "@/lib/outreach/run-funnel";
import {
  distinctBusinesses,
  LISTING_OUTCOMES,
  OUTCOME_LABEL,
  outcomeTotal,
  reconcileLedger,
  REJECT_LABEL,
  type DiscoveryLedger,
  type ReviewItem,
} from "@/lib/discovery-ledger";
import { REJECT_REASONS } from "@/lib/discovery-reasons";
import { businessAction } from "@/lib/businesses/server";
import { friendlyServerError } from "@/lib/server-errors";
import type { OutreachState } from "@/lib/outreach/server";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";
import { plural } from "@/components/app/format";

const AREAS = ["Perthshire", "Perth", "Crieff", "Stirling", "Dundee", "Fife", "Kinross", "Pitlochry"];
const TARGETS = [20, 50, 100];

export function FindPage() {
  return (
    <Page>
      <WithState>{(state) => <Find state={state} />}</WithState>
    </Page>
  );
}

function pluralTrade(trade: string): string {
  const clean = trade.trim();
  if (!clean) return clean;
  return /s$/i.test(clean) ? clean : `${clean}s`;
}

function defaultCampaignName(area: string, trades: string[]): string {
  const names = trades.map(pluralTrade);
  const list = names.length <= 2 ? names.join(" & ") : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
  return `${area.trim()} ${list}`.trim().slice(0, 60);
}

function Find({ state }: { state: OutreachState }) {
  const { prospecting } = useAppData();
  const search = useSearch({ from: "/_app/find" });
  const { run } = prospecting;
  const campaigns = state.campaigns.filter((campaign) => campaign.status === "ACTIVE" || campaign.status === "DRAFT");
  const chosen = state.campaigns.find((campaign) => campaign.id === search.campaign) ?? null;

  // A campaign's own search, else your profile's, else a sensible start.
  const profileAreas = profileList(state.profile.targetAreas);
  const profileTrades = profileList(state.profile.targetTrades);
  const [area, setArea] = useState(chosen?.locations || profileAreas.join(", ") || "Perthshire");
  const [trades, setTrades] = useState<string[]>(
    chosen
      ? chosen.trades.split(",").map((item) => item.trim()).filter(Boolean).slice(0, MAX_TRADES)
      : profileTrades.length
        ? profileTrades.slice(0, MAX_TRADES)
        : ["Joiner", "Builder", "Roofer", "Plumber"],
  );
  const marks = useMemo(() => rowsFromLeads(state.leads), [state.leads]);
  const advice = trades.map((trade) => tradeAdvice(marks, trade)).filter(Boolean);
  const [customTrade, setCustomTrade] = useState("");
  const [target, setTarget] = useState(chosen?.targetProspects ?? 50);
  const [dailyLimit, setDailyLimit] = useState(Math.min(chosen?.dailyTarget ?? 10, state.settings.dailyLimit));
  const [campaignId, setCampaignId] = useState(chosen?.id ?? "");
  const [campaignName, setCampaignName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [radius, setRadius] = useState(25);
  const [widen, setWiden] = useState(true);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!nameTouched) setCampaignName(defaultCampaignName(area, trades));
  }, [area, trades, nameTouched]);

  const problem =
    area.trim().length < 2
      ? "Choose an area."
      : trades.length === 0
        ? "Choose at least one trade."
        : !campaignId && campaignName.trim().length < 2
          ? "Name the campaign."
          : "";

  const searchesLeft = Math.max(0, state.usage.searchBudget - state.usage.search);
  const aiLeft = Math.max(0, state.usage.aiBudget - state.usage.ai);

  const toggleTrade = (trade: string) =>
    setTrades((current) =>
      current.some((item) => item.toLowerCase() === trade.toLowerCase())
        ? current.filter((item) => item.toLowerCase() !== trade.toLowerCase())
        : current.length >= MAX_TRADES
          ? current
          : [...current, trade],
    );

  const addCustom = () => {
    const trade = customTrade.trim();
    if (trade.length < 2) return;
    if (!trades.some((item) => item.toLowerCase() === trade.toLowerCase()) && trades.length < MAX_TRADES) setTrades([...trades, trade]);
    setCustomTrade("");
  };

  const start = () => {
    if (problem || prospecting.running) return;
    const config: RunConfig = {
      location: area.trim(),
      trades,
      target,
      dailyLimit,
      radiusMiles: radius,
      campaignId,
      campaignName: campaignId ? "" : campaignName.trim(),
      widen,
    };
    void prospecting.start(config);
  };

  /** Start the next search a finished run suggested, with this run's other settings. */
  const searchNext = (next: { location: string; trades: string[] }) => {
    if (prospecting.running) return;
    const base = run.config;
    prospecting.reset();
    void prospecting.start({
      location: next.location,
      trades: next.trades.slice(0, MAX_TRADES),
      target: base?.target ?? target,
      dailyLimit: base?.dailyLimit ?? dailyLimit,
      radiusMiles: base?.radiusMiles ?? radius,
      campaignId: base?.campaignId ?? "",
      campaignName: base?.campaignId ? "" : defaultCampaignName(next.location.split(",")[0] ?? next.location, next.trades),
      widen: base?.widen ?? widen,
    });
  };

  if (run.status !== "idle") {
    return <RunView run={run} onStop={prospecting.stop} onReset={prospecting.reset} running={prospecting.running} onSearch={searchNext} />;
  }

  return (
    <>
      <PageHeader
        eyebrow="Find & reach"
        title="Find new prospects"
        description="Peak Swift searches for real local businesses, removes anyone you already know, verifies each one, finds their published email and writes a personalised email — ready for you to read and send."
      />

      {state.connection.status !== "connected" ? (
        <Notice
          tone="warn"
          title="Gmail is not connected"
          action={
            <Link to="/settings" search={{ section: "gmail" }}>
              <Button variant="secondary" size="sm">
                Connect
              </Button>
            </Link>
          }
        >
          You can still find prospects and write emails. You will need Gmail to send them.
        </Notice>
      ) : null}

      <Card className="flex flex-col gap-6 p-5 md:p-6">
        <Field label="Area" htmlFor="area" hint="A town, a city or a region — or several, separated by commas. Each is searched town by town, starting with towns not searched before.">
          <Input id="area" value={area} onChange={(event) => setArea(event.target.value)} className="h-11" autoComplete="off" />
          <div className="scroll-x -mx-1 mt-1 flex gap-1.5 px-1">
            {AREAS.map((place) => (
              <button
                key={place}
                type="button"
                onClick={() => setArea(place)}
                className={cn(
                  "h-8 shrink-0 rounded-full px-3 text-xs font-medium",
                  area === place ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                )}
              >
                {place}
              </button>
            ))}
          </div>
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">Trades</span>
            <span className="text-xs text-subtle tabular">
              {trades.length} of {MAX_TRADES}
            </span>
          </div>
          {trades.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {trades.map((trade) => (
                <button
                  key={trade}
                  type="button"
                  onClick={() => toggleTrade(trade)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent pr-2.5 pl-3.5 text-sm font-medium text-accent-fg"
                  aria-label={`Remove ${trade}`}
                >
                  {trade}
                  <X className="size-3.5" />
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1.5">
            {TRADE_SUGGESTIONS.filter((trade) => !trades.some((item) => item.toLowerCase() === trade.toLowerCase()))
              .slice(0, 16)
              .map((trade) => (
                <button
                  key={trade}
                  type="button"
                  disabled={trades.length >= MAX_TRADES}
                  onClick={() => toggleTrade(trade)}
                  className="h-8 rounded-full bg-surface-2 px-3 text-xs font-medium text-muted hover:text-fg disabled:opacity-40"
                >
                  {trade}
                </button>
              ))}
          </div>
          <div className="mt-1 flex gap-2">
            <Input
              value={customTrade}
              onChange={(event) => setCustomTrade(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustom();
                }
              }}
              placeholder="Another trade, e.g. Stonemason"
              className="h-10"
              aria-label="Add another trade"
            />
            <Button variant="secondary" onClick={addCustom} disabled={trades.length >= MAX_TRADES} aria-label="Add trade">
              <Plus />
            </Button>
          </div>
          <p className="text-xs text-subtle">Up to {MAX_TRADES} per run, so one run's cost stays predictable.</p>
          {advice.map((line) => (
            <p key={line} className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {line}
            </p>
          ))}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Prospects" hint="New businesses to find. Anyone already on your sheet doesn't count.">
            <div className="flex gap-1.5">
              {TARGETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTarget(value)}
                  className={cn(
                    "h-11 flex-1 rounded-md text-sm font-medium tabular",
                    target === value ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
                  )}
                >
                  {value}
                </button>
              ))}
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={200}
                placeholder="Other"
                value={TARGETS.includes(target) ? "" : target}
                onChange={(event) => {
                  const typed = Number(event.target.value);
                  if (event.target.value !== "" && Number.isFinite(typed)) setTarget(Math.max(1, Math.min(200, Math.round(typed))));
                }}
                className={cn("h-11 w-20 text-center tabular", TARGETS.includes(target) ? "" : "ring-1 ring-accent")}
                aria-label="Custom number of prospects"
              />
            </div>
          </Field>
          <Field
            label="Daily emails"
            hint={`For this campaign. Your account-wide limit is ${state.settings.dailyLimit} a day (Settings → Sending).`}
          >
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="icon" aria-label="Fewer" onClick={() => setDailyLimit((value) => Math.max(1, value - 1))}>
                −
              </Button>
              <div className="flex h-10 flex-1 items-center justify-center rounded-md bg-surface-2 font-display text-lg tabular">{dailyLimit}</div>
              <Button
                variant="secondary"
                size="icon"
                aria-label="More"
                onClick={() => setDailyLimit((value) => Math.min(state.settings.dailyLimit, value + 1))}
              >
                +
              </Button>
            </div>
          </Field>
        </div>

        <Field label="Campaign" htmlFor="campaign">
          <select
            id="campaign"
            value={campaignId}
            onChange={(event) => setCampaignId(event.target.value)}
            className="h-11 rounded-md bg-surface px-3 text-sm shadow-(--shadow-border) outline-none"
          >
            <option value="">New campaign</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
          {!campaignId ? (
            <Input
              value={campaignName}
              onChange={(event) => {
                setNameTouched(true);
                setCampaignName(event.target.value);
              }}
              placeholder="Campaign name"
              className="mt-1 h-11"
              aria-label="New campaign name"
            />
          ) : null}
        </Field>

        <div>
          <button type="button" onClick={() => setAdvanced((open) => !open)} className="flex items-center gap-1 text-left text-sm text-muted hover:text-fg">
            <ChevronDown className={cn("size-4 transition-transform", advanced ? "rotate-180" : "")} />
            Search radius · {radius} miles{widen ? " · widens when short" : ""}
          </button>
          {advanced ? (
            <div className="mt-2 flex flex-col gap-3">
              <div className="flex gap-1.5">
                {[10, 25, 50].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRadius(value)}
                    className={cn("h-9 rounded-full px-3.5 text-sm", radius === value ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted")}
                  >
                    {value} miles
                  </button>
                ))}
              </div>
              <label className="flex items-start gap-2.5 text-sm">
                <input type="checkbox" checked={widen} onChange={(event) => setWiden(event.target.checked)} className="mt-0.5 size-4 accent-(--color-accent)" />
                <span>
                  <span className="text-fg">Search further afield when short</span>
                  <span className="block text-xs text-muted">
                    If these places run out of new businesses, also search the rest of their region and the regions next door — never towns searched recently with nothing new.
                  </span>
                </span>
              </label>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <p className="text-xs text-subtle">
            {state.searchProvider
              ? `Website search via ${state.searchProvider}: ${searchesLeft} of ${state.usage.searchBudget} searches left today.`
              : "No web-search key is configured, so websites are found from listings and domain checks only."}{" "}
            AI drafts: {state.aiAvailable ? `${aiLeft} of ${state.usage.aiBudget} left today.` : "not configured — templates are used."} Nothing is
            sent until you press Send.
          </p>
          {problem ? <p className="text-sm text-warn">{problem}</p> : null}
          <Button className="h-12 w-full text-[15px]" disabled={Boolean(problem)} onClick={start}>
            <Search />
            Find & reach prospects
          </Button>
        </div>
      </Card>
    </>
  );
}

// ── The run, live ─────────────────────────────────────────────────────────────

function stageCount(stage: FindStage, run: ProspectRunState): string {
  const { funnel, enrichment } = run;
  switch (stage) {
    case "discovering":
      return funnel.rawFound ? `${funnel.rawFound} listings found` : "";
    case "deduplicating":
      return funnel.unique ? `${funnel.unique} distinct · ${funnel.selected} new to you` : "";
    case "verifying":
      return funnel.checked ? `${funnel.websiteVerified} websites · ${funnel.emailsFound} public emails` : "";
    case "enriching":
      return enrichment.companiesChecked || enrichment.audited
        ? `${enrichment.companiesConfirmed} companies confirmed · ${enrichment.audited} sites audited`
        : "";
    case "qualifying":
      return run.result?.summary || funnel.eligible || funnel.call ? `${funnel.eligible} to email · ${run.result?.summary.callReady ?? funnel.call} to call` : "";
    case "personalising":
      return funnel.prepared ? `${funnel.prepared} drafts written` : "";
    case "ready":
      return funnel.prepared ? `${funnel.readyToday} ready today` : "";
    default:
      return "";
  }
}

function RunView({
  run,
  onStop,
  onReset,
  running,
  onSearch,
}: {
  run: ProspectRunState;
  onStop: () => void;
  onReset: () => void;
  running: boolean;
  onSearch: (next: { location: string; trades: string[] }) => void;
}) {
  const [showLog, setShowLog] = useState(run.status === "failed");
  useEffect(() => {
    if (run.status === "failed") setShowLog(true);
  }, [run.status]);
  const { funnel } = run;
  const finished = !running;
  const enrich = run.config?.mode === "enrich";
  // Checking existing businesses skips discovery and drafting; do not show those steps.
  const stages = enrich ? FIND_STAGES.filter((stage) => stage !== "discovering" && stage !== "deduplicating" && stage !== "personalising") : FIND_STAGES;
  const problems = useMemo(
    // A run from before the ledger existed counted discovery differently; only its later stages are checked.
    () => (finished && !enrich && (run.ledger.listings > 0 || funnel.rawFound === 0) ? [...reconcileFunnel(funnel), ...reconcileLedger(run.ledger)] : []),
    [finished, funnel, enrich, run.ledger],
  );

  return (
    <>
      <PageHeader
        eyebrow={enrich ? "Checking your businesses" : run.config ? `${run.config.trades.join(", ")} · ${run.config.location}` : "Find & reach"}
        title={
          running
            ? enrich
              ? "Checking your businesses…"
              : "Finding prospects…"
            : run.status === "done"
              ? enrich
                ? "Your businesses are checked"
                : "Your prospects are ready"
              : run.status === "empty"
                ? run.result
                  ? "Nothing to act on from this run"
                  : "No new prospects this time"
              : run.status === "stopped"
                ? "Run stopped"
                : "The run could not finish"
        }
        description={
          run.status === "empty" && run.diagnosis
            ? "Discovery ran, but this search left nothing to act on. Below: which stage lost the businesses, every listing's outcome, and where to look next."
            : run.detail
        }
        actions={
          running ? (
            <Button variant="secondary" onClick={onStop} disabled={!run.jobId}>
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button variant="secondary" onClick={onReset}>
              New search
            </Button>
          )
        }
      />

      {running ? (
        <p className="-mt-3 text-sm text-muted">This runs on our server — you can close this page or lock your phone, and it will carry on. Nothing is sent without you.</p>
      ) : null}
      {run.error ? (
        <Notice tone="warn" title="Reconnecting">
          {run.error}
        </Notice>
      ) : null}

      <Card className="p-5 md:p-6">
        <ol className="flex flex-col gap-0.5">
          {stages.map((stage) => {
            const done = run.completed.includes(stage) || (finished && run.status === "done");
            const current = running && run.stage === stage;
            const endedHere = finished && run.status !== "done" && run.stage === stage;
            const count = stageCount(stage, run);
            return (
              <li key={stage} className="flex items-center gap-3 py-2">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full",
                    endedHere ? "bg-warn/15 text-warn" : done ? "bg-good/15 text-good" : current ? "bg-accent text-accent-fg" : "bg-surface-2 text-subtle",
                  )}
                >
                  {endedHere ? (
                    <TriangleAlert className="size-3.5" />
                  ) : done ? (
                    <Check className="size-3.5" />
                  ) : current ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Circle className="size-2 fill-current" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <span className={cn("text-sm", done || current || endedHere ? "text-fg" : "text-subtle")}>{FIND_STAGE_TITLES[stage]}</span>
                  {count && (done || current || endedHere) ? <span className="text-xs text-muted tabular sm:text-sm">{count}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
        {running && run.progress.total > 0 ? (
          <div className="mt-3">
            <ProgressBar value={run.progress.done} max={run.progress.total} />
            <p className="mt-1.5 text-xs text-subtle tabular">
              {run.progress.done} of {run.progress.total}
            </p>
          </div>
        ) : null}
      </Card>

      {finished && run.diagnosis ? <Diagnosis run={run} onSearch={onSearch} /> : null}

      {finished && run.ledger.review.length > 0 ? <ReviewList items={run.ledger.review} total={run.ledger.outcomes.needs_review} /> : null}

      {finished && run.status !== "failed" && (run.status !== "empty" || run.result) ? <Outcome run={run} /> : null}

      {problems.length > 0 ? (
        <Notice tone="bad" title="These numbers do not add up">
          {problems.join(" · ")}. The run is recorded as it happened; please report this.
        </Notice>
      ) : null}

      {run.ledger.listings > 0 && !enrich ? <LedgerDetail ledger={run.ledger} /> : null}
      {funnel.rawFound > 0 && !enrich ? <FunnelDetail funnel={funnel} /> : null}

      <section className="flex flex-col gap-2">
        <button type="button" onClick={() => setShowLog((open) => !open)} className="flex items-center gap-1 self-start text-sm text-muted hover:text-fg">
          <ChevronDown className={cn("size-4 transition-transform", showLog ? "rotate-180" : "")} />
          Activity ({run.log.length})
        </button>
        {showLog ? (
          <Card className="max-h-80 overflow-y-auto px-4 py-3">
            <ul className="flex flex-col gap-1.5 text-sm">
              {run.log.map((event, index) => (
                <li key={`${event.at}-${index}`} className={cn(event.tone === "bad" ? "text-bad" : event.tone === "warn" ? "text-warn" : event.tone === "good" ? "text-fg" : "text-muted")}>
                  {event.text}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </section>
    </>
  );
}

function Outcome({ run }: { run: ProspectRunState }) {
  const { funnel, result } = run;
  const summary = result?.summary;
  return (
    <Card className="flex flex-col gap-5 p-5 md:p-6">
      {summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat value={summary.found} label="businesses checked" />
          <Stat value={summary.strong} label="strong" tone="good" />
          <Stat value={summary.good} label="good" />
          <Stat value={summary.weak + summary.rejected} label={`weak or not worth it`} muted />
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-3 border-t border-border pt-4 text-center">
        <Stat value={funnel.readyToday} label="emails to review today" />
        <Stat value={summary?.callReady ?? funnel.call} label="to call" />
        <Stat value={summary?.review ?? funnel.manualReview} label="need a check from you" />
      </div>
      {funnel.heldForTomorrow > 0 ? (
        <p className="-mt-2 text-center text-xs text-subtle">{plural(funnel.heldForTomorrow, "more draft")} held for tomorrow by your daily limit.</p>
      ) : null}

      {result && result.top.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-border pt-4">
          <p className="text-xs font-medium text-subtle">Best first</p>
          <ul className="flex flex-col">
            {result.top.map((prospect) => (
              <li key={prospect.id} className="flex items-baseline gap-3 py-1.5">
                <span className={cn("w-12 shrink-0 text-xs font-medium", prospect.band === "STRONG" ? "text-good" : "text-muted")}>{SHORT_BAND[prospect.band]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{prospect.businessName}</span>
                  <span className="line-clamp-2 block text-xs text-muted">
                    {[prospect.trade, prospect.town].filter(Boolean).join(" · ")} — {prospect.reason}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted">{ACTION_LABEL[prospect.action]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        {funnel.prepared > 0 ? (
          <Link to="/send" search={result?.campaignId ? { campaign: result.campaignId } : {}} className="flex-1">
            <Button className="h-12 w-full">
              <Send />
              Review & send {funnel.readyToday || funnel.prepared}
              <ArrowRight />
            </Button>
          </Link>
        ) : null}
        {(summary?.callReady ?? funnel.call) > 0 ? (
          <Link to="/calls" className="flex-1">
            <Button variant="secondary" className="h-12 w-full">
              <Phone />
              Call list ({summary?.callReady ?? funnel.call})
            </Button>
          </Link>
        ) : null}
        {result?.runId ? (
          <Link to="/runs/$runId" params={{ runId: result.runId }} className="flex-1">
            <Button variant="ghost" className="h-12 w-full">
              View run
            </Button>
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

const SHORT_BAND: Record<Band, string> = { STRONG: "Strong", GOOD: "Good", WEAK: "Weak", NONE: "—" };

function Stat({ value, label, tone, muted }: { value: number; label: string; tone?: "good"; muted?: boolean }) {
  return (
    <div className="text-center">
      <p className={cn("font-display text-3xl font-medium tabular", tone === "good" ? "text-good" : muted ? "text-muted" : "")}>{value}</p>
      <p className="mt-1 text-xs text-muted">{label}</p>
    </div>
  );
}

/** Every number in the run, with the door each business left by. */
export function FunnelDetail({ funnel }: { funnel: RunFunnel }) {
  const rows: { label: string; value: number; minus?: boolean; strong?: boolean; tone?: "good" | "warn" | "bad" }[] = [
    { label: "Listings found", value: funnel.rawFound, strong: true },
    { label: "Rejected as invalid", value: funnel.invalid, minus: true },
    { label: "Duplicates within this search", value: funnel.duplicatesAcrossAreas, minus: true },
    { label: "Distinct businesses", value: funnel.unique, strong: true },
    { label: "Already in your database", value: funnel.alreadyKnown, minus: true },
    { label: "Already contacted", value: funnel.alreadyContacted, minus: true },
    { label: "Suppressed, opted out or rejected", value: funnel.suppressed, minus: true },
    { label: "Needs manual review", value: funnel.needsReview, minus: true },
    { label: "New, over this run's target", value: funnel.notNeeded, minus: true },
    { label: "New prospects accepted", value: funnel.selected, strong: true },
  ];
  const checks: { label: string; value: number }[] = [
    { label: "Verified own website", value: funnel.websiteVerified },
    { label: "Website on listing", value: funnel.websiteListed },
    { label: "Social or directory only", value: funnel.websiteSocialOrDirectory },
    { label: "No website found", value: funnel.websiteNone },
    { label: "Verified public email — high", value: funnel.emailsHigh },
    { label: "Verified public email — medium", value: funnel.emailsMedium },
    { label: "No public email", value: funnel.noEmail },
  ];
  const outcomes: { label: string; value: number; tone?: "good" | "warn" }[] = [
    { label: "Eligible to email", value: funnel.eligible, tone: "good" },
    { label: "Call list", value: funnel.call },
    { label: "Held for you (not confirmed as a company)", value: funnel.manualReview, tone: "warn" },
    { label: "Already has a good website", value: funnel.goodWebsite },
    { label: "Low opportunity", value: funnel.lowOpportunity },
    { label: "Already emailed or replied", value: funnel.alreadyInTouch },
    { label: "Opted out", value: funnel.optedOut },
    { label: "Closed", value: funnel.closed },
    { label: "No email and no phone", value: funnel.noWayToContact },
    { label: "Other", value: funnel.otherSkipped },
  ];
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Where every business went</SectionTitle>
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="px-4 py-3">
          <p className="mb-2 text-xs font-medium text-subtle">Discovery</p>
          <FunnelRows rows={rows.filter((row) => row.strong || row.value > 0)} />
        </Card>
        <Card className="px-4 py-3">
          <p className="mb-2 text-xs font-medium text-subtle">Checks · {plural(funnel.checked, "business", "businesses")}</p>
          <FunnelRows rows={checks.filter((row) => row.value > 0)} />
          {funnel.websitesRejected + funnel.emailsRejected > 0 ? (
            <p className="mt-2 text-xs text-subtle">
              Refused along the way: {plural(funnel.websitesRejected, "candidate site")} that was not provably theirs,{" "}
              {plural(funnel.emailsRejected, "address", "addresses")} that were not a business mailbox.
            </p>
          ) : null}
          {funnel.checkErrors > 0 ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-warn">
              <TriangleAlert className="size-3.5" /> {plural(funnel.checkErrors, "check")} failed and kept the listing's details.
            </p>
          ) : null}
        </Card>
        <Card className="px-4 py-3">
          <p className="mb-2 text-xs font-medium text-subtle">Outcome</p>
          <FunnelRows rows={outcomes.filter((row) => row.value > 0)} />
          {funnel.prepared + funnel.prepareFailed > 0 ? (
            <div className="mt-2 border-t border-border pt-2">
              <FunnelRows
                rows={[
                  { label: "Personalised emails written", value: funnel.prepared },
                  ...(funnel.prepareFailed ? [{ label: "Could not be written", value: funnel.prepareFailed }] : []),
                  ...(funnel.notWritten ? [{ label: "Not written (stopped)", value: funnel.notWritten }] : []),
                ]}
              />
            </div>
          ) : null}
        </Card>
      </div>
    </section>
  );
}

function FunnelRows({ rows }: { rows: { label: string; value: number; minus?: boolean; strong?: boolean; tone?: "good" | "warn" | "bad" }[] }) {
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li key={row.label} className="flex items-baseline justify-between gap-3 py-1 text-sm">
          <span className={cn(row.strong ? "text-fg" : "text-muted", row.minus ? "pl-3" : "")}>{row.label}</span>
          <span className={cn("tabular", row.strong ? "font-medium text-fg" : row.tone === "good" ? "text-good" : row.tone === "warn" ? "text-warn" : "text-muted")}>
            {row.minus ? `−${row.value}` : row.value}
          </span>
        </li>
      ))}
      {rows.length === 0 ? <li className="py-1 text-sm text-subtle">Nothing yet.</li> : null}
    </ul>
  );
}


// ── When a run leaves nothing to act on ───────────────────────────────────────

const STAGE_NAME: Record<NonNullable<ProspectRunState["diagnosis"]>["stage"], string> = {
  discovery: "Lost at discovery",
  deduplication: "Lost at de-duplication",
  contactability: "Lost at contactability",
  scoring: "Lost at scoring",
};

/** Which stage lost the run's prospects, why, what was worked out, and where to look next. */
function Diagnosis({ run, onSearch }: { run: ProspectRunState; onSearch: (next: { location: string; trades: string[] }) => void }) {
  const diagnosis = run.diagnosis!;
  return (
    <Card className="flex flex-col gap-4 border-warn/40 p-5 md:p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-warn/15 text-warn">
          <TriangleAlert className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-warn">{STAGE_NAME[diagnosis.stage]}</p>
          <p className="mt-0.5 font-medium text-fg">{diagnosis.headline}</p>
        </div>
      </div>
      {diagnosis.details.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
          {diagnosis.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {diagnosis.widenedTo.length > 0 ? (
        <p className="text-sm text-muted">
          Also searched further afield automatically: {diagnosis.widenedTo.slice(0, 12).join(", ")}
          {diagnosis.widenedTo.length > 12 ? ` and ${diagnosis.widenedTo.length - 12} more` : ""}.
        </p>
      ) : null}
      {diagnosis.exhausted.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-subtle">Worked out for now — rested rather than searched again</p>
          <p className="text-sm text-muted">
            {diagnosis.exhausted
              .slice(0, 12)
              .map((row) => `${row.trade} in ${row.area} (${row.listings})`)
              .join(" · ")}
            {diagnosis.exhausted.length > 12 ? ` · and ${diagnosis.exhausted.length - 12} more` : ""}
          </p>
        </div>
      ) : null}
      {diagnosis.failed.length > 0 ? (
        <p className="text-sm text-warn">
          {plural(diagnosis.failed.length, "search", "searches")} failed and found nothing: {diagnosis.failed.slice(0, 3).map((row) => `${row.area} (${row.error})`).join("; ")}
        </p>
      ) : null}
      {diagnosis.suggestions.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-xs font-medium text-subtle">Where to look next</p>
          {diagnosis.suggestions.map((next) => (
            <div key={`${next.location}|${next.trades.join(",")}`} className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {next.trades.join(", ")} · {next.location}
                </p>
                <p className="text-xs text-muted">{next.why}</p>
              </div>
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => onSearch(next)}>
                <Search className="size-3.5" />
                Search these
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

const MATCH_LABEL: Record<ReviewItem["match"], string> = {
  database: "a business you already have",
  contacted: "a business you have contacted",
  suppressed: "a business that opted out or you rejected",
  this_run: "another business found in this run",
};

/** Listings the evidence could not settle: you decide whether each is new. */
function ReviewList({ items, total }: { items: ReviewItem[]; total: number }) {
  const [done, setDone] = useState<Record<string, "added" | "same" | "error">>({});
  const [busy, setBusy] = useState("");
  const add = async (item: ReviewItem) => {
    setBusy(item.key);
    const fields = {
      businessName: item.businessName,
      trade: item.trade,
      town: item.town,
      phone: item.phone,
      email: item.email,
      address: item.address,
      website: item.website,
      notes: `Found by Find (${item.source}). You confirmed it is not ${item.matchedName}${item.matchedTown ? ` in ${item.matchedTown}` : ""}.`,
    };
    const reply = await businessAction({ data: { action: "create", fields } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
    setBusy("");
    setDone((current) => ({ ...current, [item.key]: reply.ok ? "added" : "error" }));
  };
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Needs your decision ({total})</SectionTitle>
      <p className="-mt-1 text-sm text-muted">
        These might be businesses you already have — but nothing settles it (a similar name in another town, say). They were neither added nor thrown away.
      </p>
      <Card className="divide-y divide-border">
        {items.map((item) => {
          const state = done[item.key];
          return (
            <div key={item.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-fg">
                  {item.businessName} <span className="font-normal text-muted">· {[item.trade, item.town].filter(Boolean).join(" · ")}</span>
                </p>
                <p className="text-xs text-muted">
                  Possibly {MATCH_LABEL[item.match]}: <span className="text-fg">{item.matchedName}</span>
                  {item.matchedTown ? ` (${item.matchedTown})` : ""} — {item.reason}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {state === "added" ? (
                  <span className="text-sm text-good">Added</span>
                ) : state === "same" ? (
                  <span className="text-sm text-muted">Skipped</span>
                ) : (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy === item.key} onClick={() => void add(item)}>
                      <Plus className="size-3.5" />
                      Different — add it
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDone((current) => ({ ...current, [item.key]: "same" }))}>
                      Same business
                    </Button>
                  </>
                )}
                {state === "error" ? <span className="text-xs text-bad">Could not add</span> : null}
              </div>
            </div>
          );
        })}
      </Card>
      {total > items.length ? <p className="text-xs text-subtle">Showing the first {items.length} of {total}.</p> : null}
    </section>
  );
}

/** Every listing, exactly one outcome, and each search's share of it. */
export function LedgerDetail({ ledger }: { ledger: DiscoveryLedger }) {
  const [open, setOpen] = useState(false);
  const accounted = outcomeTotal(ledger.outcomes);
  const reasons = REJECT_REASONS.filter((reason) => ledger.invalidReasons[reason] > 0);
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Every listing accounted for</SectionTitle>
      <Card className="px-4 py-3">
        <p className="mb-2 text-sm text-muted">
          <span className="font-medium text-fg tabular">{ledger.listings}</span> listings ·{" "}
          <span className="font-medium text-fg tabular">{distinctBusinesses(ledger)}</span> distinct businesses · {accounted === ledger.listings ? "each with exactly one outcome" : `${accounted} outcomes recorded`}
        </p>
        <FunnelRows
          rows={LISTING_OUTCOMES.filter((outcome) => ledger.outcomes[outcome] > 0 || outcome === "accepted").map((outcome) => ({
            label: OUTCOME_LABEL[outcome],
            value: ledger.outcomes[outcome],
            strong: outcome === "accepted",
          }))}
        />
        {reasons.length > 0 || ledger.outcomes.duplicate_in_search > 0 ? (
          <p className="mt-2 text-xs text-subtle">
            {reasons.length > 0 ? `Rejected: ${reasons.map((reason) => `${ledger.invalidReasons[reason]} ${REJECT_LABEL[reason]}`).join(", ")}. ` : ""}
            {ledger.outcomes.duplicate_in_search > 0
              ? `Duplicates: ${ledger.duplicates.acrossSources} the same business from two sources, ${ledger.duplicates.acrossAreas} listed under more than one town, ${ledger.duplicates.acrossTrades} found again under another trade.`
              : ""}
          </p>
        ) : null}
      </Card>
      {ledger.searches.length > 0 ? (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)} className="flex items-center gap-1 self-start text-sm text-muted hover:text-fg">
            <ChevronDown className={cn("size-4 transition-transform", open ? "rotate-180" : "")} />
            Searches ({ledger.searches.length})
          </button>
          {open ? (
            <Card className="overflow-x-auto px-0 py-1">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead>
                  <tr className="text-xs text-subtle">
                    <th className="px-4 py-2 font-medium">Search</th>
                    <th className="px-2 py-2 text-right font-medium">Listings</th>
                    <th className="px-2 py-2 text-right font-medium">New</th>
                    <th className="px-2 py-2 text-right font-medium">Yours</th>
                    <th className="px-2 py-2 text-right font-medium">Check</th>
                    <th className="px-2 py-2 text-right font-medium">Repeats</th>
                    <th className="px-4 py-2 text-right font-medium">Invalid</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.searches.map((row) => {
                    const fresh = row.outcomes.accepted + row.outcomes.beyond_target;
                    const yours = row.outcomes.in_database + row.outcomes.contacted + row.outcomes.suppressed;
                    return (
                      <tr key={`${row.trade}|${row.area}`} className="border-t border-border">
                        <td className="px-4 py-1.5">
                          <span className="text-fg">{row.trade}</span> <span className="text-muted">· {row.area}</span>
                          {row.error ? <span className="block text-xs text-warn">Failed: {row.error}</span> : null}
                          {row.priorSearches > 0 ? <span className="block text-xs text-subtle">searched {plural(row.priorSearches, "time")} before</span> : null}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular">{row.listings}</td>
                        <td className={cn("px-2 py-1.5 text-right tabular", fresh > 0 ? "text-good" : "text-muted")}>{fresh}</td>
                        <td className="px-2 py-1.5 text-right tabular text-muted">{yours}</td>
                        <td className="px-2 py-1.5 text-right tabular text-muted">{row.outcomes.needs_review}</td>
                        <td className="px-2 py-1.5 text-right tabular text-muted">{row.outcomes.duplicate_in_search}</td>
                        <td className="px-4 py-1.5 text-right tabular text-muted">{row.outcomes.invalid}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
