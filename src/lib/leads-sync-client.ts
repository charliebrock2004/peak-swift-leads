/**
 * Calling the sync server function from the browser, with every failure turned
 * into a value.
 *
 * The auth middleware rejects signed-out callers by throwing `Unauthorized`
 * (the template's documented client contract — see `@/lib/auth/middleware`).
 * The app is local-first, so that is not an error state to show a stack trace
 * for: it just means this device keeps its own copy for now.
 */
import { syncLeads } from "@/lib/leads-server";
import type { SyncRequest, SyncResponse } from "@/lib/leads-sync";

function isUnauthorized(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unauthor(i[sz])?ed|\b401\b/i.test(message);
}

export async function runLeadSync(request: SyncRequest): Promise<SyncResponse> {
  try {
    return await syncLeads({ data: request });
  } catch (error) {
    if (isUnauthorized(error)) {
      return {
        ok: false,
        reason: "signed-out",
        message: "Sign in to keep this sheet on every device.",
      };
    }
    return {
      ok: false,
      reason: "unavailable",
      message: "Could not reach your saved sheet just now.",
    };
  }
}
