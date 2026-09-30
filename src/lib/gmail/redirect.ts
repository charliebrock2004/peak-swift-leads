/**
 * The one redirect URI a deployment sends to Google.
 *
 * Google compares `redirect_uri` with the registered list byte for byte. It used
 * to be `<the address in the browser>/oauth/gmail`, and one Vercel deployment
 * answers on several addresses: the branch alias
 * (`<project>-git-<branch>-<team>.vercel.app`), the per-deployment URL
 * (`<project>-<hash>-<team>.vercel.app`, new on every push) and, for Production,
 * the project domains. Which one was sent depended on which link the tab had been
 * opened from — and the per-deployment URL is what a Preview had to be used on,
 * because it was the only preview address sign-in trusted. So the value Google
 * received changed with every commit and never matched the registered one.
 *
 * Now the deployment decides, from Vercel's own system variables, and the browser
 * address plays no part on Vercel:
 *
 *   1. `GOOGLE_REDIRECT_URI`, when set — an explicit choice always wins;
 *   2. Production → `https://<VERCEL_PROJECT_PRODUCTION_URL>/oauth/gmail`;
 *   3. Preview    → `https://<VERCEL_BRANCH_URL>/oauth/gmail` — the branch alias,
 *      stable across every commit on the branch;
 *   4. anywhere else (local dev) → the browser's own origin, as before.
 *
 * The Connect flow is then started on that same origin (see `switchTo`), because
 * the state kept in the tab and the sign-in cookie both belong to one host.
 */

export const CALLBACK_PATH = "/oauth/gmail";

export type RedirectEnv = {
  GOOGLE_REDIRECT_URI?: string;
  VERCEL_ENV?: string;
  VERCEL_BRANCH_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_URL?: string;
};

export type RedirectSource = "configured" | "production" | "branch" | "deployment" | "browser" | "none";

export type RedirectChoice = {
  /** Exactly what is sent to Google as `redirect_uri`, or "" if none can be formed. */
  uri: string;
  /** The origin of `uri` — where the Connect flow must run. */
  origin: string;
  source: RedirectSource;
};

/** A bare value as it may arrive in an env var: quotes and whitespace stripped. */
function bare(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, "").replace(/^["']+|["']+$/g, "");
}

/** `https://<host>` from a Vercel host variable, which carries no scheme. */
function httpsOrigin(host: string | undefined): string {
  const clean = bare(host)
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return clean ? `https://${clean}` : "";
}

function originOf(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return "";
  }
}

export function chooseRedirectUri(env: RedirectEnv, browserOrigin: string): RedirectChoice {
  const configured = bare(env.GOOGLE_REDIRECT_URI);
  if (configured) return { uri: configured, origin: originOf(configured), source: "configured" };

  const environment = bare(env.VERCEL_ENV).toLowerCase();
  if (environment === "production") {
    const origin = httpsOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
    if (origin) return { uri: `${origin}${CALLBACK_PATH}`, origin, source: "production" };
  }
  if (environment === "preview") {
    const branch = httpsOrigin(env.VERCEL_BRANCH_URL);
    if (branch) return { uri: `${branch}${CALLBACK_PATH}`, origin: branch, source: "branch" };
    const deployment = httpsOrigin(env.VERCEL_URL);
    if (deployment) return { uri: `${deployment}${CALLBACK_PATH}`, origin: deployment, source: "deployment" };
  }

  const origin = browserOrigin.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/i.test(origin)) return { uri: "", origin: "", source: "none" };
  return { uri: `${origin}${CALLBACK_PATH}`, origin, source: "browser" };
}

/** Whether the tab is already on the origin the flow must run on. */
export function sameOrigin(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();
}
