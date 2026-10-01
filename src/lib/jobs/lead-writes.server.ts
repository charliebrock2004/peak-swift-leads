/**
 * Lead writes made by background jobs.
 *
 * A job only ever writes the columns it actually learned something about —
 * never the whole row — so a call note or follow-up date typed on a phone
 * while a job runs cannot be overwritten by the job's older copy of the lead.
 * `updated_at` moves on every write, so the change reaches every device on its
 * next sync.
 */
import type { Sql } from "@/lib/db";
import { buildLeadUpsert, leadFromRow, type LeadRow } from "../leads-row.ts";
import { createLead, type Lead } from "../leads.ts";

/** The lead fields a server-side write may set, and their columns. Outreach-owned columns are not here. */
const PATCHABLE: Partial<Record<keyof Lead, string>> = {
  businessName: "business_name",
  trade: "trade",
  town: "town",
  phone: "phone",
  email: "email",
  address: "address",
  rating: "rating",
  reviews: "reviews",
  website: "website",
  mapsLink: "maps_link",
  websiteStatus: "website_status",
  placeId: "place_id",
  foundAt: "found_at",
  businessStatus: "business_status",
  source: "source",
  notes: "notes",
  websiteQuality: "website_quality",
  websiteScore: "website_score",
  websiteAnalysis: "website_analysis",
  websiteCheckedAt: "website_checked_at",
  emailSource: "email_source",
  emailConfidence: "email_confidence",
  emailFoundAt: "email_found_at",
  opportunityScore: "opportunity_score",
  // Set by a person's own action (a logged call), never by a background job.
  called: "called",
  callResult: "call_result",
  followUpDate: "follow_up_date",
};

const NUMERIC = new Set<keyof Lead>(["rating", "reviews", "websiteScore", "opportunityScore"]);

/** Set only the given fields on one live lead. Returns false if the lead is gone. */
export async function patchLead(sql: Sql, userId: string, id: string, patch: Partial<Lead>): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [userId, id];
  for (const [key, value] of Object.entries(patch) as [keyof Lead, unknown][]) {
    const column = PATCHABLE[key];
    if (!column || value === undefined) continue;
    params.push(NUMERIC.has(key) && value === "" ? null : value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return true;
  const rows = await sql.query(
    `update leads set ${sets.join(", ")}, updated_at = now()
      where user_id = $1 and id = $2 and deleted_at is null
      returning id`,
    params,
  );
  return rows.length > 0;
}

/** Insert new leads. Ids are fixed before the call, so a retried insert is a no-op update. */
export async function insertLeads(sql: Sql, userId: string, leads: readonly Partial<Lead>[]): Promise<void> {
  const now = new Date().toISOString();
  const full = leads.map((lead) => createLead({ ...lead, updatedAt: now }));
  for (let at = 0; at < full.length; at += 80) {
    const { text, params } = buildLeadUpsert(userId, full.slice(at, at + 80));
    await sql.query(text, params);
  }
}

const ROW_COLUMNS = `id, business_name, trade, town, phone, email, address, rating, reviews, website,
  maps_link, website_status, place_id, found_at, business_status, demo_url, source,
  called, call_result, follow_up_date, notes,
  website_quality, website_score, website_analysis, website_checked_at,
  email_source, email_confidence, email_found_at, opportunity_score,
  outreach_status, unsubscribed, last_emailed_at, deleted_at, updated_at`;

/** The live sheet as plain leads (no facts) — what dedupe compares against. */
export async function loadSheet(sql: Sql, userId: string): Promise<Lead[]> {
  const rows = await sql.query<LeadRow>(
    `select ${ROW_COLUMNS} from leads where user_id = $1 and deleted_at is null order by updated_at desc limit 20000`,
    [userId],
  );
  return rows.map(leadFromRow);
}

export async function loadSheetLeads(sql: Sql, userId: string, ids: readonly string[]): Promise<Lead[]> {
  if (ids.length === 0) return [];
  const rows = await sql.query<LeadRow>(
    `select ${ROW_COLUMNS} from leads where user_id = $1 and id = any($2::text[]) and deleted_at is null`,
    [userId, [...ids]],
  );
  return rows.map(leadFromRow);
}
