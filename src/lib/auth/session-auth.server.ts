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

/** A real Postgres is configured — i.e. this is a deployment, not a scratch run. */
export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Is sign-in on?
 *
 * `VITE_AUTH_ENABLED=false` is the template's off-switch, and it is the shipped
 * default in `.grok/app-env.json`. Honouring it blindly on a deployment created
 * a trap: with a real database and the flag off, `requireUserId` refused *every*
 * request — Outreach and lead sync alike — and the only cure was an environment
 * variable nobody could guess they needed.
 *
 * A configured database settles it instead. Rows are owned by a `user_id`, so
 * either the server can tell people apart or it cannot serve them at all; there
 * is no useful third state. Sign-in therefore switches itself on whenever
 * `DATABASE_URL` is present, and the flag only decides the case where no
 * database exists — which is exactly local `npm run dev`, still the dev user,
 * still no sign-in.
 *
 * This is strictly stricter than before: the configuration that used to mean
 * "refuse everyone" now means "ask who you are".
 */
export function authFlagOn(): boolean {
  if (databaseConfigured()) return true;
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
