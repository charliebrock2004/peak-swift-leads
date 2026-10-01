/**
 * Where a sale stands.
 *
 * A stage is never typed in twice: what already happened moves it forward on
 * its own — an email sent is CONTACTED, a reply from a person is a
 * CONVERSATION, "booked" on a call is a MEETING — and a person moves it the
 * rest of the way (quote sent, won, lost, nurture). The stored stage and the
 * derived one are combined so the pipeline only ever moves forward by itself,
 * and a decision a person made (won, lost, nurture) always stands.
 */
import type { Lead } from "../leads.ts";
import type { OutreachEmail } from "../outreach/types.ts";
import { CLOSED_STAGES, OPEN_STAGES, type Opportunity, type Stage } from "./types.ts";

export function stageRank(stage: Stage): number {
  const open = (OPEN_STAGES as readonly Stage[]).indexOf(stage);
  return open >= 0 ? open : OPEN_STAGES.length;
}

export function isClosed(stage: Stage): boolean {
  return (CLOSED_STAGES as readonly Stage[]).includes(stage);
}

type LeadSignals = Pick<Lead, "called" | "callResult" | "unsubscribed" | "outreachStatus" | "lastEmailedAt">;
type EmailSignals = Pick<OutreachEmail, "status" | "replyKind" | "replyStage">;

/** The stage the record itself proves, with the reason in words. */
export function derivedStage(lead: LeadSignals, emails: readonly EmailSignals[] = []): { stage: Stage; reason: string } {
  if (lead.callResult === "Won") return { stage: "WON", reason: "Marked won" };
  if (lead.callResult === "Not Interested" || lead.called === "Not Interested") return { stage: "LOST", reason: "Not interested" };
  if (lead.unsubscribed.trim() || lead.outreachStatus.trim().toLowerCase() === "unsubscribed") return { stage: "LOST", reason: "Opted out" };
  if (lead.callResult === "Booked" || emails.some((email) => email.replyStage === "booked")) return { stage: "MEETING", reason: "Meeting booked" };
  const humanReply = emails.some((email) => email.status === "replied" && (email.replyKind === "human" || !email.replyKind));
  if (lead.callResult === "Interested" || lead.called === "Interested" || humanReply) {
    return { stage: "CONVERSATION", reason: humanReply ? "They replied" : "Interested on the phone" };
  }
  const emailed = lead.lastEmailedAt.trim() || emails.some((email) => email.status === "sent" || email.status === "replied");
  const rung = lead.called !== "Not Called" && lead.called.trim() !== "";
  if (emailed || rung) return { stage: "CONTACTED", reason: emailed ? "Emailed" : "Called" };
  return { stage: "PROSPECT", reason: "" };
}

/**
 * The stage to show: a closed stage a person chose stands; otherwise
 * whichever of stored and derived is further along.
 */
export function effectiveStage(stored: Pick<Opportunity, "stage"> | null | undefined, derived: Stage): Stage {
  if (stored && isClosed(stored.stage)) return stored.stage;
  if (isClosed(derived)) return derived;
  const current = stored?.stage ?? "PROSPECT";
  return stageRank(derived) > stageRank(current) ? derived : current;
}

/** £4,200 — or £4,200.50 when there are pence. */
export function formatPence(pence: number | null | undefined): string {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return "";
  const pounds = pence / 100;
  const whole = Number.isInteger(pounds);
  return pounds.toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** "£4,200", "4200", "4.2k", "1,250.50" → pence; anything else → null. */
export function parsePounds(text: string): number | null {
  const clean = text.trim().toLowerCase().replace(/[£,\s]/g, "");
  if (!clean) return null;
  const match = /^(\d+(?:\.\d{1,2})?)(k)?$/.exec(clean);
  if (!match) return null;
  const pounds = Number(match[1]) * (match[2] ? 1000 : 1);
  if (!Number.isFinite(pounds) || pounds < 0 || pounds > 10_000_000) return null;
  return Math.round(pounds * 100);
}

export type PipelineEntry = { stage: Stage; valuePence: number | null; wonDate?: string; stageChangedAt?: string };

export function pipelineTotals(entries: readonly PipelineEntry[], now: Date = new Date()) {
  const byStage = Object.fromEntries([...OPEN_STAGES, ...CLOSED_STAGES].map((stage) => [stage, { count: 0, pence: 0 }])) as Record<Stage, { count: number; pence: number }>;
  const month = now.toISOString().slice(0, 7);
  let wonThisMonth = 0;
  for (const entry of entries) {
    byStage[entry.stage].count += 1;
    byStage[entry.stage].pence += entry.valuePence ?? 0;
    if (entry.stage === "WON" && (entry.wonDate || entry.stageChangedAt || "").slice(0, 7) === month) wonThisMonth += entry.valuePence ?? 0;
  }
  const openStages: Stage[] = ["CONTACTED", "CONVERSATION", "MEETING", "QUOTE_SENT"];
  return {
    byStage,
    quotedPence: byStage.QUOTE_SENT.pence,
    wonThisMonthPence: wonThisMonth,
    wonPence: byStage.WON.pence,
    openCount: openStages.reduce((sum, stage) => sum + byStage[stage].count, 0),
    openPence: openStages.reduce((sum, stage) => sum + byStage[stage].pence, 0),
  };
}
