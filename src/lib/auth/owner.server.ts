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
 *  - `databaseConfigured` marks a real deployment, which is what makes an
 *    unset allowlist fail closed instead of open.
 */
import { gateIdentityEnabled } from "./gate-identity.server";
import { checkOwner, parseOwnerList, type OwnerPolicy, type OwnerVerdict } from "./owner";
import { localPasswordAuthActive } from "./session-auth.server";

export type { OwnerVerdict };

/** Read the policy fresh each call — tests and previews change the environment. */
export function ownerPolicy(): OwnerPolicy {
  return {
    allowlist: parseOwnerList(process.env.APP_OWNER_EMAIL),
    enforced: localPasswordAuthActive() && !gateIdentityEnabled(),
    databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
  };
}

/** May this verified address use the app? */
export function authorizeOwner(email: string | null): OwnerVerdict {
  return checkOwner(email, ownerPolicy());
}
