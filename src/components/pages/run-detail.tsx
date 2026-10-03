import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck, TriangleAlert } from "lucide-react";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { Badge, Card, LoadingPage, Notice, PageHeader, ScoreBadge, SectionTitle, Stat } from "@/components/app/ui";
import { FunnelDetail, LedgerDetail } from "@/components/pages/find";
import { parseLedger, reconcileLedger } from "@/lib/discovery-ledger";
import type { RunDiagnosis } from "@/lib/run-diagnosis";
import { statusTone } from "@/components/app/format";
import { scoreProspect } from "@/lib/scoring/prospect-score";
import { lifecycleOf, STAGE_LABELS } from "@/lib/outreach/lifecycle";
import { funnelHeadline, parseFunnel, reconcileFunnel } from "@/lib/outreach/run-funnel";
import { runDuration } from "@/lib/outreach/runs";
import { getRunDetail } from "@/lib/outreach/server";
import { useAppData } from "@/components/app/app-data";
import { plural } from "@/components/app/format";

export function RunDetailPage() {
  return (
    <Page wide>
      <WithState>{() => <RunDetail />}</WithState>
    </Page>
  );
}

type Detail = Extract<Awaited<ReturnType<typeof getRunDetail>>, { ok: true }>;

function RunDetail() {
  const { runId } = useParams({ from: "/_app/runs/$runId" });
  const { state } = useAppData();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void getRunDetail({ data: { id: runId } })
      .then((result) => (result.ok ? setDetail(result) : setError(result.error)))
      .catch(() => setError("Could not load that run."));
  }, [runId]);

  const since = useMemo(() => {
    if (!detail) return null;
    const emails = detail.emails.filter((email) => email.kind !== ("test" as never));
    const leads = detail.leads;
    return {
      written: emails.length,
      sent: emails.filter((email) => ["sent", "replied", "bounced"].includes(email.status)).length,
      awaiting: emails.filter((email) => ["draft", "approved", "queued"].includes(email.status)).length,
      replies: emails.filter((email) => email.status === "replied").length,
      bounced: emails.filter((email) => email.status === "bounced").length,
      interested: leads.filter((lead) => lead.callResult === "Interested" || lead.called === "Interested").length,
      booked: leads.filter((lead) => lead.callResult === "Booked").length,
      won: leads.filter((lead) => lead.callResult === "Won").length,
    };
  }, [detail]);

  if (error) return <Notice tone="bad" title={error} />;
  if (!detail || !since) return <LoadingPage />;
  const { run } = detail;
  const funnel = parseFunnel(run.funnel);
  const stored = (() => {
    try {
      return JSON.parse(run.funnel || "{}") as { ledger?: unknown; diagnosis?: RunDiagnosis | null };
    } catch {
      return {};
    }
  })();
  const ledger = parseLedger(stored.ledger);
  const diagnosis = stored.diagnosis ?? null;
  // Runs recorded before every listing had an outcome cannot be checked against the ledger's equations.
  const problems = funnel && ledger ? [...reconcileFunnel(funnel), ...reconcileLedger(ledger)] : [];
  const campaign = state?.campaigns.find((item) => item.id === run.campaignId);

  return (
    <>
      <Link to="/runs" className="flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Run history
      </Link>
      <PageHeader
        eyebrow={new Date(run.startedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
        title={`${run.businessType || "Run"} · ${run.location}`}
        description={run.summary}
        actions={<Badge tone={statusTone(run.status)}>{run.status}</Badge>}
      />
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
        {run.target ? <span>{run.target} prospects requested</span> : null}
        {run.dailyLimit ? <span>{run.dailyLimit} emails a day</span> : null}
        {runDuration(run.startedAt, run.finishedAt) ? <span>Took {runDuration(run.startedAt, run.finishedAt)}</span> : null}
        {campaign ? (
          <Link to="/campaigns" className="hover:text-fg">
            Campaign: {campaign.name}
          </Link>
        ) : null}
      </div>

      {funnel ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {funnelHeadline(funnel).map((item) => (
              <Stat key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
          {diagnosis ? (
            <Notice tone="warn" title={diagnosis.headline}>
              {diagnosis.details.join(" ")}
            </Notice>
          ) : null}
          {!ledger ? (
            <p className="text-sm text-muted">Recorded before every listing was given an outcome — the discovery numbers below are as that version counted them.</p>
          ) : problems.length ? (
            <Notice tone="bad" title="These numbers do not add up">
              {problems.join(" · ")}
            </Notice>
          ) : (
            <p className="flex items-center gap-1.5 text-sm text-good">
              <CircleCheck className="size-4" /> Every number reconciles — every listing has exactly one outcome.
            </p>
          )}
          {ledger && ledger.listings > 0 ? <LedgerDetail ledger={ledger} /> : null}
          <FunnelDetail funnel={funnel} />
        </>
      ) : (
        <Notice tone="info" title="Recorded before the full funnel was kept">
          {run.found} found · {run.qualified} qualified · {run.emailsFound} emails found · {run.prepared} prepared · {run.sent} sent
        </Notice>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle>Since this run</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Emails written" value={since.written} sub={since.awaiting ? `${since.awaiting} waiting to send` : undefined} to="/send" />
          <Stat label="Sent" value={since.sent} sub={since.bounced ? `${since.bounced} bounced` : undefined} />
          <Stat label="Replies" value={since.replies} to="/replies" />
          <Stat label="Interested · Booked · Won" value={`${since.interested} · ${since.booked} · ${since.won}`} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{plural(detail.leads.length, "prospect")} found by this run</SectionTitle>
        {detail.leads.length === 0 ? (
          <Card className="px-4 py-4 text-sm text-muted">
            {run.leadIds.length ? "These prospects have since been deleted from your sheet." : "This run did not record which prospects it found."}
          </Card>
        ) : (
          <Card as="div" className="divide-y divide-border">
            {detail.leads
              .map((lead) => ({ lead, scored: scoreProspect(lead) }))
              .sort((a, b) => b.scored.priority - a.scored.priority)
              .map(({ lead, scored }) => {
                const score = scored.priority;
                const emails = detail.emails.filter((email) => email.leadId === lead.id);
                const stage = lifecycleOf(lead, emails, scored);
                return (
                  <div key={lead.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{lead.businessName}</p>
                      <p className="truncate text-xs text-muted">
                        {[lead.trade, lead.town].filter(Boolean).join(" · ")} · {lead.email || (lead.phone ? `phone ${lead.phone}` : "no contact details")}
                      </p>
                    </div>
                    <Badge tone={["REPLIED", "INTERESTED", "BOOKED", "WON"].includes(stage) ? "good" : stage === "CALL" ? "info" : "neutral"}>
                      {STAGE_LABELS[stage]}
                    </Badge>
                    <ScoreBadge score={score} />
                  </div>
                );
              })}
          </Card>
        )}
        {run.status === "interrupted" ? (
          <p className="flex items-center gap-1.5 text-sm text-warn">
            <TriangleAlert className="size-4" /> This run stopped when its screen was closed. Everything it saved is kept.
          </p>
        ) : null}
      </section>
    </>
  );
}
