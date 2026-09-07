/**
 * Who is allowed to use this deployment.
 *
 * Authentication says *who you are*; this says *whether you may be here*. They
 * are separate questions and this app needs both, because of where it runs.
 *
 * Peak Swift is one person's tool on a public URL. Better Auth's email/password
 * endpoints are open by design — anyone who finds `/api/auth/sign-up/email` can
 * mint an account. Such an account lands in its own empty workspace (every row
 * is scoped by `user_id`, so it can never read the owner's leads), but it could
 * still burn the owner's xAI quota and connect a mailbox through the owner's
 * Google OAuth client. `APP_OWNER_EMAIL` closes that door.
 *
 * Pure and config-injected so the policy can be unit-tested without an
 * environment; `owner.server.ts` is the thin wrapper that reads `process.env`.
 */

/** The decision, with a reason the UI can show rather than a bare failure. */
export type OwnerVerdict =
  | { ok: true }
  | { ok: false; reason: "not-owner" | "no-allowlist"; message: string };

/**
 * With no `APP_OWNER_EMAIL` set, the app belongs to the first account created on
 * it — and to nobody else, ever.
 *
 * The alternative was refusing everyone until an environment variable appeared,
 * which is safe but leaves a correctly-configured deployment dead with no
 * on-screen way out. This is the pattern self-hosted software has settled on for
 * the same reason: the first person through the door claims the installation.
 *
 * It is still exactly one owner, still enforced server-side on every request.
 * The exposure is only the gap between a deployment going live and the owner
 * registering, and it closes the moment they do. `APP_OWNER_EMAIL` remains the
 * way to remove even that gap, and always wins when set.
 */
export function checkFirstOwner(
  userId: string,
  firstUserId: string | null,
): OwnerVerdict {
  if (!firstUserId) {
    // No account exists yet, so this request cannot be from one.
    return { ok: false, reason: "not-owner", message: "This app has no owner account yet." };
  }
  if (userId === firstUserId) return { ok: true };
  return {
    ok: false,
    reason: "not-owner",
    message: "That account is not the owner of this app.",
  };
}

export type OwnerPolicy = {
  /** Lowercased addresses permitted to use the app. Empty means unconfigured. */
  allowlist: readonly string[];
  /**
   * Whether the local email/password door is the identity mechanism in play.
   * False on the Grok gate, where the platform already decides who gets in and
   * this allowlist must not second-guess it.
   */
  enforced: boolean;
  /** A real database is configured — i.e. this is a deployment, not a scratch run. */
  databaseConfigured: boolean;
};

/**
 * Parse `APP_OWNER_EMAIL`. Comma-separated so a second address (a spare
 * mailbox, a co-worker) can be added without a code change.
 */
export function parseOwnerList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * May this verified user be served?
 *
 * Fails **closed**: with the password door open on a real database and no
 * allowlist configured, nobody is served. That is deliberate — the alternative
 * is serving whoever signed up first, and a misconfiguration should cost a
 * puzzled owner rather than an open app. Local work (no database) is unaffected,
 * so `npm run dev` keeps behaving exactly as it did.
 */
export function checkOwner(email: string | null, policy: OwnerPolicy): OwnerVerdict {
  if (!policy.enforced) return { ok: true };

  if (policy.allowlist.length === 0) {
    if (!policy.databaseConfigured) return { ok: true };
    return {
      ok: false,
      reason: "no-allowlist",
      message:
        "This deployment has no APP_OWNER_EMAIL set, so no account may use it. " +
        "Add APP_OWNER_EMAIL to the server environment and redeploy.",
    };
  }

  const normalized = email?.trim().toLowerCase() ?? "";
  if (normalized && policy.allowlist.includes(normalized)) return { ok: true };
  return {
    ok: false,
    reason: "not-owner",
    message: "That account is not the owner of this app.",
  };
}
