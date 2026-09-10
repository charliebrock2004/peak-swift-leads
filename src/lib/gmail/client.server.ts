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

/** The Gmail account this app is allowed to send from, if pinned. */
export function allowedSender(): string {
  return (process.env.GMAIL_SENDER || "").trim().toLowerCase();
}

export type TokenSet = {
  accessToken: string;
  /** Google omits this on a refresh; keep the one already held. */
  refreshToken: string;
  expiresAt: string;
  scope: string;
};

export type GmailFailure = {
  ok: false;
  error: string;
  /** True when reconnecting is the only fix. */
  fatal: boolean;
  status?: number;
};

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
  if (!config) return { ok: false, error: "Google OAuth is not configured on the server.", fatal: true };

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
    return { ok: false, error, fatal: isFatalAuthError(error), status };
  }
  const tokens = tokensFrom(json, "");
  if (!tokens.accessToken) return { ok: false, error: "Google returned no access token.", fatal: true };
  if (!tokens.refreshToken) {
    return {
      ok: false,
      error: "Google returned no refresh token. Remove the app at myaccount.google.com/permissions, then connect again.",
      fatal: true,
    };
  }
  if (!hasRequiredScopes(tokens.scope)) {
    return { ok: false, error: "Not all permissions were granted. Connect again and allow send and read access.", fatal: true };
  }
  return { ok: true, ...tokens };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const config = googleConfig();
  if (!config) return { ok: false, error: "Google OAuth is not configured on the server.", fatal: true };
  if (!refreshToken) return { ok: false, error: "No refresh token stored — reconnect Gmail.", fatal: true };

  const { status, json, text } = await postForm(
    tokenUrl(),
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  );
  if (status !== 200) {
    const error = describeError(json, text, status);
    return { ok: false, error, fatal: isFatalAuthError(error), status };
  }
  const tokens = tokensFrom(json, refreshToken);
  if (!tokens.accessToken) return { ok: false, error: "Google returned no access token.", fatal: true };
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

export type ProfileResult = { ok: true; email: string } | GmailFailure;

export async function getProfile(accessToken: string): Promise<ProfileResult> {
  const { status, json, text } = await gmailFetch(accessToken, "/users/me/profile");
  if (status !== 200) {
    const error = describeError(json, text, status);
    return { ok: false, error, fatal: status === 401 || isFatalAuthError(error), status };
  }
  return { ok: true, email: String(json.emailAddress ?? "") };
}

export type SendResult =
  | { ok: true; messageId: string; threadId: string }
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

  const { status, json, text } = await gmailFetch(accessToken, "/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) {
    const error = describeError(json, text, status);
    return { ok: false, error, fatal: status === 401 || isFatalAuthError(error), status };
  }
  return { ok: true, messageId: String(json.id ?? ""), threadId: String(json.threadId ?? threadId ?? "") };
}

export type ThreadMessage = {
  id: string;
  from: string;
  date: string;
  snippet: string;
  /** True when Gmail says we sent it. */
  fromUs: boolean;
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
export async function getThread(accessToken: string, threadId: string, ourEmail: string): Promise<ThreadResult> {
  const { status, json, text } = await gmailFetch(
    accessToken,
    `/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Date`,
  );
  if (status === 404) return { ok: true, messages: [] };
  if (status !== 200) {
    const error = describeError(json, text, status);
    return { ok: false, error, fatal: status === 401 || isFatalAuthError(error), status };
  }
  const raw = Array.isArray(json.messages) ? json.messages : [];
  const us = ourEmail.trim().toLowerCase();
  const messages: ThreadMessage[] = raw.map((item) => {
    const message = item as { id?: unknown; snippet?: unknown; labelIds?: unknown; payload?: unknown };
    const payload = message.payload as { headers?: unknown } | undefined;
    const from = headerValue(payload?.headers, "from");
    const labels = Array.isArray(message.labelIds) ? message.labelIds.map(String) : [];
    return {
      id: String(message.id ?? ""),
      from,
      date: headerValue(payload?.headers, "date"),
      snippet: String(message.snippet ?? ""),
      fromUs: labels.includes("SENT") || (us !== "" && from.toLowerCase().includes(us)),
    };
  });
  return { ok: true, messages };
}
