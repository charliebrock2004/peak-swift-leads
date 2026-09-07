/**
 * The parts of Google OAuth that are just arithmetic and string building.
 *
 * Split from the server client so the URL, the scopes and the expiry maths can
 * be tested without a network — and so nothing here ever needs the client
 * secret, which exists only in `client.server.ts` and only from the environment.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/**
 * The narrowest scopes that do the job.
 *
 * - `gmail.send` — send, and nothing else. It cannot read the mailbox.
 * - `gmail.readonly` — needed to notice replies. Gmail has no "read only the
 *   threads I sent" scope, so this is the smallest one that works; it is used
 *   solely to look up threads this app created.
 * - `userinfo.email` — so the app can show which account is connected and check
 *   it is the right one.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export const SCOPE_STRING = GMAIL_SCOPES.join(" ");

/** Refresh this long before the token actually dies, so a send never races it. */
export const REFRESH_MARGIN_MS = 120_000;

export type AuthUrlOptions = {
  clientId: string;
  redirectUri: string;
  /** CSRF token; checked when Google sends the browser back. */
  state: string;
  /** Pre-fills the account chooser. Not a security control. */
  loginHint?: string;
  /**
   * Overridden only by the end-to-end test, which points the whole flow at a
   * local stand-in for Google. Production never passes this.
   */
  authEndpoint?: string;
};

export function buildAuthUrl(options: AuthUrlOptions): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: SCOPE_STRING,
    // Without both of these Google returns no refresh token on a repeat
    // authorisation, and the connection silently dies an hour later.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: options.state,
  });
  if (options.loginHint) params.set("login_hint", options.loginHint);
  return `${options.authEndpoint || GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Absolute expiry from Google's relative `expires_in`. */
export function expiryFrom(expiresInSeconds: number, now: Date = new Date()): string {
  const seconds = Number.isFinite(expiresInSeconds) ? expiresInSeconds : 0;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/** Does this token need refreshing before we use it? */
export function needsRefresh(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at - now.getTime() <= REFRESH_MARGIN_MS;
}

/** Did Google grant everything we asked for? A partial grant cannot send. */
export function hasRequiredScopes(granted: string): boolean {
  const set = new Set(granted.split(/\s+/).filter(Boolean));
  return GMAIL_SCOPES.every((scope) => set.has(scope));
}

/**
 * Which Google failures mean "this connection is finished" rather than "try
 * again". An `invalid_grant` is a revoked or expired refresh token: retrying
 * cannot help, and the user has to reconnect.
 */
export function isFatalAuthError(error: string): boolean {
  return /invalid_grant|invalid_client|unauthorized_client|invalid_token|token has been (expired|revoked)/i.test(
    error,
  );
}

/** A random `state`, and the check for it coming back. */
export function newState(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
