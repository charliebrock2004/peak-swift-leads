import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { computeStats } from "@/lib/outreach/dashboard";
import type { EligibilityContext } from "@/lib/outreach/eligibility";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachLead } from "@/lib/outreach/types";
import type { OutreachTab } from "@/components/outreach/outreach-panel";
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
  onGoTo: (tab: OutreachTab) => void;
  onCheckReplies: () => void;
}) {
  const stats = useMemo(
    () => computeStats(state.leads as OutreachLead[], state.emails, state.settings, context),
    [state, context],
  );

  return (
    <section className="flex flex-col gap-5">
      <Group title="Your sheet">
        <Tile label="Leads" value={stats.leads} />
        <Tile label="High opportunity" value={stats.highOpportunity} tone="hot" />
        <Tile label="Emails available" value={stats.emailsAvailable} />
        <Tile label="Never contacted" value={stats.neverContacted} />
        <Tile label="Ready to email" value={stats.eligibleNow} onClick={() => onGoTo("prospects")} />
        <Tile label="Manual review" value={stats.manualReview} onClick={() => onGoTo("prospects")} />
      </Group>

      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium text-muted">Today</p>
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
        <Tile label="Failed" value={stats.failed} tone={stats.failed > 0 ? "hot" : undefined} onClick={() => onGoTo("review")} />
        <Tile label="Follow-ups due" value={stats.followUpsDue} onClick={() => onGoTo("prospects")} />
      </Group>

      <Group title="Results">
        <Tile label="Total sent" value={stats.totalSent} />
        <Tile label="Replies" value={stats.replies} onClick={() => onGoTo("replies")} />
        <Tile label="Interested" value={stats.interested} />
        <Tile label="Booked" value={stats.booked} />
        <Tile label="Won" value={stats.won} />
        <Tile label="Unsubscribed" value={stats.unsubscribed} onClick={() => onGoTo("replies")} />
      </Group>

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
    </section>
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
