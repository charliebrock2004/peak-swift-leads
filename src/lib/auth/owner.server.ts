/**
 * The owner allowlist, bound to this server's environment (server-only).
 *
 * The policy itself lives in `./owner.ts` and is pure; this file only decides
 * what the current environment means:
 *
 *  - `enforced` is true exactly when local email/password is the way in — that
 *    is, the door this app opened for its own deployment. On the Grok gate the
 *    platform decides who may enter, so the allowlist stands aside rather than
 *    adding a second, conflicting opinion.
 *  - `databaseConfigured` marks a real deployment, which is what decides whether
 *    an unset allowlist falls back to first-account ownership.
 */
import type { Sql } from "@/lib/db";
import { gateIdentityEnabled } from "./gate-identity.server";
import {
  checkFirstOwner,
  checkOwner,
  parseOwnerList,
  type OwnerPolicy,
  type OwnerVerdict,
} from "./owner";
import { databaseConfigured, localPasswordAuthActive } from "./session-auth.server";

export type { OwnerVerdict };

/** Read the policy fresh each call — tests and previews change the environment. */
export function ownerPolicy(): OwnerPolicy {
  return {
    allowlist: parseOwnerList(process.env.APP_OWNER_EMAIL),
    enforced: localPasswordAuthActive() && !gateIdentityEnabled(),
    databaseConfigured: databaseConfigured(),
  };
}

/**
 * The id of the earliest-created account, which owns this deployment when no
 * `APP_OWNER_EMAIL` is configured.
 *
 * Ordered by `createdAt` then `id`, so two accounts created in the same clock
 * tick still resolve to one stable answer rather than alternating between them.
 */
async function firstUserId(sql: Sql): Promise<string | null> {
  const rows = await sql.query<{ id: string }>(
    `select "id" from "user" order by "createdAt" asc, "id" asc limit 1`,
  );
  return rows[0]?.id ?? null;
}

/**
 * May this verified user use the app?
 *
 * `APP_OWNER_EMAIL` decides when it is set. Otherwise, on a real deployment, the
 * first account created owns it (see `checkFirstOwner`). Off a database — local
 * dev — there is nothing to protect and anyone verified is served.
 */
export async function authorizeOwner(
  user: { id: string; email: string | null },
  sql: Sql | null,
): Promise<OwnerVerdict> {
  const policy = ownerPolicy();
  if (!policy.enforced) return { ok: true };
  if (policy.allowlist.length > 0) return checkOwner(user.email, policy);
  if (!policy.databaseConfigured) return { ok: true };
  if (!sql) {
    // A deployment whose database is unreachable cannot establish ownership, and
    // guessing in either direction is worse than saying so.
    return {
      ok: false,
      reason: "not-owner",
      message: "Could not check who owns this app — the database was unreachable.",
    };
  }
  return checkFirstOwner(user.id, await firstUserId(sql));
}
