/**
 * The public address of this deployment, for links placed in emails.
 *
 * An unsubscribe link has to keep working from the recipient's inbox, so it
 * must point at an address that outlives this deployment: the production
 * domain on Production, the branch alias on a Preview, never the
 * per-deployment URL (which changes on every push). `APP_URL` overrides all of
 * it, e.g. for a custom domain.
 */
export type OriginEnv = {
  APP_URL?: string;
  BETTER_AUTH_URL?: string;
  VERCEL_ENV?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_BRANCH_URL?: string;
  VERCEL_URL?: string;
};

function httpsHost(value: string | undefined): string {
  const host = (value ?? "")
    .replace(/\s+/g, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return host ? `https://${host}` : "";
}

function cleanUrl(value: string | undefined): string {
  const url = (value ?? "").trim().replace(/^["']+|["']+$/g, "").replace(/\/+$/, "");
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

export function appOrigin(env: OriginEnv = process.env, fallback = ""): string {
  const explicit = cleanUrl(env.APP_URL) || cleanUrl(env.BETTER_AUTH_URL);
  if (explicit) return explicit;
  const environment = (env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (environment === "production") return httpsHost(env.VERCEL_PROJECT_PRODUCTION_URL) || httpsHost(env.VERCEL_URL) || fallback;
  if (environment === "preview") return httpsHost(env.VERCEL_BRANCH_URL) || httpsHost(env.VERCEL_URL) || fallback;
  return fallback.replace(/\/+$/, "");
}
