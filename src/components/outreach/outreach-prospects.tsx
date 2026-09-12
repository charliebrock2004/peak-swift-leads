import { useEffect, useMemo, useState } from "react";
import { Loader2, Phone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OutreachActions } from "@/components/outreach/outreach-panel";
import { REASON_LABELS, type Eligibility } from "@/lib/outreach/eligibility";
import {
  decideProspect,
  matchesProspectFilter,
  PROSPECT_FILTER_LABELS,
  PROSPECT_FILTERS,
  type ProspectFilter,
} from "@/lib/decision";
import { getReviewQueue, recordLeadReview } from "@/lib/outreach/server";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachLead } from "@/lib/outreach/types";
import { phoneHref } from "@/lib/leads";
import { cn } from "@/lib/utils";
import {
  ANY,
  NO_REFINEMENT,
  campaignsByLead,
  isRefined,
  matchesRefinement,
  refinementCount,
  refinementOptions,
  stagesByLead,
  type Refinement,
} from "@/lib/outreach/prospect-filters";
import { STAGE_LABELS } from "@/lib/outreach/lifecycle";

/**
 * Who is worth writing to, ringing, or looking at.
 *
 * The list is already ordered by the sales decision, so the top of it is where
 * to start. Selecting is bulk by design, but generating never sends anything:
 * every draft goes to Review first.
 */
export function OutreachProspects({
  state,
  rows,
  busy,
  actions,
  filter,
  onFilter,
}: {
  state: OutreachState;
  rows: { lead: OutreachLead; eligibility: Eligibility }[];
  busy: string;
  actions: OutreachActions;
  filter: ProspectFilter;
  onFilter: (filter: ProspectFilter) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState(state.settings.defaultMode);
  const [query, setQuery] = useState("");
  const [reviews, setReviews] = useState<Map<string, string>>(new Map());
  const [reviewBusy, setReviewBusy] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [refinement, setRefinement] = useState<Refinement>(NO_REFINEMENT);

  useEffect(() => {
    let cancelled = false;
    void getReviewQueue().then((result) => {
      if (cancelled || !result.success) return;
      const next = new Map<string, string>();
      for (const row of result.queue) next.set(row.id, "pending");
      setReviews(next);
    });
    return () => {
      cancelled = true;
    };
  }, [state.leads.length]);

  const drafted = useMemo(() => {
    const map = new Map<string, string>();
    for (const email of state.emails) {
      if (email.kind === "initial" && (email.status === "draft" || email.status === "approved" || email.status === "queued")) {
        map.set(email.leadId, email.status);
      }
    }
    return map;
  }, [state.emails]);

  const needle = query.trim().toLowerCase();

  /**
   * Stages and campaign membership for the whole list, computed once.
   *
   * Doing this per row inside the filter would re-scan every email for every
   * prospect on every keystroke.
   */
  const context = useMemo(() => {
    const decisions = new Map(
      state.leads.map((lead) => {
        const decision = decideProspect(lead as OutreachLead);
        return [lead.id, { level: decision.level, reviewRequired: decision.reviewRequired }] as const;
      }),
    );
    return {
      stages: stagesByLead(state.leads, state.emails, decisions),
      campaigns: campaignsByLead(state.campaignMembers),
    };
  }, [state.leads, state.emails, state.campaignMembers]);

  const options = useMemo(
    () => refinementOptions(state.leads, (lead) => context.stages.get(lead.id) ?? "DISCOVERED"),
    [state.leads, context.stages],
  );

  const visible = useMemo(() => {
    const rank = { HOT: 0, WARM: 1, CALL: 2, LOW: 3, SKIP: 4 };
    return rows
      .filter((entry) => matchesProspectFilter(entry.lead, entry.eligibility, filter))
      .filter((entry) =>
        matchesRefinement(entry.lead, refinement, {
          stage: context.stages.get(entry.lead.id) ?? "DISCOVERED",
          campaigns: context.campaigns.get(entry.lead.id) ?? EMPTY_SET,
        }),
      )
      .filter((entry) => {
        if (!needle) return true;
        const hay = [
          entry.lead.businessName,
          entry.lead.trade,
          entry.lead.town,
          entry.lead.phone,
          entry.lead.email,
          entry.lead.website,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => {
        const da = decideProspect(a.lead);
        const db = decideProspect(b.lead);
        const byLevel = rank[da.level] - rank[db.level];
        if (byLevel !== 0) return byLevel;
        return db.score - da.score;
      });
  }, [rows, filter, needle, refinement, context]);

  const selectable = visible.filter((entry) => entry.eligibility.eligible);
  const chosen = [...selected].filter((id) => selectable.some((entry) => entry.lead.id === id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    if (chosen.length === 0) return;
    await actions.generate(chosen, mode);
    setSelected(new Set());
  }

  async function review(leadId: string, decision: "approved" | "skipped" | "investigate") {
    setReviewBusy(leadId);
    setReviewError("");
    const result = await recordLeadReview({ data: { leadId, decision } });
    setReviewBusy("");
    if (result.success) {
      setReviews((current) => {
        const next = new Map(current);
        next.set(leadId, decision);
        return next;
      });
    } else {
      setReviewError(result.error);
    }
  }

  const counts = {
    hot: rows.filter((entry) => decideProspect(entry.lead).level === "HOT").length,
    warm: rows.filter((entry) => decideProspect(entry.lead).level === "WARM").length,
    call: rows.filter((entry) => decideProspect(entry.lead).level === "CALL").length,
    review: rows.filter((entry) => decideProspect(entry.lead).reviewRequired && decideProspect(entry.lead).level !== "SKIP").length,
  };

  const reviewQueue = visible.filter((entry) => {
    const decision = decideProspect(entry.lead);
    return decision.reviewRequired && decision.level !== "SKIP" && (reviews.get(entry.lead.id) ?? "pending") === "pending";
  });

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-xl font-medium">{visible.length} prospects</h3>
        <p className="mt-1 text-sm text-muted">
          {counts.hot} HOT · {counts.warm} WARM · {counts.call} CALL
          {counts.review > 0 ? ` · ${counts.review} need a look` : ""}
        </p>
      </div>

      <Input
        className="h-11"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search name, trade, town, phone, email"
        aria-label="Search prospects"
      />

      <div className="flex flex-wrap gap-2">
        {PROSPECT_FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onFilter(id)}
            className={cn(
              "h-9 rounded-full px-3 text-xs font-medium transition-colors duration-(--motion-quick)",
              filter === id ? "bg-accent text-accent-fg" : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
            )}
          >
            {PROSPECT_FILTER_LABELS[id]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Refine
          label="Campaign"
          value={refinement.campaign}
          onChange={(value) => setRefinement((current) => ({ ...current, campaign: value }))}
          options={state.campaigns.map((campaign) => ({
            value: campaign.id,
            label: campaign.name || "Untitled",
          }))}
        />
        <Refine
          label="Stage"
          value={refinement.stage}
          onChange={(value) => setRefinement((current) => ({ ...current, stage: value }))}
          options={options.stages.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }))}
        />
        <Refine
          label="Town"
          value={refinement.town}
          onChange={(value) => setRefinement((current) => ({ ...current, town: value }))}
          options={options.towns.map((town) => ({ value: town, label: town }))}
        />
        <Refine
          label="Trade"
          value={refinement.trade}
          onChange={(value) => setRefinement((current) => ({ ...current, trade: value }))}
          options={options.trades.map((trade) => ({ value: trade, label: trade }))}
        />
        <Refine
          label="Score"
          value={refinement.band}
          onChange={(value) => setRefinement((current) => ({ ...current, band: value }))}
          options={["High", "Medium", "Low"].map((band) => ({ value: band, label: band }))}
        />
        <Refine
          label="Website"
          value={refinement.websiteStatus}
          onChange={(value) => setRefinement((current) => ({ ...current, websiteStatus: value }))}
          options={options.websiteStatuses.map((status) => ({ value: status, label: status }))}
        />
        <Refine
          label="Email"
          value={refinement.emailConfidence}
          onChange={(value) => setRefinement((current) => ({ ...current, emailConfidence: value }))}
          options={options.confidences.map((level) => ({
            value: level,
            label: level === "none" ? "No email" : level,
          }))}
        />
        {isRefined(refinement) ? (
          <button
            type="button"
            className="h-9 text-xs text-muted underline hover:text-fg"
            onClick={() => setRefinement(NO_REFINEMENT)}
          >
            Clear {refinementCount(refinement)}
          </button>
        ) : null}
      </div>

      {filter === "review" || reviewQueue.length > 0 ? (
        <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
          <p className="text-sm font-medium">
            {reviewQueue.length} prospect{reviewQueue.length === 1 ? "" : "s"} need a look
          </p>
          <p className="mt-1 text-sm text-muted">
            Uncertain verdicts stay here instead of being emailed or skipped automatically.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSelected(new Set(selectable.filter((e) => decideProspect(e.lead).level === "HOT").map((e) => e.lead.id)))}
        >
          Select HOT
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setSelected(new Set(selectable.map((e) => e.lead.id)))}>
          Select all shown
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
          Clear
        </Button>
        <label className="ml-auto flex h-9 items-center gap-2 rounded-md bg-surface px-2.5 text-xs shadow-(--shadow-border)">
          <span className="text-muted">Write with</span>
          <select
            className="bg-transparent text-xs outline-none"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            aria-label="How to write the emails"
          >
            <option value="ai">{state.aiAvailable ? "AI personalised" : "AI (not configured)"}</option>
            {state.templates
              .filter((template) => !template.kind.startsWith("follow-up"))
              .map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {reviewError ? <p className="text-sm text-hot">{reviewError}</p> : null}

      {visible.length === 0 ? (
        <div className="rounded-xl bg-surface px-5 py-12 text-center shadow-(--shadow-border)">
          <p className="font-medium">Nobody matches that</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            Try another filter, or run Find leads / AI Outreach to bring more businesses in.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map(({ lead, eligibility }) => {
            const decision = decideProspect(lead);
            const draft = drafted.get(lead.id);
            const held = !eligibility.eligible;
            const reviewState = reviews.get(lead.id);
            const tel = phoneHref(lead.phone);
            return (
              <li
                key={lead.id}
                className={cn(
                  "lead-card",
                  decision.level === "HOT" && "lead-card-hot",
                  decision.level === "WARM" && "lead-card-warm",
                )}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0"
                    checked={selected.has(lead.id)}
                    disabled={held}
                    onChange={() => toggle(lead.id)}
                    aria-label={`Select ${lead.businessName}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          decision.level === "HOT" && "bg-hot/15 text-hot",
                          decision.level === "WARM" && "bg-warm-lead/15 text-warm-lead",
                          decision.level === "CALL" && "bg-accent/15 text-accent",
                          decision.level === "LOW" && "bg-surface-2 text-cold-lead",
                          decision.level === "SKIP" && "bg-surface-2 text-subtle",
                        )}
                      >
                        {decision.level} {decision.score}
                      </span>
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                        {decision.websiteGrade}
                      </span>
                      {draft ? (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                          {draft === "draft" ? "Drafted" : draft === "approved" ? "Approved" : "Queued"}
                        </span>
                      ) : null}
                      {held && decision.level !== "CALL" ? (
                        <span className="rounded-full bg-warm-lead/15 px-2 py-0.5 text-xs text-warm-lead">
                          {REASON_LABELS[eligibility.reasons[0]] ?? "Held"}
                        </span>
                      ) : null}
                    </div>
                    <h4 className="mt-2 leading-snug font-medium">{lead.businessName}</h4>
                    <p className="text-sm text-muted">
                      {[lead.trade, lead.town].filter(Boolean).join(" · ")}
                    </p>
                    {lead.email ? (
                      <p className="mt-1 truncate text-sm text-muted">{lead.email}</p>
                    ) : tel ? (
                      <a
                        href={tel}
                        className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-accent underline-offset-4 hover:underline"
                      >
                        <Phone className="size-3.5" />
                        {lead.phone}
                      </a>
                    ) : null}
                    <p className="mt-1 text-sm text-subtle">
                      {decision.reasons[0]}
                      {decision.confidence ? ` · ${decision.confidence}% confidence` : ""}
                    </p>
                    {decision.evidence[0] ? (
                      <p className="mt-1 text-xs text-subtle">{decision.evidence[0]}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted">Next: {decision.nextAction}</p>

                    {decision.reviewRequired && decision.level !== "SKIP" && reviewState !== "approved" && reviewState !== "skipped" ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={reviewBusy === lead.id}
                          onClick={() => void review(lead.id, "approved")}
                        >
                          {reviewBusy === lead.id ? <Loader2 className="animate-spin" /> : null}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reviewBusy === lead.id}
                          onClick={() => void review(lead.id, "investigate")}
                        >
                          Investigate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={reviewBusy === lead.id}
                          onClick={() => void review(lead.id, "skipped")}
                        >
                          Skip
                        </Button>
                      </div>
                    ) : reviewState && reviewState !== "pending" ? (
                      <p className="mt-2 text-xs text-subtle">Review: {reviewState}</p>
                    ) : null}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {chosen.length > 0 ? (
        <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface px-4 py-3 md:-mx-6 md:px-6">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
            <p className="min-w-0 flex-1 text-sm">
              <strong className="font-medium">{chosen.length}</strong> selected
            </p>
            <Button className="h-11" disabled={busy !== ""} onClick={() => void generate()}>
              {busy === "generate" ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Write {chosen.length} email{chosen.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Nothing, shared so an unmembered prospect does not allocate a set per render. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * One narrowing control.
 *
 * A native select rather than another row of chips: seven of these as chips
 * would bury the HOT / WARM / CALL row that people actually reach for, and a
 * select stays one line however many towns the sheet has.
 */
function Refine({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-9 rounded-full border-0 px-3 text-xs font-medium",
          value === ANY ? "bg-surface text-muted shadow-(--shadow-border)" : "bg-accent text-accent-fg",
        )}
        aria-label={label}
      >
        <option value={ANY}>{label}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
