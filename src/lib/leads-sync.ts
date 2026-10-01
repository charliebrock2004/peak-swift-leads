/**
 * The lead-sync wire types.
 *
 * Businesses now live on the account and every screen reads them from the
 * server. The sync endpoint (`leads-server.ts`) remains for one job: taking in
 * the changes an older version of the app left on a device's local copy, once,
 * when that device next opens the app (components/app/use-legacy-leads.ts).
 * The server, not the client, stamps `updated_at`.
 */
import type { Lead } from "./leads.ts";

/** What the client sends up: the leads it has changed since the last sync. */
export type SyncRequest = {
  /** Server cursor from the previous sync; `null` asks for the whole sheet. */
  since: string | null;
  changes: Lead[];
};

export type SyncFailure = {
  ok: false;
  /**
   * `signed-out` — nobody is signed in, so there is no sheet to sync with.
   * `not-configured` — production has no database; this device is the only copy.
   * `unavailable` — the database could not be reached (network or server error).
   */
  reason: "signed-out" | "not-configured" | "unavailable";
  message: string;
};

export type SyncSuccess = {
  ok: true;
  /** Rows changed on the server since `since` (tombstones included). */
  leads: Lead[];
  /** Pass back as `since` next time. */
  cursor: string;
  /**
   * False when the server is running on the in-memory PGLite fallback, where
   * data does not survive a restart. The UI must not claim "saved" then.
   */
  durable: boolean;
};

export type SyncResponse = SyncSuccess | SyncFailure;
