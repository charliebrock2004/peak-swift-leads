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
  address: string;
  rating: number | string | null;
  reviews: number | string | null;
  website: string;
  maps_link: string;
  website_status: string;
  place_id: string;
  found_at: string;
  business_status: string;
  demo_url: string;
  source: string;
  called: string;
  call_result: string;
  follow_up_date: string;
  notes: string;
  website_quality: string;
  website_score: number | string | null;
  website_analysis: string;
  website_checked_at: string;
  email_source: string;
  email_confidence: string;
  email_found_at: string;
  opportunity_score: number | string | null;
  outreach_status: string;
  unsubscribed: string;
  last_emailed_at: string;
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
    address: row.address ?? "",
    rating: numeric(row.rating),
    reviews: numeric(row.reviews),
    website: row.website ?? "",
    mapsLink: row.maps_link ?? "",
    websiteStatus: (row.website_status || "") as Lead["websiteStatus"],
    placeId: row.place_id ?? "",
    foundAt: row.found_at ?? "",
    businessStatus: row.business_status ?? "",
    source: row.source ?? "",
    called: (row.called || "Not Called") as Lead["called"],
    callResult: (row.call_result || "") as Lead["callResult"],
    followUpDate: row.follow_up_date ?? "",
    notes: row.notes ?? "",
    demoUrl: row.demo_url ?? "",
    websiteQuality: (row.website_quality || "") as Lead["websiteQuality"],
    websiteScore: numeric(row.website_score),
    websiteAnalysis: row.website_analysis ?? "",
    websiteCheckedAt: row.website_checked_at ?? "",
    emailSource: row.email_source ?? "",
    emailConfidence: (row.email_confidence || "") as Lead["emailConfidence"],
    emailFoundAt: row.email_found_at ?? "",
    opportunityScore: numeric(row.opportunity_score),
    outreachStatus: row.outreach_status ?? "",
    unsubscribed: row.unsubscribed ?? "",
    lastEmailedAt: row.last_emailed_at ?? "",
    updatedAt: iso(row.updated_at) || new Date().toISOString(),
    deletedAt: iso(row.deleted_at),
  });
}

/**
 * The `unsubscribed` flag as a device may send it.
 *
 * Two writers disagree on its shape: the lead sheet has always stored "yes",
 * and outreach stores the moment somebody asked to stop — an ISO timestamp.
 * Sync used to accept only "yes", so the first time a device pushed a lead that
 * outreach had unsubscribed, the timestamp was truncated, failed the check and
 * was saved as "" — silently un-unsubscribing them. Any non-empty value that is
 * either marker is kept; anything else is not a flag.
 */
export function normaliseUnsubscribed(value: unknown): string {
  const raw = value == null ? "" : String(value).trim().slice(0, 40);
  if (!raw) return "";
  if (raw.toLowerCase() === "yes") return "yes";
  const at = Date.parse(raw);
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

/** Columns bound per row. The tuple builder and the placeholder count must agree. */
const UPSERT_COLUMNS = 34;

/**
 * The statement that writes a device's changed leads.
 *
 * Most columns are the device's to set — its edit is the newest word on a call
 * result or a note. Three are not. `outreach_status`, `unsubscribed` and
 * `last_emailed_at` are written by the SERVER when an email is sent, a reply
 * arrives or somebody opts out; a device only ever holds a copy. A device that
 * last pulled before the send and then edited a note would otherwise push its
 * stale copy back and erase the fact that the lead was emailed, or had asked to
 * be left alone. So those three only ever move forward here:
 *
 * - `unsubscribed` and `outreach_status` keep the server's value once it has one;
 * - `last_emailed_at` keeps whichever is later (ISO text sorts chronologically).
 *
 * The database is the enforcement point, not the client, so no future screen
 * can reintroduce the regression by pushing a lead it did not mean to change.
 */
export function buildLeadUpsert(userId: string, leads: readonly Lead[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = leads.map((lead) => {
    const base = params.length;
    params.push(
      userId,
      lead.id,
      lead.businessName,
      lead.trade,
      lead.town,
      lead.phone,
      lead.email,
      lead.address,
      lead.rating === "" ? null : lead.rating,
      lead.reviews === "" ? null : lead.reviews,
      lead.website,
      lead.mapsLink,
      lead.websiteStatus,
      lead.placeId,
      lead.foundAt,
      lead.businessStatus,
      lead.demoUrl,
      lead.source,
      lead.called,
      lead.callResult,
      lead.followUpDate,
      lead.notes,
      lead.websiteQuality,
      lead.websiteScore === "" ? null : lead.websiteScore,
      lead.websiteAnalysis,
      lead.websiteCheckedAt,
      lead.emailSource,
      lead.emailConfidence,
      lead.emailFoundAt,
      lead.opportunityScore === "" ? null : lead.opportunityScore,
      lead.outreachStatus,
      lead.unsubscribed,
      lead.lastEmailedAt,
      lead.deletedAt || null,
    );
    const slots = Array.from({ length: UPSERT_COLUMNS }, (_, n) => `$${base + n + 1}`);
    return `(${slots.join(",")}, now(), now())`;
  });
  const text = `insert into leads (
       user_id, id, business_name, trade, town, phone, email, address, rating, reviews,
       website, maps_link, website_status, place_id, found_at, business_status,
       demo_url, source, called, call_result, follow_up_date, notes,
       website_quality, website_score, website_analysis, website_checked_at,
       email_source, email_confidence, email_found_at, opportunity_score,
       outreach_status, unsubscribed, last_emailed_at, deleted_at,
       created_at, updated_at
     ) values ${tuples.join(",")}
     on conflict (user_id, id) do update set
       business_name      = excluded.business_name,
       trade              = excluded.trade,
       town               = excluded.town,
       phone              = excluded.phone,
       email              = excluded.email,
       address            = excluded.address,
       rating             = excluded.rating,
       reviews            = excluded.reviews,
       website            = excluded.website,
       maps_link          = excluded.maps_link,
       website_status     = excluded.website_status,
       place_id           = excluded.place_id,
       found_at           = excluded.found_at,
       business_status    = excluded.business_status,
       demo_url           = excluded.demo_url,
       source             = excluded.source,
       called             = excluded.called,
       call_result        = excluded.call_result,
       follow_up_date     = excluded.follow_up_date,
       notes              = excluded.notes,
       website_quality    = excluded.website_quality,
       website_score      = excluded.website_score,
       website_analysis   = excluded.website_analysis,
       website_checked_at = excluded.website_checked_at,
       email_source       = excluded.email_source,
       email_confidence   = excluded.email_confidence,
       email_found_at     = excluded.email_found_at,
       opportunity_score  = excluded.opportunity_score,
       outreach_status    = case when leads.outreach_status <> '' then leads.outreach_status
                                 else excluded.outreach_status end,
       unsubscribed       = case when leads.unsubscribed <> '' then leads.unsubscribed
                                 else excluded.unsubscribed end,
       last_emailed_at    = greatest(leads.last_emailed_at, excluded.last_emailed_at),
       deleted_at         = excluded.deleted_at,
       updated_at         = now()`;
  return { text, params };
}
