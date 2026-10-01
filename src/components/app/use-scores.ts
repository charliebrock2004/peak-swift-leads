/**
 * The prospect score for every business on screen, computed once per change.
 *
 * Fetches the TPS/CTPS screening records and the do-not-call list (so "call"
 * means a screened, permitted call) and builds the same context the server
 * uses. Until those load, numbers count as unscreened — never as safe.
 */
import { scoringProfile } from "@/lib/outreach/profile";
import { useEffect, useMemo, useState } from "react";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachLead } from "@/lib/outreach/types";
import { getContactContext, type ContactContext } from "@/lib/contactability/server";
import { scoreAll } from "@/lib/scoring/records";
import type { ProspectScore } from "@/lib/scoring/prospect-score";

/** Shared across screens: moving between pages does not refetch every screening. */
const CONTACT_FRESH_MS = 60_000;
let shared: { at: number; request: Promise<ContactContext | null> } | null = null;

function sharedContactContext(): Promise<ContactContext | null> {
  if (shared && Date.now() - shared.at < CONTACT_FRESH_MS) return shared.request;
  const request = getContactContext()
    .then((result) => (result.success ? result : null))
    .catch(() => null);
  shared = { at: Date.now(), request };
  void request.then((result) => {
    // A failure is not cached: the next screen asks again.
    if (!result && shared?.request === request) shared = null;
  });
  return request;
}

/** After recording a screening or a do-not-call entry, so the next read is fresh. */
export function invalidateContactContext(): void {
  shared = null;
}

export function useContactContext(): ContactContext | null {
  const [contact, setContact] = useState<ContactContext | null>(null);
  useEffect(() => {
    let live = true;
    void sharedContactContext().then((result) => {
      if (live && result) setContact(result);
    });
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
      profile: scoringProfile(state.profile),
    });
  }, [state, contact]);
}
