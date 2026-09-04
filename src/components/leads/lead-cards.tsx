import { useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  MapPin,
  Monitor,
  Pencil,
  Phone,
  Trash2,
} from "lucide-react";
import { PriorityBadge } from "@/components/leads/priority-badge";
import { WebsiteStatusBadge } from "@/components/leads/website-status";
import {
  CALL_RESULT_OPTIONS,
  callOutcomePatch,
  computePriority,
  formatRating,
  isFollowUpDue,
  mapsHref,
  phoneHref,
  priorityReason,
  resolveWebsiteStatus,
  websiteActionLabel,
  websiteHref,
  type CallResult,
  type Lead,
} from "@/lib/leads";
import { cn } from "@/lib/utils";

/** Short chip labels — the full option names are too long for a phone row. */
const OUTCOME_LABELS: Record<Exclude<CallResult, "">, string> = {
  "No Answer": "No answer",
  Callback: "Callback",
  Interested: "Interested",
  "Not Interested": "Not now",
  "Wrong Number": "Wrong no.",
  Booked: "Booked",
};

function formatDate(iso: string): string {
  if (!iso) return "";
  const at = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * One lead, built for a phone in one hand.
 *
 * Call is the biggest target on the card. Underneath it is the whole outcome in
 * a single tap — the six results as chips that set called status, result and a
 * sensible follow-up date together, so nothing has to be typed between calls.
 * Everything else (date, notes, links, edit, delete) stays folded away until
 * asked for.
 */
export function LeadCards({
  leads,
  onChange,
  onEdit,
  onDelete,
}: {
  leads: Lead[];
  onChange: (id: string, patch: Partial<Lead>) => void;
  onEdit: (lead: Lead) => void;
  onDelete: (lead: Lead) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-2">
      {leads.map((lead) => {
        const priority = computePriority(lead);
        const tel = phoneHref(lead.phone);
        const maps = mapsHref(lead);
        const site = websiteHref(lead.website);
        const demo = websiteHref(lead.demoUrl);
        const due = isFollowUpDue(lead);
        const status = resolveWebsiteStatus(lead);
        const expanded = expandedId === lead.id;
        const meta = [
          lead.trade,
          lead.town,
          lead.rating !== "" ? `${formatRating(lead.rating)}★` : null,
          lead.reviews !== "" ? `${lead.reviews} reviews` : null,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <li
            key={lead.id}
            className={cn(
              "lead-card",
              priority === "HOT" && "lead-card-hot",
              priority === "WARM" && "lead-card-warm",
            )}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={priority} />
              <WebsiteStatusBadge status={status} />
              {due ? (
                <span className="rounded-full bg-hot/15 px-2 py-0.5 text-xs font-medium text-hot">
                  Due {formatDate(lead.followUpDate)}
                </span>
              ) : null}
            </div>

            <h2 className="mt-2 leading-snug font-medium">
              {lead.businessName || "Untitled lead"}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{meta || "No trade or town"}</p>

            <div className="mt-3 flex gap-2">
              {tel ? (
                <a
                  href={tel}
                  className="inline-flex h-13 flex-1 items-center justify-center gap-2 rounded-md bg-accent text-base font-medium text-accent-fg active:scale-[0.98]"
                >
                  <Phone className="size-4" />
                  Call
                </a>
              ) : (
                <span className="inline-flex h-13 flex-1 items-center justify-center rounded-md bg-surface-2 text-sm text-subtle">
                  No phone
                </span>
              )}
              {maps ? (
                <a
                  href={maps}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${lead.businessName || "lead"} in Maps`}
                  className="inline-flex size-13 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg active:scale-[0.98]"
                >
                  <MapPin className="size-5" />
                </a>
              ) : null}
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? "Hide details" : "Show details"}
                onClick={() => setExpandedId(expanded ? null : lead.id)}
                className="inline-flex size-13 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted active:scale-[0.98]"
              >
                <ChevronDown className={cn("size-5 transition-transform", expanded && "rotate-180")} />
              </button>
            </div>

            <fieldset className="mt-3">
              <legend className="mb-1.5 text-xs font-medium text-muted">
                {lead.callResult ? "Result" : "How did it go?"}
              </legend>
              <div className="grid grid-cols-3 gap-1.5">
                {CALL_RESULT_OPTIONS.map((option) => {
                  const active = lead.callResult === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        onChange(
                          lead.id,
                          active
                            ? { called: "Not Called", callResult: "" }
                            : callOutcomePatch(option, lead),
                        )
                      }
                      className={cn(
                        "h-11 rounded-md px-1 text-xs font-medium transition-colors duration-(--motion-quick) active:scale-[0.97]",
                        active
                          ? "bg-accent text-accent-fg"
                          : "bg-surface-2 text-muted hover:text-fg",
                      )}
                    >
                      {OUTCOME_LABELS[option]}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {expanded ? (
              <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                <p className="text-sm text-muted">{priorityReason(lead)}</p>
                <p className="text-sm tabular-nums text-muted">{lead.phone || "No phone number"}</p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">Follow up on</span>
                  <input
                    type="date"
                    className={cn(
                      "h-11 rounded-md bg-bg px-3 text-sm text-fg shadow-(--shadow-border) outline-none",
                      due && "text-hot",
                    )}
                    value={lead.followUpDate}
                    onChange={(event) => onChange(lead.id, { followUpDate: event.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">Notes</span>
                  <textarea
                    rows={3}
                    className="w-full resize-y rounded-md bg-bg px-3 py-2 text-sm text-fg shadow-(--shadow-border) outline-none placeholder:text-subtle"
                    value={lead.notes}
                    onChange={(event) => onChange(lead.id, { notes: event.target.value })}
                    placeholder="Who you spoke to, what they said"
                  />
                </label>

                {site || demo ? (
                  <div className="flex gap-2">
                    {site ? (
                      <a
                        href={site}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-surface-2 text-sm font-medium text-fg"
                      >
                        <ExternalLink className="size-4" />
                        {websiteActionLabel(lead.website, status)}
                      </a>
                    ) : null}
                    {demo ? (
                      <a
                        href={demo}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-surface-2 text-sm font-medium text-fg"
                      >
                        <Monitor className="size-4" />
                        Their demo
                      </a>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex gap-2">
                  <button
                    type="button"
                    className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-surface-2 text-sm font-medium text-fg"
                    onClick={() => onEdit(lead)}
                  >
                    <Pencil className="size-4" />
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${lead.businessName || "lead"}`}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted hover:text-hot"
                    onClick={() => onDelete(lead)}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            ) : (
              (lead.followUpDate || lead.notes) && (
                <p className="mt-2 truncate text-sm text-muted">
                  {lead.followUpDate ? `Follow up ${formatDate(lead.followUpDate)}` : null}
                  {lead.followUpDate && lead.notes ? " · " : null}
                  {lead.notes}
                </p>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}
