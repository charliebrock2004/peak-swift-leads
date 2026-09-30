/**
 * What the running server can and cannot see of the Google OAuth setup, in
 * words that say what to do.
 *
 * "Google sign-in is not set up" used to be the whole message, and it was the
 * same message whether the variables had never been added or had been added
 * and simply not reached this build. On Vercel those are different problems
 * with different fixes: a deployment is given the variables that existed when it
 * was created, so a variable added or changed afterwards is invisible to it
 * until it is redeployed. This makes the two cases readable.
 *
 * Pure: the server fills `OAuthSetup` from its environment (names and Vercel's
 * own non-secret system variables only — never a value), the screens print it.
 */

export const OAUTH_VARIABLES = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
export type OAuthVariable = (typeof OAUTH_VARIABLES)[number];

export type OAuthSetup = {
  /** Which variables this running build cannot see, or sees as empty. */
  missing: OAuthVariable[];
  /** "production" | "preview" | "development" from VERCEL_ENV, or "" off Vercel. */
  environment: string;
  /** The git branch this build came from, when Vercel says. */
  branch: string;
  /** Short commit id of this build, when Vercel says. */
  commit: string;
};

export const NO_SETUP: OAuthSetup = { missing: [], environment: "", branch: "", commit: "" };

/** "GOOGLE_CLIENT_ID", or "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET". */
export function missingNames(setup: Pick<OAuthSetup, "missing">): string {
  return setup.missing.length === 0 ? "" : setup.missing.join(" and ");
}

const ENVIRONMENT_LABEL: Record<string, string> = {
  production: "Production",
  preview: "Preview",
  development: "Development",
};

/** Which build this is: "the Preview build of claude/x (commit 21a81e5)". */
export function whereRunning(setup: Pick<OAuthSetup, "environment" | "branch" | "commit">): string {
  const label = ENVIRONMENT_LABEL[setup.environment];
  if (!label) return "this server";
  const of = setup.branch ? ` of ${setup.branch}` : "";
  const at = setup.commit ? ` (commit ${setup.commit})` : "";
  return `the ${label} build${of}${at}`;
}

/**
 * The one-paragraph explanation for when a variable is not visible.
 *
 * It names the build, the variable, and the two things that make a variable
 * that is "enabled" in the dashboard still absent here.
 */
export function missingAdvice(setup: OAuthSetup): string {
  const names = missingNames(setup);
  if (!names) return "";
  const target = ENVIRONMENT_LABEL[setup.environment] ?? "this environment";
  return (
    `${names} ${setup.missing.length > 1 ? "are" : "is"} not visible to ${whereRunning(setup)}. ` +
    `Vercel gives each build the variables that existed when that build was created, so a variable added or changed since needs a redeploy of this build ` +
    `(a new commit does it too). Also check it is ticked for ${target}.`
  );
}
