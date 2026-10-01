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

/** What a reply meant. A suggestion for a person; nothing is sent because of it. */
export const REPLY_INTENTS = ["positive", "neutral", "negative", "objection", "ooo", "unsubscribe", "referral", "wrong_person", "later", "bounce"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const REPLY_INTENT_LABEL: Record<ReplyIntent, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Not interested",
  objection: "Objection",
  ooo: "Out of office",
  unsubscribe: "Asked to stop",
  referral: "Referred you on",
  wrong_person: "Wrong person",
  later: "Later",
  bounce: "Bounced",
};

export type ReplyClass = { kind: Exclude<ReplyKind, "">; suggestion: ReplyStage | ""; intent: ReplyIntent };

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
const WRONG_PERSON =
  /\b(?:wrong (?:person|email|address|business|company|number)|not the (?:right )?person|you(?:'ve| have) got the wrong|(?:i|he|she|they) (?:no longer|don'?t|doesn'?t) work(?:s)? (?:here|there|for)|(?:has|have) left (?:the )?(?:company|business|firm))\b/i;
const REFERRAL =
  /\b(?:(?:speak|talk) to|(?:contact|email|try|ring|call) (?:my|our|the))\s+(?:\w+\s+){0,2}(?:partner|husband|wife|son|daughter|manager|boss|owner|office|colleague|director|team)\b|\b(?:cc'?d|copied in|forwarded (?:this|your (?:email|message)) (?:to|on))\b/i;
const LATER =
  /\b(?:maybe (?:later|next (?:year|month|spring|summer|autumn|winter))|(?:in|after) the (?:new year|spring|summer|autumn|winter)|(?:in|after|until) (?:january|february|march|april|may|june|july|august|september|october|november|december)\b|(?:get|come) back to (?:you|me|us) (?:in|after|later|next)|(?:try|contact|ask|email) (?:me|us) (?:again )?(?:in|after|later|next)|(?:too|really|very) busy (?:at the moment|right now|just now)|(?:not|maybe not) (?:just|right) now|not at the moment|later in the year|next year)\b/i;
const OBJECTION =
  /\b(?:too (?:expensive|dear|pricey|much)|can'?t afford|out of (?:our|my) budget|word of mouth|(?:get|have) (?:enough|plenty of) work|facebook (?:does|is) (?:fine|enough|plenty)|(?:is this|sounds like) a scam|what'?s the catch|how (?:do|can) (?:i|we) (?:know|trust))\b/i;
const EXPLICIT_NO = /\b(?:no thanks|no thank you|not interested|please don'?t|stop (?:emailing|contacting))\b/i;
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

/**
 * Sort one incoming message into what it is, with what it probably means and a
 * suggested stage for a person. Rules, in a fixed order, always decide —
 * nothing here guesses: delivery failures and out-of-office replies by their
 * headers first, then a request to stop, then who it is for, then timing,
 * then the answer itself.
 */
export function classifyReply(message: ThreadMessageLike): ReplyClass {
  if (isBounce(message)) return { kind: "bounce", suggestion: "", intent: "bounce" };
  if (isAutoReply(message)) return { kind: "auto_reply", suggestion: "", intent: "ooo" };
  const text = `${message.subject} ${message.snippet}`;
  if (readsAsUnsubscribe(text)) return { kind: "unsubscribe", suggestion: "not_interested", intent: "unsubscribe" };
  if (WRONG_PERSON.test(text)) return { kind: "human", suggestion: "needs_follow_up", intent: "wrong_person" };
  if (REFERRAL.test(text)) return { kind: "human", suggestion: "needs_follow_up", intent: "referral" };
  const no = EXPLICIT_NO.test(text);
  // A clear no stays a no unless it leaves the door open ("maybe next year").
  const doorOpen = /\b(?:maybe|perhaps|possibly|try (?:me|us) again|get back (?:to|in touch)|in touch (?:in|after|next))\b/i.test(text);
  if (LATER.test(text) && (!no || doorOpen)) return { kind: "human", suggestion: "needs_follow_up", intent: "later" };
  if (OBJECTION.test(text) && !no) return { kind: "human", suggestion: "needs_follow_up", intent: "objection" };
  if (NOT_INTERESTED.test(text)) return { kind: "human", suggestion: "not_interested", intent: "negative" };
  if (BOOKING.test(text)) return { kind: "human", suggestion: "booked", intent: "positive" };
  if (INTERESTED.test(text)) return { kind: "human", suggestion: "interested", intent: "positive" };
  if (/\?/.test(message.snippet)) return { kind: "human", suggestion: "needs_follow_up", intent: "neutral" };
  return { kind: "human", suggestion: "new", intent: "neutral" };
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
