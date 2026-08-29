import { ArrowDown, ArrowUp, ExternalLink, MapPin, Trash2 } from "lucide-react";
import { PriorityBadge } from "@/components/leads/priority-badge";
import {
  CALLED_OPTIONS,
  CALL_RESULT_OPTIONS,
  WEBSITE_STATUS_OPTIONS,
  computePriority,
  isFollowUpDue,
  mapsHref,
  parseNumberInput,
  formatRating,
  phoneHref,
  priorityReason,
  resolveWebsiteStatus,
  websiteHref,
  type CallResult,
  type CalledStatus,
  type Lead,
  type SortDir,
  type SortKey,
  type WebsiteStatus,
} from "@/lib/leads";
import { cn } from "@/lib/utils";

const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: "businessName", label: "Business name", width: "w-52 min-w-52" },
  { key: "trade", label: "Trade", width: "w-32 min-w-32" },
  { key: "town", label: "Town", width: "w-32 min-w-32" },
  { key: "phone", label: "Phone number", width: "w-40 min-w-40" },
  { key: "rating", label: "Google rating", width: "w-28 min-w-28" },
  { key: "reviews", label: "Reviews", width: "w-24 min-w-24" },
  { key: "website", label: "Website", width: "w-40 min-w-40" },
  { key: "websiteStatus", label: "Website status", width: "w-40 min-w-40" },
  { key: "priority", label: "Priority", width: "w-28 min-w-28" },
  { key: "called", label: "Called?", width: "w-36 min-w-36" },
  { key: "callResult", label: "Call result", width: "w-36 min-w-36" },
  { key: "followUpDate", label: "Follow-up date", width: "w-40 min-w-40" },
];

function SortHeader({
  column,
  sortKey,
  sortDir,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === column.key;
  return (
    <th className={column.width}>
      <button
        type="button"
        className="flex h-10 w-full items-center gap-1.5 px-3 text-left hover:text-fg"
        onClick={() => onSort(column.key)}
      >
        {column.label}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
      </button>
    </th>
  );
}

export function LeadTable({
  leads,
  sortKey,
  sortDir,
  onSort,
  onChange,
  onDelete,
}: {
  leads: Lead[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onChange: (id: string, patch: Partial<Lead>) => void;
  onDelete: (lead: Lead) => void;
}) {
  return (
    <div className="sheet-scroll h-full">
      <table className="sheet-table">
        <caption className="sr-only">Local business leads</caption>
        <thead>
          <tr>
            {COLUMNS.slice(0, 7).map((column) => (
              <SortHeader
                key={column.key}
                column={column}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
            ))}
            <th className="w-40 min-w-40">
              <span className="flex h-10 items-center px-3">Google Maps</span>
            </th>
            {COLUMNS.slice(7).map((column) => (
              <SortHeader
                key={column.key}
                column={column}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
            ))}
            <th className="w-64 min-w-64">
              <span className="flex h-10 items-center px-3">Notes</span>
            </th>
            <th className="w-12 min-w-12">
              <span className="sr-only">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const priority = computePriority(lead);
            const maps = mapsHref(lead);
            const site = websiteHref(lead.website);
            const tel = phoneHref(lead.phone);
            const due = isFollowUpDue(lead);
            const status = resolveWebsiteStatus(lead);
            return (
              <tr
                key={lead.id}
                className={cn(
                  priority === "HOT" ? "row-hot" : priority === "WARM" ? "row-warm" : "row-cold",
                )}
                title={priorityReason(lead)}
              >
                <td className="w-52 min-w-52">
                  <input
                    className="sheet-input font-medium"
                    value={lead.businessName}
                    onChange={(event) => onChange(lead.id, { businessName: event.target.value })}
                    aria-label="Business name"
                  />
                </td>
                <td className="w-32 min-w-32">
                  <input
                    className="sheet-input"
                    list="trade-list"
                    value={lead.trade}
                    onChange={(event) => onChange(lead.id, { trade: event.target.value })}
                    aria-label="Trade"
                  />
                </td>
                <td className="w-32 min-w-32">
                  <input
                    className="sheet-input"
                    list="town-list"
                    value={lead.town}
                    onChange={(event) => onChange(lead.id, { town: event.target.value })}
                    aria-label="Town"
                  />
                </td>
                <td className="w-40 min-w-40">
                  <div className="flex items-center">
                    <input
                      className="sheet-input tabular-nums"
                      value={lead.phone}
                      onChange={(event) => onChange(lead.id, { phone: event.target.value })}
                      aria-label="Phone number"
                    />
                    {tel ? (
                      <a href={tel} className="mr-2 text-xs font-medium text-muted hover:text-fg">
                        Call
                      </a>
                    ) : null}
                  </div>
                </td>
                <td className="w-28 min-w-28">
                  <input
                    className="sheet-input tabular-nums"
                    type="number"
                    min={0}
                    max={5}
                    step={0.1}
                    value={formatRating(lead.rating)}
                    onChange={(event) =>
                      onChange(lead.id, { rating: parseNumberInput(event.target.value, 1) })
                    }
                    aria-label="Google rating"
                  />
                </td>
                <td className="w-24 min-w-24">
                  <input
                    className="sheet-input tabular-nums"
                    type="number"
                    min={0}
                    step={1}
                    value={lead.reviews}
                    onChange={(event) =>
                      onChange(lead.id, { reviews: parseNumberInput(event.target.value) })
                    }
                    aria-label="Number of reviews"
                  />
                </td>
                <td className="w-40 min-w-40">
                  <div className="flex items-center">
                    <input
                      className="sheet-input"
                      value={lead.website}
                      onChange={(event) => onChange(lead.id, { website: event.target.value })}
                      placeholder="None"
                      aria-label="Website"
                    />
                    {site ? (
                      <a
                        href={site}
                        target="_blank"
                        rel="noreferrer"
                        className="mr-2 text-muted hover:text-fg"
                        aria-label="Open website"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                </td>
                <td className="w-40 min-w-40">
                  <div className="flex items-center">
                    <input
                      className="sheet-input"
                      value={lead.mapsLink}
                      onChange={(event) => onChange(lead.id, { mapsLink: event.target.value })}
                      placeholder="Auto from name"
                      aria-label="Google Maps link"
                    />
                    {maps ? (
                      <a
                        href={maps}
                        target="_blank"
                        rel="noreferrer"
                        className="mr-2 text-muted hover:text-fg"
                        aria-label="Open Google Maps"
                      >
                        <MapPin className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                </td>
                <td className="w-40 min-w-40">
                  <select
                    className="sheet-select"
                    value={status}
                    onChange={(event) =>
                      onChange(lead.id, { websiteStatus: event.target.value as WebsiteStatus })
                    }
                    aria-label="Website status"
                  >
                    {WEBSITE_STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="w-28 min-w-28 px-3">
                  <PriorityBadge priority={priority} />
                </td>
                <td className="w-36 min-w-36">
                  <select
                    className="sheet-select"
                    value={lead.called}
                    onChange={(event) =>
                      onChange(lead.id, { called: event.target.value as CalledStatus })
                    }
                    aria-label="Called?"
                  >
                    {CALLED_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="w-36 min-w-36">
                  <select
                    className="sheet-select"
                    value={lead.callResult}
                    onChange={(event) =>
                      onChange(lead.id, { callResult: event.target.value as CallResult })
                    }
                    aria-label="Call result"
                  >
                    <option value="">—</option>
                    {CALL_RESULT_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="w-40 min-w-40">
                  <input
                    className={cn("sheet-input tabular-nums", due && "text-hot")}
                    type="date"
                    value={lead.followUpDate}
                    onChange={(event) => onChange(lead.id, { followUpDate: event.target.value })}
                    aria-label="Follow-up date"
                  />
                </td>
                <td className="w-64 min-w-64">
                  <input
                    className="sheet-input"
                    value={lead.notes}
                    onChange={(event) => onChange(lead.id, { notes: event.target.value })}
                    aria-label="Notes"
                    title={priorityReason(lead)}
                  />
                </td>
                <td className="w-12 min-w-12">
                  <button
                    type="button"
                    className="flex size-10 items-center justify-center text-subtle hover:text-hot"
                    onClick={() => onDelete(lead)}
                    aria-label={`Delete ${lead.businessName || "lead"}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
