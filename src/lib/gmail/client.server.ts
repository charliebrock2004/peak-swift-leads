/**
 * Talking to Google. **Server-only** — nothing in this file may be imported
 * from a component.
 *
 * The client secret and every token live here and in the database, and neither
 * is ever returned to the browser. The browser only learns which address is
 * connected and whether the connection is healthy.
 *
 * Every call returns a result value rather than throwing, and marks the
 * difference between "try again later" and "this connection is finished", so a
 * dead refresh token stops the queue instead of being retried forever.
 */
import {
  GMAIL_API_BASE,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  expiryFrom,
  hasRequiredScopes,
  isFatalAuthError,
  SCOPE_STRING,
} from "./oauth.ts";

/**
 * Endpoint overrides exist ONLY so an end-to-end test can point at a local
 * stand-in for Google. Production never sets them, so there is no path by which
 * a fake Gmail can be reached from the deployed app.
 */
function tokenUrl(): string {
  return process.env.GOOGLE_OAUTH_BASE ? `${process.env.GOOGLE_OAUTH_BASE.replace(/\/+$/, "")}/token` : GOOGLE_TOKEN_URL;
}
function revokeUrl(): string {
  return process.env.GOOGLE_OAUTH_BASE
    ? `${process.env.GOOGLE_OAUTH_BASE.replace(/\/+$/, "")}/revoke`
    : GOOGLE_REVOKE_URL;
}
function apiBase(): string {
  return (process.env.GMAIL_API_BASE_URL || GMAIL_API_BASE).replace(/\/+$/, "");
}

import type { OAuthSetup, OAuthVariable } from "../outreach/oauth-setup.ts";

export type GoogleConfig = { clientId: string; clientSecret: string };

/** The OAuth client, from the environment. Absent means "not set up yet". */
/**
 * Strip what an environment variable picks up in transit but never belongs to
 * the value: surrounding quotes, and — for the client id — any whitespace at
 * all, including a line break in the middle.
 *
 * A trailing newline is invisible in a dashboard field and fatal at Google. A
 * Google client id is `<digits>-<token>.apps.googleusercontent.com` and can
 * never legitimately contain a space or a newline, so removing them cannot
 * change which client is meant — it can only recover it. The secret gets the
 * gentler treatment (ends only), because internal characters there are opaque
 * and not ours to second-guess.
 */
function cleanClientId(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").replace(/^["']+|["']+$/g, "");
}

function cleanSecret(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}

export function googleConfig(): GoogleConfig | null {
  const clientId = cleanClientId(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = cleanSecret(process.env.GOOGLE_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * What this running server can see of the OAuth variables, and which build it
 * is. Names and Vercel's own non-secret system variables only — never a value.
 *
 * `googleConfig()` cannot say *which* variable is absent, or that this is a
 * Preview build made before the variables were added; both are the difference
 * between "add the variables" and "redeploy", so the screens are told.
 */
export function oauthSetup(): OAuthSetup {
  const missing: OAuthVariable[] = [];
  if (!cleanClientId(process.env.GOOGLE_CLIENT_ID)) missing.push("GOOGLE_CLIENT_ID");
  if (!cleanSecret(process.env.GOOGLE_CLIENT_SECRET)) missing.push("GOOGLE_CLIENT_SECRET");
  return {
    missing,
    environment: (process.env.VERCEL_ENV ?? "").trim().toLowerCase(),
    branch: (process.env.VERCEL_GIT_COMMIT_REF ?? "").trim().slice(0, 100),
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim().slice(0, 7),
  };
}

/**
 * The Gmail account outreach is meant to send from. `GMAIL_SENDER` overrides it
 * for another deployment; nobody has to set anything for this one.
 */
export const DEFAULT_GMAIL_SENDER = "peakswiftstudio@gmail.com";

/**
 * The one Gmail account this app will connect and send from. It is sent to
 * Google as `login_hint`, so the account chooser opens on it, and the callback
 * refuses — and revokes — a sign-in to any other account. Which account signs in
 * is unrelated to `redirect_uri`: Google checks the redirect before it shows the
 * account chooser at all.
 */
export function allowedSender(): string {
  const configured = (process.env.GMAIL_SENDER || "").trim().replace(/^["']+|["']+$/g, "").toLowerCase();
  return configured || DEFAULT_GMAIL_SENDER;
}

export type TokenSet = {
  accessToken: string;
  /** Google omits this on a refresh; keep the one already held. */
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

/**
 * What kind of failure this was — the thing that decides whether a retry is
 * safe, and whether the rest of a batch should carry on.
 *
 * - `auth`       — the token is dead or refused. Nothing was sent; reconnect.
 * - `rate_limit` — Gmail said slow down (429 / quota). Nothing was sent; stop.
 * - `permanent`  — Gmail rejected this message (bad address, invalid raw). It
 *                  will be rejected again, so it is not retried as-is.
 * - `transient`  — a 5xx or a connection that never opened. Almost certainly
 *                  not sent, but checked before any retry.
 * - `uncertain`  — the request may have reached Gmail before we lost the
 *                  answer (a timeout, a dropped connection). Gmail is asked
 *                  whether it went before anything is sent again.
 */
export type GmailFailureKind = "auth" | "rate_limit" | "permanent" | "transient" | "uncertain";

export type GmailFailure = {
  ok: false;
  error: string;
  /** True when reconnecting is the only fix. */
  fatal: boolean;
  status?: number;
  kind: GmailFailureKind;
};

/** Classify an HTTP answer from Gmail that was not a success. */
export function classifyGmailStatus(status: number, error: string): GmailFailureKind {
  if (status === 401 || isFatalAuthError(error)) return "auth";
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|too many/i.test(error)) {
    return "rate_limit";
  }
  if (status === 403 && /insufficient|scope|permission/i.test(error)) return "auth";
  if (status >= 500 || status === 408) return "transient";
  if (status === 0) return "uncertain";
  return "permanent";
}

/**
 * Classify a request that threw instead of answering.
 *
 * A connection that was never opened (DNS failure, refused) cannot have
 * delivered anything. A timeout or a reset after the request was written might
 * have — Gmail may have sent the message and only the answer was lost.
 */
export function classifyNetworkError(error: unknown): { kind: GmailFailureKind; message: string } {
  const err = error as { name?: string; message?: string; cause?: { code?: string } } | undefined;
  const code = err?.cause?.code ?? "";
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return { kind: "uncertain", message: "Gmail did not answer in time — it may or may not have sent." };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(code)) {
    return { kind: "transient", message: `Could not reach Gmail (${code}). Nothing was sent.` };
  }
  return {
    kind: "uncertain",
    message: `The connection to Gmail dropped${code ? ` (${code})` : ""} — it may or may not have sent.`,
  };
}

export type TokenResult = ({ ok: true } & TokenSet) | GmailFailure;

const TIMEOUT_MS = 12_000;

async function postForm(url: string, body: URLSearchParams): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(json: Record<string, unknown>, text: string, status: number): string {
  const error = json.error;
  if (typeof error === "string") {
    const description = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    return `${error}${description}`;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return text.slice(0, 200) || `Google returned ${status}`;
}

function tokensFrom(json: Record<string, unknown>, fallbackRefresh: string): TokenSet {
  return {
    accessToken: String(json.access_token ?? ""),
    refreshToken: String(json.refresh_token ?? "") || fallbackRefresh,
    expiresAt: expiryFrom(Number(json.expires_in ?? 0)),
    scope: String(json.scope ?? SCOPE_STRING),
  };
}

/** Swap the one-time code from the redirect for tokens. */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResult> {
  const config = googleConfig();
  if (!config) return { ok: false, error: "Google OAuth is not configured on the server.", fatal: true, kind: "auth" };

  const { status, json, text } = await postForm(
    tokenUrl(),
    new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );
  if (status !== 200) {
    const error = describeError(json, text, status);
    return { ok: false, error, fatal: isFatalAuthError(error), status, kind: isFatalAuthError(error) ? "auth" : "transient" };
  }
  const tokens = tokensFrom(json, "");
  if (!tokens.accessToken) return { ok: false, error: "Google returned no access token.", fatal: true, kind: "auth" };
  if (!tokens.refreshToken) {
    return {
      ok: false,
      error: "Google returned no refresh token. Remove the app at myaccount.google.com/permissions, then connect again.",
      fatal: true,
      kind: "auth",
    };
  }
  if (!hasRequiredScopes(tokens.scope)) {
    return {
      ok: false,
      error: "Not all permissions were granted. Connect again and allow send and read access.",
      fatal: true,
      kind: "auth",
    };
  }
  return { ok: true, ...tokens };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const config = googleConfig();
  if (!config) return { ok: false, error: "Google OAuth is not configured on the server.", fatal: true, kind: "auth" };
  if (!refreshToken) return { ok: false, error: "No refresh token stored — reconnect Gmail.", fatal: true, kind: "auth" };

  let answer: Awaited<ReturnType<typeof postForm>>;
  try {
    answer = await postForm(
      tokenUrl(),
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
    );
  } catch (error) {
    // A token refresh sends nothing, so a network failure here is simply
    // "try again", never "maybe sent".
    return { ok: false, error: classifyNetworkError(error).message.replace(/ — it may or may not have sent\./, "."), fatal: false, kind: "transient" };
  }
  const { status, json, text } = answer;
  if (status !== 200) {
    const error = describeError(json, text, status);
    const fatal = isFatalAuthError(error);
    return { ok: false, error, fatal, status, kind: fatal ? "auth" : "transient" };
  }
  const tokens = tokensFrom(json, refreshToken);
  if (!tokens.accessToken) return { ok: false, error: "Google returned no access token.", fatal: true, kind: "auth" };
  return { ok: true, ...tokens };
}

/** Best-effort: a failed revoke must not stop the app forgetting the account. */
export async function revokeToken(token: string): Promise<void> {
  if (!token) return;
  try {
    await postForm(revokeUrl(), new URLSearchParams({ token }));
  } catch {
    /* the local disconnect is what matters */
  }
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** `gmailFetch`, but a thrown request becomes a classified failure value. */
async function gmailCall(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; status: number; json: Record<string, unknown>; text: string } | GmailFailure> {
  try {
    const answer = await gmailFetch(accessToken, path, init);
    return { ok: true, ...answer };
  } catch (error) {
    const { kind, message } = classifyNetworkError(error);
    return { ok: false, error: message, fatal: false, status: 0, kind };
  }
}

function failureFrom(status: number, json: Record<string, unknown>, text: string): GmailFailure {
  const error = describeError(json, text, status);
  const kind = classifyGmailStatus(status, error);
  return { ok: false, error, fatal: kind === "auth", status, kind };
}

export type ProfileResult = { ok: true; email: string; messagesTotal: number } | GmailFailure;

export async function getProfile(accessToken: string): Promise<ProfileResult> {
  const answer = await gmailCall(accessToken, "/users/me/profile");
  if (!answer.ok) return answer;
  const { status, json, text } = answer;
  if (status !== 200) return failureFrom(status, json, text);
  return { ok: true, email: String(json.emailAddress ?? ""), messagesTotal: Number(json.messagesTotal ?? 0) };
}

export type SendResult =
  | { ok: true; messageId: string; threadId: string; labelIds: string[] }
  | GmailFailure;

/**
 * Send one message.
 *
 * A 4xx other than 401 is the message's problem — a bad address, a rejected
 * body — and is permanent: the caller marks it failed and moves on rather than
 * retrying. A 401 means the token died mid-batch and the connection needs
 * attention. A 5xx or 429 is worth one more go later.
 */
export async function sendMessage(
  accessToken: string,
  raw: string,
  threadId?: string,
): Promise<SendResult> {
  const payload: Record<string, string> = { raw };
  if (threadId) payload.threadId = threadId;

  const answer = await gmailCall(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!answer.ok) return answer;
  const { status, json, text } = answer;
  if (status !== 200) return failureFrom(status, json, text);
  const messageId = String(json.id ?? "");
  // A 200 with no id is not a confirmation. Treat it as "we cannot say" so the
  // reconciliation path asks Gmail rather than recording a send without proof.
  if (!messageId) {
    return { ok: false, error: "Gmail answered without a message id.", fatal: false, status, kind: "uncertain" };
  }
  return {
    ok: true,
    messageId,
    threadId: String(json.threadId ?? threadId ?? ""),
    labelIds: Array.isArray(json.labelIds) ? json.labelIds.map(String) : [],
  };
}

export type MessageMeta = {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string>;
  snippet: string;
  internalDate: string;
};

/** Headers and labels of one message — used to confirm a send and to thread follow-ups. */
export async function getMessageMeta(
  accessToken: string,
  id: string,
): Promise<({ ok: true } & MessageMeta) | GmailFailure | { ok: false; notFound: true; error: string; fatal: false; kind: "permanent" }> {
  const answer = await gmailCall(
    accessToken,
    `/users/me/messages/${encodeURIComponent(id)}?format=metadata` +
      ["Message-ID", "Subject", "To", "From", "Date"].map((h) => `&metadataHeaders=${h}`).join(""),
  );
  if (!answer.ok) return answer;
  const { status, json, text } = answer;
  if (status === 404) return { ok: false, notFound: true, error: "No such message.", fatal: false, kind: "permanent" };
  if (status !== 200) return failureFrom(status, json, text);
  return { ok: true, ...metaFrom(json) };
}

function metaFrom(json: Record<string, unknown>): MessageMeta {
  const payload = json.payload as { headers?: unknown } | undefined;
  const headers: Record<string, string> = {};
  if (Array.isArray(payload?.headers)) {
    for (const header of payload.headers) {
      const entry = header as { name?: unknown; value?: unknown };
      if (typeof entry.name === "string" && typeof entry.value === "string") {
        headers[entry.name.toLowerCase()] = entry.value;
      }
    }
  }
  return {
    id: String(json.id ?? ""),
    threadId: String(json.threadId ?? ""),
    labelIds: Array.isArray(json.labelIds) ? json.labelIds.map(String) : [],
    headers,
    snippet: String(json.snippet ?? ""),
    internalDate: String(json.internalDate ?? ""),
  };
}

export type SentLookup =
  | { ok: true; found: true; id: string; threadId: string; rfc822MessageId: string }
  | { ok: true; found: false }
  | GmailFailure;

/**
 * Did Gmail actually send this? Asked before any retry of an email whose first
 * attempt ended without a clear answer, so a lost response can never become a
 * second copy in somebody's inbox.
 *
 * Two searches, strongest first: the Message-ID header this app wrote (exact,
 * when Gmail kept it), then the sent folder for that recipient since the
 * attempt began, confirmed by subject. One live initial email per address is a
 * database constraint, so that pair identifies the message.
 */
export async function findSentMessage(
  accessToken: string,
  input: { rfc822MessageId?: string; to: string; subject: string; sinceEpochSeconds: number },
): Promise<SentLookup> {
  const queries: string[] = [];
  if (input.rfc822MessageId) queries.push(`rfc822msgid:${input.rfc822MessageId.replace(/[<>]/g, "")}`);
  const since = Math.max(0, Math.floor(input.sinceEpochSeconds) - 120);
  queries.push(`in:sent to:${input.to} after:${since}`);
  const wanted = normaliseSubject(input.subject);

  for (const query of queries) {
    const list = await gmailCall(
      accessToken,
      `/users/me/messages?maxResults=10&includeSpamTrash=false&q=${encodeURIComponent(query)}`,
    );
    if (!list.ok) return list;
    if (list.status !== 200) return failureFrom(list.status, list.json, list.text);
    const messages = Array.isArray(list.json.messages) ? list.json.messages : [];
    for (const item of messages) {
      const id = String((item as { id?: unknown }).id ?? "");
      if (!id) continue;
      const meta = await getMessageMeta(accessToken, id);
      if (!meta.ok) {
        if ("notFound" in meta) continue;
        return meta;
      }
      if (!meta.labelIds.includes("SENT")) continue;
      const to = (meta.headers.to ?? "").toLowerCase();
      if (!to.includes(input.to.toLowerCase())) continue;
      if (wanted && normaliseSubject(meta.headers.subject ?? "") !== wanted) continue;
      return {
        ok: true,
        found: true,
        id: meta.id,
        threadId: meta.threadId,
        rfc822MessageId: meta.headers["message-id"] ?? "",
      };
    }
  }
  return { ok: true, found: false };
}

function normaliseSubject(subject: string): string {
  return subject.replace(/^\s*(re|fwd?):\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export type ThreadMessage = {
  id: string;
  from: string;
  date: string;
  snippet: string;
  /** True when Gmail says we sent it. */
  fromUs: boolean;
  subject: string;
  /** Lowercased header names → values, for auto-reply and bounce detection. */
  headers: Record<string, string>;
  internalDate: string;
};

export type ThreadResult = { ok: true; messages: ThreadMessage[] } | GmailFailure;

function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return "";
  for (const header of headers) {
    const entry = header as { name?: unknown; value?: unknown };
    if (typeof entry.name === "string" && entry.name.toLowerCase() === name) {
      return typeof entry.value === "string" ? entry.value : "";
    }
  }
  return "";
}

/**
 * Read one thread, so a reply can be spotted.
 *
 * Metadata format only: this asks for the headers and Gmail's own snippet, not
 * message bodies. It is the least the API can be asked for and still answer
 * "has anyone written back".
 */
const THREAD_HEADERS = [
  "From",
  "Date",
  "Subject",
  "Message-ID",
  "Auto-Submitted",
  "X-Autoreply",
  "X-Autorespond",
  "Precedence",
  "X-Failed-Recipients",
  "Content-Type",
];

export async function getThread(accessToken: string, threadId: string, ourEmail: string): Promise<ThreadResult> {
  const answer = await gmailCall(
    accessToken,
    `/users/me/threads/${encodeURIComponent(threadId)}?format=metadata` +
      THREAD_HEADERS.map((header) => `&metadataHeaders=${header}`).join(""),
  );
  if (!answer.ok) return answer;
  const { status, json, text } = answer;
  if (status === 404) return { ok: true, messages: [] };
  if (status !== 200) return failureFrom(status, json, text);
  const raw = Array.isArray(json.messages) ? json.messages : [];
  const us = ourEmail.trim().toLowerCase();
  const messages: ThreadMessage[] = raw.map((item) => {
    const meta = metaFrom(item as Record<string, unknown>);
    const from = meta.headers.from ?? headerValue((item as { payload?: { headers?: unknown } }).payload?.headers, "from");
    return {
      id: meta.id,
      from,
      date: meta.headers.date ?? "",
      snippet: meta.snippet,
      fromUs: meta.labelIds.includes("SENT") || (us !== "" && from.toLowerCase().includes(us)),
      subject: meta.headers.subject ?? "",
      headers: meta.headers,
      internalDate: meta.internalDate,
    };
  });
  return { ok: true, messages };
}
