import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Page } from "@/components/app/app-shell";
import { WithState } from "@/components/app/setup-gate";
import { MoneySection, ProspectQuality, RevenueSegments, SalesCycle, SalesFunnel } from "@/components/app/revenue";
import { qualityBySource, qualityByTrade, rowsFromLeads } from "@/lib/feedback/quality";
import { profilePounds } from "@/lib/outreach/profile";
import { useRevenue } from "@/components/app/use-revenue";
import { whatWorksLine } from "@/lib/sales/revenue";
import { Card, InsightsTabs, PageHeader, SectionTitle, Segmented, Stat } from "@/components/app/ui";
import {
  formatRate,
  outreachOverview,
  RATE_MIN_SENT,
  segmentsByCampaign,
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
  const [by, setBy] = useState<"trade" | "town" | "angle" | "campaign">("trade");
  const { revenue, error } = useRevenue();
  const overview = useMemo(() => outreachOverview(state.leads, state.emails), [state.leads, state.emails]);
  const campaigns = useMemo(
    () => segmentsByCampaign(state.leads, state.emails.filter((email) => email.kind !== ("test" as never)), state.campaigns, state.campaignMembers),
    [state],
  );
  const next = useMemo(() => (revenue ? whatWorksLine(revenue.trades, revenue.towns) : ""), [revenue]);
  const sentLeads = new Set(state.emails.filter((email) => ["sent", "replied", "bounced"].includes(email.status)).map((email) => email.leadId)).size;
  const small = overview.replyRate.smallSample;
  const quality = useMemo(() => {
    const marks = rowsFromLeads(state.leads);
    return { bySource: qualityBySource(marks), byTrade: qualityByTrade(marks) };
  }, [state.leads]);

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="What PeakSwift is making you"
        description="Every number is counted from businesses, emails, calls and sales that exist. Rates and averages only appear once there are enough of them to mean something."
      />
      <InsightsTabs current="/analytics" />

      <MoneySection revenue={revenue} error={error} typicalPounds={profilePounds(state.profile.typicalProject)} />
      {revenue ? (
        <>
          <SalesFunnel revenue={revenue} />
          <SalesCycle revenue={revenue} />
        </>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionTitle>What works</SectionTitle>
        {next ? <p className="text-sm text-fg">{next}</p> : null}
        <Segmented
          label="Group by"
          value={by}
          onChange={setBy}
          options={[
            { id: "trade", label: "Trade" },
            { id: "town", label: "Town" },
            { id: "angle", label: "Email angle" },
            { id: "campaign", label: "Campaign" },
          ]}
        />
        {by === "campaign" ? (
          campaigns.length === 0 ? (
            <Card className="px-4 py-5 text-sm text-muted">No campaigns yet.</Card>
          ) : (
            <SegmentTable segments={campaigns} />
          )
        ) : revenue ? (
          <RevenueSegments revenue={revenue} by={by} />
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Prospect quality</SectionTitle>
        <ProspectQuality bySource={quality.bySource} byTrade={quality.byTrade} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>Email outreach</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Emails sent" value={overview.emailsSent} sub={`${sentLeads} businesses`} />
          <Stat label="Replies" value={overview.replies} sub={overview.autoReplies ? `+${overview.autoReplies} out-of-office, not counted` : undefined} />
          <Stat label="Reply rate" value={rateText(overview.replyRate)} sub={small ? `Needs ${RATE_MIN_SENT}+ emailed to show a rate` : `${overview.replyRate.numerator} of ${overview.replyRate.denominator}`} />
          <Stat label="Verified emails" value={overview.emailsFound} sub={`${overview.emailsPrepared} written`} />
          <Stat label="Delivery failures" value={overview.deliveryFailures} tone={overview.deliveryFailures ? "bad" : "neutral"} sub="Bounced or rejected" />
        </div>
        {small && overview.emailsSent > 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted">
            <Info className="mt-0.5 size-4 shrink-0" />
            Only {overview.replyRate.denominator} emailed so far. A percentage from so few is noise, so rates stay hidden until {RATE_MIN_SENT} have gone
            out — the counts are exact.
          </p>
        ) : null}
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
