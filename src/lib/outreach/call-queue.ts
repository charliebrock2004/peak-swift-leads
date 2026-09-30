/**
 * Who to ring today, and why.
 *
 * A great prospect with no published email is not a dead end — it is a phone
 * call. This builds the day's list from the lead sheet itself (local-first, so
 * it works with one bar of signal): follow-ups whose date has arrived come
 * first, then the strongest never-called prospects that cannot be emailed.
 *
 * Nobody who said no, asked not to be contacted, was booked or won, or gave a
 * wrong number is ever on it. Pure and unit-tested.
 */
import { computeOpportunity, isFollowUpDue, todayIso, type Lead } from "../leads.ts";
import { decideProspect } from "../decision.ts";

export type CallItem = {
  lead: Lead;
  kind: "follow-up" | "prospect";
  /** One line: why ring them now. */
  reason: string;
  score: number;
  /** YYYY-MM-DD when a follow-up is due; empty for a fresh prospect. */
  due: string;
};

const CLOSED = new Set(["Not Interested", "Wrong Number", "Booked", "Won"]);

function callable(lead: Lead): boolean {
  if ((lead.phone ?? "").replace(/\D/g, "").length < 10) return false;
  if (lead.unsubscribed.trim() || lead.outreachStatus.trim().toLowerCase() === "unsubscribed") return false;
  if (CLOSED.has(lead.callResult) || lead.called === "Not Interested") return false;
  return true;
}

function followUpReason(lead: Lead): string {
  if (lead.callResult === "Callback" || lead.called === "Callback") return "Callback due";
  if (lead.callResult === "Interested" || lead.called === "Interested") return "Interested — follow up";
  if (lead.callResult === "No Answer" || lead.called === "No Answer") return "No answer last time — try again";
  if (lead.outreachStatus.trim().toLowerCase() === "replied") return "Replied to your email — ring them";
  return "Follow-up due";
}

export function callQueue(leads: readonly Lead[], today: string = todayIso()): { today: CallItem[]; later: CallItem[] } {
  const due: CallItem[] = [];
  const later: CallItem[] = [];
  const fresh: CallItem[] = [];
  for (const lead of leads) {
    if (!callable(lead)) continue;
    const score = computeOpportunity(lead);
    if (lead.followUpDate) {
      const item: CallItem = { lead, kind: "follow-up", reason: followUpReason(lead), score, due: lead.followUpDate };
      if (isFollowUpDue(lead) && lead.followUpDate <= today) due.push(item);
      else if (lead.followUpDate > today) later.push(item);
      continue;
    }
    if (lead.called !== "Not Called") continue;
    const decision = decideProspect(lead);
    if (decision.level !== "CALL") continue;
    fresh.push({
      lead,
      kind: "prospect",
      reason: decision.reasons[0] ? `${decision.reasons[0].replace(/\.$/, "")} — no public email` : "Good prospect — no public email",
      score,
      due: "",
    });
  }
  due.sort((a, b) => a.due.localeCompare(b.due) || b.score - a.score);
  fresh.sort((a, b) => b.score - a.score);
  later.sort((a, b) => a.due.localeCompare(b.due));
  return { today: [...due, ...fresh], later };
}
