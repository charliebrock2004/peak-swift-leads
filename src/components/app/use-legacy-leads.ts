import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { migrateLead, type Lead } from "@/lib/leads";
import { runLeadSync } from "@/lib/leads-sync-client";

/** Where the old local-first lead sheet kept its copy. */
const LEGACY_KEY = "peak-swift-leads-v1";
/** The server accepts at most this many changes per call. */
const BATCH = 500;

/**
 * The old lead sheet kept a copy on each device and synced it. Businesses are
 * now read from the account only, so anything this device changed and never
 * managed to send up is sent once — then the local copy is cleared. If the
 * account cannot be reached, nothing is cleared and it is tried again next
 * time the app opens. Nothing already on the account is lost: only the leads
 * this device had marked as changed are sent.
 */
export function useLegacyLeadMigration(onMigrated: () => void) {
  const done = useRef(onMigrated);
  done.current = onMigrated;
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(LEGACY_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let stored: { state?: { leads?: Partial<Lead>[]; dirty?: string[] } } = {};
    try {
      stored = JSON.parse(raw) as typeof stored;
    } catch {
      return;
    }
    const dirty = new Set(stored.state?.dirty ?? []);
    const changes = (stored.state?.leads ?? []).filter((lead) => lead.id && dirty.has(lead.id)).map((lead) => migrateLead(lead));
    let live = true;
    void (async () => {
      for (let at = 0; at < changes.length; at += BATCH) {
        const result = await runLeadSync({ since: new Date().toISOString(), changes: changes.slice(at, at + BATCH) }).catch(() => null);
        if (!live || !result?.ok) return;
      }
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // Nothing more to do: the account has every change.
      }
      if (changes.length > 0) {
        toast(`${changes.length} ${changes.length === 1 ? "business" : "businesses"} saved only on this device ${changes.length === 1 ? "was" : "were"} added to your account.`);
        done.current();
      }
    })();
    return () => {
      live = false;
    };
  }, []);
}
