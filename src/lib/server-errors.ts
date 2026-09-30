/**
 * Turn a rejected server-function call into a sentence a person can act on.
 *
 * `authMiddleware` rejects before a handler runs, so these arrive as bare
 * Error messages ("Unauthorized", "Forbidden: …") rather than the `{ ok: false }`
 * values handlers return. Client-safe and pure.
 */
export function friendlyServerError(error: unknown, fallback = "That did not work. Try again."): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/^unauthori[sz]ed$/i.test(message.trim())) {
    return "Sign in to do that — searching and checking websites run on your account.";
  }
  if (/not the owner|app_owner_email|no owner account/i.test(message)) {
    return "This account is not the owner of this app. Sign in with the owner account.";
  }
  if (/cross-site request blocked/i.test(message)) {
    return "The request was blocked because it did not come from this app. Reload the page and try again.";
  }
  if (/504|503|502|timeout|timed out|abort/i.test(message)) {
    return "That took too long to answer. Try again in a moment.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return message || fallback;
}
