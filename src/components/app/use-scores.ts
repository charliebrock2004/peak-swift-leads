/**
 * The prospect score for every business on screen, computed once per change.
 *
 * Fetches the TPS/CTPS screening records and the do-not-call list (so "call"
 * means a screened, permitted call) and builds the same context the server
 * uses. Until those load, numbers count as unscreened — never as safe.
 */
import { useEffect, useMemo, useState } from "react";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachLead } from "@/lib/outreach/types";
import { getContactContext, type ContactContext } from "@/lib/contactability/server";
import { scoreAll } from "@/lib/scoring/records";
import type { ProspectScore } from "@/lib/scoring/prospect-score";

export function useContactContext(): ContactContext | null {
  const [contact, setContact] = useState<ContactContext | null>(null);
  useEffect(() => {
    let live = true;
    getContactContext()
      .then((result) => {
        if (live && result.success) setContact(result);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return contact;
}

export function useScores(state: OutreachState | null): Map<string, ProspectScore> {
  const contact = useContactContext();
  return useMemo(() => {
    if (!state) return new Map();
    const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
    return scoreAll(state.leads as OutreachLead[], {
      screenings: contact?.screenings,
      doNotCall: contact?.doNotCall,
      suppressed: new Set(state.suppression.map((entry) => entry.email.trim().toLowerCase())),
      contacted: new Set(state.emails.filter((email) => email.kind === "initial" && live.has(email.status)).map((email) => email.leadId)),
      rules: state.settings.contactRules,
    });
  }, [state, contact]);
}
