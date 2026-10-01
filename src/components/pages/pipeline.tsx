import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronRight } from "lucide-react";
import { Page } from "@/components/app/app-shell";
import { Card, EmptyState, Notice, PageHeader, Segmented, Skeleton } from "@/components/app/ui";
import { relativeTime } from "@/components/app/format";
import { formatPence } from "@/lib/sales/pipeline";
import { getPipeline } from "@/lib/sales/server";
import { STAGE_LABEL, type Stage, type Task } from "@/lib/sales/types";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";

type Row = {
  leadId: string;
  businessName: string;
  trade: string;
  town: string;
  phone: string;
  stage: Stage;
  valuePence: number | null;
  stageChangedAt: string;
  wonDate: string;
  band: string;
  lastTouch: string;
  lastSummary: string;
  nextTask: Task | null;
};
type Totals = { quotedPence: number; wonThisMonthPence: number; wonPence: number; openCount: number; openPence: number; byStage: Record<Stage, { count: number; pence: number }> };

const OPEN: Stage[] = ["CONTACTED", "CONVERSATION", "MEETING", "QUOTE_SENT"];
const CLOSED: Stage[] = ["WON", "NURTURE", "LOST"];

/**
 * The pipeline: every business you have actually spoken to, by where the sale
 * stands. Not a CRM — just enough to see what is in play and what it is worth.
 * Columns on a wide screen; one stage at a time on a phone.
 */
export function PipelinePage() {
  const [data, setData] = useState<{ rows: Row[]; totals: Totals } | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<Stage>("CONVERSATION");

  const load = useCallback(async () => {
    try {
      const reply = await getPipeline();
      if (!reply.ok) return setError(reply.error);
      setData(JSON.parse(reply.json) as { rows: Row[]; totals: Totals });
      setError("");
    } catch (failure) {
      setError(friendlyServerError(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const byStage = useMemo(() => {
    const map = new Map<Stage, Row[]>();
    for (const row of data?.rows ?? []) map.set(row.stage, [...(map.get(row.stage) ?? []), row]);
    for (const list of map.values()) list.sort((a, b) => (b.valuePence ?? 0) - (a.valuePence ?? 0) || b.lastTouch.localeCompare(a.lastTouch));
    return map;
  }, [data]);

  return (
    <Page wide>
      <PageHeader eyebrow="Pipeline" title="Where every sale stands" description="Moves forward on its own as you email, call and hear back. Quotes, wins and losses are yours to set — on the business's page." />
      {error ? <Notice tone="bad" title="Could not load the pipeline">{error}</Notice> : null}
      {!data ? (
        <Skeleton className="h-64" />
      ) : data.rows.length === 0 ? (
        <EmptyState title="Nothing in play yet" action={<Link to="/" className="text-sm text-accent">Back to Today</Link>}>
          Once you email or call a prospect, they appear here.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Total label="in play" value={formatPence(data.totals.openPence) || "£0"} sub={`${data.totals.openCount} open`} />
            <Total label="quoted" value={formatPence(data.totals.quotedPence) || "£0"} sub={`${data.totals.byStage.QUOTE_SENT.count} ${data.totals.byStage.QUOTE_SENT.count === 1 ? "quote" : "quotes"} out`} />
            <Total label="won this month" value={formatPence(data.totals.wonThisMonthPence) || "£0"} sub={`${data.totals.byStage.WON.count} won in total`} tone="good" />
          </div>

          {/* Phone: one stage at a time. */}
          <div className="flex flex-col gap-3 md:hidden">
            <Segmented
              label="Stage"
              value={stage}
              onChange={setStage}
              options={([...OPEN, "WON"] as Stage[]).map((value) => ({ id: value, label: STAGE_LABEL[value], count: byStage.get(value)?.length ?? 0 }))}
            />
            <StageList rows={byStage.get(stage) ?? []} />
          </div>

          {/* Wide: the whole board. */}
          <div className="hidden gap-3 md:grid md:grid-cols-4">
            {OPEN.map((value) => (
              <section key={value} className="flex min-w-0 flex-col gap-2">
                <header className="flex items-baseline justify-between px-1">
                  <h2 className="text-sm font-medium">{STAGE_LABEL[value]}</h2>
                  <span className="text-xs text-muted tabular">
                    {byStage.get(value)?.length ?? 0}
                    {data.totals.byStage[value].pence ? ` · ${formatPence(data.totals.byStage[value].pence)}` : ""}
                  </span>
                </header>
                <StageList rows={byStage.get(value) ?? []} />
              </section>
            ))}
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-sm font-medium">Closed</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {CLOSED.map((value) => (
                <details key={value} className="rounded-xl bg-surface shadow-(--shadow-border)" open={value === "WON" && (byStage.get(value)?.length ?? 0) > 0}>
                  <summary className="flex cursor-pointer items-baseline justify-between px-4 py-3 text-sm">
                    <span className="font-medium">{STAGE_LABEL[value]}</span>
                    <span className="text-muted tabular">
                      {byStage.get(value)?.length ?? 0}
                      {data.totals.byStage[value].pence ? ` · ${formatPence(data.totals.byStage[value].pence)}` : ""}
                    </span>
                  </summary>
                  <div className="px-2 pb-2">
                    <StageList rows={byStage.get(value) ?? []} flat />
                  </div>
                </details>
              ))}
            </div>
          </section>
        </>
      )}
    </Page>
  );
}

function Total({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "good" }) {
  return (
    <Card className="px-3 py-3">
      <p className={cn("font-display text-xl font-medium tabular md:text-2xl", tone === "good" ? "text-good" : "")}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-[11px] text-subtle">{sub}</p>
    </Card>
  );
}

function StageList({ rows, flat = false }: { rows: Row[]; flat?: boolean }) {
  if (rows.length === 0) return <p className={cn("px-3 py-4 text-sm text-subtle", flat ? "" : "rounded-xl border border-dashed border-border text-center")}>None</p>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.leadId}>
          <Link to="/businesses/$leadId" params={{ leadId: row.leadId }} className={cn("group flex items-start gap-2 rounded-xl px-3 py-2.5", flat ? "hover:bg-surface-2" : "bg-surface shadow-(--shadow-border) hover:shadow-(--shadow-border-hover)")}>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{row.businessName}</span>
                {row.valuePence != null ? <span className="shrink-0 text-sm tabular">{formatPence(row.valuePence)}</span> : null}
              </span>
              <span className="block truncate text-xs text-muted">{[row.trade, row.town].filter(Boolean).join(" · ")}</span>
              {row.nextTask ? (
                <span className="mt-1 flex items-center gap-1 text-xs text-fg">
                  <CalendarClock className="size-3 shrink-0" />
                  <span className="truncate">{row.nextTask.title}</span>
                </span>
              ) : row.lastTouch ? (
                <span className="mt-1 block truncate text-xs text-subtle">{row.lastSummary || "Last contact"} · {relativeTime(row.lastTouch)}</span>
              ) : null}
            </span>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-subtle group-hover:text-fg" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
