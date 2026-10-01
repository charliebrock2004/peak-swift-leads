/**
 * Prospect-quality feedback (migration 0016). Every query is scoped to one
 * account. A mark copies the business's source, trade and town, so the counts
 * by source and by search outlive edits to the business.
 */
import type { Sql } from "@/lib/db";
import type { FeedbackRow } from "./quality.ts";
import { conflictsWith, REJECTING, type Verdict } from "./verdicts.ts";

export type MarkResult = { verdicts: Verdict[] };

/**
 * Add or withdraw one mark. Adding "good" withdraws any rejecting mark and
 * the reverse — the latest word stands. Returns the business's marks after.
 */
export async function setFeedback(
  sql: Sql,
  userId: string,
  input: { leadId: string; verdict: Verdict; on: boolean; note?: string },
): Promise<MarkResult> {
  const leads = await sql.query<{ source: string; trade: string; town: string; website: string }>(
    `select source, trade, town, website from leads where user_id = $1 and id = $2`,
    [userId, input.leadId],
  );
  const lead = leads[0];
  if (!lead) throw new Error("That business no longer exists.");
  if (input.on) {
    const conflicts = conflictsWith(input.verdict);
    if (conflicts.length) {
      await sql.query(`delete from prospect_feedback where user_id = $1 and lead_id = $2 and verdict = any($3::text[])`, [userId, input.leadId, conflicts]);
    }
    await sql.query(
      `insert into prospect_feedback (user_id, lead_id, verdict, note, source, trade, town, website)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (user_id, lead_id, verdict) do update set note = excluded.note, website = excluded.website, created_at = now()`,
      [
        userId,
        input.leadId,
        input.verdict,
        (input.note ?? "").trim().slice(0, 500),
        String(lead.source ?? "").slice(0, 120),
        String(lead.trade ?? "").slice(0, 120),
        String(lead.town ?? "").slice(0, 120),
        input.verdict === "wrong_website" ? String(lead.website ?? "").slice(0, 300) : "",
      ],
    );
  } else {
    await sql.query(`delete from prospect_feedback where user_id = $1 and lead_id = $2 and verdict = $3`, [userId, input.leadId, input.verdict]);
  }
  return { verdicts: await verdictsFor(sql, userId, input.leadId) };
}

export async function verdictsFor(sql: Sql, userId: string, leadId: string): Promise<Verdict[]> {
  const rows = await sql.query<{ verdict: Verdict }>(`select verdict from prospect_feedback where user_id = $1 and lead_id = $2 order by verdict`, [userId, leadId]);
  return rows.map((row) => row.verdict);
}

/**
 * A correction is answered by correcting the data: a new website clears
 * "wrong website", a new email or phone clears "contact details wrong".
 */
export async function clearCorrected(sql: Sql, userId: string, leadId: string, changed: { website?: boolean; contact?: boolean }): Promise<void> {
  const verdicts = [...(changed.website ? ["wrong_website", "good_website"] : []), ...(changed.contact ? ["wrong_contact"] : [])];
  if (!verdicts.length) return;
  await sql.query(`delete from prospect_feedback where user_id = $1 and lead_id = $2 and verdict = any($3::text[])`, [userId, leadId, verdicts]);
}

export async function loadFeedback(sql: Sql, userId: string): Promise<FeedbackRow[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select lead_id, verdict, source, trade, town, website, created_at from prospect_feedback where user_id = $1 order by created_at limit 20000`,
    [userId],
  );
  return rows.map((row) => ({
    leadId: String(row.lead_id),
    verdict: String(row.verdict) as Verdict,
    source: String(row.source ?? ""),
    trade: String(row.trade ?? ""),
    town: String(row.town ?? ""),
    website: String(row.website ?? ""),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
  }));
}

/**
 * Businesses you rejected, removed or not, as identities Find must never add
 * again: name, town, phone, website and source id.
 */
export async function rejectedIdentities(sql: Sql, userId: string) {
  const rows = await sql.query<Record<string, unknown>>(
    `select l.id, l.business_name, l.town, l.phone, l.website, l.place_id, l.address, l.email, l.maps_link
       from leads l
      where l.user_id = $1
        and exists (select 1 from prospect_feedback f where f.user_id = l.user_id and f.lead_id = l.id and f.verdict = any($2::text[]))
      limit 5000`,
    [userId, [...REJECTING]],
  );
  return rows.map((row) => ({
    id: String(row.id),
    businessName: String(row.business_name ?? ""),
    town: String(row.town ?? ""),
    phone: String(row.phone ?? ""),
    website: String(row.website ?? ""),
    placeId: String(row.place_id ?? ""),
    address: String(row.address ?? ""),
    email: String(row.email ?? ""),
    mapsLink: String(row.maps_link ?? ""),
  }));
}
