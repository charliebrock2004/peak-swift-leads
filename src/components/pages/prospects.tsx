import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2, PenLine, Search, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { Badge, Card, EmptyState, PageHeader, ScoreBadge, Segmented } from "@/components/app/ui";

import { BAND_LABEL, ACTION_LABEL } from "@/lib/scoring/prospect-score";
import { useScores } from "@/components/app/use-scores";
import { WhyThisProspect } from "@/components/app/prospect-facts";
import { checkEligibility, isWorthRinging } from "@/lib/outreach/eligibility";
import { lifecycleOf, STAGE_LABELS } from "@/lib/outreach/lifecycle";
import { blockedSentence } from "@/lib/outreach/block-reasons";
import { generateEmails, getReviewQueue, recordLeadReview, type OutreachState } from "@/lib/outreach/server";
import { checkCompanies } from "@/lib/contactability/server";
import { LegalFormBadge, LegalFormPanel } from "@/components/app/contactability";
import { OPPORTUNITY_LABEL } from "@/lib/audit/findings";
import type { OutreachLead } from "@/lib/outreach/types";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";
import { plural, websiteLine } from "@/components/app/format";

type Filter = "all" | "ready" | "email" | "call" | "needs-look" | "manual-review" | "emailed" | "replied" | "low";
type ReviewDecision = "approved" | "investigate" | "skipped";

export function ProspectsPage() {
  return (
    <Page wide>
      <WithState>{(state) => <Prospects state={state} />}</WithState>
    </Page>
  );
}

function Prospects({ state }: { state: OutreachState }) {
  const { context, reload } = useAppData();
  const scores = useScores(state);
  const search = useSearch({ from: "/_app/prospects" });
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>(
    (["all", "ready", "email", "call", "needs-look", "manual-review", "emailed", "replied", "low"].includes(search.filter ?? "") ? search.filter : "all") as Filter,
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [writing, setWriting] = useState("");
  const [limit, setLimit] = useState(60);
  const campaign = search.campaign ? state.campaigns.find((item) => item.id === search.campaign) : undefined;
  // Uncertain verdicts waiting on your call. Recording one is a note on the
  // prospect — it never makes anyone emailable that the rules would refuse.
  const [reviewQueue, setReviewQueue] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState("");
  useEffect(() => {
    let live = true;
    getReviewQueue()
      .then((result) => {
        if (live && result.success) setReviewQueue(new Set(result.queue.map((entry) => entry.id)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state.leads]);
  const review = async (leadId: string, name: string, decision: ReviewDecision) => {
    setReviewBusy(leadId);
    try {
      const result = await recordLeadReview({ data: { leadId, decision } });
      if (!result.success) {
        toast(result.error);
        return;
      }
      setReviewQueue((current) => {
        const next = new Set(current);
        next.delete(leadId);
        return next;
      });
      toast(`${name}: ${decision === "approved" ? "looks right" : decision === "investigate" ? "marked to investigate" : "skipped"}.`);
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setReviewBusy("");
    }
  };

  const rows = useMemo(() => {
    const members = campaign ? new Set(state.campaignMembers.filter((m) => m.campaignId === campaign.id).map((m) => m.leadId)) : null;
    const emailsByLead = new Map<string, typeof state.emails>();
    for (const email of state.emails) {
      const list = emailsByLead.get(email.leadId) ?? [];
      list.push(email);
      emailsByLead.set(email.leadId, list);
    }
    return (state.leads as OutreachLead[])
      .filter((lead) => !members || members.has(lead.id))
      .map((lead) => {
        const eligibility = context ? checkEligibility(lead, context) : null;
        const scored = scores.get(lead.id)!;
        const emails = emailsByLead.get(lead.id) ?? [];
        const stage = lifecycleOf(lead, emails, scored);
        const hasDraft = emails.some((email) => ["draft", "approved", "queued"].includes(email.status));
        return { lead, eligibility, stage, scored, score: scored.priority, hasDraft };
      })
      .sort((a, b) => b.score - a.score);
  }, [state, context, campaign, scores]);

  const matches = (row: (typeof rows)[number], which: Filter): boolean => {
    const eligible = row.eligibility?.eligible ?? false;
    switch (which) {
      case "ready":
        return eligible && !row.hasDraft;
      case "email":
        return Boolean(row.lead.email.trim()) && (row.lead.emailConfidence === "HIGH" || row.lead.emailConfidence === "MEDIUM");
      case "call":
        return row.eligibility ? isWorthRinging(row.lead, row.eligibility) : false;
      case "needs-look":
        return reviewQueue.has(row.lead.id);
      case "manual-review":
        return row.eligibility?.manualReview ?? false;
      case "emailed":
        return ["SENT", "REPLIED", "INTERESTED", "BOOKED", "WON"].includes(row.stage);
      case "replied":
        return ["REPLIED", "INTERESTED", "BOOKED", "WON"].includes(row.stage);
      case "low":
        return row.eligibility?.band === "Low";
      default:
        return true;
    }
  };

  const text = query.trim().toLowerCase();
  const filtered = rows.filter(
    (row) =>
      matches(row, filter) &&
      (!text || `${row.lead.businessName} ${row.lead.town} ${row.lead.trade} ${row.lead.email}`.toLowerCase().includes(text)),
  );
  const writable = filtered.filter((row) => row.eligibility?.eligible && !row.hasDraft);
  const chosen = writable.filter((row) => selected.has(row.lead.id));

  const write = async () => {
    const ids = chosen.map((row) => row.lead.id);
    let done = 0;
    let failed = 0;
    try {
      for (let at = 0; at < ids.length; at += 4) {
        setWriting(`Writing ${Math.min(at + 4, ids.length)} of ${ids.length}…`);
        const result = await generateEmails({
          data: { leadIds: ids.slice(at, at + 4), mode: state.settings.defaultMode || "ai", kind: "initial", campaignId: campaign?.id ?? "" },
        });
        if (!result.ok) {
          failed += Math.min(4, ids.length - at);
          continue;
        }
        done += result.rows.filter((row) => row.ok).length;
        failed += result.rows.filter((row) => !row.ok).length;
      }
      toast(`${plural(done, "email")} written${failed ? ` · ${failed} could not be written` : ""}. Review them before sending.`);
      await reload();
      setSelected(new Set());
      if (done > 0) void navigate({ to: "/send" });
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setWriting("");
    }
  };

  const count = (which: Filter) => rows.filter((row) => matches(row, which)).length;

  // Look up every held business on Companies House, a batch at a time, inside
  // the shared request budget. Only an exact local match is linked; anything
  // less is left for you to pick.
  const [checking, setChecking] = useState("");
  const checkHeld = async () => {
    const totals = { confirmed: 0, noMatch: 0, ambiguous: 0, errors: 0 };
    try {
      for (let round = 0; round < 5; round += 1) {
        setChecking(`Checking Companies House… ${totals.confirmed + totals.noMatch + totals.ambiguous} done`);
        const result = await checkCompanies({ data: { limit: 10 } });
        if (!result.success) {
          toast(result.error);
          break;
        }
        totals.confirmed += result.tally.confirmed;
        totals.noMatch += result.tally.noMatch;
        totals.ambiguous += result.tally.ambiguous;
        totals.errors += result.tally.errors;
        if (result.stopped) {
          toast(result.stopped);
          break;
        }
        if (result.tally.remaining === 0) break;
      }
      toast(
        `${plural(totals.confirmed, "company", "companies")} confirmed · ${totals.noMatch} not on the register · ${plural(totals.ambiguous, "needs", "need")} you to pick${totals.errors ? ` · ${totals.errors} failed` : ""}.`,
      );
      await reload();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setChecking("");
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Businesses"
        title={plural(rows.length, "business", "businesses")}
        description="Every business on your account, where it has got to, and whether it can be emailed — with the reason when it cannot. Open one for everything about it."
        actions={
          chosen.length ? (
            <Button disabled={Boolean(writing)} onClick={() => void write()}>
              {writing ? <Loader2 className="animate-spin" /> : <PenLine />}
              {writing || `Write ${plural(chosen.length, "email")}`}
            </Button>
          ) : (
            <Link to="/find">
              <Button>
                <Search /> Find prospects
              </Button>
            </Link>
          )
        }
      />
      {campaign ? (
        <div className="flex items-center gap-2">
          <Badge tone="info">Campaign: {campaign.name}</Badge>
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => void navigate({ to: "/prospects", search: {} })}>
            <X className="inline size-3.5" /> Show all
          </button>
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search business, town, trade, email…" className="h-11 pl-10" />
      </div>
      <Segmented
        label="Filter"
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setLimit(60);
        }}
        options={[
          { id: "all", label: "All", count: rows.length },
          { id: "ready", label: "Ready to write", count: count("ready") },
          { id: "email", label: "Verified email", count: count("email") },
          { id: "call", label: "To call", count: count("call") },
          { id: "needs-look", label: "Needs a look", count: count("needs-look") },
          { id: "manual-review", label: "Held for you", count: count("manual-review") },
          { id: "emailed", label: "Emailed", count: count("emailed") },
          { id: "replied", label: "Replied", count: count("replied") },
          { id: "low", label: "Low opportunity", count: count("low") },
        ]}
      />
      {filter === "needs-look" && count("needs-look") > 0 ? (
        <p className="text-sm text-muted">
          The checks were not sure about these. Say whether each looks right — it is recorded against the prospect, and the sending rules
          still apply either way.
        </p>
      ) : null}
      {filter === "manual-review" && count("manual-review") > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            A company may be emailed; a sole trader or partnership needs to have agreed first. These are not confirmed as companies, so they
            are held until Companies House (or you) confirms it — or you ring them instead.
          </p>
          <Button variant="secondary" className="shrink-0" disabled={Boolean(checking)} onClick={() => void checkHeld()}>
            {checking ? <Loader2 className="animate-spin" /> : <Search />}
            {checking || "Check them on Companies House"}
          </Button>
        </div>
      ) : null}
      {writable.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted">
          <span>{plural(writable.length, "prospect")} here can be emailed.</span>
          <span className="flex gap-3">
            <button type="button" className="hover:text-fg" onClick={() => setSelected(new Set(writable.map((row) => row.lead.id)))}>
              Select all
            </button>
            <button type="button" className="hover:text-fg" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </span>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState icon={<Users />} title="No prospects here">
          {rows.length === 0 ? "Run Find to discover your first prospects." : "Try another filter."}
        </EmptyState>
      ) : (
        <Card as="div" className="divide-y divide-border">
          {filtered.slice(0, limit).map((row) => {
            const canWrite = Boolean(row.eligibility?.eligible && !row.hasDraft);
            const reason =
              row.eligibility && !row.eligibility.eligible ? blockedSentence(row.eligibility.reasons[0] ?? "manual-review") : "";
            return (
              <label key={row.lead.id} className={cn("flex items-start gap-3 px-4 py-3", canWrite ? "cursor-pointer hover:bg-surface-2" : "")}>
                <input
                  type="checkbox"
                  className={cn("mt-1 size-5 shrink-0 accent-[var(--color-accent)]", canWrite ? "" : "invisible")}
                  disabled={!canWrite}
                  checked={selected.has(row.lead.id)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(row.lead.id)) next.delete(row.lead.id);
                      else next.add(row.lead.id);
                      return next;
                    })
                  }
                  aria-label={`Select ${row.lead.businessName}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link to="/businesses/$leadId" params={{ leadId: row.lead.id }} className="truncate font-medium hover:underline">
                      {row.lead.businessName || "Unnamed business"}
                    </Link>
                    <Badge tone={["REPLIED", "INTERESTED", "BOOKED", "WON"].includes(row.stage) ? "good" : row.stage === "CALL" ? "info" : "neutral"}>
                      {STAGE_LABELS[row.stage]}
                    </Badge>
                    {row.eligibility && !row.eligibility.manualReview ? <LegalFormBadge legal={row.eligibility.legal} /> : null}

                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted">
                    {[row.lead.trade, row.lead.town].filter(Boolean).join(" · ")} · {websiteLine(row.lead)}
                  </p>
                  {row.scored && !["SENT", "REPLIED", "INTERESTED", "BOOKED", "WON", "UNSUBSCRIBED"].includes(row.stage) ? (
                    <div className="mt-1.5 flex flex-col gap-1">
                      <p className="text-xs">
                        <span className="font-medium">{BAND_LABEL[row.scored.band]}</span>
                        <span className="text-muted"> · {ACTION_LABEL[row.scored.action]} — {row.scored.actionReason}</span>
                      </p>
                      {row.scored.action !== "SKIP" ? <WhyThisProspect lead={row.lead} score={row.scored} limit={3} /> : null}
                    </div>
                  ) : null}
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                    {row.lead.facts?.audit && row.lead.facts.audit.opportunity !== "unmeasured" ? (
                      <Badge tone={row.lead.facts.audit.opportunity === "strong" ? "good" : "neutral"}>
                        {OPPORTUNITY_LABEL[row.lead.facts.audit.opportunity]}
                      </Badge>
                    ) : null}
                    <Link
                      to="/businesses/$leadId/audit"
                      params={{ leadId: row.lead.id }}
                      className="text-muted underline-offset-2 hover:text-fg hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {row.lead.facts?.audit ? "Website audit" : row.lead.website ? "Audit website" : "Website check"}
                    </Link>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-subtle">
                    {row.lead.email ? `${row.lead.email} (${row.lead.emailConfidence || "unverified"})` : row.lead.phone ? `No public email · ${row.lead.phone}` : "No public email or phone"}
                  </p>
                  {reason && !row.hasDraft && ["ready", "email", "manual-review"].includes(filter) && !["SENT", "REPLIED", "INTERESTED", "BOOKED", "WON"].includes(row.stage) ? (
                    <p className="mt-0.5 text-xs text-warn">Not emailable — {reason}</p>
                  ) : null}
                  {row.eligibility?.manualReview ? (
                    <div className="mt-2">
                      <LegalFormPanel leadId={row.lead.id} businessName={row.lead.businessName} legal={row.eligibility.legal} onChanged={reload} />
                    </div>
                  ) : null}
                  {filter === "needs-look" && reviewQueue.has(row.lead.id) ? (
                    <span className="mt-2 flex flex-wrap gap-2">
                      {(
                        [
                          ["approved", "Looks right"],
                          ["investigate", "Investigate"],
                          ["skipped", "Skip"],
                        ] as const
                      ).map(([decision, label]) => (
                        <Button
                          key={decision}
                          size="sm"
                          variant={decision === "approved" ? "default" : decision === "investigate" ? "secondary" : "ghost"}
                          disabled={reviewBusy === row.lead.id}
                          onClick={(event) => {
                            event.preventDefault();
                            void review(row.lead.id, row.lead.businessName, decision);
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    </span>
                  ) : null}
                </div>
                <ScoreBadge score={row.score} />
              </label>
            );
          })}
        </Card>
      )}
      {filtered.length > limit ? (
        <Button variant="secondary" className="self-center" onClick={() => setLimit((value) => value + 100)}>
          Show more ({filtered.length - limit})
        </Button>
      ) : null}
    </>
  );
}
