/**
 * Is a real session the way into this deployment? (server-only)
 *
 * Lives in its own module because two files need the answer — `verify.server.ts`
 * to decide whether to demand a session, and `owner.server.ts` to decide whether
 * the owner allowlist applies — and having either import the other would make a
 * cycle out of a two-line predicate.
 *
 * The distinction that matters: `authConfigured` (from `./server`) reports only
 * whether **broker federation** is live. `preview.ts` defaults the broker secret
 * to `""`, so it is false on any deployment outside the Grok platform, whatever
 * `VITE_AUTH_ENABLED` says. Local email/password is a separate, equally real
 * mechanism, and this is where the two are added up.
 */
import { emailAndPasswordEnabled } from "./email-password";
import { gateIdentityEnabled } from "./gate-identity.server";
import { authConfigured } from "./server";

/**
 * The `VITE_AUTH_ENABLED` off-switch, read exactly as `auth/server.ts` reads it.
 *
 * With it set to `"false"` the CLIENT resolves a dev user without ever asking
 * the server, so a server that demanded a session would break `npm run dev`
 * outright. Sign-in being *possible* is not the same as sign-in being *on*.
 */
export function authFlagOn(): boolean {
  return process.env.VITE_AUTH_ENABLED?.trim() !== "false";
}

/** Local email/password is live and is a legitimate way to prove identity. */
export function localPasswordAuthActive(): boolean {
  return emailAndPasswordEnabled && authFlagOn();
}

/** Any mechanism that yields a verified session for this request. */
export function sessionAuthActive(): boolean {
  return authConfigured || gateIdentityEnabled() || localPasswordAuthActive();
}
