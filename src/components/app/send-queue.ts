import { decideApproval } from "@/lib/outreach/approval";
import { autoContext } from "@/lib/outreach/auto-run";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachEmail, OutreachLead } from "@/lib/outreach/types";

export type QueueEntry = { email: OutreachEmail; blocked: string };

export type SendQueue = {
  /** Written, passing every rule the server will apply, waiting to go. */
  ready: QueueEntry[];
  /** Written but refused by the quality gate or eligibility rules, with why. */
  attention: QueueEntry[];
  failed: OutreachEmail[];
  sent: OutreachEmail[];
};

/**
 * Where every unsent email stands, by the same rules the server runs at
 * approval and again at send time.
 *
 * One function for the Send page, the sidebar badge and Home, so "ready" is the
 * same number everywhere — a blocked draft is not ready, whatever its status.
 */
export function sendQueue(state: OutreachState, campaignId?: string): SendQueue {
  const leadsById = new Map((state.leads as OutreachLead[]).map((lead) => [lead.id, lead]));
  const suppressedList = state.suppression.map((entry) => entry.email);
  const suppressed = new Set(suppressedList);
  const out: SendQueue = { ready: [], attention: [], failed: [], sent: [] };
  for (const email of state.emails) {
    if ((campaignId && email.campaignId !== campaignId) || email.kind === ("test" as OutreachEmail["kind"])) continue;
    if (email.status === "draft" || email.status === "approved" || email.status === "queued") {
      // Every OTHER email is counted: this one being approved must not count
      // against itself as "already has a live email".
      const outcome = decideApproval({
        decision: "queue",
        email: { ...email, status: "draft" },
        lead: leadsById.get(email.leadId) ?? null,
        context: autoContext(
          state.emails.filter((other) => other.id !== email.id),
          suppressedList,
          state.settings,
        ),
        suppressed,
        studio: state.profile.businessName,
      });
      const blocked = outcome.action === "refuse" ? outcome.reason.replace(`${email.businessName}: `, "") : "";
      (blocked ? out.attention : out.ready).push({ email, blocked });
    } else if (email.status === "failed") out.failed.push(email);
    else if (email.status === "sent" || email.status === "replied" || email.status === "bounced") out.sent.push(email);
  }
  const approvedFirst = (a: QueueEntry, b: QueueEntry) =>
    Number(b.email.status === "approved" || b.email.status === "queued") - Number(a.email.status === "approved" || a.email.status === "queued") ||
    (a.email.approvedAt || a.email.createdAt).localeCompare(b.email.approvedAt || b.email.createdAt);
  out.ready.sort(approvedFirst);
  out.sent.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return out;
}
