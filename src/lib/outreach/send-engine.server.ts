/**
 * The send engine. **Server-only.**
 *
 * Every email that leaves this app goes through `sendOne`, one at a time. The
 * rules, in the order they run:
 *
 * 1. **Idempotent.** An email already sent reports "already sent"; one being
 *    sent reports "in progress". Pressing Send twice never sends twice.
 * 2. **The second gate.** Eligibility and the quality gate run again, on the
 *    server's own lead row and the current suppression list, immediately before
 *    Gmail. Approval can be days old.
 * 3. **An atomic claim inside the limits.** One SQL statement moves the email
 *    to `sending` only if today's sends (and the campaign's) are under their
 *    limits, and writes the Message-ID we are about to use first.
 * 4. **Only Gmail's answer marks it sent.** The schema refuses a sent row
 *    without Gmail's message id.
 * 5. **Every failure is classified**, because the class decides what is safe:
 *    a dead token or a rate limit puts the email back in the queue untouched
 *    and stops the batch; a rejected address fails it for a person to fix; a
 *    lost answer asks Gmail whether it went before anyone may retry.
 * 6. **Sent but not recorded is reported as sent.** If Gmail confirms and the
 *    database write fails, the answer says so, and the row stays `sending` for
 *    `reconcileStale` to finish from Gmail's own record.
 *
 * Dependencies are injected so the whole engine runs in tests against real SQL
 * (PGLite) and a stand-in Gmail.
 */
import type { Sql } from "@/lib/db";
import type { Lead } from "@/lib/leads";
import type { MessageMeta, SendResult, SentLookup, GmailFailure } from "../gmail/client.server.ts";
import { buildRawMessage } from "../gmail/mime.ts";
import { checkEligibility, type EligibilityContext } from "./eligibility.ts";
import type { VerificationResult } from "../contactability/email.ts";
import { checkEmailQuality } from "./quality.ts";
import { effectiveProfile, fromName, type BusinessProfile } from "./profile.ts";
import { composeEmail, type AiGenerator } from "./compose.ts";
import { campaignCanSend } from "./campaigns.ts";
import { blockedSentence } from "./block-reasons.ts";
import * as store from "./store.server.ts";
import { signUnsubscribe } from "../crypto/secrets.server.ts";
import type { OutreachEmail, OutreachSettings } from "./types.ts";

export type GmailApi = {
  sendMessage(accessToken: string, raw: string, threadId?: string): Promise<SendResult>;
  findSentMessage(
    accessToken: string,
    input: { rfc822MessageId?: string; to: string; subject: string; sinceEpochSeconds: number },
  ): Promise<SentLookup>;
  getMessageMeta(accessToken: string, id: string): Promise<({ ok: true } & MessageMeta) | GmailFailure | { ok: false; notFound: true; error: string; fatal: false; kind: "permanent" }>;
};

export type TokenResult =
  | { ok: true; accessToken: string; email: string }
  | { ok: false; error: string; needsAttention?: boolean };

export type EngineDeps = {
  sql: Sql;
  userId: string;
  gmail: GmailApi;
  /** A usable access token, refreshed if needed. Called at most once per operation. */
  token: () => Promise<TokenResult>;
  now?: () => Date;
  newId?: () => string;
  /**
   * The deployment's stable public origin (production domain / branch alias).
   * When set, every email carries a signed one-click unsubscribe link.
   */
  publicOrigin?: string;
};

/**
 * The unsubscribe line and headers for one email.
 *
 * The link is signed to this account, address and email, so it works for as
 * long as the recipient keeps the message and cannot be altered to act on
 * another address. The mailto fallback lands in our own inbox as a reply,
 * where the reply classifier suppresses the sender.
 */
export function unsubscribeParts(
  deps: Pick<EngineDeps, "publicOrigin" | "userId">,
  email: { id: string; recipient: string },
  sender: string,
): { footer: string; header?: { url: string; mailto?: string } } {
  const origin = (deps.publicOrigin ?? "").replace(/\/+$/, "");
  const mailto = sender || undefined;
  if (!/^https:\/\//i.test(origin)) return { footer: "", header: mailto ? { url: "", mailto } : undefined };
  const token = signUnsubscribe({ userId: deps.userId, email: email.recipient, emailId: email.id });
  const url = `${origin}/unsubscribe?t=${encodeURIComponent(token)}`;
  return { footer: `\n\nTo stop hearing from me: ${url}`, header: { url, mailto } };
}

export type SendOutcome = {
  emailId: string;
  businessName: string;
  recipient: string;
} & (
  | { status: "sent"; messageId: string; threadId: string; recovered?: boolean }
  /** Gmail confirmed it; recording it failed. It WAS sent — never retry it. */
  | { status: "sent_unrecorded"; messageId: string; threadId: string; reason: string }
  | { status: "already_sent"; reason: string }
  /** Refused by eligibility or the quality gate. Nothing was sent. */
  | { status: "blocked"; reason: string }
  /** Waiting on a limit or a paused campaign. Still approved; nothing was sent. */
  | { status: "held"; reason: string }
  /** Not sent, and nothing further in this batch should be tried. Still approved. */
  | { status: "not_sent"; reason: string; stopBatch: true }
  /** Gmail did not send it (or we cannot yet prove it did). */
  | { status: "failed"; reason: string; retryable: boolean; kind: string }
  /** Not in a state to send (already in flight, gone, not approved). */
  | { status: "skipped"; reason: string }
);

function nowOf(deps: EngineDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function newId(deps: EngineDeps): string {
  if (deps.newId) return deps.newId();
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** UTC midnight — the day boundary the daily limit is counted from (see limits.ts). */
export function dayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** A Message-ID for a message we are about to send, on the sender's own domain. */
export function newMessageId(id: string, senderEmail: string): string {
  const domain = senderEmail.split("@")[1]?.toLowerCase().replace(/[^a-z0-9.-]/g, "") || "peakswift.leads";
  return `<peakswift.${id.replace(/[^a-zA-Z0-9-]/g, "")}@${domain}>`;
}

/**
 * The eligibility context for one email, from targeted queries rather than the
 * whole history: the suppression list, and any OTHER live email of the same
 * kind to this lead or this address.
 */
async function contextFor(sql: Sql, userId: string, email: OutreachEmail, settings: Pick<OutreachSettings, "includeLow" | "contactRules">): Promise<{
  context: EligibilityContext;
  suppressed: Set<string>;
}> {
  const suppressed = await store.suppressedSet(sql, userId);
  const rows = await sql.query<{ lead_id: string; recipient: string }>(
    `select lead_id, recipient from outreach_emails
      where user_id = $1 and id <> $2 and kind = $3
        and status in ('approved', 'queued', 'sending', 'sent', 'replied')
        and (lead_id = $4 or lower(recipient) = lower($5))`,
    [userId, email.id, email.kind, email.leadId, email.recipient],
  );
  // A verifier result for this address, if one is recorded. It can only ever
  // add a refusal (an invalid address), never lift one.
  const verified = await sql
    .query<{ result: string }>(`select result from email_verifications where user_id = $1 and email = lower($2)`, [userId, email.recipient.trim()])
    .catch(() => []);
  return {
    suppressed,
    context: {
      settings: { includeLow: settings.includeLow },
      suppressed,
      alreadyContacted: new Set(rows.map((row) => row.lead_id)),
      contactedAddresses: new Set(rows.map((row) => row.recipient.toLowerCase())),
      rules: settings.contactRules,
      verifications: verified[0] ? new Map([[email.recipient.trim().toLowerCase(), verified[0].result as VerificationResult]]) : undefined,
    },
  };
}

/** Log without letting a logging failure stop a send. */
async function activity(deps: EngineDeps, event: Parameters<typeof store.recordActivity>[2]): Promise<void> {
  await store.recordActivity(deps.sql, deps.userId, event);
}

/** Retry a database write once; report the error if both attempts fail. */
async function twice(write: () => Promise<unknown>): Promise<Error | null> {
  try {
    await write();
    return null;
  } catch {
    try {
      await write();
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}

/** What happens after Gmail confirms: record it, thread it, tell the lead. */
async function recordSent(
  deps: EngineDeps,
  email: OutreachEmail,
  sent: { messageId: string; threadId: string; labelIds?: string[] },
  context: { account: string; rfc822MessageId: string; accessToken: string; recovered?: boolean; sentAt?: string },
): Promise<SendOutcome> {
  const base = { emailId: email.id, businessName: email.businessName, recipient: email.recipient };
  const response = JSON.stringify({
    id: sent.messageId,
    threadId: sent.threadId,
    labelIds: sent.labelIds ?? [],
    recovered: Boolean(context.recovered),
  });
  let marked = false;
  const failure = await twice(async () => {
    marked = await store.markSent(deps.sql, deps.userId, email.id, {
      messageId: sent.messageId,
      threadId: sent.threadId,
      account: context.account,
      rfc822MessageId: context.rfc822MessageId,
      providerResponse: response,
      sentAt: context.sentAt,
    });
  });
  if (failure || !marked) {
    return {
      ...base,
      status: "sent_unrecorded",
      messageId: sent.messageId,
      threadId: sent.threadId,
      reason: failure
        ? `Gmail sent it (message ${sent.messageId}), but saving that failed: ${failure.message}. It will be reconciled from Gmail — do not resend.`
        : `Gmail sent it (message ${sent.messageId}), but the email had changed state before it could be recorded. It will be reconciled from Gmail — do not resend.`,
    };
  }

  // Everything below is bookkeeping. None of it may turn a real send into a
  // reported failure, so each step swallows its own error.
  const at = nowOf(deps).toISOString();
  await store
    .updateLeadOutreach(deps.sql, deps.userId, email.leadId, {
      outreachStatus: email.kind === "initial" ? "Sent" : "Followed up",
      lastEmailedAt: at,
    })
    .catch(() => undefined);
  await store.markGmailSent(deps.sql, deps.userId).catch(() => undefined);
  // The Message-ID Gmail actually used, so a follow-up threads under the real
  // message on the recipient's side too (Gmail may replace ours).
  try {
    const meta = await deps.gmail.getMessageMeta(context.accessToken, sent.messageId);
    if (meta.ok && meta.headers["message-id"]) {
      await store.setRfc822MessageId(deps.sql, deps.userId, email.id, meta.headers["message-id"]);
    }
  } catch {
    /* threading falls back to the id we wrote */
  }
  await activity(deps, {
    id: newId(deps),
    type: "EMAIL_SENT",
    leadId: email.leadId,
    leadName: email.businessName,
    result: email.recipient,
    metadata: JSON.stringify({ emailId: email.id, messageId: sent.messageId, recovered: Boolean(context.recovered) }),
  });
  return {
    ...base,
    status: "sent",
    messageId: sent.messageId,
    threadId: sent.threadId,
    ...(context.recovered ? { recovered: true } : {}),
  };
}

export type SendOptions = {
  settings: OutreachSettings;
  profile: Partial<BusinessProfile> | null;
};

/**
 * Send one approved email, or say exactly why not.
 */
export async function sendOne(deps: EngineDeps, emailId: string, options: SendOptions): Promise<SendOutcome> {
  const { sql, userId } = deps;
  const email = await store.loadEmail(sql, userId, emailId);
  if (!email) return { emailId, businessName: "", recipient: "", status: "skipped", reason: "That email no longer exists." };
  const base = { emailId: email.id, businessName: email.businessName, recipient: email.recipient };

  if (email.status === "sent" || email.status === "replied" || email.status === "bounced") {
    return { ...base, status: "already_sent", reason: "Already sent — it was not sent again." };
  }
  if (email.status === "sending") return { ...base, status: "skipped", reason: "Already being sent." };
  if (email.status !== "approved" && email.status !== "queued") {
    return { ...base, status: "skipped", reason: email.status === "draft" ? "Not approved yet." : `Not approved (${email.status}).` };
  }

  // ── The second gate ────────────────────────────────────────────────────────
  const lead = await store.loadLead(sql, userId, email.leadId);
  if (!lead) {
    await store.markSendProblem(sql, userId, email.id, { status: "skipped", kind: "blocked", error: "The lead was deleted." });
    return { ...base, status: "blocked", reason: "Blocked — the lead was deleted from your sheet." };
  }
  const profile = effectiveProfile(options.profile);
  const { context, suppressed } = await contextFor(sql, userId, email, options.settings);
  const blocked = blockReason(lead, email, context, suppressed, profile);
  if (blocked) {
    await store.markSendProblem(sql, userId, email.id, { status: "skipped", kind: "blocked", error: blocked });
    await activity(deps, { id: newId(deps), type: "EMAIL_BLOCKED", leadId: lead.id, leadName: lead.businessName, reason: blocked });
    return { ...base, status: "blocked", reason: `Blocked — ${blocked}` };
  }

  // ── The campaign, if any, must still be live ───────────────────────────────
  let campaignLimit: { campaignId: string; limit: number } | null = null;
  if (email.campaignId) {
    const campaign = await store.loadCampaign(sql, userId, email.campaignId).catch(() => null);
    if (campaign) {
      if (!campaignCanSend(campaign.status)) {
        return { ...base, status: "held", reason: `Held — the campaign "${campaign.name}" is ${campaign.status.toLowerCase()}.` };
      }
      campaignLimit = { campaignId: campaign.id, limit: Math.max(0, campaign.dailyTarget) };
    }
  }

  // ── A token, before anything is claimed ────────────────────────────────────
  const token = await deps.token();
  if (!token.ok) return { ...base, status: "not_sent", stopBatch: true, reason: token.error };

  // ── Claim, atomically, inside the limits ───────────────────────────────────
  const now = nowOf(deps);
  const rfc822MessageId = email.rfc822MessageId || newMessageId(newId(deps), token.email);
  const claim = await store.claimWithinLimits(sql, userId, email.id, {
    rfc822MessageId,
    dayStartIso: dayStart(now),
    dailyLimit: Math.max(0, Math.floor(options.settings.dailyLimit)),
    campaignLimit,
  });
  if (!claim.claimed) {
    if (claim.reason === "daily-limit") {
      return { ...base, status: "held", reason: `Held for tomorrow — today's limit of ${options.settings.dailyLimit} is reached.` };
    }
    if (claim.reason === "campaign-limit") {
      return { ...base, status: "held", reason: `Held for tomorrow — this campaign's daily limit of ${campaignLimit?.limit ?? 0} is reached.` };
    }
    return { ...base, status: "skipped", reason: claim.status === "sending" ? "Already being sent." : `Not ready (${claim.status}).` };
  }

  // ── Threading, for a follow-up ─────────────────────────────────────────────
  let inReplyTo: string | undefined;
  let threadId = email.gmailThreadId || undefined;
  if (email.kind !== "initial") {
    const previous = await store.lastDeliveredFor(sql, userId, email.leadId).catch(() => null);
    if (previous) {
      inReplyTo = previous.rfc822MessageId || undefined;
      threadId = previous.gmailThreadId || threadId;
    }
  }

  const unsubscribe = unsubscribeParts(deps, email, token.email);
  const raw = buildRawMessage({
    to: email.recipient,
    from: token.email,
    fromName: fromName(profile),
    subject: email.subject,
    body: `${email.body}${unsubscribe.footer}`,
    messageId: rfc822MessageId,
    inReplyTo,
    references: inReplyTo,
    date: now,
    listUnsubscribe: unsubscribe.header,
  });

  const result = await deps.gmail.sendMessage(token.accessToken, raw, threadId);
  if (result.ok) {
    return recordSent(deps, email, result, { account: token.email, rfc822MessageId, accessToken: token.accessToken });
  }

  // ── Gmail did not confirm. What that means depends on why. ─────────────────
  const response = JSON.stringify({ status: result.status ?? 0, kind: result.kind, error: result.error.slice(0, 300) });
  await activity(deps, {
    id: newId(deps),
    type: "EMAIL_FAILED",
    leadId: email.leadId,
    leadName: email.businessName,
    result: email.recipient,
    error: result.error,
    metadata: JSON.stringify({ emailId: email.id, kind: result.kind, status: result.status ?? 0 }),
  });

  if (result.kind === "auth") {
    await store.markSendProblem(sql, userId, email.id, { status: "queued", kind: "auth", error: result.error, providerResponse: response });
    await store.markGmailProblem(sql, userId, result.error).catch(() => undefined);
    return {
      ...base,
      status: "not_sent",
      stopBatch: true,
      reason: "Gmail refused the connection (the sign-in expired or was revoked). Nothing was sent. Reconnect Gmail in Settings — the email is still approved.",
    };
  }
  if (result.kind === "rate_limit") {
    await store.markSendProblem(sql, userId, email.id, { status: "queued", kind: "rate_limit", error: result.error, providerResponse: response });
    return {
      ...base,
      status: "not_sent",
      stopBatch: true,
      reason: "Gmail asked us to slow down (rate limit). Nothing was sent; the rest stay approved. Try again later.",
    };
  }
  if (result.kind === "permanent") {
    await store.markSendProblem(sql, userId, email.id, { status: "failed", kind: "permanent", error: result.error, providerResponse: response });
    return {
      ...base,
      status: "failed",
      kind: "permanent",
      retryable: false,
      reason: `Gmail rejected this email: ${result.error}. Check the address, edit the email, and approve it again.`,
    };
  }

  // transient or uncertain: ask Gmail whether it went before saying anything.
  if (result.kind === "uncertain") {
    const lookup = await deps.gmail
      .findSentMessage(token.accessToken, {
        rfc822MessageId,
        to: email.recipient,
        subject: email.subject,
        sinceEpochSeconds: Math.floor(now.getTime() / 1000),
      })
      .catch(() => null);
    if (lookup?.ok && lookup.found) {
      return recordSent(deps, email, { messageId: lookup.id, threadId: lookup.threadId }, {
        account: token.email,
        rfc822MessageId: lookup.rfc822MessageId || rfc822MessageId,
        accessToken: token.accessToken,
        recovered: true,
      });
    }
  }
  await store.markSendProblem(sql, userId, email.id, {
    status: "failed",
    kind: result.kind,
    error: result.error,
    providerResponse: response,
  });
  return {
    ...base,
    status: "failed",
    kind: result.kind,
    retryable: true,
    reason:
      result.kind === "uncertain"
        ? `${result.error} Gmail has no record of it yet. Retry checks Gmail again first, so it cannot be sent twice.`
        : `${result.status ? `Gmail was briefly unavailable (${result.status}: ${result.error})` : `Could not reach Gmail (${result.error})`}. Nothing was sent. Retry checks Gmail first, so it cannot be sent twice.`,
  };
}

/**
 * Why this email may not go right now, in words that say what to do — or "".
 */
export function blockReason(
  lead: Lead,
  email: OutreachEmail,
  context: EligibilityContext,
  suppressed: ReadonlySet<string>,
  profile: BusinessProfile,
): string {
  if (email.recipient.trim().toLowerCase() !== lead.email.trim().toLowerCase()) {
    return `the lead's email address changed to ${lead.email || "nothing"} after this email was written. Regenerate it.`;
  }
  const eligibility = checkEligibility(lead, context, email.kind);
  if (!eligibility.eligible) return blockedSentence(eligibility.reasons[0] ?? "manual-review");
  const verdict = checkEmailQuality({
    subject: email.subject,
    body: email.body,
    recipient: email.recipient,
    lead,
    suppressed,
    studio: profile.businessName,
  });
  if (!verdict.ok) return verdict.problems[0]!.message.replace(/\.$/, "");
  return "";
}

/**
 * Finish sends whose answer was lost — a function that died between claiming
 * an email and recording Gmail's reply. Gmail's own record decides: found means
 * sent; not found (after two minutes) means it never went and may be retried.
 */
export async function reconcileStale(deps: EngineDeps): Promise<{ recovered: number; released: number; checked: number; error?: string }> {
  const stale = await store.staleSending(deps.sql, deps.userId);
  if (stale.length === 0) return { recovered: 0, released: 0, checked: 0 };
  const token = await deps.token();
  if (!token.ok) return { recovered: 0, released: 0, checked: 0, error: token.error };
  let recovered = 0;
  let released = 0;
  for (const email of stale) {
    const since = Date.parse(email.sendingStartedAt || email.updatedAt) || nowOf(deps).getTime();
    const lookup = await deps.gmail.findSentMessage(token.accessToken, {
      rfc822MessageId: email.rfc822MessageId,
      to: email.recipient,
      subject: email.subject,
      sinceEpochSeconds: Math.floor(since / 1000),
    });
    if (!lookup.ok) return { recovered, released, checked: recovered + released, error: lookup.error };
    if (lookup.found) {
      const outcome = await recordSent(deps, email, { messageId: lookup.id, threadId: lookup.threadId }, {
        account: token.email,
        rfc822MessageId: lookup.rfc822MessageId || email.rfc822MessageId || "",
        accessToken: token.accessToken,
        recovered: true,
      });
      if (outcome.status === "sent") recovered += 1;
    } else {
      await store.markSendProblem(deps.sql, deps.userId, email.id, {
        status: "failed",
        kind: "transient",
        error: "The send was interrupted and Gmail has no record of it, so it never went. Safe to retry.",
      });
      released += 1;
    }
  }
  return { recovered, released, checked: stale.length };
}

export type RetryOutcome = { emailId: string; businessName: string; result: "requeued" | "already_sent" | "refused"; reason: string };

/**
 * Put failed emails back in the queue — but only after proving they did not go.
 *
 * An email whose failure left any doubt (a timeout, a dropped connection, a
 * 5xx) is looked up in Gmail first. If Gmail has it, it is recorded as sent and
 * NOT requeued. A permanent rejection is not retried as-is: something about the
 * address or the text has to change first.
 */
export async function retryEmails(deps: EngineDeps, ids: readonly string[]): Promise<RetryOutcome[]> {
  const out: RetryOutcome[] = [];
  let token: TokenResult | null = null;
  for (const id of ids) {
    const email = await store.loadEmail(deps.sql, deps.userId, id);
    if (!email) {
      out.push({ emailId: id, businessName: "", result: "refused", reason: "That email no longer exists." });
      continue;
    }
    const who = { emailId: email.id, businessName: email.businessName };
    if (email.status === "sent" || email.status === "replied" || email.status === "bounced") {
      out.push({ ...who, result: "already_sent", reason: "Already sent." });
      continue;
    }
    if (email.status !== "failed") {
      out.push({ ...who, result: "refused", reason: `Not a failed email (${email.status}).` });
      continue;
    }
    if (email.failureKind === "permanent") {
      out.push({
        ...who,
        result: "refused",
        reason: `Gmail rejected it (${email.error || "permanent failure"}). Edit the email or the address and approve it again.`,
      });
      continue;
    }
    if (email.failureKind === "uncertain" || email.failureKind === "transient" || !email.failureKind) {
      token ??= await deps.token();
      if (!token.ok) {
        out.push({ ...who, result: "refused", reason: `Could not check Gmail first: ${token.error}` });
        continue;
      }
      const since = Date.parse(email.sendingStartedAt || email.updatedAt) || nowOf(deps).getTime();
      const lookup = await deps.gmail.findSentMessage(token.accessToken, {
        rfc822MessageId: email.rfc822MessageId,
        to: email.recipient,
        subject: email.subject,
        sinceEpochSeconds: Math.floor(since / 1000),
      });
      if (!lookup.ok) {
        out.push({ ...who, result: "refused", reason: `Could not check Gmail first: ${lookup.error}` });
        continue;
      }
      if (lookup.found) {
        await recordSent(deps, email, { messageId: lookup.id, threadId: lookup.threadId }, {
          account: token.email,
          rfc822MessageId: lookup.rfc822MessageId || email.rfc822MessageId || "",
          accessToken: token.accessToken,
          recovered: true,
        });
        out.push({ ...who, result: "already_sent", reason: "Gmail shows it was sent after all — recorded as sent, not resent." });
        continue;
      }
    }
    const requeued = await store.requeue(deps.sql, deps.userId, email.id);
    out.push(
      requeued
        ? { ...who, result: "requeued", reason: "Checked Gmail — it was not sent. Approved again, ready to send." }
        : { ...who, result: "refused", reason: "It changed state before it could be requeued." },
    );
  }
  return out;
}

// ── End-to-end test ──────────────────────────────────────────────────────────

export type TestStep = { step: string; ok: boolean; detail: string };

/**
 * The whole pipeline, once, to your own address.
 *
 * A synthetic prospect (never stored on the sheet) → the real composer (AI when
 * configured) → the real quality gate → approval → Gmail → the message id
 * stored → Gmail asked to confirm it is in Sent. The recipient must be the
 * designated test address or the connected account itself; anything else is
 * refused before a word is written, so a real prospect can never be emailed by
 * the test.
 */
export async function runEndToEndTest(
  deps: EngineDeps,
  input: {
    to: string;
    designated: string;
    profile: Partial<BusinessProfile> | null;
    generate?: AiGenerator;
  },
): Promise<{ ok: boolean; steps: TestStep[]; messageId?: string; threadId?: string }> {
  const steps: TestStep[] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ step: name, ok, detail });
    return ok;
  };
  const to = input.to.trim().toLowerCase();
  const token = await deps.token();
  if (!step("Gmail connection", token.ok, token.ok ? `Sending as ${token.email}` : token.error)) return { ok: false, steps };
  if (!token.ok) return { ok: false, steps };

  const allowed = new Set([token.email.toLowerCase(), input.designated.trim().toLowerCase()].filter(Boolean));
  if (!step("Test recipient", allowed.has(to), allowed.has(to) ? `${to} is a designated test address` : `${to} is not your test address — refused. Set it in Settings → Gmail.`)) {
    return { ok: false, steps };
  }

  const profile = effectiveProfile(input.profile);
  const testLead = {
    id: "e2e-test",
    businessName: "Peak Swift Test Prospect",
    trade: "Joiner",
    town: "Perth",
    phone: "",
    email: to,
    address: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "No Website Found",
    placeId: "test:e2e",
    foundAt: "",
    businessStatus: "Active",
    websiteQuality: "",
    websiteScore: "",
    websiteAnalysis: "",
    websiteCheckedAt: "",
    emailSource: "End-to-end test address",
    emailConfidence: "HIGH",
    emailFoundAt: "",
    opportunityScore: "",
    source: "test",
    called: "Not Called",
    callResult: "",
    followUpDate: "",
    notes: "",
    demoUrl: "",
    outreachStatus: "",
    unsubscribed: "",
    lastEmailedAt: "",
    updatedAt: "",
    deletedAt: "",
  } as Lead;
  step("Test prospect", true, "A synthetic prospect — never added to your sheet or analytics.");

  const composed = await composeEmail(testLead, { kind: "initial", mode: "ai", generate: input.generate, profile });
  step(
    "Email written",
    true,
    composed.generatedBy === "ai" ? "Written by AI from the test prospect's evidence." : composed.fellBackBecause ? `Template used: ${composed.fellBackBecause.replace(/\s*—\s*used a template\.?$/, "")}.` : "Template used.",
  );

  const verdict = checkEmailQuality({
    subject: `[TEST] ${composed.subject}`,
    body: composed.body,
    recipient: to,
    lead: testLead,
    studio: profile.businessName,
  });
  if (!step("Quality gate", verdict.ok, verdict.ok ? "Passed every check." : verdict.problems.map((p) => p.message).join(" "))) {
    return { ok: false, steps };
  }
  step("Approved", true, "Approved for this test only.");

  const id = newId(deps);
  const rfc822MessageId = newMessageId(id, token.email);
  const subject = `[TEST] ${composed.subject}`;
  const testUnsubscribe = unsubscribeParts(deps, { id, recipient: to }, token.email);
  const raw = buildRawMessage({
    to,
    from: token.email,
    fromName: fromName(profile),
    subject,
    body: `${composed.body}${testUnsubscribe.footer}`,
    messageId: rfc822MessageId,
    date: nowOf(deps),
    listUnsubscribe: testUnsubscribe.header,
  });
  const sent = await deps.gmail.sendMessage(token.accessToken, raw);
  if (!step("Sent through Gmail", sent.ok, sent.ok ? `Gmail message id ${sent.messageId}` : `${sent.error} (${sent.kind})`)) {
    return { ok: false, steps };
  }
  if (!sent.ok) return { ok: false, steps };

  try {
    await store.insertTestEmail(deps.sql, deps.userId, {
      id,
      recipient: to,
      subject,
      body: composed.body,
      rfc822MessageId,
      messageId: sent.messageId,
      threadId: sent.threadId,
      account: token.email,
      providerResponse: JSON.stringify({ id: sent.messageId, threadId: sent.threadId, labelIds: sent.labelIds }),
    });
    step("Recorded", true, "Message id and thread stored.");
  } catch (error) {
    step("Recorded", false, `Sent, but storing the record failed: ${error instanceof Error ? error.message : error}`);
  }

  const meta = await deps.gmail.getMessageMeta(token.accessToken, sent.messageId);
  const confirmed = meta.ok && meta.labelIds.includes("SENT");
  step(
    "Confirmed by Gmail",
    confirmed,
    confirmed ? "Gmail lists it in Sent. Check your inbox for it." : `Gmail did not confirm it: ${meta.ok ? "not labelled SENT" : meta.error}`,
  );
  return { ok: steps.every((entry) => entry.ok), steps, messageId: sent.messageId, threadId: sent.threadId };
}
