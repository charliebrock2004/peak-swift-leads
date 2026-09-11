import { useMemo, useState } from "react";
import { Bot, CircleStop, Loader2, Phone, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutoRun } from "@/components/outreach/use-auto-run";
import {
  AUTO_DAILY_MAX,
  AUTO_TARGET_MAX,
  clampAutoConfig,
  DEFAULT_AUTO_CONFIG,
  dominantSkip,
  groupSkips,
  isFinished,
  PHASE_LABELS,
  RINGING_REASON,
  SKIP_ADVICE,
  type AutoRunConfig,
  type RingingLead,
} from "@/lib/outreach/auto-run";
import type { OutreachState } from "@/lib/outreach/server";
import { RADIUS_MILES, TOWN_SUGGESTIONS, TRADE_SUGGESTIONS } from "@/lib/leads";
import { cn } from "@/lib/utils";

const STEPS = [
  { phase: "searching", label: "Search" },
  { phase: "qualifying", label: "Qualify" },
  { phase: "personalising", label: "Personalise" },
  { phase: "sending", label: "Send" },
  { phase: "replies", label: "Record" },
] as const;

/**
 * AI Outreach — the whole pipeline, started once.
 *
 * This runs the same steps you would run by hand, in the same order, calling
 * the same server functions: search, website and email checks, AI drafting, the
 * queue, then Gmail. Nothing here decides who may be emailed. Every send is
 * still gated twice on the server, held to the daily limit and the batch size,
 * and refused outright for anyone suppressed, unsubscribed, already contacted or
 * held for manual review.
 *
 * The manual workflow is untouched and still in the other tabs. This is a
 * second way in, not a replacement for the first.
 */
export function OutreachAuto({
  state,
  onReload,
}: {
  state: OutreachState;
  onReload: () => void;
}) {
  const [form, setForm] = useState<AutoRunConfig>(() =>
    clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, dailyLimit: state.settings.dailyLimit }),
  );
  const { run, start, stop, reset, running } = useAutoRun(onReload);

  const set = <K extends keyof AutoRunConfig>(key: K, value: AutoRunConfig[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const connected = state.connection.status === "connected";
  const blocked = form.mode === "send" && !connected;

  const stepIndex = useMemo(() => STEPS.findIndex((step) => step.phase === run.phase), [run.phase]);

  const tiles = [
    { label: "Businesses found", value: run.counters.found },
    { label: "Qualified prospects", value: run.counters.qualified },
    { label: "Emails prepared", value: run.counters.prepared },
    { label: "Emails sent", value: run.counters.sent, tone: "good" as const },
    { label: "Replies received", value: run.counters.replies },
    { label: "Skipped leads", value: run.counters.skipped },
    { label: "Errors", value: run.counters.errors, tone: run.counters.errors > 0 ? ("hot" as const) : undefined },
  ];

  return (
    <section className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="size-5 text-accent" />
          <h3 className="font-display text-xl font-medium">AI Outreach</h3>
        </div>
        <p className="mt-1 text-sm text-muted">
          Search, qualify, personalise, send and record — in one run, while this screen is open.
          Manual review is still there in the other tabs and works exactly as before.
        </p>
      </div>

      {running || isFinished(run.phase) ? (
        <RunView
          run={run}
          stepIndex={stepIndex}
          tiles={tiles}
          running={running}
          onStop={stop}
          onReset={reset}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Town or area">
            <Chips
              options={TOWN_SUGGESTIONS}
              value={form.location}
              onChange={(value) => set("location", value)}
            />
            <Input
              className="mt-3 h-11"
              value={form.location}
              onChange={(event) => set("location", event.target.value)}
              placeholder="Or type a town, city or region"
              aria-label="Town or area"
            />
          </Field>

          <Field label="Business type">
            <Chips
              options={TRADE_SUGGESTIONS}
              value={form.businessType}
              onChange={(value) => set("businessType", value)}
            />
            <Input
              className="mt-3 h-11"
              value={form.businessType}
              onChange={(event) => set("businessType", event.target.value)}
              placeholder="Or type a trade"
              aria-label="Business type"
            />
          </Field>

          <Field label="Radius">
            <Chips
              options={RADIUS_MILES.map((miles) => `${miles} miles`)}
              value={`${form.radiusMiles} miles`}
              onChange={(value) => set("radiusMiles", Number.parseInt(value, 10))}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Businesses to target (max ${AUTO_TARGET_MAX})`}>
              <Input
                className="mt-2 h-11"
                type="number"
                min={1}
                max={AUTO_TARGET_MAX}
                value={form.target}
                onChange={(event) => set("target", Number(event.target.value))}
                aria-label="Businesses to target"
              />
            </Field>
            <Field label={`Daily sending limit (max ${AUTO_DAILY_MAX})`}>
              <Input
                className="mt-2 h-11"
                type="number"
                min={0}
                max={AUTO_DAILY_MAX}
                value={form.dailyLimit}
                onChange={(event) => set("dailyLimit", Number(event.target.value))}
                aria-label="Daily sending limit"
              />
            </Field>
          </div>

          <Field label="What this run does">
            <div className="mt-2 flex flex-wrap gap-2">
              <Chip
                label="Search, write and send"
                active={form.mode === "send"}
                onClick={() => set("mode", "send")}
              />
              <Chip
                label="Prepare drafts only"
                active={form.mode === "prepare"}
                onClick={() => set("mode", "prepare")}
              />
            </div>
            <p className="mt-2 text-sm text-subtle">
              {form.mode === "send"
                ? `Sends up to ${Math.min(form.dailyLimit, state.allowance.remaining)} today — ${
                    state.allowance.sent
                  } of ${state.allowance.limit} already gone, ${state.settings.batchSize} per batch, ${
                    state.settings.delaySeconds
                  }s between batches.`
                : "Runs everything except the send. Drafts land in Review for you to look at."}
            </p>
          </Field>

          {/* The whole promise of this tab is a personalised email. Without an AI
              key every one is a template, and the only place that showed was a
              note per email after the fact. Say it before the run starts. */}
          {!state.aiAvailable ? (
            <p className="text-sm text-warm-lead">
              AI personalisation is not configured, so emails will be written from your templates
              instead. They are still honest and specific to each business&apos;s website situation —
              but they are not individually written. Add <code>XAI_API_KEY</code> to the deployment to
              turn personalisation on.
            </p>
          ) : null}

          {blocked ? (
            <p className="text-sm text-warm-lead">
              Gmail is not connected, so nothing can be sent. Connect it in Settings, or choose
              “Prepare drafts only”.
            </p>
          ) : null}
          {run.phase === "failed" && run.detail ? <p className="text-sm text-hot">{run.detail}</p> : null}

          <Button className="h-12 w-full md:w-auto" disabled={blocked} onClick={() => void start(form)}>
            <Play />
            Start run
          </Button>

          <p className="text-xs text-subtle">
            The run stops when you close this screen. Nothing is scheduled and nothing sends while
            the app is shut. Suppressed, unsubscribed, already-contacted, replied, booked, won and
            manual-review leads are never contacted.
          </p>
        </div>
      )}
    </section>
  );
}

function RunView({
  run,
  stepIndex,
  tiles,
  running,
  onStop,
  onReset,
}: {
  run: ReturnType<typeof useAutoRun>["run"];
  stepIndex: number;
  tiles: { label: string; value: number; tone?: "good" | "hot" }[];
  running: boolean;
  onStop: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <div className="flex items-center gap-2">
          {running ? <Loader2 className="size-4 shrink-0 animate-spin text-muted" /> : null}
          <p className="font-medium" aria-live="polite">
            {PHASE_LABELS[run.phase]}
          </p>
        </div>
        {run.detail ? <p className="mt-1 text-sm text-muted">{run.detail}</p> : null}

        <ol className="mt-4 flex flex-wrap gap-1.5">
          {STEPS.map((step, index) => (
            <li
              key={step.phase}
              className={cn(
                "h-8 rounded-full px-3 text-xs leading-8 font-medium",
                index < stepIndex || (!running && run.phase === "done")
                  ? "bg-accent/15 text-accent"
                  : index === stepIndex
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-2 text-subtle",
              )}
            >
              {step.label}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-surface px-3 py-3 md:px-4">
            <p className="text-xs font-medium text-muted">{tile.label}</p>
            <p
              className={cn(
                "mt-1 font-display text-2xl leading-none font-medium tabular-nums",
                tile.tone === "hot" ? "text-hot" : tile.tone === "good" ? "text-accent" : "text-fg",
              )}
            >
              {tile.value}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button variant="secondary" className="h-11" onClick={onStop}>
            <CircleStop />
            Stop
          </Button>
        ) : (
          <Button variant="secondary" className="h-11" onClick={onReset}>
            <RotateCcw />
            New run
          </Button>
        )}
      </div>

      {run.ringing.length > 0 ? <WorthRinging leads={run.ringing} /> : null}

      {run.skips.length > 0 ? <SkippedWhy skips={run.skips} /> : null}

      {run.log.length > 0 ? (
        <div>
          <h4 className="text-xs font-medium tracking-wide text-muted uppercase">Activity</h4>
          <ul className="mt-2 flex flex-col gap-1">
            {[...run.log].reverse().map((event, index) => (
              <li
                key={`${event.at}-${index}`}
                className={cn(
                  "text-sm",
                  event.tone === "good"
                    ? "text-fg"
                    : event.tone === "bad"
                      ? "text-hot"
                      : event.tone === "warn"
                        ? "text-warm-lead"
                        : "text-muted",
                )}
              >
                <span className="mr-2 text-xs tabular-nums text-subtle">
                  {event.at.slice(11, 16)}
                </span>
                {event.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The businesses worth ringing.
 *
 * These are not failures. They are the prospects with the clearest problem to
 * solve — usually no website at all — who simply have no address to write to.
 * The run keeps them in the sheet with everything a call needs, and this is the
 * list to work down. Tapping a number dials it.
 *
 * Deliberately plain: a name, a number, where they are, and what is wrong with
 * their web presence. Nothing here is a task, a stage or a pipeline.
 */
function WorthRinging({ leads }: { leads: RingingLead[] }) {
  return (
    <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
      <div className="flex items-center gap-2">
        <Phone className="size-4 text-accent" />
        <p className="text-sm font-medium">{leads.length} worth ringing</p>
      </div>
      <p className="mt-1 text-sm text-muted">{RINGING_REASON}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {leads.map((lead) => (
          <li key={lead.id} className="rounded-md bg-surface-2 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 font-medium">{lead.businessName}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                  lead.band === "High" ? "bg-hot/15 text-hot" : "bg-warm-lead/15 text-warm-lead",
                )}
              >
                {lead.band} {lead.score}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {[lead.town, lead.websiteStatus].filter(Boolean).join(" · ")}
            </p>
            {lead.phone ? (
              <a
                href={`tel:${lead.phone.replace(/\s+/g, "")}`}
                className="mt-1 inline-block text-sm font-medium text-accent underline-offset-4 hover:underline"
              >
                {lead.phone}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-subtle">
        They stay on your lead sheet with everything above. Prospects → “Worth ringing” shows the
        same list any time.
      </p>
    </div>
  );
}

/**
 * Why the run did not write to them.
 *
 * Counted reasons first, then the businesses. A run that skips everything skips
 * it for two or three shared reasons, and forty business names in a list hide
 * that completely — the whole question is "why did nothing qualify", and the
 * count answers it on the first line. The advice under it says what, if
 * anything, to do: "no public email" is usually not a fault to fix.
 */
function SkippedWhy({ skips }: { skips: { businessName: string; reasons: string[] }[] }) {
  const groups = groupSkips(skips);
  const advice = SKIP_ADVICE[dominantSkip(skips)];
  return (
    <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
      <p className="text-sm font-medium">{skips.length} skipped — why</p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {groups.map((group) => (
          <li key={group.reason} className="flex items-baseline gap-3 text-sm">
            <span className="w-8 shrink-0 text-right font-medium tabular-nums">{group.count}</span>
            <span className="min-w-0 flex-1 text-muted">{group.reason}</span>
          </li>
        ))}
      </ul>
      {advice ? <p className="mt-3 text-sm text-subtle">{advice}</p> : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">Show each business</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {skips.map((entry, index) => (
            <li key={`${entry.businessName}-${index}`} className="text-sm text-muted">
              {entry.businessName ? <span className="text-fg">{entry.businessName}</span> : null}
              {entry.businessName ? " — " : null}
              {entry.reasons.join(" · ")}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="text-xs font-medium text-muted">{label}</legend>
      {children}
    </fieldset>
  );
}

function Chips({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {options.map((option) => (
        <Chip key={option} label={option} active={value === option} onClick={() => onChange(option)} />
      ))}
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-11 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
        active ? "bg-accent text-accent-fg" : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}
