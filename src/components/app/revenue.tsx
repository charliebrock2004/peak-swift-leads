/**
 * Insights → Money: what PeakSwift helped create, and what it cost in your
 * time. Every figure comes from revenue.ts; anything below its sample-size
 * minimum shows its counts and a "not enough yet" instead of a number.
 */
import { Info } from "lucide-react";
import { Card, SectionTitle, Skeleton, Stat } from "@/components/app/ui";
import { RATE_MIN_SENT, type Rate } from "@/lib/outreach/analytics";
import { ANGLE_LABEL, type Angle } from "@/lib/outreach/angles";
import { FEEDBACK_MIN, SOURCE_LABEL, type QualityRow } from "@/lib/feedback/quality";
import { formatPence } from "@/lib/sales/pipeline";
import {
  formatDays,
  formatDuration,
  HOURLY_MIN_HOURS,
  PER_CONVERSATION_MIN,
  PER_CUSTOMER_MIN,
  TIMING_MIN,
  type Revenue,
  type Segment,
} from "@/lib/sales/revenue";
import { cn } from "@/lib/utils";

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

function rateText(rate: Rate | null): string {
  if (!rate || rate.value === null) return "—";
  return `${Math.round(rate.value)}%`;
}

function sinceText(day: string): string {
  if (!day) return "";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function MoneySection({ revenue, error, typicalPounds = null }: { revenue: Revenue | null; error: string; typicalPounds?: number | null }) {
  if (error) return <Card className="px-4 py-4 text-sm text-muted">Revenue figures could not load: {error}</Card>;
  if (!revenue) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-[5.5rem]" />
        ))}
      </div>
    );
  }
  const { money } = revenue;
  return (
    <section className="flex flex-col gap-3" aria-label="Money">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Won"
          value={formatPence(money.wonPence) || "£0"}
          tone={money.wonPence > 0 ? "good" : "neutral"}
          sub={money.wonCount ? `${plural(money.wonCount, "customer")} · ${formatPence(money.wonThisMonthPence) || "£0"} this month` : "No customers yet"}
        />
        <Stat
          label="Open pipeline"
          value={formatPence(money.openPence) || "£0"}
          sub={money.unvalued ? `${plural(money.openCount, "sale")} · ${money.unvalued} with no value yet` : plural(money.openCount, "sale") + " in play"}
          to="/pipeline"
        />
        <Stat label="Quotes out" value={formatPence(money.quotedPence) || "£0"} sub="Waiting on an answer" />
        <Stat
          label="Average job"
          value={money.averageWonPence === null ? "—" : formatPence(money.averageWonPence)}
          sub={
            money.averageWonPence === null
              ? `Needs ${PER_CUSTOMER_MIN} won with a value${typicalPounds ? ` · you said £${typicalPounds.toLocaleString("en-GB")} is typical` : ""}`
              : typicalPounds
                ? `You said £${typicalPounds.toLocaleString("en-GB")} is typical`
                : "Across won jobs with a value"
          }
        />
      </div>
      <NorthStar revenue={revenue} />
    </section>
  );
}

/** Minutes per conversation, minutes per customer, £ per hour — the numbers the product is for. */
function NorthStar({ revenue }: { revenue: Revenue }) {
  const { north } = revenue;
  const seconds = north.appSeconds + north.callSeconds;
  const tiles = [
    {
      label: "Minutes per conversation",
      value: north.minutesPerConversation === null ? "—" : Math.round(north.minutesPerConversation).toString(),
      sub: north.minutesPerConversation === null ? `Needs ${PER_CONVERSATION_MIN} conversations · ${north.conversations} so far` : `From ${plural(north.conversations, "conversation")}`,
    },
    {
      label: "Minutes per customer",
      value: north.minutesPerCustomer === null ? "—" : Math.round(north.minutesPerCustomer).toString(),
      sub: north.minutesPerCustomer === null ? `Needs ${PER_CUSTOMER_MIN} customers · ${north.customers} so far` : `From ${plural(north.customers, "customer")}`,
    },
    {
      label: "£ per hour of prospecting",
      value: north.poundsPerHour === null ? "—" : formatPence(Math.round(north.poundsPerHour) * 100),
      sub: north.poundsPerHour === null ? `Needs ${PER_CUSTOMER_MIN} customers and ${HOURLY_MIN_HOURS}h measured` : `${formatPence(north.wonPence)} won in ${formatDuration(seconds)}`,
    },
  ];
  return (
    <Card className="px-4 py-4 md:px-5">
      <p className="text-sm font-medium text-fg">Your time</p>
      <p className="mt-0.5 text-sm text-muted">
        {north.since
          ? `Measured since ${sinceText(north.since)}: ${formatDuration(seconds)} — ${formatDuration(north.appSeconds)} using PeakSwift, ${formatDuration(north.callSeconds)} on calls. ${plural(north.conversations, "conversation")} and ${plural(north.customers, "customer")} since then.`
          : "Measuring starts now: minutes you spend using PeakSwift, and the minutes you confirm when you log a call. Nothing before today is guessed."}
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label}>
            <p className="text-xs text-muted">{tile.label}</p>
            <p className={cn("mt-1 font-display text-[1.65rem] leading-none font-medium tabular", tile.value === "—" ? "text-subtle" : "text-fg")}>{tile.value}</p>
            <p className="mt-1.5 text-xs text-subtle">{tile.sub}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function SalesFunnel({ revenue }: { revenue: Revenue }) {
  const max = Math.max(1, ...revenue.funnel.map((step) => step.count));
  const hidden = revenue.funnel.some((step) => step.fromPrevious?.smallSample && step.fromPrevious.denominator > 0);
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>From found to won</SectionTitle>
      <Card className="px-4 py-4 md:px-5">
        <ol className="flex flex-col gap-2.5">
          {revenue.funnel.map((step, index) => {
            const previous = index > 0 ? revenue.funnel[index - 1]! : null;
            const rate = step.fromPrevious;
            const tip = `${step.label}: ${step.count}${previous && rate?.value != null ? ` — ${Math.round(rate.value)}% of ${previous.label.toLowerCase()}` : ""}`;
            return (
              <li key={step.step} className="grid grid-cols-[6.5rem_1fr] items-center gap-3 sm:grid-cols-[9rem_1fr]" title={tip} aria-label={tip} tabIndex={0}>
                <span className="truncate text-sm text-muted">{step.label}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-3 shrink-0 rounded-r-[4px] bg-accent/80 transition-[width] duration-(--motion-fast) hover:bg-accent"
                    style={{ width: `${Math.max(step.count ? 1.5 : 0, (step.count / max) * 78)}%` }}
                  />
                  <span className="shrink-0 text-sm text-fg tabular">{step.count}</span>
                  {rate && rate.value !== null ? <span className="shrink-0 text-xs text-subtle tabular">{Math.round(rate.value)}%</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
        {hidden ? (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-subtle">
            <Info className="mt-px size-3.5 shrink-0" />
            A step's % of the step before is shown once that step has {RATE_MIN_SENT} or more businesses.
          </p>
        ) : null}
      </Card>
    </section>
  );
}

export function SalesCycle({ revenue }: { revenue: Revenue }) {
  const { channels } = revenue;
  return (
    <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <SectionTitle>How long it takes</SectionTitle>
        <Card className="divide-y divide-border">
          {revenue.timings.map((timing) => (
            <div key={timing.label} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
              <span className="text-sm text-muted">{timing.label}</span>
              {timing.medianDays === null ? (
                <span className="shrink-0 text-xs text-subtle tabular">{timing.sample ? `${timing.sample} so far · needs ${TIMING_MIN}` : "Not yet"}</span>
              ) : (
                <span className="shrink-0 text-sm text-fg tabular">
                  {formatDays(timing.medianDays)} <span className="text-xs text-subtle">typical, of {timing.sample}</span>
                </span>
              )}
            </div>
          ))}
        </Card>
      </div>
      <div className="flex flex-col gap-3">
        <SectionTitle>Where conversations come from</SectionTitle>
        <Card className="divide-y divide-border">
          {channels.map((row) => {
            const touch = row.channel === "email" ? "email" : "call";
            return (
              <div key={row.channel} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-fg">{row.channel === "email" ? "Email" : "Phone"}</span>
                  <span className="text-sm text-fg tabular">
                    {plural(row.conversations, "conversation")}
                    {row.won ? <span className="text-good"> · {row.won} won</span> : null}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted tabular">
                  {plural(row.contacted, "business", "businesses")} contacted · {plural(row.touches, touch)}
                  {row.conversationRate.value !== null ? ` · ${rateText(row.conversationRate)} led to a conversation` : ""}
                  {row.touchesPerConversation !== null ? ` · ${row.touchesPerConversation.toFixed(1)} ${touch}s per conversation` : ""}
                </p>
              </div>
            );
          })}
          <p className="px-4 py-2.5 text-xs text-subtle">
            A conversation is a reply from a person, or a call where they were interested or booked a meeting — credited to whichever came first.
          </p>
        </Card>
      </div>
    </section>
  );
}

export function RevenueSegments({ revenue, by }: { revenue: Revenue; by: "trade" | "town" | "angle" }) {
  if (by === "angle") {
    if (!revenue.angles.length) return <Card className="px-4 py-5 text-sm text-muted">No emails with an angle have been sent yet.</Card>;
    return (
      <Card className="divide-y divide-border">
        {revenue.angles.map((row) => (
          <div key={row.angle} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <span className="truncate text-sm text-fg">{ANGLE_LABEL[row.angle as Angle] ?? row.angle}</span>
            <span className="text-xs text-muted tabular">
              {row.sent} sent · {plural(row.replies, "reply", "replies")} · {row.positive} positive · reply rate{" "}
              <span className={row.replyRate.value === null ? "text-subtle" : "text-fg"}>{rateText(row.replyRate)}</span>
            </span>
          </div>
        ))}
      </Card>
    );
  }
  const rows = by === "trade" ? revenue.trades : revenue.towns;
  if (!rows.length) return <Card className="px-4 py-5 text-sm text-muted">Nothing to compare yet.</Card>;
  return <SegmentRows rows={rows.slice(0, 25)} />;
}

function SegmentRows({ rows }: { rows: Segment[] }) {
  const columns: { label: string; cell: (row: Segment) => string; dim?: (row: Segment) => boolean }[] = [
    { label: "Found", cell: (row) => String(row.found) },
    { label: "Contacted", cell: (row) => String(row.contacted) },
    { label: "Conversations", cell: (row) => String(row.conversations) },
    { label: "Rate", cell: (row) => rateText(row.conversationRate), dim: (row) => row.conversationRate.value === null },
    { label: "Won", cell: (row) => String(row.won) },
    { label: "£ won", cell: (row) => (row.wonPence ? formatPence(row.wonPence) : "—") },
  ];
  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-subtle">
              <th className="px-4 py-2.5 font-medium">Name</th>
              {columns.map((column) => (
                <th key={column.label} className="px-3 py-2.5 text-right font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.name} className="hover:bg-surface-2">
                <td className="max-w-56 truncate px-4 py-2.5 text-fg">{row.name}</td>
                {columns.map((column) => (
                  <td key={column.label} className={cn("px-3 py-2.5 text-right tabular", column.dim?.(row) ? "text-subtle" : "text-muted")}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <Card key={row.name} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="truncate font-medium">{row.name}</p>
              {row.wonPence ? <span className="shrink-0 text-sm text-good tabular">{formatPence(row.wonPence)}</span> : null}
            </div>
            <p className="mt-1 text-sm text-muted tabular">
              {row.found} found · {row.contacted} contacted · {plural(row.conversations, "conversation")}
              {row.conversationRate.value !== null ? ` (${rateText(row.conversationRate)})` : ""}
              {row.won ? ` · ${row.won} won` : ""}
            </p>
          </Card>
        ))}
      </div>
    </>
  );
}

/** How often each source and trade search gave you a business you kept, from your own marks. */
export function ProspectQuality({ bySource, byTrade }: { bySource: QualityRow[]; byTrade: QualityRow[] }) {
  if (!bySource.length) {
    return (
      <Card className="px-4 py-4 text-sm text-muted">
        Mark businesses as good or not on their page — "not actually in this trade", "wrong business" and so on. Once a source or a trade search has{" "}
        {FEEDBACK_MIN} marks, Find ranks it by what you said.
      </Card>
    );
  }
  const rows = (items: QualityRow[], label: (key: string) => string) =>
    items.slice(0, 8).map((row) => (
      <div key={row.key} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
        <span className="min-w-0 truncate text-sm text-fg">{label(row.key)}</span>
        <span className="shrink-0 text-xs text-muted tabular">
          {row.good} good · {row.rejected} rejected
          {row.rejectedRate.value !== null ? <span className={row.rejectedRate.value >= 60 ? "text-warn" : ""}> · {Math.round(row.rejectedRate.value)}% rejected</span> : <span className="text-subtle"> · needs {FEEDBACK_MIN}</span>}
        </span>
      </div>
    ));
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Card className="divide-y divide-border">
        <p className="px-4 py-2.5 text-xs font-medium text-subtle">By source</p>
        {rows(bySource, (key) => SOURCE_LABEL[key as keyof typeof SOURCE_LABEL] ?? key)}
      </Card>
      <Card className="divide-y divide-border">
        <p className="px-4 py-2.5 text-xs font-medium text-subtle">By trade searched</p>
        {rows(byTrade, (key) => key)}
      </Card>
    </div>
  );
}
