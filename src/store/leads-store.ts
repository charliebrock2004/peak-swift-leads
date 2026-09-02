import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createLead, migrateLead, type Lead } from "@/lib/leads";
import { runLeadSync } from "@/lib/leads-sync-client";
import {
  describeSync,
  mergeServerLeads,
  pruneTombstones,
  settledDirtyIds,
  type SyncState,
} from "@/lib/leads-sync";

/**
 * The lead sheet.
 *
 * **Local-first.** Every mutation lands in memory and in `localStorage` at once,
 * so the app is instant and works with no signal — which matters when you are
 * stood outside a job in Comrie with one bar. The same mutation marks the lead
 * *dirty*; a background sync pushes dirty leads to the account's copy and pulls
 * anything changed on another device.
 *
 * Nothing here throws when sync is unavailable. Signed out, offline, or no
 * database configured all end the same way: the sheet still works, and the
 * header says plainly that this device is the only copy.
 */

/** Debounce so a burst of edits (a call outcome, then a follow-up date) is one push. */
const PUSH_DELAY_MS = 1200;

type LeadsState = {
  /** Includes tombstones — read `liveLeads` for anything user-facing. */
  leads: Lead[];
  /** Ids changed here and not yet accepted by the server. */
  dirty: string[];
  /** Server clock from the last successful sync; `null` asks for the whole sheet. */
  cursor: string | null;
  syncState: SyncState;
  /** False while the server copy is the in-memory preview database. */
  durable: boolean;
  /** Why sync is not running, when it isn't. */
  syncMessage: string;

  addLead: (partial?: Partial<Lead>) => string;
  addLeads: (partials: Partial<Lead>[]) => number;
  updateLead: (id: string, patch: Partial<Lead>) => void;
  updateLeads: (patches: { id: string; patch: Partial<Lead> }[]) => void;
  removeLead: (id: string) => void;
  sync: () => Promise<void>;
  syncSoon: () => void;
};

let pushTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | null = null;

function stamp<T extends Partial<Lead>>(patch: T): T & { updatedAt: string } {
  return { ...patch, updatedAt: new Date().toISOString() };
}

function withDirty(current: string[], ids: string[]): string[] {
  return [...new Set([...current, ...ids])];
}

export const useLeadsStore = create<LeadsState>()(
  persist(
    (set, get) => ({
      leads: [],
      dirty: [],
      cursor: null,
      syncState: "idle",
      durable: false,
      syncMessage: "",

      addLead: (partial = {}) => {
        const lead = createLead(stamp(partial));
        set((state) => ({
          leads: [lead, ...state.leads],
          dirty: withDirty(state.dirty, [lead.id]),
        }));
        get().syncSoon();
        return lead.id;
      },

      addLeads: (partials) => {
        if (partials.length === 0) return 0;
        const leads = partials.map((partial) => createLead(stamp(partial)));
        set((state) => ({
          leads: [...leads, ...state.leads],
          dirty: withDirty(
            state.dirty,
            leads.map((lead) => lead.id),
          ),
        }));
        get().syncSoon();
        return leads.length;
      },

      updateLead: (id, patch) => {
        get().updateLeads([{ id, patch }]);
      },

      updateLeads: (patches) => {
        if (patches.length === 0) return;
        const byId = new Map(patches.map((entry) => [entry.id, entry.patch]));
        set((state) => ({
          leads: state.leads.map((lead) => {
            const patch = byId.get(lead.id);
            return patch ? { ...lead, ...stamp(patch) } : lead;
          }),
          dirty: withDirty(state.dirty, [...byId.keys()]),
        }));
        get().syncSoon();
      },

      // Soft delete: the tombstone is what tells the other devices to drop it
      // too. `pruneTombstones` clears them out once they are old enough.
      removeLead: (id) => {
        get().updateLeads([{ id, patch: { deletedAt: new Date().toISOString() } }]);
      },

      syncSoon: () => {
        if (typeof window === "undefined") return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => void get().sync(), PUSH_DELAY_MS);
      },

      sync: async () => {
        if (typeof window === "undefined") return;
        if (inFlight) return inFlight;

        const run = async () => {
          const before = get();
          const dirtySet = new Set(before.dirty);
          const changes = before.leads.filter((lead) => dirtySet.has(lead.id));

          set({ syncState: "syncing" });
          const result = await runLeadSync({ since: before.cursor, changes });

          if (!result.ok) {
            set({
              syncState: result.reason === "signed-out" ? "local-only" : "error",
              syncMessage: result.message,
            });
            return;
          }

          set((state) => {
            const settled = new Set(settledDirtyIds(changes, state.leads));
            const stillDirty = state.dirty.filter((id) => !settled.has(id));
            const merged = mergeServerLeads(state.leads, result.leads, stillDirty);
            return {
              leads: pruneTombstones(merged),
              dirty: stillDirty,
              cursor: result.cursor,
              durable: result.durable,
              syncState: "synced",
              syncMessage: "",
            };
          });
        };

        inFlight = run().finally(() => {
          inFlight = null;
        });
        return inFlight;
      },
    }),
    {
      name: "peak-swift-leads-v1",
      version: 3,
      // Transient status is derived on every sync — persisting it would show a
      // stale "Saved" on a device that has since gone offline.
      partialize: (state) => ({
        leads: state.leads,
        dirty: state.dirty,
        cursor: state.cursor,
      }),
      merge: (persisted, current) => {
        const incoming = persisted as Partial<LeadsState> | undefined;
        const leads = Array.isArray(incoming?.leads)
          ? incoming.leads.map((lead) => migrateLead(lead))
          : current.leads;
        return {
          ...current,
          leads,
          dirty: Array.isArray(incoming?.dirty) ? incoming.dirty : [],
          cursor: typeof incoming?.cursor === "string" ? incoming.cursor : null,
        };
      },
      migrate: (persisted, version) => {
        const state = persisted as { leads?: Partial<Lead>[]; dirty?: string[]; cursor?: string };
        const leads = Array.isArray(state.leads) ? state.leads.map((lead) => migrateLead(lead)) : [];
        // v2 and earlier never synced, so everything it holds is unpushed work
        // that must reach the server on the first sync — not silently dropped.
        const dirty = version < 3 ? leads.map((lead) => lead.id) : (state.dirty ?? []);
        return { leads, dirty, cursor: version < 3 ? null : (state.cursor ?? null) };
      },
    },
  ),
);

/** Header status line: state, work still queued, and whether the server copy is real. */
export function useSyncStatus(): { label: string; state: SyncState; pending: number } {
  const state = useLeadsStore((s) => s.syncState);
  const pending = useLeadsStore((s) => s.dirty.length);
  const durable = useLeadsStore((s) => s.durable);
  return { label: describeSync(state, pending, durable), state, pending };
}
