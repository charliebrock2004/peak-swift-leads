/**
 * Local email/password sign-in (this app's Better Auth DB — not the broker).
 *
 * Off by default. To enable: set `emailAndPasswordEnabled` to `true` below,
 * then build sign-up / sign-in forms with `authClient.signUp.email` /
 * `authClient.signIn.email` from `@/lib/auth/client` (see the auth skill).
 *
 * Do NOT edit `server.ts` for this — that file is frozen pre-wired config.
 */
/**
 * ON for Peak Swift.
 *
 * The deployment at `peak-swift-leads.vercel.app` has no other way in. The Grok
 * gate needs `GROK_PROJECT_ID` plus a `grok.me` host, and the broker's fallback
 * OAuth client only accepts `*.grok-sandbox.com` callbacks — neither is true of
 * a plain Vercel domain, so every server function would reject every request.
 * Better Auth's own email/password is the mechanism this template already ships
 * for exactly that case: it needs no external identity provider and works on any
 * origin.
 *
 * Sign-up is open at `/api/auth/sign-up/email` whenever this is on, so who may
 * actually *use* the app is decided separately by `APP_OWNER_EMAIL` — see
 * `./owner.ts`.
 */
export const emailAndPasswordEnabled = true;
