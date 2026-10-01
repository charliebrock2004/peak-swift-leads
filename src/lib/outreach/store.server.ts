/**
 * Every read and write of the outreach tables. **Server-only.**
 *
 * Kept apart from the server functions so the SQL is in one place and the
 * functions stay about policy. Every statement is scoped by `user_id`, which is
 * always the verified id from `authMiddleware` — never anything a client sent.
 */
import { domainOf, parseVerdicts } from "../feedback/verdicts.ts";
import { log } from "../log.server.ts";
import type { Sql } from "@/lib/db";
import { leadFromRow, type LeadRow } from "../leads-row.ts";
import { openSecret, sealSecret } from "../crypto/secrets.server.ts";
import {
  DEFAULT_SETTINGS,
  type AuditSummary,
  type BusinessFacts,
  type LeadWithFacts,
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
import { parseEvidenceRows } from "./evidence-record.ts";
import { sanitizeSettings } from "./limits.ts";
import type { Campaign } from "./campaigns.ts";
import type { BusinessProfile } from "./profile.ts";

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
  /** Opened (plain) token. Stored sealed; see `crypto/secrets.server.ts`. */
  access_token: string;
  /** Opened (plain) token. Stored sealed. */
  refresh_token: string;
  expires_at: Date | string | null;
  scope: string;
  status: string;
  last_error: string;
  connected_at: Date | string;
  last_send_at?: Date | string | null;
  last_health?: string;
  last_health_at?: Date | string | null;
  /**
   * Set when a stored token could not be opened — the encryption key changed
   * or the value is damaged. The tokens above are then empty and the only fix
   * is reconnecting, which the UI says in these words.
   */
  tokenProblem?: string;
};

/**
 * The full record, tokens opened. Never leaves the server.
 *
 * Tokens written before encryption existed are read as-is and immediately
 * re-sealed, so a deployment upgrades its own rows the first time it uses them.
 */
export async function loadGmailAccount(sql: Sql, userId: string): Promise<GmailAccountRow | null> {
  const rows = await sql.query<GmailAccountRow>(
    `select email, access_token, refresh_token, expires_at, scope, status, last_error, connected_at,
            last_send_at, last_health, last_health_at
       from gmail_accounts where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const access = openSecret(row.access_token ?? "");
  const refresh = openSecret(row.refresh_token ?? "");
  if (!access.ok || !refresh.ok) {
    const reason = !refresh.ok ? refresh.reason : !access.ok ? access.reason : "corrupt";
    return {
      ...row,
      access_token: "",
      refresh_token: "",
      tokenProblem:
        reason === "key-changed"
          ? "The stored Gmail tokens were sealed with a different encryption key (TOKEN_ENCRYPTION_KEY, BETTER_AUTH_SECRET or DATABASE_URL changed). Reconnect Gmail."
          : "The stored Gmail tokens could not be read. Reconnect Gmail.",
    };
  }
  if ((access.legacy && access.value) || (refresh.legacy && refresh.value)) {
    // Upgrade in place: seal what was stored in plain text.
    await sql.query(
      `update gmail_accounts set access_token = $2, refresh_token = $3 where user_id = $1`,
      [userId, sealSecret(access.value), sealSecret(refresh.value)],
    );
  }
  return { ...row, access_token: access.value, refresh_token: refresh.value };
}

/** Record that Gmail accepted a message just now. */
export async function markGmailSent(sql: Sql, userId: string): Promise<void> {
  await sql.query(`update gmail_accounts set last_send_at = now() where user_id = $1`, [userId]);
}

/** Store the outcome of the latest health check (JSON), for Settings to show. */
export async function saveGmailHealth(sql: Sql, userId: string, report: string): Promise<void> {
  await sql.query(
    `update gmail_accounts set last_health = $2, last_health_at = now() where user_id = $1`,
    [userId, report.slice(0, 4000)],
  );
}

/** What the browser may see: an address and a health state, never a token. */
export function publicConnection(
  row: GmailAccountRow | null,
  configured: boolean,
  client: {
    clientProject?: string;
    clientMasked?: string;
    redirectUriOverride?: string;
    setup?: GmailConnection["setup"];
    intendedSender?: string;
  } = {},
): GmailConnection {
  // Which OAuth client this deployment will ask Google for. Carried on every
  // connection state, including "not configured", because that is exactly when
  // somebody needs to check it against the Credentials page.
  const identity = {
    clientProject: client.clientProject ?? "",
    clientMasked: client.clientMasked ?? "",
    redirectUriOverride: client.redirectUriOverride ?? "",
    ...(client.setup ? { setup: client.setup } : {}),
    ...(client.intendedSender ? { intendedSender: client.intendedSender } : {}),
  };
  if (!row || row.status === "disconnected") {
    return {
      email: row?.email ?? "",
      status: "disconnected",
      lastError: row?.last_error ?? "",
      connectedAt: "",
      configured,
      ...identity,
    };
  }
  return {
    email: row.email,
    // A token that cannot be opened is a connection that cannot send, whatever
    // the stored status says.
    status: row.tokenProblem ? "needs_attention" : ((row.status as GmailStatus) ?? "disconnected"),
    lastError: row.tokenProblem || row.last_error,
    connectedAt: iso(row.connected_at),
    lastSendAt: iso(row.last_send_at),
    lastHealth: row.last_health ?? "",
    lastHealthAt: iso(row.last_health_at),
    configured,
    ...identity,
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
    [userId, values.email, sealSecret(values.accessToken), sealSecret(values.refreshToken), values.expiresAt, values.scope],
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
    [userId, sealSecret(values.accessToken), sealSecret(values.refreshToken), values.expiresAt],
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
            follow_up_2_days, max_follow_ups, auto_send, include_low, default_mode,
            test_recipient, search_daily_budget, ai_daily_budget, contact_rules
       from outreach_settings where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_SETTINGS };
  // Clamped on the way out as well as on the way in: a row written when the
  // ceilings were looser (an 80-a-day limit from the old settings form) must
  // not let today's code send past today's ceiling.
  return sanitizeSettings({
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
    testRecipient: text(row.test_recipient),
    searchDailyBudget: Number(row.search_daily_budget ?? DEFAULT_SETTINGS.searchDailyBudget),
    aiDailyBudget: Number(row.ai_daily_budget ?? DEFAULT_SETTINGS.aiDailyBudget),
    contactRules: parseJson(row.contact_rules) as OutreachSettings["contactRules"],
  }, DEFAULT_SETTINGS);
}

export async function saveSettings(sql: Sql, userId: string, settings: OutreachSettings): Promise<void> {
  await sql.query(
    `insert into outreach_settings
       (user_id, daily_limit, batch_size, delay_seconds, follow_ups_on, follow_up_1_days,
        follow_up_2_days, max_follow_ups, auto_send, include_low, default_mode,
        test_recipient, search_daily_budget, ai_daily_budget, contact_rules, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb, now())
     on conflict (user_id) do update set
       daily_limit         = excluded.daily_limit,
       batch_size          = excluded.batch_size,
       delay_seconds       = excluded.delay_seconds,
       follow_ups_on       = excluded.follow_ups_on,
       follow_up_1_days    = excluded.follow_up_1_days,
       follow_up_2_days    = excluded.follow_up_2_days,
       max_follow_ups      = excluded.max_follow_ups,
       auto_send           = excluded.auto_send,
       include_low         = excluded.include_low,
       default_mode        = excluded.default_mode,
       test_recipient      = excluded.test_recipient,
       search_daily_budget = excluded.search_daily_budget,
       ai_daily_budget     = excluded.ai_daily_budget,
       contact_rules       = excluded.contact_rules,
       updated_at          = now()`,
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
      settings.testRecipient ?? "",
      settings.searchDailyBudget ?? DEFAULT_SETTINGS.searchDailyBudget,
      settings.aiDailyBudget ?? DEFAULT_SETTINGS.aiDailyBudget,
      JSON.stringify(settings.contactRules ?? DEFAULT_SETTINGS.contactRules),
    ],
  );
}

/** A jsonb column: the pg driver parses it, PGLite may hand back text. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

const EMAIL_COLUMNS = `campaign_id, personalisation_evidence, id, lead_id, business_name, recipient, subject, body, status, kind,
  generated_by, sending_account, gmail_message_id, gmail_thread_id, error, attempts,
  approved_at, sent_at, replied_at, created_at, updated_at,
  rfc822_message_id, run_id, failure_kind, provider_response, sending_started_at, personalisation_note,
  reply_from, reply_subject, reply_snippet, reply_kind, reply_stage, reply_suggestion, bounced_at, auto_reply_at,
  angle, reply_intent`;

function emailFromRow(row: Record<string, unknown>): OutreachEmail {
  return {
    campaignId: text(row.campaign_id),
    personalisationEvidence: text(row.personalisation_evidence),
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
    rfc822MessageId: text(row.rfc822_message_id),
    runId: text(row.run_id),
    failureKind: text(row.failure_kind) as OutreachEmail["failureKind"],
    providerResponse: text(row.provider_response),
    sendingStartedAt: iso(row.sending_started_at),
    personalisationNote: text(row.personalisation_note),
    angle: text(row.angle),
    replyIntent: text(row.reply_intent),
    replyFrom: text(row.reply_from),
    replySubject: text(row.reply_subject),
    replySnippet: text(row.reply_snippet),
    replyKind: text(row.reply_kind) as OutreachEmail["replyKind"],
    replyStage: text(row.reply_stage) as OutreachEmail["replyStage"],
    replySuggestion: text(row.reply_suggestion) as OutreachEmail["replySuggestion"],
    bouncedAt: iso(row.bounced_at),
    autoReplyAt: iso(row.auto_reply_at),
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
  /** Why this email said what it said, for the Review screen. */
  personalisationEvidence?: string;
  /** Which campaign this was written under. Empty outside a campaign. */
  campaignId?: string;
  /** Which run wrote it. Empty outside a run. */
  runId?: string;
  /** One sentence: what the text was personalised from. */
  personalisationNote?: string;
  /** The angle the text leads with (angles.ts). */
  angle?: string;
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
        generated_by, gmail_thread_id, personalisation_evidence, campaign_id, run_id,
        personalisation_note, angle, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now())
     on conflict (user_id, id) do update set
       subject = excluded.subject, body = excluded.body, status = excluded.status,
       generated_by = excluded.generated_by, recipient = excluded.recipient,
       business_name = excluded.business_name,
       -- A manual edit keeps the evidence and note the text was written from.
       personalisation_evidence = case when excluded.personalisation_evidence = '' then outreach_emails.personalisation_evidence
                                       else excluded.personalisation_evidence end,
       personalisation_note = case when excluded.personalisation_note = '' then outreach_emails.personalisation_note
                                   else excluded.personalisation_note end,
       angle = case when excluded.angle = '' then outreach_emails.angle else excluded.angle end,
       -- A campaign or run label is only ever set, never cleared: regenerating a
       -- draft outside a campaign must not erase which campaign it belongs to.
       campaign_id = case when excluded.campaign_id = '' then outreach_emails.campaign_id
                         else excluded.campaign_id end,
       run_id = case when excluded.run_id = '' then outreach_emails.run_id else excluded.run_id end,
       error = '', failure_kind = '', updated_at = now()
     -- Never rewrite an email that has gone, or is going, out.
     where outreach_emails.status not in ('sending', 'sent', 'replied', 'bounced', 'test_sent')`,
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
      email.personalisationEvidence ?? "",
      email.campaignId ?? "",
      email.runId ?? "",
      email.personalisationNote ?? "",
      email.angle ?? "",
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
        set status = 'sending', attempts = attempts + 1, sending_started_at = now(), updated_at = now()
      where user_id = $1 and id = $2 and status = 'queued'
      returning id`,
    [userId, id],
  );
  return rows.length > 0;
}

export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; reason: "not-ready" | "daily-limit" | "campaign-limit"; status: string };

/**
 * Claim one approved email for sending — atomically, and only inside the limits.
 *
 * One statement does the whole check: the email must still be approved or
 * queued, and the number already sent (or mid-send) today must be under the
 * daily limit — and under the campaign's own daily target when it belongs to
 * one. Counting in-flight rows is what stops two tabs pressing Send at once
 * from each seeing room for "one more". The Message-ID we are about to use is
 * written in the same statement, before Gmail is ever called, so a send whose
 * answer is lost can still be found afterwards.
 */
export async function claimWithinLimits(
  sql: Sql,
  userId: string,
  id: string,
  input: {
    rfc822MessageId: string;
    dayStartIso: string;
    dailyLimit: number;
    campaignLimit?: { campaignId: string; limit: number } | null;
  },
): Promise<ClaimOutcome> {
  const campaignId = input.campaignLimit?.campaignId ?? "";
  const campaignLimit = input.campaignLimit ? input.campaignLimit.limit : null;
  const rows = await sql.query<{ id: string }>(
    `update outreach_emails e
        set status = 'sending', attempts = e.attempts + 1, sending_started_at = now(),
            rfc822_message_id = $3, error = '', failure_kind = '', updated_at = now()
      where e.user_id = $1 and e.id = $2 and e.status in ('approved', 'queued')
        and (select count(*) from outreach_emails d
              where d.user_id = $1 and d.kind <> 'test'
                and ((d.status in ('sent', 'replied', 'bounced') and d.sent_at >= $4::timestamptz)
                     or d.status = 'sending')) < $5
        and ($7::integer is null or (select count(*) from outreach_emails c
              where c.user_id = $1 and c.campaign_id = $6 and c.kind <> 'test'
                and ((c.status in ('sent', 'replied', 'bounced') and c.sent_at >= $4::timestamptz)
                     or c.status = 'sending')) < $7)
      returning e.id`,
    [userId, id, input.rfc822MessageId, input.dayStartIso, input.dailyLimit, campaignId, campaignLimit],
  );
  if (rows.length > 0) return { claimed: true };
  const [current] = await sql.query<{ status: string }>(
    `select status from outreach_emails where user_id = $1 and id = $2`,
    [userId, id],
  );
  const status = current?.status ?? "missing";
  if (status !== "approved" && status !== "queued") return { claimed: false, reason: "not-ready", status };
  const sentToday = await countSentSince(sql, userId, input.dayStartIso);
  if (sentToday >= input.dailyLimit) return { claimed: false, reason: "daily-limit", status };
  return { claimed: false, reason: campaignLimit === null ? "daily-limit" : "campaign-limit", status };
}

/** Emails Gmail accepted (or is being handed) since a moment, optionally for one campaign. */
export async function countSentSince(sql: Sql, userId: string, sinceIso: string, campaignId?: string): Promise<number> {
  const rows = await sql.query<{ n: number }>(
    `select count(*)::int as n from outreach_emails
      where user_id = $1 and kind <> 'test'
        and ((status in ('sent', 'replied', 'bounced') and sent_at >= $2::timestamptz) or status = 'sending')
        and ($3::text is null or campaign_id = $3)`,
    [userId, sinceIso, campaignId ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Record a send Gmail confirmed.
 *
 * Only from `sending` (or from a failed row whose send was later found in
 * Gmail), and only with Gmail's own message id — the schema refuses a sent row
 * without one. Returns false when the row was not in a state to be marked.
 */
export async function markSent(
  sql: Sql,
  userId: string,
  id: string,
  values: {
    messageId: string;
    threadId: string;
    account: string;
    rfc822MessageId?: string;
    providerResponse?: string;
    /** When Gmail says it went, for a send found after the fact. Defaults to now. */
    sentAt?: string;
  },
): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update outreach_emails
        set status = 'sent', gmail_message_id = $3, gmail_thread_id = $4,
            sending_account = $5,
            rfc822_message_id = case when $6 = '' then rfc822_message_id else $6 end,
            provider_response = $7,
            sent_at = coalesce($8::timestamptz, now()), error = '', failure_kind = '', updated_at = now()
      where user_id = $1 and id = $2 and status in ('sending', 'failed', 'queued', 'approved')
      returning id`,
    [
      userId,
      id,
      values.messageId,
      values.threadId,
      values.account,
      values.rfc822MessageId ?? "",
      (values.providerResponse ?? "").slice(0, 2000),
      values.sentAt ?? null,
    ],
  );
  return rows.length > 0;
}

/**
 * A send that did not happen, or might have.
 *
 * `status` is where the email goes next: `queued` when Gmail certainly sent
 * nothing and the email should simply wait (a dead token, a rate limit),
 * `failed` when a person has to look — a rejected address, or an attempt whose
 * outcome is unknown and must be checked before any retry.
 */
export async function markSendProblem(
  sql: Sql,
  userId: string,
  id: string,
  values: { status: "queued" | "failed" | "skipped"; kind: string; error: string; providerResponse?: string },
): Promise<void> {
  await sql.query(
    `update outreach_emails
        set status = $3, failure_kind = $4, error = $5, provider_response = $6, updated_at = now()
      where user_id = $1 and id = $2 and status in ('sending', 'queued', 'approved', 'failed')`,
    [userId, id, values.status, values.kind.slice(0, 20), values.error.slice(0, 500), (values.providerResponse ?? "").slice(0, 2000)],
  );
}

/** Emails stuck mid-send — a function that died between claiming and recording. */
export async function staleSending(sql: Sql, userId: string, olderThanSeconds = 120): Promise<OutreachEmail[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails
      where user_id = $1 and status = 'sending'
        and coalesce(sending_started_at, updated_at) < now() - make_interval(secs => $2)
      order by updated_at asc limit 25`,
    [userId, olderThanSeconds],
  );
  return rows.map(emailFromRow);
}

/** Move an approved email back to the queue for another try. Never touches a sent one. */
export async function requeue(sql: Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update outreach_emails set status = 'queued', error = '', failure_kind = '', updated_at = now()
      where user_id = $1 and id = $2 and status in ('failed', 'approved')
      returning id`,
    [userId, id],
  );
  return rows.length > 0;
}

/** The previous delivered email to this lead, for threading a follow-up. */
export async function lastDeliveredFor(sql: Sql, userId: string, leadId: string): Promise<OutreachEmail | null> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails
      where user_id = $1 and lead_id = $2 and status in ('sent', 'replied') and kind <> 'test'
      order by sent_at desc nulls last limit 1`,
    [userId, leadId],
  );
  return rows[0] ? emailFromRow(rows[0]) : null;
}

/** Store the Message-ID header Gmail actually used, once it is known. */
export async function setRfc822MessageId(sql: Sql, userId: string, id: string, messageId: string): Promise<void> {
  if (!messageId) return;
  await sql.query(
    `update outreach_emails set rfc822_message_id = $3 where user_id = $1 and id = $2`,
    [userId, id, messageId.slice(0, 300)],
  );
}

/** A test email: recorded for the audit trail, never counted as outreach. */
export async function insertTestEmail(
  sql: Sql,
  userId: string,
  values: {
    id: string;
    recipient: string;
    subject: string;
    body: string;
    rfc822MessageId: string;
    messageId: string;
    threadId: string;
    account: string;
    providerResponse: string;
  },
): Promise<void> {
  await sql.query(
    `insert into outreach_emails
       (user_id, id, lead_id, business_name, recipient, subject, body, status, kind, generated_by,
        sending_account, gmail_message_id, gmail_thread_id, rfc822_message_id, provider_response,
        attempts, sent_at, created_at, updated_at)
     values ($1,$2,'test','End-to-end test',$3,$4,$5,'test_sent','test','test',$6,$7,$8,$9,$10,1, now(), now(), now())`,
    [
      userId,
      values.id,
      values.recipient,
      values.subject,
      values.body,
      values.account,
      values.messageId,
      values.threadId,
      values.rfc822MessageId,
      values.providerResponse.slice(0, 2000),
    ],
  );
}

export async function markReplied(
  sql: Sql,
  userId: string,
  id: string,
  reply: { from?: string; subject?: string; snippet?: string; kind?: string; suggestion?: string; at?: string; intent?: string } = {},
): Promise<void> {
  await sql.query(
    `update outreach_emails
        set status = 'replied', replied_at = coalesce($8::timestamptz, now()), updated_at = now(),
            reply_from = $3, reply_subject = $4, reply_snippet = $5, reply_kind = $6,
            reply_stage = case when reply_stage = '' then 'new' else reply_stage end,
            reply_suggestion = $7, reply_intent = $9
      where user_id = $1 and id = $2 and status in ('sent', 'replied')`,
    [
      userId,
      id,
      (reply.from ?? "").slice(0, 200),
      (reply.subject ?? "").slice(0, 300),
      (reply.snippet ?? "").slice(0, 600),
      reply.kind ?? "human",
      reply.suggestion ?? "",
      reply.at ?? null,
      (reply.intent ?? "").slice(0, 30),
    ],
  );
}

/** The recipient's server bounced it. Gmail accepted it, so it still counts as sent. */
export async function markBounced(
  sql: Sql,
  userId: string,
  id: string,
  bounce: { from: string; subject: string; snippet: string },
): Promise<void> {
  await sql.query(
    `update outreach_emails
        set status = 'bounced', bounced_at = now(), updated_at = now(), reply_kind = 'bounce', reply_intent = 'bounce',
            reply_from = $3, reply_subject = $4, reply_snippet = $5,
            error = 'Bounced: the recipient address did not accept the email.'
      where user_id = $1 and id = $2 and status = 'sent'`,
    [userId, id, bounce.from.slice(0, 200), bounce.subject.slice(0, 300), bounce.snippet.slice(0, 600)],
  );
}

/** An out-of-office came back. Recorded, but it is not a reply: follow-ups continue. */
export async function markAutoReply(
  sql: Sql,
  userId: string,
  id: string,
  reply: { from: string; subject: string; snippet: string },
): Promise<void> {
  await sql.query(
    `update outreach_emails
        set auto_reply_at = now(), updated_at = now(), reply_kind = 'auto_reply', reply_intent = 'ooo',
            reply_from = $3, reply_subject = $4, reply_snippet = $5
      where user_id = $1 and id = $2 and status = 'sent' and auto_reply_at is null`,
    [userId, id, reply.from.slice(0, 200), reply.subject.slice(0, 300), reply.snippet.slice(0, 600)],
  );
}

/** Move a reply conversation to a stage. Only a replied email has one. */
export async function setReplyStage(sql: Sql, userId: string, id: string, stage: string): Promise<OutreachEmail | null> {
  const rows = await sql.query<Record<string, unknown>>(
    `update outreach_emails set reply_stage = $3, updated_at = now()
      where user_id = $1 and id = $2 and status = 'replied'
      returning ${EMAIL_COLUMNS}`,
    [userId, id, stage],
  );
  return rows[0] ? emailFromRow(rows[0]) : null;
}

/**
 * Sent emails still waiting on an answer — the set reply detection polls.
 *
 * Bounded two ways, because this drives one Gmail API call per row and those
 * calls are sequential. Without a bound the work grows with everything ever
 * sent: at the 30/day ceiling an account passes 200 sent emails inside a week,
 * and the poll then takes longer than a serverless function is allowed to live.
 *
 * - `withinDays` drops conversations old enough to be over. Follow-ups run at
 *   4 and 7 days and stop at two, so a month is well past the point where a
 *   reply is still expected.
 * - `order by updated_at asc` takes the least recently touched first, so
 *   successive polls rotate through the whole waiting set instead of
 *   re-checking the same newest rows forever.
 */
export async function awaitingReply(
  sql: Sql,
  userId: string,
  limit = 40,
  withinDays = 30,
): Promise<OutreachEmail[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${EMAIL_COLUMNS} from outreach_emails
      where user_id = $1 and status = 'sent' and gmail_thread_id <> ''
        and sent_at > now() - make_interval(days => $3)
      order by updated_at asc limit $2`,
    [userId, limit, withinDays],
  );
  return rows.map(emailFromRow);
}

/**
 * Note that these were just looked at.
 *
 * Only moves `updated_at`, which is what `awaitingReply` orders by — so a row
 * checked on this pass goes to the back of the queue for the next one. The
 * status and every other field are left exactly as they are.
 */
export async function markRepliesChecked(sql: Sql, userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql.query(
    `update outreach_emails set updated_at = now()
      where user_id = $1 and id = any($2::text[]) and status = 'sent'`,
    [userId, [...ids]],
  );
}

// ── Leads ────────────────────────────────────────────────────────────────────

const LEAD_COLUMNS = `id, business_name, trade, town, phone, email, address, rating, reviews, website,
  maps_link, website_status, place_id, found_at, business_status, demo_url, source,
  called, call_result, follow_up_date, notes,
  website_quality, website_score, website_analysis, website_checked_at,
  email_source, email_confidence, email_found_at, opportunity_score,
  outreach_status, unsubscribed, last_emailed_at, deleted_at, updated_at,
  company_number, company_type, company_status, company_checked_at,
  legal_form_override, legal_form_note, legal_form_set_at`;

const QUALIFIED_LEAD_COLUMNS = LEAD_COLUMNS.split(",").map((column) => `l.${column.trim()}`).join(", ");

/**
 * Leads with their server-held facts: the synced columns, the website search
 * evidence, and a summary of the latest website audit — one query, no N+1.
 */
function leadsWithFacts(feedback: boolean): string {
  return `select ${QUALIFIED_LEAD_COLUMNS},
    e.data as website_evidence,
    a.id as audit_id, a.status as audit_status, a.http_status as audit_http_status, a.url as audit_url,
    a.finished_at as audit_finished_at, a.opportunity as audit_opportunity, a.points as audit_points,
    a.key_findings as audit_key_findings${feedback ? ",\n    fb.verdicts as feedback_verdicts, fb.wrong_site as feedback_wrong_site" : ""}
  from leads l
  left join lead_evidence e on e.user_id = l.user_id and e.lead_id = l.id and e.kind = 'website'${
    feedback
      ? `
  left join lateral (
    select string_agg(verdict, ',' order by verdict) as verdicts,
           max(case when verdict = 'wrong_website' then website end) as wrong_site
      from prospect_feedback f
     where f.user_id = l.user_id and f.lead_id = l.id
  ) fb on true`
      : ""
  }
  left join lateral (
    select id, status, http_status, url, finished_at, opportunity, points, key_findings
      from website_audits w
     where w.user_id = l.user_id and w.lead_id = l.id
     order by finished_at desc limit 1
  ) a on true`;
}
const LEADS_WITH_FACTS = leadsWithFacts(true);
/** Before 0016: the same, without your feedback marks. */
const LEADS_WITH_FACTS_0011 = leadsWithFacts(false);

/** Run a facts query, falling back to the pre-0016 shape on a deploy mid-migration. */
async function queryLeadsWithFacts(sql: Sql, tail: string, params: unknown[]): Promise<LeadWithFactsRow[]> {
  try {
    return await sql.query<LeadWithFactsRow>(`${LEADS_WITH_FACTS} ${tail}`, params);
  } catch (error) {
    if (!/relation "prospect_feedback" does not exist/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return sql.query<LeadWithFactsRow>(`${LEADS_WITH_FACTS_0011} ${tail}`, params);
  }
}

type LeadWithFactsRow = LeadRow & {
  website_evidence?: string | null;
  audit_id?: string | null;
  audit_status?: string | null;
  audit_http_status?: number | null;
  audit_url?: string | null;
  audit_finished_at?: unknown;
  audit_opportunity?: string | null;
  audit_points?: number | null;
  audit_key_findings?: unknown;
  company_number?: string | null;
  company_type?: string | null;
  company_status?: string | null;
  company_checked_at?: string | null;
  legal_form_override?: string | null;
  legal_form_note?: string | null;
  legal_form_set_at?: string | null;
  feedback_verdicts?: string | null;
  feedback_wrong_site?: string | null;
};

/** The server-owned identity facts (0010) beside the synced lead fields. */
export function factsFromRow(row: LeadWithFactsRow): BusinessFacts {
  const override = text(row.legal_form_override);
  // An audit, or a "confirmed site" record, about a different site than the
  // one on record (the site changed, or you said it was not theirs) describes
  // someone else's website: it must not reach a score or an email.
  const site = domainOf(text(row.website));
  const audit = row.audit_id ? auditSummaryFromRow(row) : null;
  const evidence = row.website_evidence ? (parseEvidenceRows([{ leadId: "x", kind: "website", json: String(row.website_evidence) }]).get("x")?.website ?? null) : null;
  const sameSite = (url: string) => Boolean(site) && domainOf(url) === site;
  return {
    companyNumber: text(row.company_number),
    companyType: text(row.company_type),
    companyStatus: text(row.company_status),
    companyCheckedAt: text(row.company_checked_at),
    legalFormOverride: (["CORPORATE", "INDIVIDUAL", "UNKNOWN", "REVIEW_REQUIRED"].includes(override) ? override : "") as BusinessFacts["legalFormOverride"],
    legalFormNote: text(row.legal_form_note),
    legalFormSetAt: text(row.legal_form_set_at),
    websiteEvidence: evidence && evidence.verified && evidence.url && !sameSite(evidence.url) ? null : evidence,
    audit: audit && sameSite(audit.url) ? audit : null,
    feedback: parseVerdicts(row.feedback_verdicts),
    wrongWebsite: text(row.feedback_wrong_site),
  };
}

function auditSummaryFromRow(row: LeadWithFactsRow): AuditSummary {
  const status = text(row.audit_status);
  const opportunity = text(row.audit_opportunity);
  const findings = parseJson(row.audit_key_findings);
  return {
    id: text(row.audit_id),
    status: status === "unreachable" || status === "error" ? status : "ok",
    httpStatus: Number(row.audit_http_status ?? 0),
    url: text(row.audit_url),
    finishedAt: row.audit_finished_at instanceof Date ? row.audit_finished_at.toISOString() : text(row.audit_finished_at) ? new Date(text(row.audit_finished_at)).toISOString() : "",
    opportunity: (["strong", "moderate", "low", "none", "unmeasured"].includes(opportunity) ? opportunity : "unmeasured") as AuditSummary["opportunity"],
    points: Number(row.audit_points ?? 0),
    keyFindings: Array.isArray(findings)
      ? findings.slice(0, 5).map((item) => {
          const entry = (item ?? {}) as Record<string, unknown>;
          return {
            kind: text(entry.kind),
            title: text(entry.title),
            evidence: text(entry.evidence),
            impact: Number(entry.impact ?? 0),
            observedAt: text(entry.observedAt),
            source: text(entry.source),
          };
        })
      : [],
  };
}

function leadWithFacts(row: LeadWithFactsRow): LeadWithFacts {
  return { ...leadFromRow(row), facts: factsFromRow(row) };
}

/**
 * The lead sheet, read server-side.
 *
 * Outreach never takes lead data from the browser. The sheet is local-first, so
 * a client copy can be stale or edited; who may be emailed has to be decided
 * from the row the server holds.
 */
export async function loadLeads(sql: Sql, userId: string, limit = 20000): Promise<LeadWithFacts[]> {
  const rows = await queryLeadsWithFacts(sql, `where l.user_id = $1 and l.deleted_at is null order by l.updated_at desc limit $2`, [userId, limit]);
  return rows.map(leadWithFacts);
}

/** Several leads with their facts in one query (a Find run's batch), in no particular order. */
export async function loadLeadsByIds(sql: Sql, userId: string, ids: readonly string[]): Promise<LeadWithFacts[]> {
  const unique = [...new Set(ids)].slice(0, 5000);
  if (unique.length === 0) return [];
  const rows = await queryLeadsWithFacts(sql, `where l.user_id = $1 and l.id = any($2::text[]) and l.deleted_at is null`, [userId, unique]);
  return rows.map(leadWithFacts);
}

export async function loadLead(sql: Sql, userId: string, id: string): Promise<LeadWithFacts | null> {
  const rows = await queryLeadsWithFacts(sql, `where l.user_id = $1 and l.id = $2 and l.deleted_at is null`, [userId, id]);
  return rows[0] ? leadWithFacts(rows[0]) : null;
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

/**
 * Record a sales outcome on the lead, from the Replies inbox.
 *
 * The same fields the call buttons write, so the lead's stage, eligibility and
 * every screen agree whichever way the outcome was recorded. `updated_at`
 * moves, so the change reaches every device on its next sync.
 */
export async function updateLeadOutcome(
  sql: Sql,
  userId: string,
  leadId: string,
  values: { called?: string; callResult?: string; followUpDate?: string },
): Promise<void> {
  await sql.query(
    `update leads
        set called         = coalesce($3, called),
            call_result    = coalesce($4, call_result),
            follow_up_date = case when $5::text is null then follow_up_date
                                  when follow_up_date <> '' then follow_up_date else $5 end,
            updated_at     = now()
      where user_id = $1 and id = $2`,
    [userId, leadId, values.called ?? null, values.callResult ?? null, values.followUpDate ?? null],
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
  const rows = await sql.query(
    `insert into outreach_suppression (user_id, email, reason, lead_id, business_name, created_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (user_id, email) do nothing
     returning email`,
    [userId, email, entry.reason.slice(0, 200), entry.leadId ?? "", entry.businessName ?? ""],
  );
  // The address itself stays out of the logs: the lead and the reason identify it.
  if (rows.length) log.info("suppression_added", { userId, leadId: entry.leadId || undefined, reason: entry.reason.slice(0, 120) });
}

/**
 * An opt-out arriving from the recipient's own unsubscribe link.
 *
 * Everything that could still reach the address stops at once: the address is
 * suppressed (permanently, and outliving the lead), the business is marked
 * unsubscribed, and any draft or approved email to it is withdrawn. Idempotent
 * — a second click, or a mail client's one-click POST after a human click,
 * changes nothing.
 */
export async function unsubscribeByLink(
  sql: Sql,
  userId: string,
  claim: { email: string; emailId: string },
  now: Date = new Date(),
): Promise<{ businessName: string; alreadySuppressed: boolean }> {
  const email = claim.email.trim().toLowerCase();
  const rows = await sql.query<{ lead_id: string; business_name: string }>(
    `select lead_id, business_name from outreach_emails where user_id = $1 and id = $2`,
    [userId, claim.emailId],
  );
  const leadId = rows[0]?.lead_id ?? "";
  const businessName = rows[0]?.business_name ?? "";
  const before = await sql.query<{ n: number }>(
    `select count(*)::int as n from outreach_suppression where user_id = $1 and email = $2`,
    [userId, email],
  );
  await suppress(sql, userId, { email, reason: "Unsubscribed with the link in our email", leadId, businessName });
  await sql.query(
    `update leads set unsubscribed = case when unsubscribed <> '' then unsubscribed else $3 end,
                      outreach_status = 'Unsubscribed', updated_at = now()
      where user_id = $1 and (lower(email) = $2 or id = $4)`,
    [userId, email, now.toISOString(), leadId],
  );
  await sql.query(
    `update outreach_emails set status = 'skipped', error = 'The recipient unsubscribed.', updated_at = now()
      where user_id = $1 and lower(recipient) = $2 and status in ('draft', 'approved', 'queued')`,
    [userId, email],
  );
  return { businessName, alreadySuppressed: Number(before[0]?.n ?? 0) > 0 };
}

export async function suppressedSet(sql: Sql, userId: string): Promise<Set<string>> {
  const rows = await sql.query<{ email: string }>(
    `select email from outreach_suppression where user_id = $1`,
    [userId],
  );
  return new Set(rows.map((row) => row.email.toLowerCase()));
}

// ── Activity, runs, reviews (0006) ───────────────────────────────────────────

function isMissingRelation(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: string }).code === "42P01";
  }
  return /does not exist/i.test(error instanceof Error ? error.message : String(error ?? ""));
}

export type ActivityRow = {
  id: string;
  at: string;
  eventType: string;
  leadId: string;
  leadName: string;
  result: string;
  reason: string;
  confidence: number | "";
  error: string;
  metadata: string;
};

export async function insertActivity(
  sql: Sql,
  userId: string,
  event: {
    id: string;
    type: string;
    leadId?: string;
    leadName?: string;
    result?: string;
    reason?: string;
    confidence?: number | "";
    error?: string;
    metadata?: string;
  },
): Promise<void> {
  await sql.query(
    `insert into activity_events
       (user_id, id, at, event_type, lead_id, lead_name, result, reason, confidence, error, metadata)
     values ($1,$2, now(), $3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      userId,
      event.id,
      event.type.slice(0, 60),
      event.leadId ?? "",
      (event.leadName ?? "").slice(0, 200),
      (event.result ?? "").slice(0, 200),
      (event.reason ?? "").slice(0, 400),
      typeof event.confidence === "number" ? event.confidence : null,
      (event.error ?? "").slice(0, 400),
      (event.metadata ?? "").slice(0, 2000),
    ],
  );
}

/**
 * Write an activity row. Never throws: a missing 0006 table or a log failure
 * must not take down sending, generating, or reply checks.
 */
export async function recordActivity(
  sql: Sql,
  userId: string,
  event: {
    id: string;
    type: string;
    leadId?: string;
    leadName?: string;
    result?: string;
    reason?: string;
    confidence?: number | "";
    error?: string;
    metadata?: string;
  },
): Promise<void> {
  try {
    await insertActivity(sql, userId, event);
  } catch (error) {
    if (isMissingRelation(error)) return;
    console.error("[outreach] activity log failed:", error);
  }
}

export async function loadActivity(sql: Sql, userId: string, limit = 80): Promise<ActivityRow[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, at, event_type, lead_id, lead_name, result, reason, confidence, error, metadata
       from activity_events where user_id = $1 order by at desc limit $2`,
    [userId, Math.min(200, Math.max(1, limit))],
  );
  return rows.map((row) => ({
    id: text(row.id),
    at: iso(row.at),
    eventType: text(row.event_type),
    leadId: text(row.lead_id),
    leadName: text(row.lead_name),
    result: text(row.result),
    reason: text(row.reason),
    confidence: row.confidence == null || row.confidence === "" ? "" : Number(row.confidence),
    error: text(row.error),
    metadata: text(row.metadata),
  }));
}

export type StoredRun = {
  id: string;
  startedAt: string;
  finishedAt: string;
  location: string;
  businessType: string;
  mode: string;
  found: number;
  qualified: number;
  hot: number;
  warm: number;
  callCount: number;
  lowCount: number;
  skipped: number;
  emailsFound: number;
  prepared: number;
  sent: number;
  replies: number;
  errors: number;
  bottleneck: string;
  summary: string;
};

export async function insertRun(sql: Sql, userId: string, run: StoredRun): Promise<void> {
  await sql.query(
    `insert into outreach_runs (
       user_id, id, started_at, finished_at, location, business_type, mode,
       found, qualified, hot, warm, call_count, low_count, skipped,
       emails_found, prepared, sent, replies, errors, bottleneck, summary
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     )`,
    [
      userId,
      run.id,
      run.startedAt || new Date().toISOString(),
      run.finishedAt || null,
      run.location.slice(0, 80),
      run.businessType.slice(0, 80),
      run.mode.slice(0, 20),
      run.found,
      run.qualified,
      run.hot,
      run.warm,
      run.callCount,
      run.lowCount,
      run.skipped,
      run.emailsFound,
      run.prepared,
      run.sent,
      run.replies,
      run.errors,
      run.bottleneck.slice(0, 300),
      run.summary.slice(0, 500),
    ],
  );
}

export async function loadRuns(sql: Sql, userId: string, limit = 8): Promise<StoredRun[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, started_at, finished_at, location, business_type, mode,
            found, qualified, hot, warm, call_count, low_count, skipped,
            emails_found, prepared, sent, replies, errors, bottleneck, summary
       from outreach_runs where user_id = $1 order by started_at desc limit $2`,
    [userId, Math.min(30, Math.max(1, limit))],
  );
  const num = (value: unknown) => {
    const next = Number(value);
    return Number.isFinite(next) ? next : 0;
  };
  return rows.map((row) => ({
    id: text(row.id),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    location: text(row.location),
    businessType: text(row.business_type),
    mode: text(row.mode),
    found: num(row.found),
    qualified: num(row.qualified),
    hot: num(row.hot),
    warm: num(row.warm),
    callCount: num(row.call_count),
    lowCount: num(row.low_count),
    skipped: num(row.skipped),
    emailsFound: num(row.emails_found),
    prepared: num(row.prepared),
    sent: num(row.sent),
    replies: num(row.replies),
    errors: num(row.errors),
    bottleneck: text(row.bottleneck),
    summary: text(row.summary),
  }));
}

export type LeadReview = {
  leadId: string;
  decision: string;
  note: string;
  decidedAt: string;
};

export async function upsertReview(
  sql: Sql,
  userId: string,
  review: { leadId: string; decision: string; note?: string },
): Promise<void> {
  const leadId = review.leadId.trim();
  if (!leadId) return;
  await sql.query(
    `insert into lead_reviews (user_id, lead_id, decision, note, decided_at)
     values ($1,$2,$3,$4, now())
     on conflict (user_id, lead_id) do update set
       decision   = excluded.decision,
       note       = excluded.note,
       decided_at = now()`,
    [userId, leadId, review.decision.slice(0, 40), (review.note ?? "").slice(0, 400)],
  );
}

export async function loadReviews(sql: Sql, userId: string): Promise<LeadReview[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select lead_id, decision, note, decided_at from lead_reviews where user_id = $1`,
    [userId],
  );
  return rows.map((row) => ({
    leadId: text(row.lead_id),
    decision: text(row.decision),
    note: text(row.note),
    decidedAt: iso(row.decided_at),
  }));
}

// ── Campaigns ────────────────────────────────────────────────────────────────

/**
 * Campaign rows.
 *
 * Only intent is stored: name, what to look for, how much and how fast. Every
 * progress number is computed from `leads` and `outreach_emails` at read time,
 * so a campaign row can never claim a send that did not happen.
 */
export async function loadCampaigns(sql: Sql, userId: string, limit = 100): Promise<Campaign[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, name, status, locations, trades, target_prospects, daily_target,
            batch_size, send_mode, created_at, updated_at
       from campaigns where user_id = $1 order by updated_at desc limit $2`,
    [userId, Math.min(200, Math.max(1, limit))],
  );
  const num = (value: unknown, fallback: number) => {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  };
  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    status: (text(row.status) || "DRAFT") as Campaign["status"],
    locations: text(row.locations),
    trades: text(row.trades),
    targetProspects: num(row.target_prospects, 50),
    dailyTarget: num(row.daily_target, 10),
    batchSize: num(row.batch_size, 5),
    sendMode: text(row.send_mode) === "send" ? "send" : "prepare",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

export async function loadCampaign(sql: Sql, userId: string, id: string): Promise<Campaign | null> {
  const all = await loadCampaigns(sql, userId, 200);
  return all.find((campaign) => campaign.id === id) ?? null;
}

/** Create or update one campaign. `created_at` is never moved by an update. */
export async function upsertCampaign(sql: Sql, userId: string, campaign: Campaign): Promise<void> {
  await sql.query(
    `insert into campaigns
       (user_id, id, name, status, locations, trades, target_prospects,
        daily_target, batch_size, send_mode, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
     on conflict (user_id, id) do update set
       name = excluded.name, status = excluded.status, locations = excluded.locations,
       trades = excluded.trades, target_prospects = excluded.target_prospects,
       daily_target = excluded.daily_target, batch_size = excluded.batch_size,
       send_mode = excluded.send_mode, updated_at = now()`,
    [
      userId,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.locations,
      campaign.trades,
      campaign.targetProspects,
      campaign.dailyTarget,
      campaign.batchSize,
      campaign.sendMode,
    ],
  );
}

/** Every campaign membership for this account: campaign id → lead ids. */
export async function loadCampaignMembers(
  sql: Sql,
  userId: string,
  limit = 20000,
): Promise<{ campaignId: string; leadId: string }[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select campaign_id, lead_id from campaign_prospects
       where user_id = $1 order by added_at desc limit $2`,
    [userId, Math.min(50000, Math.max(1, limit))],
  );
  return rows.map((row) => ({ campaignId: text(row.campaign_id), leadId: text(row.lead_id) }));
}

/**
 * Add prospects to a campaign.
 *
 * Idempotent by primary key: re-running discovery for a campaign re-adds
 * nothing. Membership is all this writes — it never touches a lead's outreach
 * state, which is why a rediscovery run cannot reset where a prospect had got
 * to.
 */
export async function addCampaignProspects(
  sql: Sql,
  userId: string,
  campaignId: string,
  leadIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(leadIds.filter((id) => id.trim()))].slice(0, 1000);
  if (ids.length === 0) return 0;
  await sql.query(
    `insert into campaign_prospects (user_id, campaign_id, lead_id)
       select $1, $2, unnest($3::text[])
     on conflict (user_id, campaign_id, lead_id) do nothing`,
    [userId, campaignId, ids],
  );
  return ids.length;
}

// ── Business profile (0009) ──────────────────────────────────────────────────

const PROFILE_COLUMNS: [keyof BusinessProfile, string][] = [
  ["businessName", "business_name"],
  ["senderName", "sender_name"],
  ["senderEmail", "sender_email"],
  ["website", "website"],
  ["services", "services"],
  ["location", "location"],
  ["areasServed", "areas_served"],
  ["tone", "tone"],
  ["cta", "cta"],
  ["portfolioUrl", "portfolio_url"],
  ["signature", "signature"],
  ["optOutLine", "opt_out_line"],
  ["targetAreas", "target_areas"],
  ["targetTrades", "target_trades"],
  ["preferredTrades", "preferred_trades"],
  ["excludedTrades", "excluded_trades"],
  ["typicalProject", "typical_project"],
  ["minimumProject", "minimum_project"],
  ["contactMethods", "contact_methods"],
  ["examples", "examples"],
  ["businessAddress", "business_address"],
];

/** The columns 0009 created — what a deploy that has not run 0016 yet has. */
const PROFILE_COLUMNS_0009 = PROFILE_COLUMNS.slice(0, 12);

const missingColumn = (error: unknown) => /column .* does not exist/i.test(error instanceof Error ? error.message : String(error));

/** The stored profile, exactly as saved — empty fields stay empty. */
export async function loadProfile(sql: Sql, userId: string): Promise<Partial<BusinessProfile> | null> {
  const read = (columns: typeof PROFILE_COLUMNS) =>
    sql.query<Record<string, unknown>>(`select ${columns.map(([, column]) => column).join(", ")} from business_profile where user_id = $1`, [userId]);
  // Mid-migration (0016 not yet applied) the older columns still load.
  let columns = PROFILE_COLUMNS;
  const rows = await read(columns).catch((error: unknown) => {
    if (!missingColumn(error)) throw error;
    columns = PROFILE_COLUMNS_0009;
    return read(columns);
  });
  const row = rows[0];
  if (!row) return null;
  const out: Partial<BusinessProfile> = {};
  for (const [key, column] of columns) out[key] = text(row[column]);
  return out;
}

export async function saveProfile(sql: Sql, userId: string, profile: BusinessProfile, options: { onboarded?: boolean } = {}): Promise<void> {
  const columns = PROFILE_COLUMNS.map(([, column]) => column);
  await sql.query(
    `insert into business_profile (user_id, ${columns.join(", ")}, onboarded_at, updated_at)
     values ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")}, case when $${columns.length + 2}::boolean then now() end, now())
     on conflict (user_id) do update set
       ${columns.map((column) => `${column} = excluded.${column}`).join(",\n       ")},
       onboarded_at = coalesce(business_profile.onboarded_at, excluded.onboarded_at),
       updated_at = now()`,
    [userId, ...PROFILE_COLUMNS.map(([key]) => profile[key]), Boolean(options.onboarded)],
  );
}

/** When the welcome was finished, or "" — before 0016, always "". */
export async function loadOnboardedAt(sql: Sql, userId: string): Promise<string> {
  const rows = await sql
    .query<{ onboarded_at: unknown }>(`select onboarded_at from business_profile where user_id = $1`, [userId])
    .catch(() => [] as { onboarded_at: unknown }[]);
  const at = rows[0]?.onboarded_at;
  return at instanceof Date ? at.toISOString() : at ? String(at) : "";
}

// ── Budgets for paid calls (0009) ────────────────────────────────────────────

/**
 * Spend `amount` of today's budget for `kind`, or refuse.
 *
 * One conditional upsert, so two requests racing for the last credit cannot
 * both win. Returns the new total, or null when the budget would be exceeded —
 * in which case nothing was recorded and the caller must not make the call.
 */
export async function consumeBudget(
  sql: Sql,
  userId: string,
  kind: "search" | "ai" | "companies-house" | "audit" | "email-verify",
  amount: number,
  limit: number,
  day: string = new Date().toISOString().slice(0, 10),
): Promise<number | null> {
  if (amount <= 0) return 0;
  if (amount > limit) return null;
  const rows = await sql.query<{ used: number }>(
    `insert into usage_counters (user_id, day, kind, used) values ($1, $2, $3, $4)
     on conflict (user_id, day, kind) do update set used = usage_counters.used + excluded.used
       where usage_counters.used + excluded.used <= $5
     returning used`,
    [userId, day, kind, amount, limit],
  );
  return rows[0] ? Number(rows[0].used) : null;
}

export async function budgetUsed(
  sql: Sql,
  userId: string,
  day: string = new Date().toISOString().slice(0, 10),
): Promise<{ search: number; ai: number }> {
  const rows = await sql.query<{ kind: string; used: number }>(
    `select kind, used from usage_counters where user_id = $1 and day = $2`,
    [userId, day],
  );
  const out = { search: 0, ai: 0 };
  for (const row of rows) if (row.kind === "search" || row.kind === "ai") out[row.kind] = Number(row.used);
  return out;
}

// ── Evidence per lead (0009) ─────────────────────────────────────────────────

export async function saveLeadEvidence(
  sql: Sql,
  userId: string,
  leadId: string,
  kind: "website" | "email",
  data: unknown,
): Promise<void> {
  if (!leadId.trim()) return;
  await sql.query(
    `insert into lead_evidence (user_id, lead_id, kind, data, updated_at) values ($1,$2,$3,$4, now())
     on conflict (user_id, lead_id, kind) do update set data = excluded.data, updated_at = now()`,
    [userId, leadId, kind, JSON.stringify(data).slice(0, 12000)],
  );
}

/** One evidence row. `json` is parsed on the client (see `evidence-record.ts`). */
export type StoredEvidence = { leadId: string; kind: "website" | "email"; json: string; updatedAt: string };

export async function loadLeadEvidence(sql: Sql, userId: string, leadIds?: readonly string[]): Promise<StoredEvidence[]> {
  const rows = await sql.query<Record<string, unknown>>(
    leadIds
      ? `select lead_id, kind, data, updated_at from lead_evidence where user_id = $1 and lead_id = any($2::text[])`
      : `select lead_id, kind, data, updated_at from lead_evidence where user_id = $1 order by updated_at desc limit 5000`,
    leadIds ? [userId, [...leadIds]] : [userId],
  );
  return rows.map((row) => ({
    leadId: text(row.lead_id),
    kind: text(row.kind) as "website" | "email",
    json: text(row.data),
    updatedAt: iso(row.updated_at),
  }));
}

// ── Runs, recorded as they happen (0009) ─────────────────────────────────────

export type RunRow = StoredRun & {
  status: string;
  phase: string;
  campaignId: string;
  target: number;
  dailyLimit: number;
  funnel: string;
  leadIds: string[];
  updatedAt: string;
};

/**
 * Create or update a run. The run is written when it starts and after every
 * stage, so a tab closed mid-run still leaves an honest record of how far it
 * got. `lead_ids` is bounded; the funnel is whatever the run measured.
 */
export async function upsertRun(sql: Sql, userId: string, run: RunRow): Promise<void> {
  await sql.query(
    `insert into outreach_runs (
       user_id, id, started_at, finished_at, location, business_type, mode,
       found, qualified, hot, warm, call_count, low_count, skipped,
       emails_found, prepared, sent, replies, errors, bottleneck, summary,
       status, phase, campaign_id, target, daily_limit, funnel, lead_ids, updated_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
       $22,$23,$24,$25,$26,$27,$28, now()
     )
     on conflict (user_id, id) do update set
       finished_at = excluded.finished_at, location = excluded.location,
       business_type = excluded.business_type, mode = excluded.mode,
       found = excluded.found, qualified = excluded.qualified, hot = excluded.hot,
       warm = excluded.warm, call_count = excluded.call_count, low_count = excluded.low_count,
       skipped = excluded.skipped, emails_found = excluded.emails_found,
       prepared = excluded.prepared, sent = excluded.sent, replies = excluded.replies,
       errors = excluded.errors, bottleneck = excluded.bottleneck, summary = excluded.summary,
       status = excluded.status, phase = excluded.phase, campaign_id = excluded.campaign_id,
       target = excluded.target, daily_limit = excluded.daily_limit, funnel = excluded.funnel,
       lead_ids = case when excluded.lead_ids = '' then outreach_runs.lead_ids else excluded.lead_ids end,
       updated_at = now()`,
    [
      userId,
      run.id,
      run.startedAt || new Date().toISOString(),
      run.finishedAt || null,
      run.location.slice(0, 80),
      run.businessType.slice(0, 200),
      run.mode.slice(0, 20),
      run.found,
      run.qualified,
      run.hot,
      run.warm,
      run.callCount,
      run.lowCount,
      run.skipped,
      run.emailsFound,
      run.prepared,
      run.sent,
      run.replies,
      run.errors,
      run.bottleneck.slice(0, 300),
      run.summary.slice(0, 500),
      run.status.slice(0, 20),
      run.phase.slice(0, 40),
      run.campaignId.slice(0, 40),
      run.target,
      run.dailyLimit,
      run.funnel.slice(0, 8000),
      run.leadIds.length ? JSON.stringify(run.leadIds.slice(0, 500)) : "",
    ],
  );
}

function runFromRow(row: Record<string, unknown>): RunRow {
  const num = (value: unknown) => {
    const next = Number(value);
    return Number.isFinite(next) ? next : 0;
  };
  let leadIds: string[] = [];
  try {
    const parsed = JSON.parse(text(row.lead_ids) || "[]") as unknown;
    if (Array.isArray(parsed)) leadIds = parsed.map(String);
  } catch {
    leadIds = [];
  }
  return {
    id: text(row.id),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    location: text(row.location),
    businessType: text(row.business_type),
    mode: text(row.mode),
    found: num(row.found),
    qualified: num(row.qualified),
    hot: num(row.hot),
    warm: num(row.warm),
    callCount: num(row.call_count),
    lowCount: num(row.low_count),
    skipped: num(row.skipped),
    emailsFound: num(row.emails_found),
    prepared: num(row.prepared),
    sent: num(row.sent),
    replies: num(row.replies),
    errors: num(row.errors),
    bottleneck: text(row.bottleneck),
    summary: text(row.summary),
    status: text(row.status) || "done",
    phase: text(row.phase),
    campaignId: text(row.campaign_id),
    target: num(row.target),
    dailyLimit: num(row.daily_limit),
    funnel: text(row.funnel),
    leadIds,
    updatedAt: iso(row.updated_at),
  };
}

const RUN_COLUMNS = `id, started_at, finished_at, location, business_type, mode,
  found, qualified, hot, warm, call_count, low_count, skipped,
  emails_found, prepared, sent, replies, errors, bottleneck, summary,
  status, phase, campaign_id, target, daily_limit, funnel, lead_ids, updated_at`;

export async function loadRunRows(sql: Sql, userId: string, limit = 30): Promise<RunRow[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${RUN_COLUMNS} from outreach_runs where user_id = $1 order by started_at desc limit $2`,
    [userId, Math.min(100, Math.max(1, limit))],
  );
  return rows.map(runFromRow);
}

export async function loadRunRow(sql: Sql, userId: string, id: string): Promise<RunRow | null> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${RUN_COLUMNS} from outreach_runs where user_id = $1 and id = $2`,
    [userId, id],
  );
  return rows[0] ? runFromRow(rows[0]) : null;
}

/**
 * Runs left "running" long after anyone could still be driving them — the tab
 * was closed. Marked interrupted so history never shows a run as live forever.
 */
export async function closeAbandonedRuns(sql: Sql, userId: string, olderThanMinutes = 30): Promise<void> {
  await sql.query(
    `update outreach_runs set status = 'interrupted', finished_at = coalesce(finished_at, updated_at)
      where user_id = $1 and status = 'running' and updated_at < now() - make_interval(mins => $2)`,
    [userId, olderThanMinutes],
  );
}

// ── State version ────────────────────────────────────────────────────────────

/**
 * A fingerprint of everything the app's state is built from: row counts and
 * the latest change in each table, plus today's date (the daily allowance
 * turns over at midnight). One small query, so a screen coming back into view
 * can ask "has anything changed?" instead of reloading thousands of rows.
 * Any failure (a table missing mid-migration) returns "" — which never
 * matches, so the caller simply loads in full.
 */
export async function stateVersion(sql: Sql, userId: string, now: Date = new Date()): Promise<string> {
  const part = (table: string, column: string, counted = true) =>
    `(select ${counted ? "count(*)::text || ':' || " : ""}coalesce(max(${column})::text, '') from ${table} where user_id = $1)`;
  try {
    const rows = await sql.query<{ v: string }>(
      `select concat_ws('|',
          ${part("leads", "updated_at")},
          ${part("outreach_emails", "updated_at")},
          ${part("outreach_settings", "updated_at", false)},
          ${part("business_profile", "updated_at", false)},
          ${part("outreach_suppression", "created_at")},
          ${part("gmail_accounts", "updated_at", false)},
          ${part("outreach_templates", "updated_at")},
          ${part("campaigns", "updated_at")},
          ${part("campaign_prospects", "added_at")},
          ${part("lead_evidence", "updated_at")},
          ${part("website_audits", "finished_at")},
          ${part("prospect_feedback", "created_at")},
          (select coalesce(sum(used), 0)::text from usage_counters where user_id = $1 and day = $2)
        ) as v`,
      [userId, now.toISOString().slice(0, 10)],
    );
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(`${now.toISOString().slice(0, 10)}|${rows[0]?.v ?? ""}`).digest("base64url").slice(0, 24);
  } catch {
    return "";
  }
}
