import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Page } from "@/components/app/app-shell";
import { WithState } from "@/components/app/setup-gate";
import { Card, PageHeader, SectionTitle, Segmented, Stat } from "@/components/app/ui";
import {
  formatRate,
  outreachOverview,
  RATE_MIN_SENT,
  segmentsByCampaign,
  segmentsByTown,
  segmentsByTrade,
  whereToSearchNext,
  type Rate,
  type Segment,
} from "@/lib/outreach/analytics";
import type { OutreachState } from "@/lib/outreach/server";
import { cn } from "@/lib/utils";

export function AnalyticsPage() {
  return (
    <Page wide>
      <WithState>{(state) => <Analytics state={state} />}</WithState>
    </Page>
  );
}

function rateText(rate: Rate): string {
  if (rate.value === null) return rate.denominator === 0 ? "—" : `${rate.numerator}/${rate.denominator}`;
  return `${Math.round(rate.value)}%`;
}

function Analytics({ state }: { state: OutreachState }) {
  const [by, setBy] = useState<"campaign" | "trade" | "town">("campaign");
  const overview = useMemo(() => outreachOverview(state.leads, state.emails), [state.leads, state.emails]);
  const segments = useMemo(() => {
    const emails = state.emails.filter((email) => email.kind !== ("test" as never));
    if (by === "campaign") return segmentsByCampaign(state.leads, emails, state.campaigns, state.campaignMembers);
    if (by === "trade") return segmentsByTrade(state.leads, emails);
    return segmentsByTown(state.leads, emails);
  }, [by, state]);
  const next = useMemo(
    () => whereToSearchNext(segmentsByTown(state.leads, state.emails), segmentsByTrade(state.leads, state.emails)),
    [state.leads, state.emails],
  );
  const sentLeads = new Set(state.emails.filter((email) => ["sent", "replied", "bounced"].includes(email.status)).map((email) => email.leadId)).size;
  const funnel = [
    { label: "Prospects found", value: overview.prospects },
    { label: "Real website opportunities", value: overview.qualified },
    { label: "Verified public emails", value: overview.emailsFound },
    { label: "Emails written", value: overview.emailsPrepared },
    { label: "Emailed", value: sentLeads },
    { label: "Replied", value: overview.replies },
    { label: "Interested", value: overview.interested },
    { label: "Booked", value: overview.booked },
    { label: "Won", value: overview.won },
  ];
  const max = Math.max(1, ...funnel.map((step) => step.value));
  const small = overview.replyRate.smallSample;

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="What is working"
        description="Every number is a count of prospects and emails that exist. Rates are only shown once there are enough emails for them to mean something."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Emails sent" value={overview.emailsSent} sub={`${sentLeads} businesses`} />
        <Stat label="Replies" value={overview.replies} sub={overview.autoReplies ? `+${overview.autoReplies} out-of-office, not counted` : undefined} />
        <Stat label="Reply rate" value={rateText(overview.replyRate)} sub={small ? `Needs ${RATE_MIN_SENT}+ emailed to show a rate` : `${overview.replyRate.numerator} of ${overview.replyRate.denominator}`} />
        <Stat label="Booked" value={overview.booked} sub={overview.bookedRate.value !== null ? `${rateText(overview.bookedRate)} of emailed` : undefined} />
        <Stat label="Delivery failures" value={overview.deliveryFailures} tone={overview.deliveryFailures ? "bad" : "neutral"} sub="Bounced or rejected" />
      </div>

      {small && overview.emailsSent > 0 ? (
        <p className="flex items-start gap-2 text-sm text-muted">
          <Info className="mt-0.5 size-4 shrink-0" />
          Only {overview.replyRate.denominator} emailed so far. A percentage from so few is noise, so rates stay hidden until {RATE_MIN_SENT} have gone
          out — the counts are exact.
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionTitle>Funnel</SectionTitle>
        <Card className="px-4 py-4 md:px-5">
          <ol className="flex flex-col gap-2.5">
            {funnel.map((step, index) => {
              const previous = index > 0 ? funnel[index - 1]!.value : 0;
              const conversion = index > 0 && previous > 0 ? Math.round((step.value / previous) * 100) : null;
              const width = (step.value / max) * 100;
              const tip = `${step.label}: ${step.value}${conversion !== null ? ` (${conversion}% of ${funnel[index - 1]!.label.toLowerCase()})` : ""}`;
              return (
                <li key={step.label} className="grid grid-cols-[minmax(0,9.5rem)_1fr] items-center gap-3 sm:grid-cols-[minmax(0,13rem)_1fr]" title={tip} aria-label={tip} tabIndex={0}>
                  <span className="truncate text-sm text-muted">{step.label}</span>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-3 rounded-r-[4px] bg-accent/80 transition-[width] duration-(--motion-fast) hover:bg-accent"
                      style={{ width: `${Math.max(step.value ? 1.5 : 0, width * 0.82)}%` }}
                    />
                    <span className="shrink-0 text-sm text-fg tabular">{step.value}</span>
                    {conversion !== null && previous >= RATE_MIN_SENT ? <span className="shrink-0 text-xs text-subtle tabular">{conversion}%</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Performance by {by}</SectionTitle>
        {next ? <p className="text-sm text-fg">{next}</p> : null}
        <Segmented
          label="Group by"
          value={by}
          onChange={setBy}
          options={[
            { id: "campaign", label: "Campaign" },
            { id: "trade", label: "Trade" },
            { id: "town", label: "Town" },
          ]}
        />
        {segments.length === 0 ? (
          <Card className="px-4 py-5 text-sm text-muted">Nothing to compare yet.</Card>
        ) : (
          <SegmentTable segments={segments} />
        )}
      </section>
    </>
  );
}

function SegmentTable({ segments }: { segments: Segment[] }) {
  const columns: { key: keyof Segment | "rate"; label: string }[] = [
    { key: "prospects", label: "Prospects" },
    { key: "withEmail", label: "Emails" },
    { key: "sent", label: "Sent" },
    { key: "replies", label: "Replies" },
    { key: "rate", label: "Reply rate" },
    { key: "interested", label: "Interested" },
    { key: "booked", label: "Booked" },
    { key: "won", label: "Won" },
    { key: "failed", label: "Failed" },
  ];
  const cell = (segment: Segment, key: (typeof columns)[number]["key"]) =>
    key === "rate" ? formatRate(segment.replyRate) : String(segment[key as keyof Segment] ?? 0);
  return (
    <>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-subtle">
              <th className="px-4 py-2.5 font-medium">Name</th>
              {columns.map((column) => (
                <th key={column.key} className="px-3 py-2.5 text-right font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {segments.slice(0, 50).map((segment) => (
              <tr key={segment.name} className="hover:bg-surface-2">
                <td className="max-w-56 truncate px-4 py-2.5 text-fg">{segment.name}</td>
                {columns.map((column) => (
                  <td key={column.key} className={cn("px-3 py-2.5 text-right tabular", column.key === "rate" && segment.replyRate === null ? "text-subtle" : "text-muted")}>
                    {cell(segment, column.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="flex flex-col gap-2 md:hidden">
        {segments.slice(0, 50).map((segment) => (
          <Card key={segment.name} className="px-4 py-3">
            <p className="truncate font-medium">{segment.name}</p>
            <p className="mt-1 text-sm text-muted tabular">
              {segment.prospects} prospects · {segment.sent} sent · {segment.replies} replies · rate {formatRate(segment.replyRate)}
            </p>
            {(segment.interested ?? 0) + (segment.booked ?? 0) + (segment.won ?? 0) > 0 ? (
              <p className="text-sm text-muted tabular">
                {segment.interested} interested · {segment.booked} booked · {segment.won} won
              </p>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
