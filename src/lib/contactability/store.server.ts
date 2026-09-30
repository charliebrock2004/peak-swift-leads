/**
 * Provenance and contactability, stored (migration 0010).
 *
 * Every write is scoped by `user_id` and every read filters on it, like the
 * rest of the store. Facts are appended, not overwritten: a newer observation
 * of the same kind retires the old one (`superseded_at`) so the history of
 * what was known, and when, survives.
 */
import type { Sql } from "@/lib/db";
import type { LegalForm } from "./legal-form.ts";
import { normalizeUkPhone, type DoNotCall, type PhoneScreening, type ScreeningResult } from "./phone.ts";
import type { VerificationResult } from "./email.ts";

const text = (value: unknown): string => (value == null ? "" : String(value));
const iso = (value: unknown): string => {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
function json(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Source records ───────────────────────────────────────────────────────────

export type SourceRecord = {
  id: string;
  source: string;
  sourceId: string;
  primaryId: string;
  leadId: string;
  name: string;
  url: string;
  fields: Record<string, unknown>;
  fetchedAt: string;
};

export type SourceRecordInput = Omit<SourceRecord, "fetchedAt" | "leadId" | "primaryId"> & {
  primaryId?: string;
  leadId?: string;
  fetchedAt?: string;
};

/**
 * Keep what a source said. Re-fetching a record refreshes its fields and date;
 * a link to a business, once made, is never cleared by a later discovery run.
 */
export async function upsertSourceRecords(sql: Sql, userId: string, records: readonly SourceRecordInput[]): Promise<number> {
  let written = 0;
  for (let start = 0; start < records.length; start += 50) {
    const batch = records.slice(start, start + 50);
    const values: string[] = [];
    const params: unknown[] = [userId];
    for (const record of batch) {
      const at = params.length;
      params.push(
        record.id.slice(0, 120),
        record.source.slice(0, 40),
        record.sourceId.slice(0, 120),
        (record.primaryId ?? "").slice(0, 120),
        (record.leadId ?? "").slice(0, 64),
        record.name.slice(0, 200),
        record.url.slice(0, 500),
        JSON.stringify(record.fields ?? {}),
        record.fetchedAt || new Date().toISOString(),
      );
      values.push(`($1, $${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7}, $${at + 8}::jsonb, $${at + 9}::timestamptz)`);
    }
    await sql.query(
      `insert into source_records (user_id, id, source, source_id, primary_id, lead_id, name, url, fields, fetched_at)
       values ${values.join(", ")}
       on conflict (user_id, id) do update set
         source     = excluded.source,
         source_id  = excluded.source_id,
         primary_id = case when excluded.primary_id <> '' then excluded.primary_id else source_records.primary_id end,
         lead_id    = case when source_records.lead_id <> '' then source_records.lead_id else excluded.lead_id end,
         name       = excluded.name,
         url        = excluded.url,
         fields     = excluded.fields,
         fetched_at = excluded.fetched_at`,
      params,
    );
    written += batch.length;
  }
  return written;
}

/** Every record behind one business: linked to it, or merged into its place id. */
export async function sourceRecordsForLead(sql: Sql, userId: string, lead: { id: string; placeId?: string }): Promise<SourceRecord[]> {
  const placeId = (lead.placeId ?? "").trim();
  const rows = await sql.query<Record<string, unknown>>(
    `select id, source, source_id, primary_id, lead_id, name, url, fields, fetched_at
       from source_records
      where user_id = $1 and (lead_id = $2 or ($3 <> '' and (id = $3 or primary_id = $3)))
      order by fetched_at desc limit 50`,
    [userId, lead.id, placeId],
  );
  return rows.map((row) => ({
    id: text(row.id),
    source: text(row.source),
    sourceId: text(row.source_id),
    primaryId: text(row.primary_id),
    leadId: text(row.lead_id),
    name: text(row.name),
    url: text(row.url),
    fields: json(row.fields),
    fetchedAt: iso(row.fetched_at),
  }));
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export type EvidenceItem = {
  id: string;
  leadId: string;
  kind: string;
  value: string;
  label: string;
  source: string;
  sourceRef: string;
  sourceUrl: string;
  confidence: Confidence;
  observedAt: string;
  detail: Record<string, unknown>;
  supersededAt: string;
};

export type EvidenceInput = {
  kind: string;
  value: string;
  label: string;
  source: string;
  sourceRef?: string;
  sourceUrl?: string;
  confidence: Confidence;
  observedAt?: string;
  detail?: Record<string, unknown>;
};

/**
 * Record observed facts about a business. Each replaces (retires) the current
 * fact of the same kind for that business; the old row stays as history.
 */
export async function addEvidence(sql: Sql, userId: string, leadId: string, items: readonly EvidenceInput[]): Promise<void> {
  for (const item of items) {
    await sql.query(
      `update evidence_items set superseded_at = now()
        where user_id = $1 and lead_id = $2 and kind = $3 and superseded_at is null`,
      [userId, leadId, item.kind],
    );
    await sql.query(
      `insert into evidence_items (user_id, id, lead_id, kind, value, label, source, source_ref, source_url, confidence, observed_at, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::jsonb)`,
      [
        userId,
        newId(),
        leadId,
        item.kind.slice(0, 60),
        item.value.slice(0, 500),
        item.label.slice(0, 500),
        item.source.slice(0, 60),
        (item.sourceRef ?? "").slice(0, 200),
        (item.sourceUrl ?? "").slice(0, 500),
        item.confidence,
        item.observedAt || new Date().toISOString(),
        JSON.stringify(item.detail ?? {}),
      ],
    );
  }
}

function evidenceFromRow(row: Record<string, unknown>): EvidenceItem {
  const confidence = text(row.confidence);
  return {
    id: text(row.id),
    leadId: text(row.lead_id),
    kind: text(row.kind),
    value: text(row.value),
    label: text(row.label),
    source: text(row.source),
    sourceRef: text(row.source_ref),
    sourceUrl: text(row.source_url),
    confidence: confidence === "high" || confidence === "low" ? confidence : "medium",
    observedAt: iso(row.observed_at),
    detail: json(row.detail),
    supersededAt: iso(row.superseded_at),
  };
}

export async function evidenceForLead(sql: Sql, userId: string, leadId: string, options: { history?: boolean } = {}): Promise<EvidenceItem[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, lead_id, kind, value, label, source, source_ref, source_url, confidence, observed_at, detail, superseded_at
       from evidence_items
      where user_id = $1 and lead_id = $2 ${options.history ? "" : "and superseded_at is null"}
      order by observed_at desc limit 200`,
    [userId, leadId],
  );
  return rows.map(evidenceFromRow);
}

// ── Registered identity ──────────────────────────────────────────────────────

export type CompanyFactsInput = {
  companyNumber: string;
  companyType: string;
  companyStatus: string;
  checkedAt: string;
};

/**
 * The register's answer, on the business row. An empty number with a date
 * means "searched; no matching company". Does not move `updated_at`: these
 * columns are server-only, and moving it would make every device re-sync.
 */
export async function saveCompanyFacts(sql: Sql, userId: string, leadId: string, facts: CompanyFactsInput): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update leads set company_number = $3, company_type = $4, company_status = $5, company_checked_at = $6
      where user_id = $1 and id = $2 and deleted_at is null
      returning id`,
    [userId, leadId, facts.companyNumber.toUpperCase().slice(0, 12), facts.companyType.slice(0, 60), facts.companyStatus.slice(0, 40), facts.checkedAt],
  );
  return rows.length > 0;
}

export async function setLegalFormOverride(
  sql: Sql,
  userId: string,
  leadId: string,
  input: { form: LegalForm | ""; note: string; at: string },
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update leads set legal_form_override = $3, legal_form_note = $4, legal_form_set_at = $5
      where user_id = $1 and id = $2 and deleted_at is null
      returning id`,
    [userId, leadId, input.form, input.note.slice(0, 300), input.form ? input.at : ""],
  );
  return rows.length > 0;
}

// ── Phone screening and do-not-call ──────────────────────────────────────────

function e164(phone: string): string {
  return normalizeUkPhone(phone)?.e164 ?? "";
}

export async function recordScreening(
  sql: Sql,
  userId: string,
  phone: string,
  result: { tps: ScreeningResult; ctps: ScreeningResult; checkedAt: string; method: string; note?: string },
): Promise<string> {
  const number = e164(phone);
  if (!number) throw new Error("That is not a valid UK phone number.");
  await sql.query(
    `insert into phone_screening (user_id, phone, tps, ctps, checked_at, method, note, updated_at)
     values ($1, $2, $3, $4, $5::timestamptz, $6, $7, now())
     on conflict (user_id, phone) do update set
       tps = excluded.tps, ctps = excluded.ctps, checked_at = excluded.checked_at,
       method = excluded.method, note = excluded.note, updated_at = now()`,
    [userId, number, result.tps, result.ctps, result.checkedAt, result.method.slice(0, 80), (result.note ?? "").slice(0, 300)],
  );
  return number;
}

export async function loadScreenings(sql: Sql, userId: string): Promise<Map<string, PhoneScreening>> {
  const rows = await sql.query<Record<string, unknown>>(
    `select phone, tps, ctps, checked_at, method from phone_screening where user_id = $1`,
    [userId],
  );
  const map = new Map<string, PhoneScreening>();
  for (const row of rows) {
    const tps = text(row.tps) as ScreeningResult;
    const ctps = text(row.ctps) as ScreeningResult;
    map.set(text(row.phone), { tps, ctps, checkedAt: iso(row.checked_at), method: text(row.method) });
  }
  return map;
}

export async function addDoNotCall(
  sql: Sql,
  userId: string,
  entry: { phone: string; reason: string; source: "internal" | "objection"; leadId?: string },
): Promise<string> {
  const number = e164(entry.phone);
  if (!number) throw new Error("That is not a valid UK phone number.");
  // An objection is never downgraded to a plain list entry.
  await sql.query(
    `insert into call_suppression (user_id, phone, reason, source, lead_id)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, phone) do update set
       reason = case when excluded.reason <> '' then excluded.reason else call_suppression.reason end,
       source = case when call_suppression.source = 'objection' then 'objection' else excluded.source end`,
    [userId, number, entry.reason.slice(0, 300), entry.source, entry.leadId ?? ""],
  );
  return number;
}

export async function removeDoNotCall(sql: Sql, userId: string, phone: string): Promise<void> {
  const number = e164(phone);
  // An objection is the person's own request: it is not removable from here.
  await sql.query(`delete from call_suppression where user_id = $1 and phone = $2 and source = 'internal'`, [userId, number]);
}

export async function loadDoNotCall(sql: Sql, userId: string): Promise<Map<string, DoNotCall>> {
  const rows = await sql.query<Record<string, unknown>>(
    `select phone, reason, source, created_at from call_suppression where user_id = $1`,
    [userId],
  );
  const map = new Map<string, DoNotCall>();
  for (const row of rows) {
    map.set(text(row.phone), {
      reason: text(row.reason),
      source: text(row.source) === "objection" ? "objection" : "internal",
      createdAt: iso(row.created_at),
    });
  }
  return map;
}

// ── Email verification ───────────────────────────────────────────────────────

export async function saveVerification(
  sql: Sql,
  userId: string,
  entry: { email: string; result: VerificationResult; provider: string; detail?: string },
): Promise<void> {
  await sql.query(
    `insert into email_verifications (user_id, email, result, provider, detail, checked_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (user_id, email) do update set
       result = excluded.result, provider = excluded.provider, detail = excluded.detail, checked_at = now()`,
    [userId, entry.email.trim().toLowerCase(), entry.result, entry.provider.slice(0, 40), (entry.detail ?? "").slice(0, 300)],
  );
}

export async function loadVerifications(sql: Sql, userId: string): Promise<Map<string, { result: VerificationResult; provider: string; checkedAt: string }>> {
  const rows = await sql.query<Record<string, unknown>>(
    `select email, result, provider, checked_at from email_verifications where user_id = $1`,
    [userId],
  );
  return new Map(
    rows.map((row) => [text(row.email), { result: text(row.result) as VerificationResult, provider: text(row.provider), checkedAt: iso(row.checked_at) }]),
  );
}

// ── Entity overrides ─────────────────────────────────────────────────────────

export async function setEntityOverride(
  sql: Sql,
  userId: string,
  input: { a: string; b: string; decision: "same" | "different"; note?: string },
): Promise<void> {
  const [a, b] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  if (a === b) throw new Error("A business is always the same as itself.");
  await sql.query(
    `insert into entity_overrides (user_id, a, b, decision, note) values ($1, $2, $3, $4, $5)
     on conflict (user_id, a, b) do update set decision = excluded.decision, note = excluded.note, created_at = now()`,
    [userId, a, b, input.decision, (input.note ?? "").slice(0, 300)],
  );
}

export async function loadEntityOverrides(sql: Sql, userId: string): Promise<{ a: string; b: string; decision: "same" | "different"; note: string }[]> {
  const rows = await sql.query<Record<string, unknown>>(`select a, b, decision, note from entity_overrides where user_id = $1`, [userId]);
  return rows.map((row) => ({ a: text(row.a), b: text(row.b), decision: text(row.decision) === "same" ? "same" : "different", note: text(row.note) }));
}
