/**
 * The website opportunity audit for one business — a sales tool, not a
 * technical report. It leads with the few measured findings worth raising,
 * then the detail by area, every line with where and when it was measured.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, CircleCheck, CircleDot, ExternalLink, Info, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";
import { Badge, Card, EmptyState, LoadingPage, Notice, PageHeader, SectionTitle } from "@/components/app/ui";
import { auditWebsite, getWebsiteAudit } from "@/lib/audit/server";
import {
  AUDIT_CATEGORIES,
  CATEGORY_LABEL,
  dateLabel,
  freshness,
  OPPORTUNITY_LABEL,
  type AuditCategory,
  type Finding,
} from "@/lib/audit/findings";
import { WEBSITE_STATE_LABEL, websiteVerification } from "@/lib/audit/website-state";
import type { WebsiteAudit } from "@/lib/audit/run.server";
import type { WebsiteEvidenceRecord } from "@/lib/outreach/evidence-record";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";

type Loaded = Extract<Awaited<ReturnType<typeof getWebsiteAudit>>, { success: true }>;

export function AuditPage() {
  return (
    <Page>
      <Audit />
    </Page>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  homepage: "Homepage",
  http: "HTTP check",
  pagespeed: "Google PageSpeed",
  "robots.txt": "robots.txt",
  sitemap: "Sitemap",
  "link-check": "Link check",
};

function Audit() {
  const { leadId } = useParams({ from: "/_app/businesses/$leadId/audit" });
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [auditId, setAuditId] = useState("");

  const load = useCallback(
    async (id = "") => {
      try {
        const result = await getWebsiteAudit({ data: { leadId, auditId: id } });
        if (result.success) {
          setData(result);
          setError("");
        } else setError(result.error);
      } catch (cause) {
        setError(friendlyServerError(cause));
      }
    },
    [leadId],
  );
  useEffect(() => {
    void load(auditId);
  }, [load, auditId]);

  const run = async () => {
    setRunning(true);
    try {
      const result = await auditWebsite({ data: { leadId } });
      if (!result.success) return void toast(result.error);
      if (result.reused) toast("Audited in the last few minutes — showing that one.");
      setAuditId("");
      await load("");
    } catch (cause) {
      toast(friendlyServerError(cause));
    } finally {
      setRunning(false);
    }
  };

  const audit = useMemo<WebsiteAudit | null>(() => (data?.audit ? (JSON.parse(data.audit) as WebsiteAudit) : null), [data]);
  const evidence = useMemo<WebsiteEvidenceRecord | null>(() => (data?.websiteEvidence ? (JSON.parse(data.websiteEvidence) as WebsiteEvidenceRecord) : null), [data]);

  if (error) return <Notice tone="bad" title={error} />;
  if (!data) return <LoadingPage />;
  const { lead } = data;
  const verification = websiteVerification(
    lead,
    evidence,
    audit ? { status: audit.status, httpStatus: audit.httpStatus, finishedAt: audit.finishedAt, url: audit.url } : null,
  );
  const auditable = ["WEBSITE_FOUND", "WEBSITE_NOT_CONFIRMED", "WEBSITE_UNREACHABLE"].includes(verification.state) && Boolean(lead.website.trim());

  return (
    <>
      <Link to="/prospects" className="inline-flex items-center gap-1 self-start text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Prospects
      </Link>
      <PageHeader
        eyebrow="Website audit"
        title={lead.businessName || "Unnamed business"}
        description={[lead.trade, lead.town].filter(Boolean).join(" · ")}
        actions={
          auditable ? (
            <Button variant={audit ? "secondary" : "default"} disabled={running} onClick={() => void run()}>
              {running ? <Loader2 className="animate-spin" /> : audit ? <RefreshCw /> : <Search />}
              {running ? "Auditing… up to a minute" : audit ? "Audit again" : "Audit website"}
            </Button>
          ) : null
        }
      />

      <Card as="section" className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={verification.state === "WEBSITE_FOUND" ? "good" : verification.state === "VERIFIED_NO_WEBSITE" ? "info" : "warn"}>
            {WEBSITE_STATE_LABEL[verification.state]}
          </Badge>
          {lead.website ? (
            <a
              href={/^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
            >
              {lead.website.replace(/^https?:\/\//i, "").replace(/\/$/, "")} <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
        <ul className="flex flex-col gap-1 text-sm text-muted">
          {verification.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {verification.search && verification.search.rejections.length > 0 ? (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Sites the search rejected</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {verification.search.rejections.map((entry) => (
                <li key={entry.url} className="break-all">
                  {entry.url} — {entry.why}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      {!auditable ? (
        <EmptyState icon={<Info />} title="Nothing to audit">
          {verification.state === "VERIFIED_NO_WEBSITE"
            ? "A search found no independent website — that is the opportunity."
            : "There is no independent website on record. Find their website first (email discovery searches for it)."}
        </EmptyState>
      ) : !audit ? (
        <EmptyState icon={<Search />} title="Not audited yet">
          The audit loads the homepage, checks the basics a customer would notice, and asks Google PageSpeed how it performs on a phone. Every
          finding is a measurement with a date — never an opinion.
        </EmptyState>
      ) : (
        <AuditBody audit={audit} lead={lead} />
      )}

      {data.history.length > 1 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Earlier audits</SectionTitle>
          <Card as="div" className="divide-y divide-border">
            {data.history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setAuditId(entry.id)}
                className={cn("flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-surface-2", audit?.id === entry.id ? "font-medium" : "")}
              >
                <span>{dateLabel(entry.finishedAt)}</span>
                <span className="text-muted">
                  {entry.opportunity === "unmeasured" ? "Not measured" : OPPORTUNITY_LABEL[entry.opportunity as keyof typeof OPPORTUNITY_LABEL]}
                  {entry.performance !== null ? ` · mobile ${entry.performance}` : ""}
                </span>
              </button>
            ))}
          </Card>
        </section>
      ) : null}
    </>
  );
}

export function AuditBody({ audit, lead }: { audit: WebsiteAudit; lead: Loaded["lead"] }) {
  const age = freshness(audit.finishedAt);
  const byCategory = useMemo(() => {
    const map = new Map<AuditCategory, Finding[]>();
    for (const finding of audit.findings) {
      const list = map.get(finding.category) ?? [];
      list.push(finding);
      map.set(finding.category, list);
    }
    const order: Record<Finding["status"], number> = { opportunity: 0, info: 1, ok: 2 };
    for (const list of map.values()) list.sort((a, b) => order[a.status] - order[b.status] || b.impact - a.impact);
    return map;
  }, [audit]);
  const psi = audit.pagespeed;

  return (
    <>
      <Card as="section" className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={audit.opportunity === "strong" ? "good" : audit.opportunity === "moderate" ? "info" : "neutral"}>
            {audit.opportunity === "unmeasured" ? "Could not be measured" : OPPORTUNITY_LABEL[audit.opportunity]}
          </Badge>
          <Badge tone={age === "fresh" ? "neutral" : "warn"}>
            {age === "fresh" ? "Measured" : age === "aging" ? "Aging — measured" : "Stale — measured"} {dateLabel(audit.finishedAt)}
          </Badge>
        </div>
        {audit.error ? <p className="text-sm text-warn">{audit.error}</p> : null}
        {audit.pagespeedError ? <p className="text-xs text-muted">Google PageSpeed: {audit.pagespeedError}</p> : null}
      </Card>

      {audit.keyFindings.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Key opportunities</SectionTitle>
          <div className="flex flex-col gap-2">
            {audit.keyFindings.map((finding) => (
              <Card key={`${finding.kind}-${finding.evidence}`} as="article" className="p-4">
                <p className="font-medium">{finding.title}</p>
                <p className="mt-1 text-sm">{finding.evidence}</p>
                {finding.why ? <p className="mt-1 text-sm text-muted">Why it matters: {finding.why}</p> : null}
                <p className="mt-2 text-xs text-subtle">
                  {SOURCE_LABEL[finding.source] ?? finding.source} · {dateLabel(finding.observedAt)}
                  {finding.confidence !== "high" ? ` · ${finding.confidence} confidence` : ""}
                </p>
              </Card>
            ))}
          </div>
        </section>
      ) : (
        <Notice tone="good" title="No measured problems worth raising">
          The checks found nothing a customer would notice. This business is probably not a website prospect.
        </Notice>
      )}

      {psi ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>On a phone — Google PageSpeed, {dateLabel(psi.fetchedAt)}</SectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ["Performance", psi.performance],
                ["Accessibility", psi.accessibility],
                ["SEO basics", psi.seo],
                ["Best practices", psi.bestPractices],
              ] as const
            ).map(([label, value]) => (
              <Card key={label} as="div" className="p-3">
                <p className="text-xs text-muted">{label}</p>
                <p className="mt-1 font-display text-2xl tabular">{value ?? "—"}</p>
                <p className="text-xs text-subtle">{value === null ? "not measured" : value >= 90 ? "good" : value >= 50 ? "needs work" : "poor"} · out of 100</p>
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted">
            {psi.field
              ? `Real Chrome users: main content in ${psi.field.lcpMs != null ? `${(psi.field.lcpMs / 1000).toFixed(1)} s` : "—"}${psi.field.inpMs != null ? `, taps answered in ${Math.round(psi.field.inpMs)} ms` : ""}.`
              : `One simulated mobile load: main content in ${psi.lab.lcpMs != null ? `${(psi.lab.lcpMs / 1000).toFixed(1)} s` : "—"}. Google has too little real-user data for this site.`}{" "}
            Scores vary by a few points between runs.
          </p>
        </section>
      ) : null}

      {AUDIT_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => (
        <section key={category} className="flex flex-col gap-2">
          <SectionTitle>{category === "performance" ? "Mobile & speed" : CATEGORY_LABEL[category]}</SectionTitle>
          <Card as="div" className="divide-y divide-border">
            {category === "trust" && typeof lead.reviews === "number" && lead.reviews > 0 ? (
              <FindingRow
                finding={{
                  kind: "listing_reviews",
                  category: "trust",
                  status: "info",
                  impact: 0,
                  title: "Reviews on their listing",
                  evidence: `${lead.reviews} review${lead.reviews === 1 ? "" : "s"}${typeof lead.rating === "number" ? ` averaging ${lead.rating}` : ""} on the listing they were found through.`,
                  why: "",
                  value: String(lead.reviews),
                  source: "homepage",
                  url: "",
                  observedAt: lead.foundAt,
                  confidence: "medium",
                }}
                sourceOverride={`${lead.source || "Listing"}`}
              />
            ) : null}
            {byCategory.get(category)!.map((finding) => (
              <FindingRow key={`${finding.kind}-${finding.evidence}`} finding={finding} />
            ))}
          </Card>
        </section>
      ))}
    </>
  );
}

function FindingRow({ finding, sourceOverride }: { finding: Finding; sourceOverride?: string }) {
  const Icon = finding.status === "ok" ? CircleCheck : finding.status === "opportunity" ? CircleDot : Info;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", finding.status === "ok" ? "text-good" : finding.status === "opportunity" ? "text-warn" : "text-subtle")}
        aria-label={finding.status === "ok" ? "Passed" : finding.status === "opportunity" ? "Opportunity" : "Information"}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">{finding.title}</p>
        <p className="text-sm text-muted">{finding.evidence}</p>
        <p className="mt-0.5 text-xs text-subtle">
          {sourceOverride ?? SOURCE_LABEL[finding.source] ?? finding.source}
          {finding.observedAt ? ` · ${dateLabel(finding.observedAt)}` : ""}
          {finding.confidence !== "high" ? ` · ${finding.confidence} confidence` : ""}
        </p>
      </div>
    </div>
  );
}
