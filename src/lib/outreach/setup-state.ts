/**
 * Why Outreach could not load, in words the person reading them can act on.
 *
 * Every one of these failures used to surface as the same sentence — "Outreach
 * needs the database" — including the ones that had nothing to do with the
 * database. Somebody signed out, or signed in as the wrong account, was told to
 * go and configure Postgres. That sends you to fix the wrong thing, which is
 * worse than saying nothing.
 *
 * Pure and string-based so it can be unit-tested and so the same classification
 * works on both sides: the server knows its own environment and says so
 * directly, while the client has only the message from a rejected server
 * function (the auth middleware throws before any handler runs, so those never
 * reach the server's own error handling).
 */

export const SETUP_REASONS = [
  "no-database",
  "schema-missing",
  "signed-out",
  "not-owner",
  "auth-off",
  "unknown",
] as const;
export type SetupReason = (typeof SETUP_REASONS)[number];

export type SetupCopy = {
  title: string;
  detail: string;
  /** The concrete next action, when there is one a person can take. */
  fix?: string;
};

/**
 * Reassuring where it should be: the lead sheet is local-first and genuinely
 * unaffected by all of these, so every message says so rather than leaving the
 * owner wondering whether their leads are gone.
 */
export const SETUP_COPY: Record<SetupReason, SetupCopy> = {
  "no-database": {
    title: "Outreach needs the database",
    detail:
      "Sending, the queue and the suppression list all live on the server, and this deployment has no DATABASE_URL. Your lead sheet is unaffected and still works exactly as it did.",
    fix: "Add a Neon Postgres database in Vercel (Storage → Create Database → Neon) so DATABASE_URL is injected, then redeploy — the build applies the migrations itself.",
  },
  "schema-missing": {
    title: "The outreach tables are not there yet",
    detail:
      "The database is reachable but the outreach schema has not been applied to it. Your lead sheet is unaffected.",
    fix: "Redeploy: the build runs the migrations, which creates the outreach tables.",
  },
  "signed-out": {
    title: "You are signed out",
    detail:
      "Outreach is scoped to your account, so it needs a signed-in session. Your lead sheet is unaffected and still works on this device.",
    fix: "Sign in again, then reopen Outreach.",
  },
  "not-owner": {
    title: "This account cannot use Outreach",
    detail:
      "You are signed in, but this account is not the owner of this deployment. Your lead sheet is unaffected.",
    fix: "Sign in with the address configured as APP_OWNER_EMAIL.",
  },
  "auth-off": {
    title: "Sign-in is switched off on this deployment",
    detail:
      "A database is configured, but VITE_AUTH_ENABLED is false, so the server will not serve Outreach as a shared guest. Your lead sheet is unaffected and still works on this device.",
    fix: "Set VITE_AUTH_ENABLED=true, BETTER_AUTH_SECRET, BETTER_AUTH_URL and APP_OWNER_EMAIL, then redeploy. After that, create the owner account at /login.",
  },
  unknown: {
    title: "Outreach could not load",
    detail:
      "Something went wrong on the server. Your lead sheet is unaffected and still works exactly as it did.",
  },
};

/** Postgres' code for "relation does not exist" — a migration that never ran. */
export const UNDEFINED_TABLE = "42P01";

/**
 * Classify a failure from its message.
 *
 * Ordered most-specific first, and every pattern is anchored to text this app
 * or its dependencies actually produce — see `verify.server.ts` for the two auth
 * messages and `db.ts` for the no-database one.
 *
 * The fail-closed auth error mentions DATABASE_URL, so it MUST be classified as
 * `auth-off` before the generic `database_url` check. Matching it as
 * `no-database` tells the owner to add a variable they already have.
 */
export function classifySetupError(message: string | null | undefined): SetupReason {
  const text = (message ?? "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("not the owner") || text.includes("app_owner_email")) return "not-owner";
  if (text.includes("unauthorized")) return "signed-out";
  if (text.includes("auth is disabled") || text.includes("vite_auth_enabled")) return "auth-off";
  if (text.includes("no database configured") || text.includes("database_url")) return "no-database";
  // `text` is lowercased, so the code must be too — comparing it as `42P01`
  // never matched.
  if (text.includes(UNDEFINED_TABLE.toLowerCase()) || text.includes("does not exist")) {
    return "schema-missing";
  }
  return "unknown";
}
