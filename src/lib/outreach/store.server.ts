/**
 * Every read and write of the outreach tables. **Server-only.**
 *
 * Kept apart from the server functions so the SQL is in one place and the
 * functions stay about policy. Every statement is scoped by `user_id`, which is
 * always the verified id from `authMiddleware` — never anything a client sent.
 */
import type { Sql } from "@/lib/db";
import type { Lead } from "@/lib/leads";
import { leadFromRow, type LeadRow } from "@/lib/leads-row";
import {
  DEFAULT_SETTINGS,
  type EmailKind,
  type EmailStatus,
  type GmailConnection,
  type GmailStatus,
  type OutreachEmail,
  type OutreachSettings,
  type OutreachTemplate,
  type SuppressionEntry,
  type TemplateKind,
} from "./types.ts";
import { DEFAULT_TEMPLATES } from "./templates.ts";

function iso(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

const text = (value: unknown): string => (value == null ? "" : String(value));

// ── Gmail account ────────────────────────────────────────────────────────────

export type GmailAccountRow = {
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date | string | null;
  scope: string;
  status: string;
  last_error: string;
  connected_at: Date | string;
};

/** The full record, tokens included. Never leaves the server. */
export async function loadGmailAccount(sql: Sql, userId: string): Promise<GmailAccountRow | null> {
  const rows = await sql.query<GmailAccountRow>(
    `select email, access_token, refresh_token, expires_at, scope, status, last_error, connected_at
       from gmail_accounts where user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** What the browser may see: an address and a health state, never a token. */
export function publicConnection(row: GmailAccountRow | null, configured: boolean): GmailConnection {
  if (!row || row.status === "disconnected") {
    return { email: row?.email ?? "", status: "disconnected", lastError: row?.last_error ?? "", connectedAt: "", configured };
  }
  return {
    email: row.email,
    status: (row.status as GmailStatus) ?? "disconnected",
    lastError: row.last_error,
    connectedAt: iso(row.connected_at),
    configured,
  };
}

export async function saveGmailTokens(
  sql: Sql,
  userId: string,
  values: { email: string; accessToken: string; refreshToken: string; expiresAt: string; scope: string },
): Promise<void> {
  await sql.query(
    `insert into gmail_accounts
       (user_id, email, access_token, refresh_token, expires_at, scope, status, last_error, connected_at, updated_at)
     values ($1, $2, $3, $4, $5::timestamptz, $6, 'connected', '', now(), now())
     on conflict (user_id) do update set
       email         = excluded.email,
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       scope         = excluded.scope,
       status        = 'connected',
       last_error    = '',
       connected_at  = now(),
       updated_at    = now()`,
    [userId, values.email, values.accessToken, values.refreshToken, values.expiresAt, values.scope],
  );
}

/** After a refresh: new access token, same connection. */
export async function updateGmailAccessToken(
  sql: Sql,
  userId: string,
  values: { accessToken: string; refreshToken: string; expiresAt: string },
): Promise<void> {
  await sql.query(
    `update gmail_accounts
        set access_token = $2, refresh_token = $3, expires_at = $4::timestamptz,
            status = 'connected', last_error = '', updated_at = now()
      where user_id = $1`,
    [userId, values.accessToken, values.refreshToken, values.expiresAt],
  );
}

export async function markGmailProblem(sql: Sql, userId: string, error: string): Promise<void> {
  await sql.query(
    `update gmail_accounts set status = 'needs_attention', last_error = $2, updated_at = now() where user_id = $1`,
    [userId, error.slice(0, 500)],
  );
}

/** Forget the account. Tokens are cleared, not just flagged. */
export async function clearGmailAccount(sql: Sql, userId: string): Promise<void> {
  await sql.query(
    `update gmail_accounts
        set access_token = '', refresh_token = '', expires_at = null,
            status = 'disconnected', last_error = '', updated_at = now()
      where user_id = $1`,
    [userId],
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function loadSettings(sql: Sql, userId: string): Promise<OutreachSettings> {
  const rows = await sql.query<Record<string, unknown>>(
    `select daily_limit, batch_size, delay_seconds, follow_ups_on, follow_up_1_days,
            follow_up_2_days, max_follow_ups, auto_send, include_low, default_mode
       from outreach_settings where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    dailyLimit: Number(row.daily_limit ?? DEFAULT_SETTINGS.dailyLimit),
    batchSize: Number(row.batch_size ?? DEFAULT_SETTINGS.batchSize),
    delaySeconds: Number(row.delay_seconds ?? DEFAULT_SETTINGS.delaySeconds),
    followUpsOn: Boolean(row.follow_ups_on),
    followUp1Days: Number(row.follow_up_1_days ?? DEFAULT_SETTINGS.followUp1Days),
    followUp2Days: Number(row.follow_up_2_days ?? DEFAULT_SETTINGS.followUp2Days),
    maxFollowUps: Number(row.max_follow_ups ?? DEFAULT_SETTINGS.maxFollowUps),
    autoSend: false,
    includeLow: Boolean(row.include_low),
    defaultMode: text(row.default_mode) || DEFAULT_SETTINGS.defaultMode,
  };
}

export async function saveSettings(sql: Sql, userId: string, settings: OutreachSettings): Promise<void> {
  await sql.query(
    `insert into outreach_settings
       (user_id, daily_limit, batch_size, delay_seconds, follow_ups_on, follow_up_1_days,
        follow_up_2_days, max_follow_ups, auto_send, include_low, default_mode, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (user_id) do update set
       daily_limit      = excluded.daily_limit,
       batch_size       = excluded.batch_size,
       delay_seconds    = excluded.delay_seconds,
       follow_ups_on    = excluded.follow_ups_on,
       follow_up_1_days = excluded.follow_up_1_days,
       follow_up_2_days = excluded.follow_up_2_days,
       max_follow_ups   = excluded.max_follow_ups,
       auto_send        = excluded.auto_send,
       include_low      = excluded.include_low,
       default_mode     = excluded.default_mode,
       updated_at       = now()`,
    [
      userId,
      settings.dailyLimit,
      settings.batchSize,
      settings.delaySeconds,
      settings.followUpsOn,
      settings.followUp1Days,
      settings.followUp2Days,
      settings.maxFollowUps,
      settings.autoSend,
      settings.includeLow,
      settings.defaultMode,
    ],
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

/** Stored templates, seeded with the defaults the first time they are asked for. */
export async function loadTemplates(sql: Sql, userId: string): Promise<OutreachTemplate[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, name, kind, subject, body, signature from outreach_templates where user_id = $1 order by id`,
    [userId],
  );
  if (rows.length === 0) {
    await seedTemplates(sql, userId);
    return DEFAULT_TEMPLATES.map((template) => ({ ...template }));
  }
  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    kind: text(row.kind) as TemplateKind,
    subject: text(row.subject),
    body: text(row.body),
    signature: text(row.signature),
  }));
}

async function seedTemplates(sql: Sql, userId: string): Promise<void> {
  for (const template of DEFAULT_TEMPLATES) {
    await saveTemplate(sql, userId, template);
  }
}

export async function saveTemplate(sql: Sql, userId: string, template: OutreachTemplate): Promise<void> {
  await sql.query(
    `insert into outreach_templates (user_id, id, name, kind, subject, body, signature, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     on conflict (user_id, id) do update set
       name = excluded.name, kind = excluded.kind, subject = excluded.subject,
       body = excluded.body, signature = excluded.signature, updated_at = now()`,
    [userId, template.id, template.name, template.kind, template.subject, template.body, template.signature],
  );
}

// ── Emails ───────────────────────────────────────────────────────────────────

const EMAIL_COLUMNS = `id, lead_id, business_name, recipient, subject, body, status, kind,
  generated_by, sending_account, gmail_message_id, gmail_thread_id, error, attempts,
  approved_at, sent_at, replied_at, created_at, updated_at`;

function emailFromRow(row: Record<string, unknown>): OutreachEmail {
  return {
    id: text(row.id),
    leadId: text(row.lead_id),
    businessName: text(row.business_name),
    recipient: text(row.recipient),
    subject: text(row.subject),
    body: text(row.body),
    status: text(row.status) as EmailStatus,
    kind: (text(row.kind) || "initial") as EmailKind,
    generatedBy: text(row.generated_by),
    sendingAccount: text(row.sending_account),
    gmailMessageId: text(row.gmail_message_id),
    gmailThreadId: text(row.gmail_thread_id),
    error: text(row.error),
    attempts: Number(row.attempts ?? 0),
    approvedAt: iso(row.approved_at),
    sentAt: iso(row.sent_at),
    repliedAt: iso(row.replied_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * The whole outreach history. Bounded: this drives the dashboard and the
 * duplicate checks, and both want the full picture, but not an unbounded one.
 */
export async function loadEmails(sql: Sql, userId: string, limit = 5000): Promise<OutreachEmail[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails where user_id = $1 order by created_at desc limit $2`,
    [userId, limit],
  );
  return rows.map(emailFromRow);
}

export async function loadEmail(sql: Sql, userId: string, id: string): Promise<OutreachEmail | null> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails where user_id = $1 and id = $2`,
    [userId, id],
  );
  return rows[0] ? emailFromRow(rows[0]) : null;
}

export type NewEmail = {
  id: string;
  leadId: string;
  businessName: string;
  recipient: string;
  subject: string;
  body: string;
  kind: EmailKind;
  generatedBy: string;
  status: EmailStatus;
  gmailThreadId?: string;
};

/**
 * Write a draft.
 *
 * A lead may only ever hold one *draft* of a given kind: regenerating replaces
 * the text rather than piling up drafts. The partial unique index in the schema
 * separately guarantees only one *live* email per recipient per kind, which is
 * the duplicate protection that actually matters.
 */
export async function upsertDraft(sql: Sql, userId: string, email: NewEmail): Promise<void> {
  await sql.query(
    `insert into outreach_emails
       (user_id, id, lead_id, business_name, recipient, subject, body, status, kind,
        generated_by, gmail_thread_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
     on conflict (user_id, id) do update set
       subject = excluded.subject, body = excluded.body, status = excluded.status,
       generated_by = excluded.generated_by, recipient = excluded.recipient,
       business_name = excluded.business_name, error = '', updated_at = now()`,
    [
      userId,
      email.id,
      email.leadId,
      email.businessName,
      email.recipient,
      email.subject,
      email.body,
      email.status,
      email.kind,
      email.generatedBy,
      email.gmailThreadId ?? "",
    ],
  );
}

/** The existing draft for a lead and kind, so regenerating reuses its id. */
export async function findDraft(
  sql: Sql,
  userId: string,
  leadId: string,
  kind: EmailKind,
): Promise<OutreachEmail | null> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails
      where user_id = $1 and lead_id = $2 and kind = $3 and status in ('draft','failed','skipped')
      order by created_at desc limit 1`,
    [userId, leadId, kind],
  );
  return rows[0] ? emailFromRow(rows[0]) : null;
}

export async function setEmailStatus(
  sql: Sql,
  userId: string,
  id: string,
  status: EmailStatus,
  extra: { error?: string; approved?: boolean } = {},
): Promise<void> {
  await sql.query(
    `update outreach_emails
        set status = $3,
            error = $4,
            approved_at = case when $5 then now() else approved_at end,
            updated_at = now()
      where user_id = $1 and id = $2`,
    [userId, id, status, (extra.error ?? "").slice(0, 500), extra.approved ?? false],
  );
}

/** Claim an email for sending. Returns false if something else already has it. */
export async function claimForSending(sql: Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update outreach_emails
        set status = 'sending', attempts = attempts + 1, updated_at = now()
      where user_id = $1 and id = $2 and status = 'queued'
      returning id`,
    [userId, id],
  );
  return rows.length > 0;
}

export async function markSent(
  sql: Sql,
  userId: string,
  id: string,
  values: { messageId: string; threadId: string; account: string },
): Promise<void> {
  await sql.query(
    `update outreach_emails
        set status = 'sent', gmail_message_id = $3, gmail_thread_id = $4,
            sending_account = $5, sent_at = now(), error = '', updated_at = now()
      where user_id = $1 and id = $2`,
    [userId, id, values.messageId, values.threadId, values.account],
  );
}

export async function markReplied(sql: Sql, userId: string, id: string): Promise<void> {
  await sql.query(
    `update outreach_emails set status = 'replied', replied_at = now(), updated_at = now()
      where user_id = $1 and id = $2 and status <> 'replied'`,
    [userId, id],
  );
}

/** Sent emails still waiting on an answer — the set reply detection polls. */
export async function awaitingReply(sql: Sql, userId: string, limit = 200): Promise<OutreachEmail[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails
      where user_id = $1 and status = 'sent' and gmail_thread_id <> ''
      order by sent_at desc limit $2`,
    [userId, limit],
  );
  return rows.map(emailFromRow);
}

// ── Leads ────────────────────────────────────────────────────────────────────

const LEAD_COLUMNS = `id, business_name, trade, town, phone, email, address, rating, reviews, website,
  maps_link, website_status, place_id, found_at, business_status, demo_url, source,
  called, call_result, follow_up_date, notes,
  website_quality, website_score, website_analysis, website_checked_at,
  email_source, email_confidence, email_found_at, opportunity_score,
  outreach_status, unsubscribed, last_emailed_at, deleted_at, updated_at`;

/**
 * The lead sheet, read server-side.
 *
 * Outreach never takes lead data from the browser. The sheet is local-first, so
 * a client copy can be stale or edited; who may be emailed has to be decided
 * from the row the server holds.
 */
export async function loadLeads(sql: Sql, userId: string, limit = 20000): Promise<Lead[]> {
  const rows = await sql.query<LeadRow>(
    `select ${LEAD_COLUMNS} from leads
      where user_id = $1 and deleted_at is null
      order by updated_at desc limit $2`,
    [userId, limit],
  );
  return rows.map(leadFromRow);
}

export async function loadLead(sql: Sql, userId: string, id: string): Promise<Lead | null> {
  const rows = await sql.query<LeadRow>(
    `select ${LEAD_COLUMNS} from leads where user_id = $1 and id = $2 and deleted_at is null`,
    [userId, id],
  );
  return rows[0] ? leadFromRow(rows[0]) : null;
}

/**
 * Write outreach's own three columns back onto a lead.
 *
 * Deliberately narrow: outreach owns `outreach_status`, `unsubscribed` and
 * `last_emailed_at` and touches nothing else, so it can never overwrite a call
 * result, a note or a follow-up date. `updated_at` moves so the change reaches
 * the phone on the next sync.
 */
export async function updateLeadOutreach(
  sql: Sql,
  userId: string,
  leadId: string,
  values: { outreachStatus?: string; unsubscribed?: string; lastEmailedAt?: string },
): Promise<void> {
  await sql.query(
    `update leads
        set outreach_status = coalesce($3, outreach_status),
            unsubscribed    = coalesce($4, unsubscribed),
            last_emailed_at = coalesce($5, last_emailed_at),
            updated_at      = now()
      where user_id = $1 and id = $2`,
    [
      userId,
      leadId,
      values.outreachStatus ?? null,
      values.unsubscribed ?? null,
      values.lastEmailedAt ?? null,
    ],
  );
}

// ── Suppression ──────────────────────────────────────────────────────────────

export async function loadSuppression(sql: Sql, userId: string): Promise<SuppressionEntry[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select email, reason, lead_id, business_name, created_at
       from outreach_suppression where user_id = $1 order by created_at desc limit 5000`,
    [userId],
  );
  return rows.map((row) => ({
    email: text(row.email),
    reason: text(row.reason),
    leadId: text(row.lead_id),
    businessName: text(row.business_name),
    createdAt: iso(row.created_at),
  }));
}

/**
 * Suppress an address for good.
 *
 * Idempotent, and it never overwrites the original reason: the first time
 * somebody asked to be left alone is the fact worth keeping.
 */
export async function suppress(
  sql: Sql,
  userId: string,
  entry: { email: string; reason: string; leadId?: string; businessName?: string },
): Promise<void> {
  const email = entry.email.trim().toLowerCase();
  if (!email) return;
  await sql.query(
    `insert into outreach_suppression (user_id, email, reason, lead_id, business_name, created_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (user_id, email) do nothing`,
    [userId, email, entry.reason.slice(0, 200), entry.leadId ?? "", entry.businessName ?? ""],
  );
}

export async function suppressedSet(sql: Sql, userId: string): Promise<Set<string>> {
  const rows = await sql.query<{ email: string }>(
    `select email from outreach_suppression where user_id = $1`,
    [userId],
  );
  return new Set(rows.map((row) => row.email.toLowerCase()));
}
