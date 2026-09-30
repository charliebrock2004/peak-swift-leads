/**
 * What came back on a thread, and what it probably means.
 *
 * Reply detection used to treat any message not from us as a reply. That
 * counted a bounce from `mailer-daemon` as "they replied" — inflating the reply
 * rate, stopping follow-ups for an address that does not exist, and hiding a
 * delivery failure — and counted an out-of-office as a conversation. This sorts
 * messages into the four things they actually are.
 *
 * The stage suggestion is only ever a suggestion. Nothing here sends anything,
 * and a person decides the stage; the inbox just starts them in the likely
 * place. Pure and unit-tested.
 */
import { readsAsUnsubscribe } from "./quality.ts";
import type { ReplyKind, ReplyStage } from "./types.ts";

export type ThreadMessageLike = {
  from: string;
  subject: string;
  snippet: string;
  /** Lowercased header names. */
  headers?: Record<string, string>;
};

export type ReplyClass = { kind: Exclude<ReplyKind, "">; suggestion: ReplyStage | "" };

const BOUNCE_FROM = /mailer-daemon|postmaster@|mail delivery (?:subsystem|system)|microsoftexchange[0-9a-f]*@/i;
const BOUNCE_SUBJECT =
  /delivery status notification|undeliverable|undelivered mail|mail delivery failed|returned mail|failure notice|delivery (?:has )?failed|could not be delivered|message not delivered|address not found/i;

const AUTO_SUBJECT =
  /^\s*(?:automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (?:the )?office|ooo\b|away from (?:the|my) office|on (?:annual )?leave|on holiday|absence notice)/i;
const AUTO_BODY =
  /\b(?:i am|i'm)\s+(?:currently\s+)?(?:out of (?:the )?office|away (?:from|until)|on (?:annual )?leave|on holiday)\b|\bthis is an automated (?:reply|response|message)\b|\bthank you for your (?:email|message)[.,!]?\s+(?:we|i) will (?:get back|respond|reply)\b/i;

const NOT_INTERESTED =
  /\b(?:no thanks|no thank you|not interested|no need|we'?re (?:fine|ok|okay|sorted|happy|all set)|we already have|already got (?:a|one)|not (?:at the moment|right now|for us)|don'?t need|do not need|not looking)\b/i;
// Checked only after NOT_INTERESTED, so "not interested" never reaches here.
const INTERESTED =
  /\b(?:yes|yeah|aye|sounds (?:good|great|interesting)|interested|go ahead|how much|what (?:would|does) it cost|price|pricing|quote|give (?:me|us) a (?:call|ring)|call me|ring me|let'?s (?:chat|talk)|happy to (?:chat|talk)|mock[- ]?up|send (?:it|me|us) over|keen|tell me more|more (?:info|information|details))\b/i;
const BOOKING = /\b(?:book(?:ed)? (?:a|in)|meet(?:ing)? (?:on|at)|see you (?:on|at)|(?:monday|tuesday|wednesday|thursday|friday|saturday) (?:at|morning|afternoon)|pop (?:in|round|over))\b/i;

function header(message: ThreadMessageLike, name: string): string {
  return message.headers?.[name] ?? "";
}

/** Is this a delivery failure rather than a person? */
export function isBounce(message: ThreadMessageLike): boolean {
  if (BOUNCE_FROM.test(message.from)) return true;
  if (header(message, "x-failed-recipients")) return true;
  if (/multipart\/report/i.test(header(message, "content-type")) && /delivery-status/i.test(header(message, "content-type"))) {
    return true;
  }
  return BOUNCE_SUBJECT.test(message.subject) && /mail|deliver|postmaster|daemon/i.test(`${message.from} ${message.subject}`);
}

/** Is this an out-of-office or other machine reply? */
export function isAutoReply(message: ThreadMessageLike): boolean {
  const autoSubmitted = header(message, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (header(message, "x-autoreply") || header(message, "x-autorespond")) return true;
  if (/^(?:auto_reply|auto-reply)$/i.test(header(message, "precedence").trim())) return true;
  if (AUTO_SUBJECT.test(message.subject)) return true;
  return AUTO_BODY.test(message.snippet);
}

/** Sort one incoming message into what it is, with a suggested stage for a person. */
export function classifyReply(message: ThreadMessageLike): ReplyClass {
  if (isBounce(message)) return { kind: "bounce", suggestion: "" };
  if (isAutoReply(message)) return { kind: "auto_reply", suggestion: "" };
  const text = `${message.subject} ${message.snippet}`;
  if (readsAsUnsubscribe(text)) return { kind: "unsubscribe", suggestion: "not_interested" };
  if (NOT_INTERESTED.test(text)) return { kind: "human", suggestion: "not_interested" };
  if (BOOKING.test(text)) return { kind: "human", suggestion: "booked" };
  if (INTERESTED.test(text)) return { kind: "human", suggestion: "interested" };
  if (/\?/.test(message.snippet)) return { kind: "human", suggestion: "needs_follow_up" };
  return { kind: "human", suggestion: "new" };
}

/**
 * The message on a thread that decides what happened, oldest first.
 *
 * A bounce decides immediately (the address is dead). A person's reply beats
 * any number of auto-replies before it. An auto-reply alone is reported as
 * such and does not end the conversation.
 */
export function decideThread<T extends ThreadMessageLike>(theirs: readonly T[]): { message: T; verdict: ReplyClass } | null {
  let auto: { message: T; verdict: ReplyClass } | null = null;
  for (const message of theirs) {
    const verdict = classifyReply(message);
    if (verdict.kind === "bounce" || verdict.kind === "human" || verdict.kind === "unsubscribe") return { message, verdict };
    auto ??= { message, verdict };
  }
  return auto;
}

/**
 * What a reply stage means for the lead record, so every screen, the lifecycle
 * and the eligibility gate agree with the inbox.
 */
export function leadOutcomeForStage(stage: ReplyStage): { called?: string; callResult?: string; followUpInDays?: number } | null {
  switch (stage) {
    case "interested":
      return { called: "Interested", callResult: "Interested", followUpInDays: 2 };
    case "needs_follow_up":
      return { followUpInDays: 1 };
    case "booked":
      return { called: "Called", callResult: "Booked" };
    case "won":
      return { called: "Called", callResult: "Won" };
    case "not_interested":
      return { called: "Not Interested", callResult: "Not Interested" };
    default:
      return null;
  }
}
