/**
 * Lead sync — the server half.
 *
 * One server function: push the leads this device changed, pull everything that
 * changed elsewhere. Rows are scoped to the signed-in owner and the primary key
 * is `(user_id, id)`, so a client cannot reach another account's row by sending
 * its id.
 *
 * Every failure comes back as a value, never as a crash the UI has to survive:
 * the app is local-first and a failed sync must simply mean "still saved on this
 * device". The one exception is the auth middleware's `Unauthorized`, which is
 * the template's documented contract and is translated by `runLeadSync` in
 * `@/lib/leads-sync-client`.
 *
 * `@/lib/db` and the row mapper are imported INSIDE the handler: this module is
 * also loaded by the browser (for the server-function stub), and `pg` must never
 * follow it there.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { CALLED_OPTIONS, CALL_RESULT_OPTIONS, WEBSITE_STATUS_OPTIONS, type Lead } from "@/lib/leads";
import { leadFromRow, type LeadRow } from "@/lib/leads-row";
import type { SyncRequest, SyncResponse } from "@/lib/leads-sync";

/** Never accept an unbounded push — one device should not be able to fill the table. */
const MAX_CHANGES_PER_SYNC = 600;
/** Rows per INSERT. 19 params each, so this stays far under Postgres' parameter cap. */
const UPSERT_BATCH = 100;
/** Bound columns in one place: the tuple builder and the placeholder count must agree. */
const UPSERT_COLUMNS = 19;
/**
 * The returned cursor is held back by this much so a row committed moments after
 * our read is picked up next time instead of being skipped forever. Re-reading a
 * few rows is free — the merge is idempotent.
 */
const CURSOR_LAG_SECONDS = 5;

const CALLED = new Set<string>(CALLED_OPTIONS);
const RESULTS = new Set<string>(CALL_RESULT_OPTIONS);
const STATUSES = new Set<string>(WEBSITE_STATUS_OPTIONS);

function text(value: unknown, max: number): string {
  if (value == null) return "";
  return String(value).slice(0, max);
}

function num(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function isoOrEmpty(value: unknown): string {
  const raw = text(value, 40);
  if (!raw) return "";
  const at = Date.parse(raw);
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

/** Clamp one client-sent lead to something safe to store. */
function sanitizeLead(raw: unknown): Lead | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = text(row.id, 64).trim();
  if (!id) return null;
  const called = text(row.called, 40);
  const callResult = text(row.callResult, 40);
  const websiteStatus = text(row.websiteStatus, 40);
  const followUpDate = text(row.followUpDate, 10);
  return {
    id,
    businessName: text(row.businessName, 160),
    trade: text(row.trade, 80),
    town: text(row.town, 80),
    phone: text(row.phone, 40),
    email: text(row.email, 160),
    rating: num(row.rating) ?? "",
    reviews: num(row.reviews) ?? "",
    website: text(row.website, 500),
    mapsLink: text(row.mapsLink, 1000),
    websiteStatus: STATUSES.has(websiteStatus) ? (websiteStatus as Lead["websiteStatus"]) : "",
    source: text(row.source, 500),
    called: CALLED.has(called) ? (called as Lead["called"]) : "Not Called",
    callResult: RESULTS.has(callResult) ? (callResult as Lead["callResult"]) : "",
    followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(followUpDate) ? followUpDate : "",
    notes: text(row.notes, 4000),
    demoUrl: text(row.demoUrl, 500),
    updatedAt: isoOrEmpty(row.updatedAt) || new Date().toISOString(),
    deletedAt: isoOrEmpty(row.deletedAt),
  };
}

export const syncLeads = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown): SyncRequest => {
    const source = (input ?? {}) as { since?: unknown; changes?: unknown };
    const since = typeof source.since === "string" ? isoOrEmpty(source.since) : "";
    const list = Array.isArray(source.changes) ? source.changes : [];
    const changes: Lead[] = [];
    for (const raw of list.slice(0, MAX_CHANGES_PER_SYNC)) {
      const lead = sanitizeLead(raw);
      if (lead) changes.push(lead);
    }
    return { since: since || null, changes };
  })
  .handler(async ({ data, context }): Promise<SyncResponse> => {
    const { getSql, dbSource } = await import("@/lib/db");
    const userId = context.userId;

    try {
      const sql = await getSql();

      for (let i = 0; i < data.changes.length; i += UPSERT_BATCH) {
        const batch = data.changes.slice(i, i + UPSERT_BATCH);
        const params: unknown[] = [];
        const tuples = batch.map((lead) => {
          const base = params.length;
          params.push(
            userId,
            lead.id,
            lead.businessName,
            lead.trade,
            lead.town,
            lead.phone,
            lead.email,
            lead.rating === "" ? null : lead.rating,
            lead.reviews === "" ? null : lead.reviews,
            lead.website,
            lead.mapsLink,
            lead.websiteStatus,
            lead.demoUrl,
            lead.source,
            lead.called,
            lead.callResult,
            lead.followUpDate,
            lead.notes,
            lead.deletedAt || null,
          );
          const slots = Array.from({ length: UPSERT_COLUMNS }, (_, n) => `$${base + n + 1}`);
          return `(${slots.join(",")}, now(), now())`;
        });
        await sql.query(
          `insert into leads (
             user_id, id, business_name, trade, town, phone, email, rating, reviews,
             website, maps_link, website_status, demo_url, source, called,
             call_result, follow_up_date, notes, deleted_at, created_at, updated_at
           ) values ${tuples.join(",")}
           on conflict (user_id, id) do update set
             business_name  = excluded.business_name,
             trade          = excluded.trade,
             town           = excluded.town,
             phone          = excluded.phone,
             email          = excluded.email,
             rating         = excluded.rating,
             reviews        = excluded.reviews,
             website        = excluded.website,
             maps_link      = excluded.maps_link,
             website_status = excluded.website_status,
             demo_url       = excluded.demo_url,
             source         = excluded.source,
             called         = excluded.called,
             call_result    = excluded.call_result,
             follow_up_date = excluded.follow_up_date,
             notes          = excluded.notes,
             deleted_at     = excluded.deleted_at,
             updated_at     = now()`,
          params,
        );
      }

      // `>=` plus the lagged cursor below: a little overlap, never a gap.
      const rows = await sql.query<LeadRow>(
        `select id, business_name, trade, town, phone, email, rating, reviews, website,
                maps_link, website_status, demo_url, source, called, call_result,
                follow_up_date, notes, deleted_at, updated_at
           from leads
          where user_id = $1
            and ($2::timestamptz is null or updated_at >= $2::timestamptz)
          order by updated_at
          limit 5000`,
        [userId, data.since],
      );

      // The cursor is the SERVER's clock, never the caller's — a device with a
      // skewed clock must not be able to page past rows it has not seen.
      const [clock] = await sql.query<{ epoch: string | number }>(
        "select extract(epoch from now()) as epoch",
      );
      const cursor = new Date((Number(clock.epoch) - CURSOR_LAG_SECONDS) * 1000).toISOString();

      return {
        ok: true,
        leads: rows.map(leadFromRow),
        cursor,
        durable: dbSource === "neon",
      };
    } catch (error) {
      console.error("[leads] sync failed:", error);
      return {
        ok: false,
        reason: "unavailable",
        message: "Could not reach your saved sheet just now.",
      };
    }
  });
