import { useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OutreachActions } from "@/components/outreach/outreach-panel";
import {
  FILTER_LABELS,
  OUTREACH_FILTERS,
  matchesFilter,
  REASON_LABELS,
  type Eligibility,
  type OutreachFilter,
} from "@/lib/outreach/eligibility";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachLead } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

/**
 * Who is worth writing to, and writing to them.
 *
 * The list is already ordered by opportunity, so the top of it is where to
 * start. Selecting is bulk by design — nobody should tick a hundred boxes — but
 * generating never sends anything: every draft goes to Review first.
 */
export function OutreachProspects({
  state,
  eligible,
  busy,
  actions,
}: {
  state: OutreachState;
  eligible: { lead: OutreachLead; eligibility: Eligibility }[];
  busy: string;
  actions: OutreachActions;
}) {
  const [filter, setFilter] = useState<OutreachFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState(state.settings.defaultMode);

  const rows = useMemo(
    () =>
      eligible
        .filter((entry) => matchesFilter(entry.lead, entry.eligibility, filter))
        .sort((a, b) => {
          const rank = { High: 0, Medium: 1, Low: 2 };
          const byBand = rank[a.eligibility.band] - rank[b.eligibility.band];
          return byBand !== 0 ? byBand : b.eligibility.score - a.eligibility.score;
        }),
    [eligible, filter],
  );

  /** Leads that already have a draft, so the list can say so. */
  const drafted = useMemo(() => {
    const map = new Map<string, string>();
    for (const email of state.emails) {
      if (email.kind === "initial" && (email.status === "draft" || email.status === "approved" || email.status === "queued")) {
        map.set(email.leadId, email.status);
      }
    }
    return map;
  }, [state.emails]);

  const selectable = rows.filter((entry) => entry.eligibility.eligible);
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

  const counts = {
    high: eligible.filter((entry) => entry.eligibility.band === "High" && entry.eligibility.eligible).length,
    medium: eligible.filter((entry) => entry.eligibility.band === "Medium" && entry.eligibility.eligible).length,
    review: eligible.filter((entry) => !entry.eligibility.eligible && entry.eligibility.manualReview).length,
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-xl font-medium">
          {selectable.length} ready to email
        </h3>
        <p className="mt-1 text-sm text-muted">
          {counts.high} high · {counts.medium} medium
          {counts.review > 0 ? ` · ${counts.review} held for review` : ""}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {OUTREACH_FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={cn(
              "h-9 rounded-full px-3 text-xs font-medium transition-colors duration-(--motion-quick)",
              filter === id ? "bg-accent text-accent-fg" : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
            )}
          >
            {FILTER_LABELS[id]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSelected(new Set(selectable.filter((e) => e.eligibility.band === "High").map((e) => e.lead.id)))}
        >
          Select high
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

      {rows.length === 0 ? (
        <div className="rounded-xl bg-surface px-5 py-12 text-center shadow-(--shadow-border)">
          <p className="font-medium">Nobody matches that</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            A lead becomes eligible once it has a public email found on the site, a real website
            opportunity, and has not been contacted or ruled out.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ lead, eligibility }) => {
            const draft = drafted.get(lead.id);
            const held = !eligibility.eligible;
            return (
              <li
                key={lead.id}
                className={cn(
                  "lead-card",
                  eligibility.band === "High" && "lead-card-hot",
                  eligibility.band === "Medium" && "lead-card-warm",
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
                          eligibility.band === "High" && "bg-hot/15 text-hot",
                          eligibility.band === "Medium" && "bg-warm-lead/15 text-warm-lead",
                          eligibility.band === "Low" && "bg-surface-2 text-cold-lead",
                        )}
                      >
                        {eligibility.band} {eligibility.score}
                      </span>
                      {draft ? (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                          {draft === "draft" ? "Drafted" : draft === "approved" ? "Approved" : "Queued"}
                        </span>
                      ) : null}
                      {held ? (
                        <span className="rounded-full bg-warm-lead/15 px-2 py-0.5 text-xs text-warm-lead">
                          {REASON_LABELS[eligibility.reasons[0]] ?? "Held"}
                        </span>
                      ) : null}
                    </div>
                    <h4 className="mt-2 leading-snug font-medium">{lead.businessName}</h4>
                    <p className="text-sm text-muted">
                      {[lead.trade, lead.town].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-1 truncate text-sm text-muted">{lead.email}</p>
                    <p className="mt-1 text-sm text-subtle">
                      {lead.websiteStatus || "Website unknown"}
                      {lead.websiteQuality ? ` · ${lead.websiteQuality}` : ""}
                      {lead.emailConfidence ? ` · ${lead.emailConfidence} confidence` : ""}
                    </p>
                    {held ? (
                      <p className="mt-2 text-xs text-subtle">
                        Held because it looks like a sole trader or a personal mailbox. Check it, then email
                        by hand if you are happy to.
                      </p>
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
