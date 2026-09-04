/**
 * Lead sync — the pure half.
 *
 * Peak Swift Leads is **local-first**. Every device keeps a full copy of the
 * sheet in `localStorage` and stays fully usable with no network, no database
 * and nobody signed in. When a server IS reachable, this module decides how the
 * two copies reconcile.
 *
 * The rules, in one place so they can be unit-tested without a database:
 *
 * - Each device tracks the ids it has changed but not yet pushed (**dirty**).
 * - A sync pushes the dirty leads, then pulls everything the server has seen
 *   change since this device's `cursor`.
 * - A pulled row replaces the local copy **unless** the lead is still dirty —
 *   an unpushed local edit always survives, and goes up on the next pass.
 * - Deletes travel as tombstones (`deletedAt`), so deleting on the phone also
 *   removes it on the laptop. Tombstones are pruned once they are old enough
 *   that every device has certainly seen them.
 *
 * The server, not the client, stamps the `updated_at` that `cursor` pages
 * through — a device with a wrong clock must not be able to skip other rows.
 */
import type { Lead } from "./leads.ts";
import { migrateLead } from "./leads.ts";

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

/** How long a tombstone is kept before it is dropped from the local copy. */
export const TOMBSTONE_TTL_DAYS = 60;

/**
 * Fold pulled rows into the local sheet.
 *
 * `dirty` are ids with unpushed local edits: those keep the local copy, because
 * the pull may have been served before this device's change arrived.
 */
export function mergeServerLeads(local: Lead[], incoming: Lead[], dirty: Iterable<string>): Lead[] {
  const held = new Set(dirty);
  const byId = new Map(local.map((lead) => [lead.id, lead]));
  for (const raw of incoming) {
    if (!raw?.id || held.has(raw.id)) continue;
    byId.set(raw.id, migrateLead(raw));
  }
  return [...byId.values()];
}

/**
 * Drop tombstones older than `ttlDays`. Anything still live is untouched, so
 * this can run on every load without risking real leads.
 */
export function pruneTombstones(
  leads: Lead[],
  now: Date = new Date(),
  ttlDays: number = TOMBSTONE_TTL_DAYS,
): Lead[] {
  const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
  return leads.filter((lead) => {
    if (!lead.deletedAt) return true;
    const at = Date.parse(lead.deletedAt);
    return Number.isNaN(at) || at > cutoff;
  });
}

/**
 * Which ids can leave the dirty set after a successful push.
 *
 * A lead edited again *while the push was in flight* must stay dirty — its new
 * value never reached the server. Comparing the `updatedAt` that was sent
 * against the one held now is what distinguishes the two cases.
 */
export function settledDirtyIds(pushed: Lead[], current: Lead[]): string[] {
  const now = new Map(current.map((lead) => [lead.id, lead.updatedAt]));
  return pushed.filter((lead) => now.get(lead.id) === lead.updatedAt).map((lead) => lead.id);
}

/** What the sync indicator shows. */
export type SyncState =
  | "idle"
  | "syncing"
  | "synced"
  /** Working, but this device's copy is the only copy. */
  | "local-only"
  | "error";

export function describeSync(state: SyncState, pending: number, durable: boolean): string {
  if (state === "syncing") return "Saving…";
  if (state === "error") return "Could not sync — saved on this device";
  if (state === "local-only") return "This device only";
  if (!durable) return "Preview storage";
  if (pending > 0) return `${pending} to save`;
  if (state === "synced") return "Saved to your account";
  return "Ready";
}
