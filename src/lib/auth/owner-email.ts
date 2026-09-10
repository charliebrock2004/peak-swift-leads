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

// ── Read-only account inspection ─────────────────────────────────────────────

export type AccountRow = {
  userId: string;
  email: string;
  createdAt: string;
  isOwner: boolean;
  isYou: boolean;
  leads: number;
  outreachEmails: number;
  outreachSettings: number;
  outreachTemplates: number;
  outreachSuppression: number;
  gmailAccounts: number;
};

export type Overlap = {
  otherUserId: string;
  otherEmail: string;
  sharedLeadIds: number;
  sharedEmailIds: number;
  sharedTemplateIds: number;
  sharedSuppressed: number;
};

export type AccountsOverview =
  | { ok: true; accounts: AccountRow[]; overlaps: Overlap[] }
  | { ok: false; error: string };

/**
 * Every account and what is filed under it. READ ONLY — no statement here
 * writes anything.
 *
 * The overlap figures are the ones that decide whether two accounts can be
 * merged by moving rows. `leads` is keyed `(user_id, id)`, so a lead id present
 * under BOTH accounts cannot simply have its `user_id` rewritten: that would
 * collide with the existing primary key. The same is true of
 * `outreach_templates`, `outreach_emails` and `outreach_suppression`, and
 * `outreach_settings` and `gmail_accounts` are one row per user by definition.
 */
export const getAccountsOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AccountsOverview> => {
    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();

      const rows = await sql.query<{
        id: string;
        email: string;
        createdAt: string | Date;
        leads: number;
        outreach_emails: number;
        outreach_settings: number;
        outreach_templates: number;
        outreach_suppression: number;
        gmail_accounts: number;
      }>(
        `select u."id", u."email", u."createdAt",
                (select count(*)::int from leads                l where l.user_id = u."id") as leads,
                (select count(*)::int from outreach_emails      e where e.user_id = u."id") as outreach_emails,
                (select count(*)::int from outreach_settings    s where s.user_id = u."id") as outreach_settings,
                (select count(*)::int from outreach_templates   t where t.user_id = u."id") as outreach_templates,
                (select count(*)::int from outreach_suppression p where p.user_id = u."id") as outreach_suppression,
                (select count(*)::int from gmail_accounts       g where g.user_id = u."id") as gmail_accounts
           from "user" u
          order by u."createdAt" asc, u."id" asc`,
      );

      const accounts: AccountRow[] = rows.map((row, index) => ({
        userId: row.id,
        email: row.email,
        createdAt: new Date(row.createdAt).toISOString(),
        isOwner: index === 0,
        isYou: row.id === context.userId,
        leads: row.leads,
        outreachEmails: row.outreach_emails,
        outreachSettings: row.outreach_settings,
        outreachTemplates: row.outreach_templates,
        outreachSuppression: row.outreach_suppression,
        gmailAccounts: row.gmail_accounts,
      }));

      // What a merge into the signed-in account would collide with.
      const overlaps: Overlap[] = [];
      for (const other of accounts) {
        if (other.userId === context.userId) continue;
        const [o] = await sql.query<{
          shared_lead_ids: number;
          shared_email_ids: number;
          shared_template_ids: number;
          shared_suppressed: number;
        }>(
          `select
             (select count(*)::int from leads x join leads y
                 on x.id = y.id and x.user_id = $1 and y.user_id = $2)                    as shared_lead_ids,
             (select count(*)::int from outreach_emails x join outreach_emails y
                 on x.id = y.id and x.user_id = $1 and y.user_id = $2)                    as shared_email_ids,
             (select count(*)::int from outreach_templates x join outreach_templates y
                 on x.id = y.id and x.user_id = $1 and y.user_id = $2)                    as shared_template_ids,
             (select count(*)::int from outreach_suppression x join outreach_suppression y
                 on x.email = y.email and x.user_id = $1 and y.user_id = $2)              as shared_suppressed`,
          [context.userId, other.userId],
        );
        overlaps.push({
          otherUserId: other.userId,
          otherEmail: other.email,
          sharedLeadIds: o?.shared_lead_ids ?? 0,
          sharedEmailIds: o?.shared_email_ids ?? 0,
          sharedTemplateIds: o?.shared_template_ids ?? 0,
          sharedSuppressed: o?.shared_suppressed ?? 0,
        });
      }

      return { ok: true, accounts, overlaps };
    } catch (error) {
      console.error("[owner-email] overview failed:", error);
      return { ok: false, error: "Could not read the account overview." };
    }
  });

// ── Plan A: absorb an empty duplicate account, then take its address ─────────

export type MergeResult =
  | {
      ok: true;
      userId: string;
      email: string;
      leads: number;
      templates: number;
      deletedUserId: string;
      orphanedSettingsRows: number;
    }
  | { ok: false; error: string };

/**
 * Delete an EMPTY duplicate account and move its email onto the owner's row.
 *
 * No lead, template or outreach row is read for anything but counting, and none
 * is written, moved or deleted — the owner's `user_id` never changes, so
 * everything filed under it stays exactly where it is. The only rows written are
 * one `"user"` delete (its `"session"`/`"account"` rows cascade) and one
 * `"user"` email update.
 *
 * It runs on its OWN connection, taken from the same `DATABASE_URL` the app
 * already uses. The shared client in `@/lib/db` issues every query through
 * `pool.query()`, which may pick a different pooled connection each time, so
 * `BEGIN`/`COMMIT` through it would not be one session. Data-modifying CTEs are
 * not an option either: Postgres does not order them, so the DELETE might not
 * happen before the UPDATE and the UNIQUE constraint on `"email"` would fire.
 * A real transaction on a dedicated connection is the only correct shape.
 *
 * Every precondition is re-checked INSIDE the transaction, and the lead and
 * template counts are compared before and after — a mismatch rolls back.
 */
export const mergeOwnerAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { from?: unknown; to?: unknown };
    return { from: str(source.from), to: str(source.to) };
  })
  .handler(async ({ data, context }): Promise<MergeResult> => {
    const from = data.from.trim().toLowerCase();
    const to = data.to.trim();
    if (!from || !to) return { ok: false, error: "Both addresses are required." };
    if (!looksLikeEmail(to)) return { ok: false, error: "The target address is not a valid email." };
    if (from === to.toLowerCase()) return { ok: false, error: "The two addresses are the same." };

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) return { ok: false, error: "No database is configured." };

    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString });
    await client.connect();
    try {
      await client.query("BEGIN");

      // The owner's own row, locked for the duration.
      const me = await client.query<{ id: string; email: string }>(
        `select "id", "email" from "user" where "id" = $1 for update`,
        [context.userId],
      );
      if (me.rowCount !== 1) throw new Error("No account row for this session.");
      if (me.rows[0].email.toLowerCase() !== from) {
        throw new Error(`You are signed in as ${me.rows[0].email}, not ${from}.`);
      }

      // Exactly one OTHER account may hold the target address.
      const others = await client.query<{ id: string }>(
        `select "id" from "user" where lower("email") = lower($1) and "id" <> $2 for update`,
        [to, context.userId],
      );
      if (others.rowCount !== 1) {
        throw new Error(
          others.rowCount === 0
            ? `No account uses ${to}. Use the rename action instead.`
            : `${others.rowCount} accounts use ${to}. Refusing to guess which to remove.`,
        );
      }
      const victimId = others.rows[0].id;

      // It must be EMPTY. Anything filed under it would be orphaned by the delete.
      const counts = await client.query<{
        leads: number;
        emails: number;
        templates: number;
        suppression: number;
        gmail: number;
        settings: number;
      }>(
        `select (select count(*)::int from leads                 where user_id = $1) as leads,
                (select count(*)::int from outreach_emails       where user_id = $1) as emails,
                (select count(*)::int from outreach_templates    where user_id = $1) as templates,
                (select count(*)::int from outreach_suppression  where user_id = $1) as suppression,
                (select count(*)::int from gmail_accounts        where user_id = $1) as gmail,
                (select count(*)::int from outreach_settings     where user_id = $1) as settings`,
        [victimId],
      );
      const v = counts.rows[0];
      const notEmpty = [
        v.leads ? `${v.leads} lead(s)` : "",
        v.emails ? `${v.emails} outreach email(s)` : "",
        v.templates ? `${v.templates} template(s)` : "",
        v.suppression ? `${v.suppression} suppressed address(es)` : "",
        v.gmail ? `${v.gmail} Gmail connection(s)` : "",
      ].filter(Boolean);
      if (notEmpty.length > 0) {
        throw new Error(`${to} is not empty — it holds ${notEmpty.join(", ")}. Refusing to delete it.`);
      }

      // What must survive, measured before the writes.
      const before = await client.query<{ leads: number; templates: number }>(
        `select (select count(*)::int from leads              where user_id = $1) as leads,
                (select count(*)::int from outreach_templates where user_id = $1) as templates`,
        [context.userId],
      );
      const beforeLeads = before.rows[0].leads;
      const beforeTemplates = before.rows[0].templates;

      // 1. Remove the empty account. "session" and "account" cascade.
      const deleted = await client.query(`delete from "user" where "id" = $1`, [victimId]);
      if (deleted.rowCount !== 1) throw new Error("The empty account was not removed.");

      // 2. Take its address. The user id is untouched, so nothing filed under
      //    this owner moves.
      const renamed = await client.query(
        `update "user" set "email" = $2, "updatedAt" = now() where "id" = $1`,
        [context.userId, to],
      );
      if (renamed.rowCount !== 1) throw new Error("The owner email was not updated.");

      // 3. Prove the data is untouched before committing.
      const after = await client.query<{ leads: number; templates: number }>(
        `select (select count(*)::int from leads              where user_id = $1) as leads,
                (select count(*)::int from outreach_templates where user_id = $1) as templates`,
        [context.userId],
      );
      if (after.rows[0].leads !== beforeLeads || after.rows[0].templates !== beforeTemplates) {
        throw new Error(
          `Row counts moved (leads ${beforeLeads}->${after.rows[0].leads}, ` +
            `templates ${beforeTemplates}->${after.rows[0].templates}). Rolled back.`,
        );
      }

      await client.query("COMMIT");
      return {
        ok: true,
        userId: context.userId,
        email: to,
        leads: after.rows[0].leads,
        templates: after.rows[0].templates,
        deletedUserId: victimId,
        orphanedSettingsRows: v.settings,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[owner-email] merge failed:", error);
      const message = error instanceof Error ? error.message : String(error ?? "");
      return { ok: false, error: `${message} Nothing was changed.` };
    } finally {
      await client.end().catch(() => undefined);
    }
  });
