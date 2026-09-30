import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, History, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";
import { WithState } from "@/components/app/setup-gate";
import { Badge, Card, EmptyState, LoadingPage, Notice, PageHeader } from "@/components/app/ui";
import { funnelHeadline, parseFunnel } from "@/lib/outreach/run-funnel";
import { runDuration } from "@/lib/outreach/runs";
import { listRuns } from "@/lib/outreach/server";
import { cn } from "@/lib/utils";
import { statusTone } from "@/components/app/format";

export function RunsPage() {
  return (
    <Page wide>
      <WithState>{() => <Runs />}</WithState>
    </Page>
  );
}

type Runs = Extract<Awaited<ReturnType<typeof listRuns>>, { ok: true }>["runs"];

function Runs() {
  const [runs, setRuns] = useState<Runs | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void listRuns()
      .then((result) => (result.ok ? setRuns(result.runs) : setError(result.error)))
      .catch(() => setError("Could not load run history."));
  }, []);
  if (error) return <Notice tone="bad" title={error} />;
  if (!runs) return <LoadingPage />;
  return (
    <>
      <PageHeader
        eyebrow="Run history"
        title="Previous runs"
        description="Every Find run, what it asked for and where every business went. Open one to see its prospects and what has happened to them since."
      />
      {runs.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="No runs yet"
          action={
            <Link to="/find">
              <Button>
                <Search />
                Find & reach prospects
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {runs.map((run) => {
            const funnel = parseFunnel(run.funnel);
            const headline = funnel ? funnelHeadline(funnel) : null;
            const numbers = headline
              ? headline.filter((_, index) => [0, 1, 3, 4, 5, 6].includes(index))
              : [
                  { label: "Found", value: run.found },
                  { label: "Qualified", value: run.qualified },
                  { label: "Emails found", value: run.emailsFound },
                  { label: "Prepared", value: run.prepared },
                  { label: "Sent", value: run.sent },
                ];
            return (
              <Link key={run.id} to="/runs/$runId" params={{ runId: run.id }} className="group block">
                <Card className="p-4 transition-shadow group-hover:shadow-(--shadow-border-hover) md:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium tracking-widest text-subtle uppercase">
                        {new Date(run.startedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                        {run.target ? ` · ${run.target} requested` : ""}
                      </p>
                      <h3 className="mt-1 truncate font-medium">
                        {run.businessType || "Run"} · {run.location}
                      </h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      {runDuration(run.startedAt, run.finishedAt) ? (
                        <span className="text-xs text-subtle">{runDuration(run.startedAt, run.finishedAt)}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-y-3 sm:grid-cols-6">
                    {numbers.map((item, index) => (
                      <div key={item.label} className={cn(index > 0 ? "sm:border-l sm:border-border sm:pl-3" : "")}>
                        <p className="font-display text-lg leading-none tabular">{item.value}</p>
                        <p className="mt-1 truncate text-[11px] text-muted">{item.label}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 flex items-center gap-1 text-sm text-muted group-hover:text-fg">
                    View run <ArrowRight className="size-3.5" />
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
