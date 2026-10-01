/**
 * The business list as a spreadsheet: every business, with the one score —
 * band, priority, recommended action and its top reason — next to the raw
 * fields. Client-safe and pure apart from `downloadCsv`.
 */
import { resolveWebsiteStatus, type Lead } from "./leads.ts";
import { ACTION_LABEL, BAND_LABEL, scoreProspect, type ProspectScore } from "./scoring/prospect-score.ts";

function cell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  // Formula injection: a spreadsheet must never execute a cell it is given.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_HEADER = [
  "Business Name",
  "Trade",
  "Town",
  "Address",
  "Phone Number",
  "Email",
  "Email Source",
  "Email Confidence",
  "Google Rating",
  "Number of Reviews",
  "Website",
  "Website Status",
  "Prospect Band",
  "Priority",
  "Recommended Action",
  "Why",
  "Called?",
  "Call Result",
  "Follow-Up Date",
  "Source",
  "Date Found",
  "Google Maps Link",
  "Notes",
];

export function leadsToCsv(leads: readonly Lead[], scores?: ReadonlyMap<string, ProspectScore>): string {
  const rows = leads.map((lead) => {
    const score = scores?.get(lead.id) ?? scoreProspect(lead);
    return [
      lead.businessName,
      lead.trade,
      lead.town,
      lead.address,
      lead.phone,
      lead.email,
      lead.emailSource,
      lead.emailConfidence,
      lead.rating,
      lead.reviews,
      lead.website,
      resolveWebsiteStatus(lead),
      BAND_LABEL[score.band],
      score.priority,
      ACTION_LABEL[score.action],
      score.why[0]?.text ?? score.actionReason,
      lead.called,
      lead.callResult,
      lead.followUpDate,
      lead.source,
      lead.foundAt,
      lead.mapsLink,
      lead.notes,
    ]
      .map(cell)
      .join(",");
  });
  return [CSV_HEADER.join(","), ...rows].join("\n");
}

export function downloadCsv(leads: readonly Lead[], scores?: ReadonlyMap<string, ProspectScore>): void {
  const blob = new Blob([leadsToCsv(leads, scores)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `peak-swift-businesses-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
