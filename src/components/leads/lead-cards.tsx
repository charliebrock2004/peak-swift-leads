import { MapPin, Pencil, Phone, Trash2 } from "lucide-react";
import { PriorityBadge } from "@/components/leads/priority-badge";
import {
  CALLED_OPTIONS,
  computePriority,
  hasWebsite,
  isFollowUpDue,
  mapsHref,
  phoneHref,
  type CalledStatus,
  type Lead,
} from "@/lib/leads";
import { cn } from "@/lib/utils";

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
  return (
    <ul className="flex flex-col gap-2">
      {leads.map((lead) => {
        const priority = computePriority(lead);
        const tel = phoneHref(lead.phone);
        const maps = mapsHref(lead);
        const due = isFollowUpDue(lead);
        const noSite = !hasWebsite(lead.website);
        return (
          <li
            key={lead.id}
            className={cn(
              "lead-card",
              priority === "HOT" && "lead-card-hot",
              priority === "WARM" && "lead-card-warm",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <PriorityBadge priority={priority} />
                  {noSite ? <span className="text-xs text-hot">No website</span> : null}
                  {due ? <span className="text-xs text-hot">Follow-up due</span> : null}
                </div>
                <h2 className="mt-2 truncate font-medium leading-snug">
                  {lead.businessName || "Untitled lead"}
                </h2>
                <p className="mt-0.5 truncate text-sm text-muted">
                  {[lead.trade, lead.town].filter(Boolean).join(" · ") || "No trade or town"}
                </p>
                <p className="mt-1 text-sm tabular-nums text-muted">
                  {lead.rating !== "" ? `${lead.rating} rating` : "No rating"}
                  {" · "}
                  {lead.reviews !== "" ? `${lead.reviews} reviews` : "No reviews"}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                  onClick={() => onEdit(lead)}
                  aria-label={`Edit ${lead.businessName || "lead"}`}
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-hot"
                  onClick={() => onDelete(lead)}
                  aria-label={`Delete ${lead.businessName || "lead"}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {tel ? (
                <a
                  href={tel}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-surface-2 text-sm font-medium text-fg"
                >
                  <Phone className="size-4" />
                  Call
                </a>
              ) : (
                <span className="inline-flex h-11 items-center justify-center rounded-md bg-surface-2 text-sm text-subtle">
                  No phone
                </span>
              )}
              {maps ? (
                <a
                  href={maps}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-surface-2 text-sm font-medium text-fg"
                >
                  <MapPin className="size-4" />
                  Maps
                </a>
              ) : (
                <span className="inline-flex h-11 items-center justify-center rounded-md bg-surface-2 text-sm text-subtle">
                  No maps
                </span>
              )}
            </div>
            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Called?</span>
              <select
                className="h-11 rounded-md bg-bg px-3 text-sm text-fg shadow-(--shadow-border) outline-none"
                value={lead.called}
                onChange={(event) => onChange(lead.id, { called: event.target.value as CalledStatus })}
              >
                {CALLED_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            {lead.notes ? <p className="mt-2 line-clamp-2 text-sm text-muted">{lead.notes}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
