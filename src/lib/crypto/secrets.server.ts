/**
 * Secrets at rest, and the OAuth `state`. **Server-only.**
 *
 * Gmail refresh tokens are the keys to a mailbox. They used to sit in
 * `gmail_accounts` as plain text, so anyone who ever saw a database dump, a
 * backup or a SQL console could send mail as the owner. They are now sealed with
 * AES-256-GCM before they are written and opened only in the server process.
 *
 * The key is derived — never stored in the database:
 *
 * 1. `TOKEN_ENCRYPTION_KEY`, when set (recommended; rotate by reconnecting);
 * 2. otherwise `DATABASE_URL`, hashed with a purpose label — the same
 *    "stable, server-only, already high-entropy" reasoning `auth/server.ts` uses
 *    for the session secret, and it keeps a zero-config deploy working;
 * 3. otherwise `BETTER_AUTH_SECRET`;
 * 4. otherwise a fixed development key, which is only reachable with no
 *    database configured — i.e. the in-memory preview, which forgets
 *    everything on restart anyway.
 *
 * Every sealed value names the key it was sealed with (a short fingerprint), so
 * a key change is reported as "reconnect Gmail" rather than as corruption.
 * Values written before encryption existed are read as-is and re-sealed on the
 * next write, so no migration has to touch a token.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "enc:v1:";

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

export type KeySource = "TOKEN_ENCRYPTION_KEY" | "DATABASE_URL" | "BETTER_AUTH_SECRET" | "development";

function material(): { key: Buffer; kid: string; source: KeySource } {
  const explicit = env("TOKEN_ENCRYPTION_KEY");
  const database = env("DATABASE_URL");
  const auth = env("BETTER_AUTH_SECRET");
  const [seed, source]: [string, KeySource] = explicit
    ? [`explicit:${explicit}`, "TOKEN_ENCRYPTION_KEY"]
    : database
      ? [`database:${database}`, "DATABASE_URL"]
      : auth
        ? [`auth:${auth}`, "BETTER_AUTH_SECRET"]
        : ["development-only-key", "development"];
  const key = createHash("sha256").update(`peakswift.secrets.v1:${seed}`).digest();
  const kid = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return { key, kid, source };
}

/** Where the encryption key currently comes from. Shown in the Gmail health check. */
export function keySource(): KeySource {
  return material().source;
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

/** Seal a secret for storage. The empty string stays empty (nothing to hide). */
export function sealSecret(plain: string): string {
  if (!plain) return "";
  const { key, kid } = material();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${kid}:${b64(iv)}:${b64(body)}:${b64(cipher.getAuthTag())}`;
}

export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export type OpenResult =
  | { ok: true; value: string; legacy: boolean }
  | { ok: false; reason: "key-changed" | "corrupt" };

/** Open a stored secret. Legacy plain text is returned as-is and flagged. */
export function openSecret(stored: string): OpenResult {
  if (!stored) return { ok: true, value: "", legacy: false };
  if (!isSealed(stored)) return { ok: true, value: stored, legacy: true };
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 4) return { ok: false, reason: "corrupt" };
  const [kid, iv, body, tag] = parts as [string, string, string, string];
  const { key, kid: current } = material();
  if (kid !== current) return { ok: false, reason: "key-changed" };
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv));
    decipher.setAuthTag(unb64(tag));
    const value = Buffer.concat([decipher.update(unb64(body)), decipher.final()]).toString("utf8");
    return { ok: true, value, legacy: false };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

// ── OAuth state ───────────────────────────────────────────────────────────────

/** How long a "Connect Gmail" click stays valid. Google's consent screen is quick. */
export const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function stateMac(userId: string, issued: string, nonce: string): string {
  const { key } = material();
  return createHmac("sha256", key).update(`oauth-state:${userId}:${issued}:${nonce}`).digest("base64url");
}

/**
 * A `state` value the server can check on its own.
 *
 * It used to be a random UUID compared only in the browser's sessionStorage,
 * which proves the redirect returned to the same tab but not that the signed-in
 * account started it. This one is an HMAC over the user id and the issue time,
 * so a code minted from someone else's flow cannot be completed against this
 * account, and an old link expires.
 */
export function signOAuthState(userId: string, now: number = Date.now()): string {
  const issued = now.toString(36);
  const nonce = randomBytes(9).toString("base64url");
  return `${issued}.${nonce}.${stateMac(userId, issued, nonce)}`;
}

export function verifyOAuthState(
  userId: string,
  state: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: "missing" | "malformed" | "forged" | "expired" } {
  if (!state) return { ok: false, reason: "missing" };
  const parts = state.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [issued, nonce, mac] = parts as [string, string, string];
  const expected = Buffer.from(stateMac(userId, issued, nonce));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "forged" };
  const at = Number.parseInt(issued, 36);
  if (!Number.isFinite(at) || now - at > STATE_MAX_AGE_MS || at - now > 60_000) return { ok: false, reason: "expired" };
  return { ok: true };
}

// ── Unsubscribe links ────────────────────────────────────────────────────────

export type UnsubscribeClaim = { userId: string; email: string; emailId: string };

function unsubscribeMac(payload: string): string {
  const { key } = material();
  return createHmac("sha256", key).update(`unsubscribe:${payload}`).digest("base64url").slice(0, 32);
}

/**
 * A token for an unsubscribe link, bound to one account, one address and the
 * email it was sent in.
 *
 * Signed rather than stored, so the link works for as long as the recipient
 * keeps the email, and cannot be edited to unsubscribe some other address or
 * act on another account. It deliberately never expires: an opt-out that stops
 * working after a month is not an opt-out.
 */
export function signUnsubscribe(claim: UnsubscribeClaim): string {
  const payload = Buffer.from(
    JSON.stringify({ u: claim.userId, e: claim.email.trim().toLowerCase(), i: claim.emailId }),
  ).toString("base64url");
  return `v1.${payload}.${unsubscribeMac(payload)}`;
}

export function verifyUnsubscribe(token: string): { ok: true; claim: UnsubscribeClaim } | { ok: false } {
  const parts = (token ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false };
  const [, payload, mac] = parts as [string, string, string];
  const expected = Buffer.from(unsubscribeMac(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false };
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; e?: unknown; i?: unknown };
    const userId = typeof parsed.u === "string" ? parsed.u : "";
    const email = typeof parsed.e === "string" ? parsed.e : "";
    const emailId = typeof parsed.i === "string" ? parsed.i : "";
    if (!userId || !email.includes("@")) return { ok: false };
    return { ok: true, claim: { userId, email, emailId } };
  } catch {
    return { ok: false };
  }
}
