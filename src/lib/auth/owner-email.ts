/**
 * A one-time, owner-only correction of the owner's own email address.
 *
 * TEMPORARY. This exists to fix an address typed during first setup, using the
 * database connection the deployment already has. Delete this file and
 * `src/routes/admin.owner-email.tsx` once the correction is done.
 *
 * Why it is safe to expose at all:
 *
 * - `authMiddleware` resolves `context.userId` through `requireUserId`, which
 *   already refuses anyone who is not the owner (`ForbiddenError`). So this is
 *   owner-only by construction, not by a check that could be forgotten.
 * - It can only ever rename the CALLER's own row: the `WHERE` is
 *   `"id" = context.userId`. There is no parameter for choosing a victim.
 * - The caller must type the CURRENT address as well as the new one. Getting it
 *   wrong changes nothing, which also makes the action single-use: once renamed,
 *   the old address no longer matches and a second attempt is a no-op.
 * - It only ever writes `"user"."email"` and `"account"."accountId"`. It names
 *   no other table, so no lead and no outreach row can be touched, and there is
 *   no DELETE anywhere in this file.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

const str = (value: unknown, max = 254): string =>
  value == null ? "" : String(value).trim().slice(0, max);

/** Deliberately strict: this is a gate, not a parser. */
function looksLikeEmail(value: string): boolean {
  const email = value.trim();
  if (email.length < 6 || email.length > 254 || /\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain);
}

export type OwnerEmailState =
  | {
      ok: true;
      userId: string;
      email: string;
      /** Row counts, so the effect of the change can be judged before making it. */
      leads: number;
      outreachEmails: number;
    }
  | { ok: false; error: string };

/** What the signed-in owner's record looks like right now. Read-only. */
export const getOwnerEmailState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<OwnerEmailState> => {
    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();
      const rows = await sql.query<{ id: string; email: string }>(
        `select "id", "email" from "user" where "id" = $1`,
        [context.userId],
      );
      const row = rows[0];
      if (!row) return { ok: false, error: "No account row found for this session." };
      const leads = await sql.query<{ n: number }>(
        `select count(*)::int as n from leads where user_id = $1`,
        [context.userId],
      );
      const emails = await sql.query<{ n: number }>(
        `select count(*)::int as n from outreach_emails where user_id = $1`,
        [context.userId],
      );
      return {
        ok: true,
        userId: row.id,
        email: row.email,
        leads: leads[0]?.n ?? 0,
        outreachEmails: emails[0]?.n ?? 0,
      };
    } catch (error) {
      console.error("[owner-email] state failed:", error);
      return { ok: false, error: "Could not read the owner record." };
    }
  });

export type RenameResult =
  | { ok: true; userId: string; email: string; accountsUpdated: number }
  | { ok: false; error: string };

export const renameOwnerEmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { from?: unknown; to?: unknown };
    return { from: str(source.from), to: str(source.to) };
  })
  .handler(async ({ data, context }): Promise<RenameResult> => {
    const from = data.from.toLowerCase();
    const to = data.to.trim();
    if (!from || !to) return { ok: false, error: "Both the current and the new address are required." };
    if (!looksLikeEmail(to)) return { ok: false, error: "The new address is not a valid email address." };
    if (from === to.toLowerCase()) {
      return { ok: false, error: "The new address is the same as the current one." };
    }

    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();

      const current = await sql.query<{ id: string; email: string }>(
        `select "id", "email" from "user" where "id" = $1`,
        [context.userId],
      );
      const row = current[0];
      if (!row) return { ok: false, error: "No account row found for this session." };
      if (row.email.toLowerCase() !== from) {
        return {
          ok: false,
          error: `You are signed in as ${row.email}. Type that as the current address to confirm.`,
        };
      }

      const clash = await sql.query<{ id: string }>(
        `select "id" from "user" where lower("email") = lower($1) and "id" <> $2`,
        [to, context.userId],
      );
      if (clash.length > 0) {
        return { ok: false, error: `An account with ${to} already exists. Sign in as that one instead.` };
      }

      // ONE statement, because `@/lib/db` runs each query on whatever pooled
      // connection is free — BEGIN/COMMIT issued separately would not be the
      // same session, and could half-apply. A single statement with
      // data-modifying CTEs is atomic, and both CTEs read the same snapshot, so
      // the `"account"` match still sees the OLD address.
      const result = await sql.query<{
        users_updated: number;
        accounts_updated: number;
        user_id: string | null;
        new_email: string | null;
      }>(
        `with target as (
           select "id", "email" from "user" where "id" = $1 and lower("email") = lower($2)
         ),
         acct as (
           update "account" a
              set "accountId" = $3, "updatedAt" = now()
             from target t
            where a."userId" = t."id" and lower(a."accountId") = lower(t."email")
           returning a."id"
         ),
         usr as (
           update "user" u
              set "email" = $3, "updatedAt" = now()
             from target t
            where u."id" = t."id"
           returning u."id", u."email"
         )
         select
           (select count(*)::int from usr)  as users_updated,
           (select count(*)::int from acct) as accounts_updated,
           (select "id" from usr)           as user_id,
           (select "email" from usr)        as new_email`,
        [context.userId, from, to],
      );

      const out = result[0];
      if (!out || out.users_updated !== 1 || !out.user_id) {
        return { ok: false, error: "Nothing was changed — the current address did not match." };
      }
      return {
        ok: true,
        userId: out.user_id,
        email: out.new_email ?? to,
        accountsUpdated: out.accounts_updated,
      };
    } catch (error) {
      console.error("[owner-email] rename failed:", error);
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (/unique/i.test(message)) {
        return { ok: false, error: "That address is already taken by another account." };
      }
      return { ok: false, error: "The update did not run. Nothing was changed." };
    }
  });
