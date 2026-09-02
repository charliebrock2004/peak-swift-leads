/**
 * The `leads` table row shape and its mapping to the app's `Lead`.
 *
 * Kept in its own dependency-free module so the server function can import it
 * without dragging a database driver anywhere near the browser bundle, and so
 * the mapping can be unit-tested on its own.
 */
import { migrateLead, type Lead } from "./leads.ts";

export type LeadRow = {
  id: string;
  business_name: string;
  trade: string;
  town: string;
  phone: string;
  email: string;
  rating: number | string | null;
  reviews: number | string | null;
  website: string;
  maps_link: string;
  website_status: string;
  demo_url: string;
  source: string;
  called: string;
  call_result: string;
  follow_up_date: string;
  notes: string;
  deleted_at: Date | string | null;
  updated_at: Date | string;
};

/** Postgres timestamps arrive as `Date` (pg and PGLite alike); the wire wants ISO text. */
function iso(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const at = Date.parse(value);
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

function numeric(value: number | string | null): number | "" {
  if (value === null || value === "") return "";
  const next = Number(value);
  return Number.isFinite(next) ? next : "";
}

export function leadFromRow(row: LeadRow): Lead {
  return migrateLead({
    id: row.id,
    businessName: row.business_name ?? "",
    trade: row.trade ?? "",
    town: row.town ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    rating: numeric(row.rating),
    reviews: numeric(row.reviews),
    website: row.website ?? "",
    mapsLink: row.maps_link ?? "",
    websiteStatus: (row.website_status || "") as Lead["websiteStatus"],
    source: row.source ?? "",
    called: (row.called || "Not Called") as Lead["called"],
    callResult: (row.call_result || "") as Lead["callResult"],
    followUpDate: row.follow_up_date ?? "",
    notes: row.notes ?? "",
    demoUrl: row.demo_url ?? "",
    updatedAt: iso(row.updated_at) || new Date().toISOString(),
    deletedAt: iso(row.deleted_at),
  });
}
