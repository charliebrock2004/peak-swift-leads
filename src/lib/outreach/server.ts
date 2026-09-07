/**
 * The outreach server functions.
 *
 * This is where policy lives: nothing else may send an email, suppress an
 * address, or move an email's status. Every one of these runs behind
 * `authMiddleware`, so `context.userId` is verified and is the only scope any
 * query ever uses.
 *
 * Two rules shape the whole file:
 *
 * 1. **The server decides who may be emailed**, from the lead row it holds —
 *    never from anything the browser sent. A client can ask to email lead X; it
 *    cannot assert that lead X is eligible.
 * 2. **Nothing reaches Gmail without passing eligibility and the quality gate
 *    again, at send time.** Approval can be minutes or days old, and a lead can
 *    reply, unsubscribe or be marked Not Interested in between.
 *
 * `@/lib/db`, the Gmail client and the store are imported *inside* handlers:
 * this module is also loaded by the browser for its server-function stubs, and
 * `pg` and the OAuth secret must never follow it there.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { newLeadId, type Lead } from "@/lib/leads";
import { composeEmail, parseAiDraft, type AiDraft } from "./compose.ts";
import { checkEligibility, emptyContext, type EligibilityContext } from "./eligibility.ts";
import { allowance, nextBatch, sanitizeSettings } from "./limits.ts";
import { checkEmailQuality, readsAsUnsubscribe } from "./quality.ts";
import {
  classifySetupError,
  SETUP_COPY,
  UNDEFINED_TABLE,
  type SetupReason,
} from "./setup-state.ts";
import { SENDER_STUDIO } from "./templates.ts";
import {
  DEFAULT_SETTINGS,
  type EmailKind,
  type GmailConnection,
  type OutreachEmail,
  type OutreachSettings,
  type OutreachTemplate,
  type SuppressionEntry,
} from "./types.ts";

// ── shared helpers ───────────────────────────────────────────────────────────

const str = (value: unknown, max = 200): string =>
  value == null ? "" : String(value).trim().slice(0, max);

function idList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(entry, 64)).filter(Boolean).slice(0, max);
}

/** The failure shape every one of these functions uses. Never throws at the UI. */
export type Fail = {
  ok: false;
  error: string;
  needsAttention?: boolean;
  /** Set when the failure is a setup problem the UI should explain, not just report. */
  setup?: SetupReason;
};

/**
 * Build the context the eligibility rules need, from what is actually stored:
 * the suppression list, and which leads and addresses already have a live email.
 */
function contextFrom(
  emails: readonly OutreachEmail[],
  suppressed: ReadonlySet<string>,
  settings: OutreachSettings,
  kind: EmailKind = "initial",
): EligibilityContext {
  const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
  const alreadyContacted = new Set<string>();
  const contactedAddresses = new Set<string>();
  for (const email of emails) {
    if (email.kind !== kind || !live.has(email.status)) continue;
    alreadyContacted.add(email.leadId);
    if (email.recipient) contactedAddresses.add(email.recipient.toLowerCase());
  }
  return {
    settings: { includeLow: settings.includeLow },
    suppressed,
    alreadyContacted,
    contactedAddresses,
  };
}

/** Every server function needs the same four things; fetch them once. */
async function loadWorld(userId: string) {
  const { getSql } = await import("@/lib/db");
  const store = await import("./store.server.ts");
  const sql = await getSql();
  const [settings, emails, suppression, templates] = await Promise.all([
    store.loadSettings(sql, userId),
    store.loadEmails(sql, userId),
    store.suppressedSet(sql, userId),
    store.loadTemplates(sql, userId),
  ]);
  return { sql, store, settings, emails, suppression, templates };
}

// ── AI ───────────────────────────────────────────────────────────────────────

/**
 * The project's existing AI key, used for personalisation.
 *
 * Absent is not an error: `composeEmail` falls back to the templates and says
 * so. That keeps outreach fully usable with no AI configured at all.
 */
function aiGenerator(): ((prompt: string) => Promise<AiDraft | null>) | undefined {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const base = (process.env.XAI_API_BASE || "https://api.x.ai/v1").replace(/\/+$/, "");
  return async (prompt: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: "grok-4.20-0309-non-reasoning",
          input: [
            {
              role: "system",
              content:
                "You write short, honest, British-English cold emails for a small web design studio. You never invent facts and never insult anyone. Reply with JSON only.",
            },
            { role: "user", content: prompt },
          ],
          max_output_tokens: 900,
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        output_text?: unknown;
        output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
      };
      let text = typeof payload.output_text === "string" ? payload.output_text : "";
      if (!text) {
        const chunks: string[] = [];
        for (const item of payload.output ?? []) {
          for (const part of item.content ?? []) if (part.text) chunks.push(part.text);
        }
        text = chunks.join("\n");
      }
      return parseAiDraft(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Gmail token handling ─────────────────────────────────────────────────────

type UsableToken = { ok: true; accessToken: string; email: string } | Fail;

/**
 * A live access token, refreshing it first if it is close to expiry.
 *
 * A fatal refresh failure marks the connection `needs_attention` and stops
 * whatever was being attempted: retrying a revoked grant can only fail again.
 */
async function usableToken(userId: string): Promise<UsableToken> {
  const { getSql } = await import("@/lib/db");
  const store = await import("./store.server.ts");
  const gmail = await import("@/lib/gmail/client.server.ts");
  const { needsRefresh } = await import("@/lib/gmail/oauth.ts");

  const sql = await getSql();
  const account = await store.loadGmailAccount(sql, userId);
  if (!account || account.status === "disconnected" || !account.refresh_token) {
    return { ok: false, error: "Gmail is not connected." };
  }
  const expiresAt = account.expires_at
    ? account.expires_at instanceof Date
      ? account.expires_at.toISOString()
      : String(account.expires_at)
    : "";

  if (account.access_token && !needsRefresh(expiresAt)) {
    return { ok: true, accessToken: account.access_token, email: account.email };
  }

  const refreshed = await gmail.refreshAccessToken(account.refresh_token);
  if (!refreshed.ok) {
    if (refreshed.fatal) await store.markGmailProblem(sql, userId, refreshed.error);
    return {
      ok: false,
      error: refreshed.fatal ? "Gmail connection needs attention. Reconnect the account." : refreshed.error,
      needsAttention: refreshed.fatal,
    };
  }
  await store.updateGmailAccessToken(sql, userId, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  });
  return { ok: true, accessToken: refreshed.accessToken, email: account.email };
}

// ── State ────────────────────────────────────────────────────────────────────

export type OutreachState = {
  ok: true;
  connection: GmailConnection;
  settings: OutreachSettings;
  templates: OutreachTemplate[];
  emails: OutreachEmail[];
  suppression: SuppressionEntry[];
  leads: Lead[];
  allowance: { sent: number; limit: number; remaining: number; batch: number; atLimit: boolean };
  aiAvailable: boolean;
};

/** Everything the outreach screen needs, in one round trip. */
export const getOutreachState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<OutreachState | Fail> => {
    try {
      const { sql, store, settings, emails, templates } = await loadWorld(context.userId);
      const gmail = await import("@/lib/gmail/client.server.ts");
      const [account, suppression, leads] = await Promise.all([
        store.loadGmailAccount(sql, context.userId),
        store.loadSuppression(sql, context.userId),
        store.loadLeads(sql, context.userId),
      ]);
      return {
        ok: true,
        connection: store.publicConnection(account, gmail.googleConfig() !== null),
        settings,
        templates,
        emails,
        suppression,
        leads,
        allowance: allowance(emails, settings),
        aiAvailable: Boolean(process.env.XAI_API_KEY?.trim()),
      };
    } catch (error) {
      console.error("[outreach] state failed:", error);
      const setup = await classifyStateFailure(error);
      return { ok: false, error: SETUP_COPY[setup].detail, setup };
    }
  });

/**
 * Work out what actually went wrong loading outreach state.
 *
 * The environment is asked first and the error text second: `dbSource` and the
 * Postgres error code are facts, whereas message matching is a guess. Only when
 * neither is conclusive does this fall back to reading the message.
 */
async function classifyStateFailure(error: unknown): Promise<SetupReason> {
  const { dbSource } = await import("@/lib/db");
  if (dbSource === "none") return "no-database";
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === UNDEFINED_TABLE) return "schema-missing";
  }
  return classifySetupError(error instanceof Error ? error.message : String(error ?? ""));
}

// ── Gmail connect / disconnect / test ────────────────────────────────────────

/**
 * Start the OAuth dance.
 *
 * The client id is read on the server; the browser only ever receives the URL
 * to send the person to. `state` is returned so the callback page can prove the
 * redirect came from a flow this browser started.
 */
export const startGmailConnect = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ origin: str((input as { origin?: unknown })?.origin, 200) }))
  .handler(async ({ data }): Promise<{ ok: true; url: string; state: string } | Fail> => {
    const gmail = await import("@/lib/gmail/client.server.ts");
    const { buildAuthUrl, newState } = await import("@/lib/gmail/oauth.ts");
    const config = gmail.googleConfig();
    if (!config) {
      return {
        ok: false,
        error:
          "Google OAuth is not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment.",
      };
    }
    const redirectUri = redirectUriFor(data.origin);
    if (!redirectUri) return { ok: false, error: "Could not work out the redirect URI." };
    const state = newState();
    return {
      ok: true,
      state,
      url: buildAuthUrl({
        clientId: config.clientId,
        redirectUri,
        state,
        loginHint: gmail.allowedSender() || undefined,
        authEndpoint: process.env.GOOGLE_OAUTH_BASE
          ? `${process.env.GOOGLE_OAUTH_BASE.replace(/\/+$/, "")}/auth`
          : undefined,
      }),
    };
  });

/**
 * The redirect URI must match Google's registered value byte for byte.
 *
 * `GOOGLE_REDIRECT_URI` wins when set; otherwise it is built from the origin the
 * browser is actually on, which is what makes this work unchanged on localhost,
 * a preview URL and production.
 */
function redirectUriFor(origin: string): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) return configured;
  const clean = origin.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) return "";
  return `${clean}/oauth/gmail`;
}

export const completeGmailConnect = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { code?: unknown; origin?: unknown };
    return { code: str(source.code, 512), origin: str(source.origin, 200) };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; connection: GmailConnection } | Fail> => {
    if (!data.code) return { ok: false, error: "Google did not return an authorisation code." };
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const gmail = await import("@/lib/gmail/client.server.ts");

    const redirectUri = redirectUriFor(data.origin);
    const exchanged = await gmail.exchangeCode(data.code, redirectUri);
    if (!exchanged.ok) return { ok: false, error: exchanged.error };

    const profile = await gmail.getProfile(exchanged.accessToken);
    if (!profile.ok) return { ok: false, error: `Connected, but Gmail would not identify the account: ${profile.error}` };

    // When a sender is pinned, connecting the wrong account is refused outright
    // rather than quietly sending from somewhere unexpected.
    const expected = gmail.allowedSender();
    if (expected && profile.email.toLowerCase() !== expected) {
      await gmail.revokeToken(exchanged.accessToken);
      return { ok: false, error: `That is ${profile.email}. This app is set up to send from ${expected}.` };
    }

    const sql = await getSql();
    await store.saveGmailTokens(sql, context.userId, {
      email: profile.email,
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      expiresAt: exchanged.expiresAt,
      scope: exchanged.scope,
    });
    const account = await store.loadGmailAccount(sql, context.userId);
    return { ok: true, connection: store.publicConnection(account, true) };
  });

export const disconnectGmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ ok: true } | Fail> => {
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const gmail = await import("@/lib/gmail/client.server.ts");
    const sql = await getSql();
    const account = await store.loadGmailAccount(sql, context.userId);
    // Tell Google first, but never let that failure block forgetting locally.
    if (account?.refresh_token) await gmail.revokeToken(account.refresh_token);
    await store.clearGmailAccount(sql, context.userId);
    return { ok: true };
  });

export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ to: str((input as { to?: unknown })?.to, 254) }))
  .handler(async ({ data, context }): Promise<{ ok: true; messageId: string; to: string } | Fail> => {
    const token = await usableToken(context.userId);
    if (!token.ok) return token;
    const gmail = await import("@/lib/gmail/client.server.ts");
    const { buildRawMessage } = await import("@/lib/gmail/mime.ts");
    const to = data.to || token.email;
    const raw = buildRawMessage({
      to,
      from: token.email,
      fromName: SENDER_STUDIO,
      subject: "Peak Swift outreach — test email",
      body: `This is a test from Peak Swift Leads.\n\nIf you are reading this, the Gmail connection works and outreach can send from ${token.email}.\n\nNo prospect was contacted.`,
    });
    const sent = await gmail.sendMessage(token.accessToken, raw);
    if (!sent.ok) {
      if (sent.fatal) {
        const { getSql } = await import("@/lib/db");
        const store = await import("./store.server.ts");
        await store.markGmailProblem(await getSql(), context.userId, sent.error);
      }
      return { ok: false, error: sent.error, needsAttention: sent.fatal };
    }
    return { ok: true, messageId: sent.messageId, to };
  });

// ── Generation ───────────────────────────────────────────────────────────────

export type GeneratedRow = {
  leadId: string;
  ok: boolean;
  emailId?: string;
  subject?: string;
  body?: string;
  generatedBy?: string;
  note?: string;
  error?: string;
};

/**
 * Draft emails for the given leads.
 *
 * Eligibility is re-checked here from the server's own lead rows, so a client
 * asking to write to somebody who unsubscribed gets a refusal, not a draft.
 * Nothing generated here is sendable until it is approved and queued.
 */
export const generateEmails = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { leadIds?: unknown; mode?: unknown; kind?: unknown };
    const kind = str(source.kind, 20);
    return {
      leadIds: idList(source.leadIds, 50),
      mode: str(source.mode, 60) || "ai",
      kind: (kind === "follow-up-1" || kind === "follow-up-2" ? kind : "initial") as EmailKind,
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; rows: GeneratedRow[] } | Fail> => {
    if (data.leadIds.length === 0) return { ok: true, rows: [] };
    try {
      const { sql, store, settings, emails, suppression, templates } = await loadWorld(context.userId);
      const eligibilityContext = contextFrom(emails, suppression, settings, data.kind);
      const generate = aiGenerator();
      const rows: GeneratedRow[] = [];

      for (const leadId of data.leadIds) {
        const lead = await store.loadLead(sql, context.userId, leadId);
        if (!lead) {
          rows.push({ leadId, ok: false, error: "Lead not found." });
          continue;
        }
        const eligibility = checkEligibility(lead, eligibilityContext, data.kind);
        if (!eligibility.eligible) {
          rows.push({ leadId, ok: false, error: eligibility.reasons.join(", ") });
          continue;
        }

        const composed = await composeEmail(lead, {
          kind: data.kind,
          mode: data.mode,
          templates,
          generate,
        });

        // A draft that cannot pass the gate is still stored, so it can be seen
        // and edited — but it is stored as a draft, and the queue will refuse it.
        const verdict = checkEmailQuality({
          subject: composed.subject,
          body: composed.body,
          recipient: lead.email,
          lead,
          suppressed: suppression,
        });

        const existing = await store.findDraft(sql, context.userId, leadId, data.kind);
        const id = existing?.id ?? newLeadId();
        // A follow-up must land in the same Gmail thread as what it follows.
        const previous = emails
          .filter((email) => email.leadId === leadId && email.gmailThreadId)
          .sort((a, b) => (b.sentAt || b.createdAt).localeCompare(a.sentAt || a.createdAt))[0];

        await store.upsertDraft(sql, context.userId, {
          id,
          leadId,
          businessName: lead.businessName,
          recipient: lead.email,
          subject: composed.subject,
          body: composed.body,
          kind: data.kind,
          generatedBy: composed.generatedBy,
          status: "draft",
          gmailThreadId: data.kind === "initial" ? "" : (previous?.gmailThreadId ?? ""),
        });

        rows.push({
          leadId,
          ok: true,
          emailId: id,
          subject: composed.subject,
          body: composed.body,
          generatedBy: composed.generatedBy,
          note: [composed.fellBackBecause, verdict.ok ? "" : verdict.problems[0]?.message]
            .filter(Boolean)
            .join(" "),
        });
      }
      return { ok: true, rows };
    } catch (error) {
      console.error("[outreach] generate failed:", error);
      return { ok: false, error: "Could not generate emails." };
    }
  });

/** Edit a draft by hand. Anything edited is marked manual, not AI. */
export const updateDraft = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { id?: unknown; subject?: unknown; body?: unknown };
    return { id: str(source.id, 64), subject: str(source.subject, 200), body: str(source.body, 6000) };
  })
  .handler(async ({ data, context }): Promise<{ ok: true } | Fail> => {
    if (!data.id) return { ok: false, error: "No email id." };
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    const email = await store.loadEmail(sql, context.userId, data.id);
    if (!email) return { ok: false, error: "That email no longer exists." };
    if (email.status === "sent" || email.status === "replied") {
      return { ok: false, error: "That email has already been sent." };
    }
    await store.upsertDraft(sql, context.userId, {
      id: email.id,
      leadId: email.leadId,
      businessName: email.businessName,
      recipient: email.recipient,
      subject: data.subject,
      body: data.body,
      kind: email.kind,
      generatedBy: "manual",
      status: "draft",
      gmailThreadId: email.gmailThreadId,
    });
    return { ok: true };
  });

// ── Approve / queue / skip ───────────────────────────────────────────────────

export const setEmailDecision = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { ids?: unknown; decision?: unknown };
    const decision = str(source.decision, 20);
    return {
      ids: idList(source.ids, 200),
      decision: (decision === "approve" || decision === "queue" || decision === "skip" ? decision : "skip") as
        | "approve"
        | "queue"
        | "skip",
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; changed: number; refused: string[] } | Fail> => {
    try {
      const { sql, store, settings, emails, suppression } = await loadWorld(context.userId);
      const refused: string[] = [];
      let changed = 0;

      for (const id of data.ids) {
        const email = await store.loadEmail(sql, context.userId, id);
        if (!email) continue;
        if (email.status === "sent" || email.status === "replied" || email.status === "sending") {
          refused.push(`${email.businessName}: already sent`);
          continue;
        }
        if (data.decision === "skip") {
          await store.setEmailStatus(sql, context.userId, id, "skipped");
          changed += 1;
          continue;
        }

        // Approving is the moment a person says "send this", so it is checked
        // properly rather than trusted.
        const lead = await store.loadLead(sql, context.userId, email.leadId);
        if (!lead) {
          refused.push(`${email.businessName}: lead is gone`);
          continue;
        }
        const eligibilityContext = contextFrom(
          emails.filter((other) => other.id !== id),
          suppression,
          settings,
          email.kind,
        );
        const eligibility = checkEligibility(lead, eligibilityContext, email.kind);
        if (!eligibility.eligible) {
          refused.push(`${email.businessName}: ${eligibility.reasons[0]}`);
          continue;
        }
        const verdict = checkEmailQuality({
          subject: email.subject,
          body: email.body,
          recipient: email.recipient,
          lead,
          suppressed: suppression,
        });
        if (!verdict.ok) {
          refused.push(`${email.businessName}: ${verdict.problems[0].message}`);
          continue;
        }

        try {
          await store.setEmailStatus(
            sql,
            context.userId,
            id,
            data.decision === "queue" ? "queued" : "approved",
            { approved: true },
          );
          changed += 1;
        } catch (error) {
          // The partial unique index is the last line of duplicate defence: if
          // another live email already exists for this address and kind, this
          // is where it is refused.
          const message = error instanceof Error ? error.message : String(error);
          refused.push(
            /unique|duplicate/i.test(message)
              ? `${email.businessName}: already has an email queued or sent`
              : `${email.businessName}: could not approve`,
          );
        }
      }
      return { ok: true, changed, refused };
    } catch (error) {
      console.error("[outreach] decision failed:", error);
      return { ok: false, error: "Could not update those emails." };
    }
  });

// ── Sending ──────────────────────────────────────────────────────────────────

export type SendReport = {
  ok: true;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  details: { id: string; businessName: string; status: string; error?: string }[];
  stopped?: string;
};

/**
 * Send one batch of queued emails.
 *
 * Bounded by the daily limit and the batch size, and checked again per email.
 * A failure marks that email failed and moves on; only a dead Gmail connection
 * stops the whole batch, because every remaining send would fail identically.
 */
export const sendQueued = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<SendReport | Fail> => {
    try {
      const { sql, store, settings, emails, suppression } = await loadWorld(context.userId);
      const room = allowance(emails, settings);
      if (room.atLimit) {
        return {
          ok: true,
          sent: 0,
          failed: 0,
          skipped: 0,
          remaining: 0,
          details: [],
          stopped: `Daily limit reached (${room.sent}/${room.limit}).`,
        };
      }

      const batch = nextBatch(emails, settings);
      if (batch.length === 0) {
        return { ok: true, sent: 0, failed: 0, skipped: 0, remaining: room.remaining, details: [] };
      }

      const token = await usableToken(context.userId);
      if (!token.ok) return token;

      const gmail = await import("@/lib/gmail/client.server.ts");
      const { buildRawMessage } = await import("@/lib/gmail/mime.ts");

      const details: SendReport["details"] = [];
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      let stopped: string | undefined;

      for (const email of batch) {
        const lead = await store.loadLead(sql, context.userId, email.leadId);
        if (!lead) {
          await store.setEmailStatus(sql, context.userId, email.id, "skipped", { error: "Lead no longer exists." });
          details.push({ id: email.id, businessName: email.businessName, status: "skipped", error: "Lead is gone" });
          skipped += 1;
          continue;
        }

        // The second gate. Everything here was already checked at approval; a
        // lead can change in between, and this is the check that matters.
        const eligibilityContext = contextFrom(
          emails.filter((other) => other.id !== email.id),
          suppression,
          settings,
          email.kind,
        );
        const eligibility = checkEligibility(lead, eligibilityContext, email.kind);
        const verdict = checkEmailQuality({
          subject: email.subject,
          body: email.body,
          recipient: email.recipient,
          lead,
          suppressed: suppression,
        });
        if (!eligibility.eligible || !verdict.ok) {
          const why = !eligibility.eligible
            ? eligibility.reasons[0]
            : verdict.ok
              ? "unknown"
              : verdict.problems[0].message;
          await store.setEmailStatus(sql, context.userId, email.id, "skipped", { error: why });
          details.push({ id: email.id, businessName: email.businessName, status: "skipped", error: why });
          skipped += 1;
          continue;
        }

        // Claim it. If this returns false another pass already took it, which is
        // what stops two concurrent sends producing two emails.
        const claimed = await store.claimForSending(sql, context.userId, email.id);
        if (!claimed) {
          details.push({ id: email.id, businessName: email.businessName, status: "skipped", error: "Already sending" });
          skipped += 1;
          continue;
        }

        const raw = buildRawMessage({
          to: email.recipient,
          from: token.email,
          fromName: SENDER_STUDIO,
          subject: email.subject,
          body: email.body,
          inReplyTo: email.kind === "initial" ? undefined : email.gmailMessageId || undefined,
        });
        const result = await gmail.sendMessage(token.accessToken, raw, email.gmailThreadId || undefined);

        if (result.ok) {
          await store.markSent(sql, context.userId, email.id, {
            messageId: result.messageId,
            threadId: result.threadId,
            account: token.email,
          });
          await store.updateLeadOutreach(sql, context.userId, email.leadId, {
            outreachStatus: email.kind === "initial" ? "Sent" : "Followed up",
            lastEmailedAt: new Date().toISOString(),
          });
          details.push({ id: email.id, businessName: email.businessName, status: "sent" });
          sent += 1;
          continue;
        }

        await store.setEmailStatus(sql, context.userId, email.id, "failed", { error: result.error });
        details.push({ id: email.id, businessName: email.businessName, status: "failed", error: result.error });
        failed += 1;

        // A dead token fails every remaining send identically. Stop, and say so.
        if (result.fatal) {
          await store.markGmailProblem(sql, context.userId, result.error);
          stopped = "Gmail connection needs attention. The rest of the queue was left alone.";
          break;
        }
      }

      const after = await store.loadEmails(sql, context.userId);
      return { ok: true, sent, failed, skipped, remaining: allowance(after, settings).remaining, details, stopped };
    } catch (error) {
      console.error("[outreach] send failed:", error);
      return { ok: false, error: "Sending failed. Nothing further was sent." };
    }
  });

// ── Replies ──────────────────────────────────────────────────────────────────

/**
 * Look for replies to emails we sent.
 *
 * Read-only and one-way: the app never answers a prospect. A reply stops
 * follow-ups, moves the lead to Replied, and — if the reply asks us to stop —
 * suppresses the address permanently.
 */
export const checkReplies = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ ok: true; replies: number; unsubscribes: number; checked: number } | Fail> => {
    try {
      const token = await usableToken(context.userId);
      if (!token.ok) return token;
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const gmail = await import("@/lib/gmail/client.server.ts");
      const sql = await getSql();

      const waiting = await store.awaitingReply(sql, context.userId);
      let replies = 0;
      let unsubscribes = 0;

      for (const email of waiting) {
        const thread = await gmail.getThread(token.accessToken, email.gmailThreadId, token.email);
        if (!thread.ok) {
          if (thread.fatal) {
            await store.markGmailProblem(sql, context.userId, thread.error);
            return { ok: false, error: "Gmail connection needs attention.", needsAttention: true };
          }
          continue;
        }
        const theirs = thread.messages.filter((message) => !message.fromUs);
        if (theirs.length === 0) continue;

        await store.markReplied(sql, context.userId, email.id);
        await store.updateLeadOutreach(sql, context.userId, email.leadId, { outreachStatus: "Replied" });
        replies += 1;

        const said = theirs.map((message) => message.snippet).join(" ");
        if (readsAsUnsubscribe(said)) {
          await store.suppress(sql, context.userId, {
            email: email.recipient,
            reason: "Asked to stop in a reply",
            leadId: email.leadId,
            businessName: email.businessName,
          });
          await store.updateLeadOutreach(sql, context.userId, email.leadId, {
            outreachStatus: "Unsubscribed",
            unsubscribed: new Date().toISOString(),
          });
          unsubscribes += 1;
        }
      }
      return { ok: true, replies, unsubscribes, checked: waiting.length };
    } catch (error) {
      console.error("[outreach] reply check failed:", error);
      return { ok: false, error: "Could not check for replies." };
    }
  });

// ── Suppression ──────────────────────────────────────────────────────────────

/** Suppress an address by hand. There is deliberately no way to undo this here. */
export const unsubscribeLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { leadId?: unknown; email?: unknown; reason?: unknown };
    return {
      leadId: str(source.leadId, 64),
      email: str(source.email, 254).toLowerCase(),
      reason: str(source.reason, 200) || "Marked by hand",
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true } | Fail> => {
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    const lead = data.leadId ? await store.loadLead(sql, context.userId, data.leadId) : null;
    const address = data.email || lead?.email || "";
    if (!address) return { ok: false, error: "No email address to suppress." };
    await store.suppress(sql, context.userId, {
      email: address,
      reason: data.reason,
      leadId: data.leadId,
      businessName: lead?.businessName ?? "",
    });
    if (data.leadId) {
      await store.updateLeadOutreach(sql, context.userId, data.leadId, {
        outreachStatus: "Unsubscribed",
        unsubscribed: new Date().toISOString(),
      });
    }
    return { ok: true };
  });

// ── Settings and templates ───────────────────────────────────────────────────

export const saveOutreachSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => (input ?? {}) as Partial<OutreachSettings>)
  .handler(async ({ data, context }): Promise<{ ok: true; settings: OutreachSettings } | Fail> => {
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    const current = await store.loadSettings(sql, context.userId);
    const next = sanitizeSettings(data ?? {}, current ?? DEFAULT_SETTINGS);
    await store.saveSettings(sql, context.userId, next);
    return { ok: true, settings: next };
  });

export const saveOutreachTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as Record<string, unknown>;
    return {
      id: str(source.id, 60),
      name: str(source.name, 80),
      kind: str(source.kind, 30),
      subject: str(source.subject, 200),
      body: str(source.body, 6000),
      signature: str(source.signature, 400),
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; templates: OutreachTemplate[] } | Fail> => {
    if (!data.id) return { ok: false, error: "No template id." };
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    await store.saveTemplate(sql, context.userId, {
      id: data.id,
      name: data.name || data.id,
      kind: (data.kind || "general") as OutreachTemplate["kind"],
      subject: data.subject,
      body: data.body,
      signature: data.signature,
    });
    return { ok: true, templates: await store.loadTemplates(sql, context.userId) };
  });

export { emptyContext };
