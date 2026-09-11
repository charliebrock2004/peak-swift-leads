import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACTIVITY_LABELS, computeStats, nextMove } from "@/lib/outreach/dashboard";
import { assessHealth, type HealthLevel } from "@/lib/outreach/health";
import {
  formatRate,
  segmentsByTown,
  segmentsByTrade,
  whereToSearchNext,
  type Segment,
} from "@/lib/outreach/analytics";
import type { EligibilityContext } from "@/lib/outreach/eligibility";
import { getActivityLog, type OutreachState } from "@/lib/outreach/server";
import type { OutreachLead } from "@/lib/outreach/types";
import type { OutreachTab } from "@/components/outreach/outreach-panel";
import type { ProspectFilter } from "@/lib/decision";
import { cn } from "@/lib/utils";

/**
 * The overview.
 *
 * Every number here is derived from the lead sheet and the email history, so it
 * can never quietly disagree with either. Tiles that lead somewhere are
 * buttons; the rest are plain, so tapping around never does something you did
 * not ask for.
 */
export function OutreachDashboard({
  state,
  context,
  busy,
  onGoTo,
  onCheckReplies,
}: {
  state: OutreachState;
  context: EligibilityContext;
  busy: string;
  onGoTo: (tab: OutreachTab, filter?: ProspectFilter) => void;
  onCheckReplies: () => void;
}) {
  const stats = useMemo(
    () => computeStats(state.leads as OutreachLead[], state.emails, state.settings, context),
    [state, context],
  );

  const health = useMemo(
    () =>
      assessHealth({
        database: state.database,
        connection: state.connection,
        leads: state.leads as OutreachLead[],
        emails: state.emails,
        aiAvailable: state.aiAvailable,
      }),
    [state],
  );

  const [activity, setActivity] = useState<
    { id: string; at: string; eventType: string; leadName: string; result: string; reason: string; error: string }[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    void getActivityLog().then((result) => {
      if (cancelled || !result.success) return;
      setActivity(result.events.slice(0, 8));
    });
    return () => {
      cancelled = true;
    };
  }, [state.emails.length, state.leads.length]);

  const towns = useMemo(() => segmentsByTown(state.leads, state.emails), [state.leads, state.emails]);
  const trades = useMemo(
    () => segmentsByTrade(state.leads, state.emails),
    [state.leads, state.emails],
  );
  const searchNext = whereToSearchNext(towns, trades);

  const move = nextMove(stats, state.connection.status);

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">What to do next</p>
        <p className="mt-1 text-base font-medium">{move}</p>
        <p className="mt-2 text-sm text-subtle">{stats.bottleneck}</p>
      </div>

      <Group title="Today">
        <Tile label="Leads" value={stats.leads} />
        <Tile label="HOT" value={stats.hot} tone="hot" onClick={() => onGoTo("prospects", "hot")} />
        <Tile label="WARM" value={stats.warm} onClick={() => onGoTo("prospects", "warm")} />
        <Tile label="CALL" value={stats.call} onClick={() => onGoTo("prospects", "call")} />
        <Tile label="Ready to email" value={stats.eligibleNow} onClick={() => onGoTo("prospects", "ready")} />
        <Tile label="Need a look" value={stats.review} onClick={() => onGoTo("prospects", "review")} />
        <Tile label="Emails sent" value={stats.sentToday} />
        <Tile label="Replies" value={stats.replies} onClick={() => onGoTo("replies")} />
        <Tile
          label="Follow-ups due"
          value={stats.followUpsDue}
          onClick={() => onGoTo("prospects", "follow-up")}
        />
        <Tile
          label="Errors"
          value={stats.failed}
          tone={stats.failed > 0 ? "hot" : undefined}
          onClick={() => onGoTo("review")}
        />
      </Group>

      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium text-muted">Sending today</p>
          <p className="text-xs tabular-nums text-subtle">
            {stats.dailyLimit - stats.sentToday} left of your daily limit
          </p>
        </div>
        <p className="mt-1 font-display text-3xl leading-none font-medium tabular-nums">
          {stats.sentToday} <span className="text-muted">/ {stats.dailyLimit}</span>
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-(--motion-fast)"
            style={{ width: `${Math.min(100, Math.round((stats.sentToday / Math.max(1, stats.dailyLimit)) * 100))}%` }}
          />
        </div>
        {state.connection.status !== "connected" ? (
          <p className="mt-3 text-sm text-warm-lead">
            {state.connection.status === "needs_attention"
              ? "Gmail connection needs attention."
              : "Gmail is not connected yet."}{" "}
            <button type="button" className="underline" onClick={() => onGoTo("settings")}>
              Open settings
            </button>
          </p>
        ) : null}
      </div>

      <Group title="In progress">
        <Tile label="Awaiting review" value={stats.awaitingApproval} onClick={() => onGoTo("review")} />
        <Tile label="Queued" value={stats.queued} onClick={() => onGoTo("review")} />
        <Tile label="Manual review" value={stats.manualReview} onClick={() => onGoTo("prospects", "review")} />
        <Tile label="Never contacted" value={stats.neverContacted} />
      </Group>

      <Group title="Results">
        <Tile label="Total sent" value={stats.totalSent} />
        <Tile label="Interested" value={stats.interested} />
        <Tile label="Booked" value={stats.booked} onClick={() => onGoTo("prospects", "booked")} />
        <Tile label="Won" value={stats.won} />
        <Tile label="Unsubscribed" value={stats.unsubscribed} onClick={() => onGoTo("replies")} />
      </Group>

      {towns.length > 0 ? (
        <div>
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">What is working</h3>
          {searchNext ? <p className="mt-1 text-sm text-subtle">{searchNext}</p> : null}
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <SegmentTable title="Towns" segments={towns} />
            <SegmentTable title="Trades" segments={trades} />
          </div>
          <p className="mt-2 text-xs text-subtle">
            Reply rate is only shown once a town or trade has had enough emails for the number to
            mean anything. Everything here counts real sent emails and real replies.
          </p>
        </div>
      ) : null}

      <div>
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">System health</h3>
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-(--shadow-border)">
          {health.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-xs text-subtle">{item.detail}</p>
              </div>
              <HealthBadge level={item.level} />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="h-11"
          disabled={busy !== "" || state.connection.status !== "connected"}
          onClick={onCheckReplies}
        >
          {busy === "replies" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Check for replies
        </Button>
      </div>
      <p className="text-xs text-subtle">
        Replies are read, never answered. Anything that comes back is yours to handle.
      </p>

      {activity.length > 0 ? (
        <div>
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Recent activity</h3>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-(--shadow-border)">
            {activity.map((event) => (
              <li key={event.id} className="px-4 py-2.5">
                <p className="text-sm">
                  <span className="font-medium">{ACTIVITY_LABELS[event.eventType] ?? event.eventType}</span>
                  {event.leadName ? <span className="text-muted"> · {event.leadName}</span> : null}
                </p>
                <p className="text-xs text-subtle">
                  {event.at.slice(11, 16)}
                  {event.reason ? ` · ${event.reason}` : ""}
                  {event.error ? ` · ${event.error}` : ""}
                  {event.result && !event.reason && !event.error ? ` · ${event.result}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function HealthBadge({ level }: { level: HealthLevel }) {
  const label =
    level === "HEALTHY" ? "Healthy" : level === "WARNING" ? "Warning" : level === "ERROR" ? "Error" : "Off";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        level === "HEALTHY" && "bg-accent/15 text-accent",
        level === "WARNING" && "bg-warm-lead/15 text-warm-lead",
        level === "ERROR" && "bg-hot/15 text-hot",
        level === "OFF" && "bg-surface-2 text-subtle",
      )}
    >
      {label}
    </span>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{title}</h3>
      <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-3">{children}</div>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "hot";
  onClick?: () => void;
}) {
  const content = (
    <>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={cn(
          "mt-1 font-display text-2xl leading-none font-medium tabular-nums",
          tone === "hot" ? "text-hot" : "text-fg",
        )}
      >
        {value}
      </p>
    </>
  );
  if (!onClick) return <div className="bg-surface px-3 py-3 md:px-4">{content}</div>;
  return (
    <button type="button" onClick={onClick} className="bg-surface px-3 py-3 text-left hover:bg-surface-2 md:px-4">
      {content}
    </button>
  );
}

/**
 * A league table of towns or trades.
 *
 * Capped at eight rows: this is a signal about where to search next, not a
 * report, and a long tail of one-prospect towns hides the answer.
 */
function SegmentTable({ title, segments }: { title: string; segments: readonly Segment[] }) {
  const rows = segments.slice(0, 8);
  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-(--shadow-border)">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-subtle">sent · replies · rate</p>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {rows.map((segment) => (
          <li key={segment.name} className="flex items-center justify-between gap-3 px-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm">{segment.name}</p>
              <p className="text-xs text-subtle">
                {segment.prospects} {segment.prospects === 1 ? "prospect" : "prospects"} ·{" "}
                {segment.withEmail} with an email
              </p>
            </div>
            <p className="shrink-0 text-sm tabular-nums text-muted">
              {segment.sent} · {segment.replies} · {formatRate(segment.replyRate)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
