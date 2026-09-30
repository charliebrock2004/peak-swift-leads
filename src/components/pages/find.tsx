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
import { RUN_STAGES, STAGE_TITLES, type ProspectRunState, type RunConfig } from "@/components/app/use-prospect-run";
import { TRADE_SUGGESTIONS } from "@/lib/leads";
import { MAX_TRADES } from "@/lib/outreach/auto-run";
import { reconcileFunnel, type RunFunnel } from "@/lib/outreach/run-funnel";
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

  const [area, setArea] = useState(chosen?.locations || "Perthshire");
  const [trades, setTrades] = useState<string[]>(
    chosen ? chosen.trades.split(",").map((item) => item.trim()).filter(Boolean).slice(0, MAX_TRADES) : ["Joiner", "Builder", "Roofer", "Plumber"],
  );
  const [customTrade, setCustomTrade] = useState("");
  const [target, setTarget] = useState(chosen?.targetProspects ?? 50);
  const [dailyLimit, setDailyLimit] = useState(Math.min(chosen?.dailyTarget ?? 10, state.settings.dailyLimit));
  const [campaignId, setCampaignId] = useState(chosen?.id ?? "");
  const [campaignName, setCampaignName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [radius, setRadius] = useState(25);
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
    };
    void prospecting.start(config);
  };

  if (run.status !== "idle") {
    return <RunView run={run} onStop={prospecting.stop} onReset={prospecting.reset} running={prospecting.running} />;
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
        <Field label="Area" htmlFor="area" hint="A town, a city or a region — a region is searched town by town.">
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
          <button type="button" onClick={() => setAdvanced((open) => !open)} className="flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ChevronDown className={cn("size-4 transition-transform", advanced ? "rotate-180" : "")} />
            Search radius · {radius} miles
          </button>
          {advanced ? (
            <div className="mt-2 flex gap-1.5">
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

function stageCount(stage: (typeof RUN_STAGES)[number], funnel: RunFunnel): string {
  switch (stage) {
    case "discovering":
      return funnel.rawFound ? `${funnel.rawFound} listings found` : "";
    case "deduplicating":
      return funnel.unique ? `${funnel.unique} unique · ${funnel.selected} new to you` : "";
    case "verifying":
      return funnel.checked ? `${funnel.checked} businesses checked` : "";
    case "websites":
      return funnel.checked ? `${funnel.websiteVerified} websites verified · ${funnel.checked - funnel.goodWebsite} opportunities` : "";
    case "emails":
      return funnel.checked ? `${funnel.emailsFound} verified public emails` : "";
    case "qualifying":
      return funnel.eligible || funnel.call ? `${funnel.eligible} eligible · ${funnel.call} to call` : "";
    case "personalising":
      return funnel.prepared ? `${funnel.prepared} personalised emails` : "";
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
}: {
  run: ProspectRunState;
  onStop: () => void;
  onReset: () => void;
  running: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const { funnel } = run;
  const finished = !running;
  const problems = useMemo(() => (finished ? reconcileFunnel(funnel) : []), [finished, funnel]);

  return (
    <>
      <PageHeader
        eyebrow={run.config ? `${run.config.trades.join(", ")} · ${run.config.location}` : "Find & reach"}
        title={
          running
            ? "Finding prospects…"
            : run.status === "done"
              ? "Your prospects are ready"
              : run.status === "stopped"
                ? "Run stopped"
                : "The run could not finish"
        }
        description={run.detail}
        actions={
          running ? (
            <Button variant="secondary" onClick={onStop}>
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

      <Card className="p-5 md:p-6">
        <ol className="flex flex-col gap-0.5">
          {RUN_STAGES.map((stage) => {
            const done = run.completed.includes(stage) || (finished && run.status === "done");
            const current = running && run.stage === stage;
            const count = stageCount(stage, funnel);
            return (
              <li key={stage} className="flex items-center gap-3 py-2">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full",
                    done ? "bg-good/15 text-good" : current ? "bg-accent text-accent-fg" : "bg-surface-2 text-subtle",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : current ? <Loader2 className="size-3.5 animate-spin" /> : <Circle className="size-2 fill-current" />}
                </span>
                <span className={cn("flex-1 text-sm", done || current ? "text-fg" : "text-subtle")}>{STAGE_TITLES[stage]}</span>
                {count && (done || current) ? <span className="text-sm text-muted tabular">{count}</span> : null}
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

      {finished && run.status !== "failed" ? <Outcome run={run} /> : null}

      {problems.length > 0 ? (
        <Notice tone="bad" title="These numbers do not add up">
          {problems.join(" · ")}. The run is recorded as it happened; please report this.
        </Notice>
      ) : null}

      {funnel.rawFound > 0 ? <FunnelDetail funnel={funnel} /> : null}

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
  return (
    <Card className="flex flex-col gap-4 p-5 md:p-6">
      <div className="grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="font-display text-3xl font-medium tabular">{funnel.readyToday}</p>
          <p className="mt-1 text-xs text-muted">ready to send today</p>
        </div>
        <div>
          <p className="font-display text-3xl font-medium tabular">{funnel.heldForTomorrow}</p>
          <p className="mt-1 text-xs text-muted">held for tomorrow</p>
        </div>
        <div>
          <p className="font-display text-3xl font-medium tabular">{funnel.call}</p>
          <p className="mt-1 text-xs text-muted">to call</p>
        </div>
      </div>
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
        {funnel.call > 0 ? (
          <Link to="/calls" className="flex-1">
            <Button variant="secondary" className="h-12 w-full">
              <Phone />
              Call list ({funnel.call})
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

/** Every number in the run, with the door each business left by. */
export function FunnelDetail({ funnel }: { funnel: RunFunnel }) {
  const rows: { label: string; value: number; minus?: boolean; strong?: boolean; tone?: "good" | "warn" | "bad" }[] = [
    { label: "Listings found", value: funnel.rawFound, strong: true },
    { label: "Unique businesses", value: funnel.unique, strong: true },
    { label: "Beyond one page per area", value: funnel.beyondFetchBudget, minus: true },
    { label: "Duplicates across areas and trades", value: funnel.duplicatesAcrossAreas, minus: true },
    { label: "Already on your sheet", value: funnel.alreadyKnown, minus: true },
    { label: "Already contacted", value: funnel.alreadyContacted, minus: true },
    { label: "Opted out", value: funnel.suppressed, minus: true },
    { label: "Past the safety ceiling", value: funnel.beyondSafetyCeiling, minus: true },
    { label: "Not needed (target met)", value: funnel.notNeeded, minus: true },
    { label: "New prospects", value: funnel.selected, strong: true },
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
    { label: "Held for you (sole trader / personal mailbox)", value: funnel.manualReview, tone: "warn" },
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

