/**
 * Everything that happened with one business, newest first.
 *
 * Merged from the rows that already record it — discovery, the Companies
 * House check, website audits, emails and their replies, bounces and opt-outs
 * — plus the interactions table (calls, notes, meetings, quotes, stage
 * changes) and finished tasks. Nothing is copied to build it, so it can never
 * disagree with the records it shows.
 */
import type { Lead } from "../leads.ts";
import type { OutreachEmail } from "../outreach/types.ts";
import { CALL_OUTCOME_LABEL, STAGE_LABEL, TASK_LABEL, type CallOutcome, type Interaction, type Stage, type Task } from "./types.ts";

export type TimelineKind = "discovered" | "company" | "audit" | "email" | "reply" | "bounce" | "opt_out" | "call" | "note" | "meeting" | "quote" | "stage" | "task" | "system";

export type TimelineEvent = {
  id: string;
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  tone: "good" | "bad" | "warn" | "neutral";
};

export type TimelineAudit = { id: string; finishedAt: string; status: string; opportunity: string };

const EMAIL_KIND: Record<string, string> = { initial: "Email", "follow-up-1": "Follow-up", "follow-up-2": "Second follow-up" };

export function buildTimeline(input: {
  lead: Pick<Lead, "id" | "foundAt" | "source" | "unsubscribed"> & { facts?: { companyCheckedAt?: string; companyNumber?: string; companyStatus?: string } };
  emails?: readonly OutreachEmail[];
  audits?: readonly TimelineAudit[];
  interactions?: readonly Interaction[];
  tasks?: readonly Task[];
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const { lead } = input;
  const push = (event: TimelineEvent) => {
    if (event.at && !Number.isNaN(Date.parse(event.at))) events.push(event);
  };

  push({ id: `found-${lead.id}`, at: lead.foundAt, kind: "discovered", title: "Prospect discovered", detail: lead.source ? `From ${lead.source.split(/[;,]/)[0]!.trim()}` : "", tone: "neutral" });
  const facts = lead.facts;
  if (facts?.companyCheckedAt) {
    push({
      id: `company-${lead.id}`,
      at: facts.companyCheckedAt,
      kind: "company",
      title: facts.companyNumber ? `Companies House: ${facts.companyNumber}${facts.companyStatus ? ` (${facts.companyStatus})` : ""}` : "Companies House checked — no matching company",
      detail: "",
      tone: "neutral",
    });
  }
  for (const audit of input.audits ?? []) {
    push({
      id: `audit-${audit.id}`,
      at: audit.finishedAt,
      kind: "audit",
      title: audit.status === "ok" ? "Website audit completed" : "Website audit could not reach the site",
      detail: audit.status === "ok" ? `Opportunity: ${audit.opportunity}` : "",
      tone: audit.status === "ok" ? "neutral" : "warn",
    });
  }
  for (const email of input.emails ?? []) {
    if (email.sentAt && (email.status === "sent" || email.status === "replied" || email.bouncedAt)) {
      push({ id: `sent-${email.id}`, at: email.sentAt, kind: "email", title: `${EMAIL_KIND[email.kind] ?? "Email"} sent`, detail: email.subject, tone: "neutral" });
    }
    if (email.bouncedAt) push({ id: `bounce-${email.id}`, at: email.bouncedAt, kind: "bounce", title: "Email bounced — address suppressed", detail: email.recipient, tone: "bad" });
    if (email.autoReplyAt) push({ id: `ooo-${email.id}`, at: email.autoReplyAt, kind: "reply", title: "Automatic reply (out of office)", detail: email.replySnippet ?? "", tone: "neutral" });
    if (email.repliedAt && email.status === "replied") {
      push({ id: `reply-${email.id}`, at: email.repliedAt, kind: "reply", title: "They replied", detail: email.replySnippet ?? "", tone: "good" });
    }
  }
  if (lead.unsubscribed.trim()) {
    const at = Date.parse(lead.unsubscribed) ? lead.unsubscribed : "";
    if (at) push({ id: `optout-${lead.id}`, at, kind: "opt_out", title: "Opted out — will not be contacted again", detail: "", tone: "bad" });
  }
  for (const item of input.interactions ?? []) {
    const outcome = item.outcome as CallOutcome;
    const title =
      item.type === "call"
        ? `Called — ${(CALL_OUTCOME_LABEL[outcome] ?? item.outcome ?? "").toLowerCase() || "logged"}`
        : item.type === "stage_change"
          ? `Moved to ${STAGE_LABEL[item.outcome as Stage] ?? item.outcome}`
          : item.type === "note"
            ? "Note"
            : item.type === "meeting"
              ? "Meeting"
              : item.type === "quote"
                ? "Quote sent"
                : item.summary || "Update";
    const tone = item.type === "call" ? (outcome === "interested" || outcome === "meeting_booked" ? "good" : outcome === "not_interested" || outcome === "wrong_number" ? "bad" : "neutral") : item.outcome === "WON" ? "good" : item.outcome === "LOST" ? "bad" : "neutral";
    const kind: TimelineKind = item.type === "stage_change" ? "stage" : item.type === "call" || item.type === "note" || item.type === "meeting" || item.type === "quote" ? item.type : "system";
    push({ id: `i-${item.id}`, at: item.occurredAt, kind, title, detail: item.type === "note" ? item.summary : (item.detail.note ?? ""), tone });
  }
  for (const task of input.tasks ?? []) {
    if (task.status !== "done" || !task.completedAt) continue;
    push({ id: `t-${task.id}`, at: task.completedAt, kind: "task", title: `${TASK_LABEL[task.type]} done: ${task.title}`, detail: task.notes, tone: "neutral" });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}
