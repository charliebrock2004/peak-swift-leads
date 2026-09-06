/**
 * The last gate before Gmail.
 *
 * Everything that reaches this function has already been judged eligible and, in
 * most cases, read by a human. It is checked again anyway: generation can go
 * wrong, a lead can change between approval and sending, and the cost of one bad
 * email — to a real business, from a real address — is far higher than the cost
 * of refusing to send it.
 *
 * A failure here is never a retry. It is a stop.
 */
import { looksLikeEmail } from "./eligibility.ts";
import { leftoverVariables, SENDER_STUDIO } from "./templates.ts";
import type { OutreachLead } from "./types.ts";

export type QualityProblem = {
  code: string;
  message: string;
};

export type QualityVerdict = { ok: true } | { ok: false; problems: QualityProblem[] };

const MIN_SUBJECT = 4;
const MAX_SUBJECT = 120;
const MIN_BODY = 80;
const MAX_BODY = 4000;

/**
 * Text that means generation failed, however plausible the rest reads: a model
 * talking about itself, an unfilled placeholder, or a fenced code block.
 */
const BROKEN_MARKERS: [RegExp, string][] = [
  [/\bas an ai\b|\blanguage model\b|\bi'm an ai\b/i, "reads as an AI talking about itself"],
  [/\[(insert|your|business|name|company|todo|placeholder)[^\]]*\]/i, "contains an unfilled placeholder"],
  [/\blorem ipsum\b/i, "contains placeholder text"],
  [/\bTODO\b|\bFIXME\b|\bXXXX+\b/, "contains a note to self"],
  [/```/, "contains a code fence"],
  [/^\s*(subject|body)\s*:/im, "contains the field labels instead of the text"],
  [/\{\{|\}\}|<<|>>/, "contains template markers"],
];

/**
 * Wording that insults the recipient. Cold email that opens by telling someone
 * their work is bad does not win the job, and several of these are claims a page
 * fetch cannot support anyway.
 */
const INSULTING: [RegExp, string][] = [
  [/\b(terrible|awful|horrible|hideous|ugly|embarrassing|amateur|useless|rubbish)\b/i, "is insulting"],
  [/\b(bad|poor|dreadful|shocking)\s+(website|site|design)\b/i, "calls their website bad"],
  [/\b(website|site)\s+is\s+(bad|poor|terrible|awful|outdated|broken|a mess)\b/i, "calls their website bad"],
  [/\byou\s+(clearly|obviously)\b/i, "is condescending"],
];

export type QualityInput = {
  subject: string;
  body: string;
  recipient: string;
  lead: Pick<OutreachLead, "businessName" | "emailConfidence" | "emailSource" | "unsubscribed">;
  /** Lowercased suppression list. */
  suppressed?: ReadonlySet<string>;
};

/**
 * Is this specific email safe to send right now?
 *
 * Returns every problem rather than the first, so a regenerate has the full
 * picture instead of failing one rule at a time.
 */
export function checkEmailQuality(input: QualityInput): QualityVerdict {
  const problems: QualityProblem[] = [];
  const add = (code: string, message: string) => problems.push({ code, message });

  const recipient = input.recipient.trim().toLowerCase();
  if (!recipient) add("no-recipient", "There is no recipient address.");
  else if (!looksLikeEmail(recipient)) add("invalid-recipient", "The recipient address does not look valid.");
  else if (input.suppressed?.has(recipient)) add("suppressed", "That address is on the suppression list.");

  const confidence = input.lead.emailConfidence;
  if (confidence !== "HIGH" && confidence !== "MEDIUM") {
    add("low-confidence", "The email address is not confident enough to use.");
  }
  if (/guess/i.test(input.lead.emailSource)) {
    add("guessed-email", "The email address was guessed rather than found.");
  }
  if (input.lead.unsubscribed.trim()) {
    add("unsubscribed", "This business asked not to be contacted.");
  }

  const subject = input.subject.trim();
  const body = input.body.trim();

  if (subject.length < MIN_SUBJECT) add("no-subject", "The subject is empty or too short.");
  if (subject.length > MAX_SUBJECT) add("long-subject", "The subject is too long.");
  if (body.length < MIN_BODY) add("short-body", "The email is too short to be worth sending.");
  if (body.length > MAX_BODY) add("long-body", "The email is far too long.");

  const leftovers = [...leftoverVariables(subject), ...leftoverVariables(body)];
  if (leftovers.length > 0) {
    add("placeholder", `Unfilled placeholder: ${[...new Set(leftovers)].map((v) => `{{${v}}}`).join(", ")}`);
  }

  const businessName = input.lead.businessName.trim();
  if (!businessName) add("no-business-name", "The lead has no business name.");
  // Personalisation has to be real. If the business is not named anywhere, this
  // is a circular that happens to have an address on it.
  else if (!body.toLowerCase().includes(businessName.toLowerCase()) && !subject.toLowerCase().includes(businessName.toLowerCase())) {
    add("not-personalised", "The email never mentions the business by name.");
  }

  // Whoever receives this has to be able to tell who sent it.
  if (!body.toLowerCase().includes(SENDER_STUDIO.toLowerCase())) {
    add("unidentified", `The email does not identify ${SENDER_STUDIO}.`);
  }

  if (!hasOptOut(body)) add("no-opt-out", "The email gives no way to opt out.");

  for (const [pattern, why] of BROKEN_MARKERS) {
    if (pattern.test(body) || pattern.test(subject)) {
      add("broken", `The generated text ${why}.`);
      break;
    }
  }
  for (const [pattern, why] of INSULTING) {
    if (pattern.test(body) || pattern.test(subject)) {
      add("insulting", `The generated text ${why}.`);
      break;
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Does the text tell them how to stop hearing from us? */
export function hasOptOut(body: string): boolean {
  return /(rather i didn'?t|rather not hear|not to contact|don'?t contact|no longer wish|just let me know and i won'?t|reply .{0,20}stop)/i.test(
    body,
  );
}

/**
 * Words in a reply that mean "stop". Kept deliberately tight: the cost of a
 * false positive is a lead you never email again, which is survivable, but the
 * cost of matching "no thanks, not right now" as a permanent opt-out is a lost
 * prospect — so those go to the Replies list for you to read instead.
 */
const UNSUBSCRIBE_PHRASES = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bopt[- ]?out\b/i,
  /\bstop (emailing|contacting|messaging) me\b/i,
  /\bdo not (contact|email) me\b/i,
  /\bdon'?t (contact|email) me again\b/i,
  /\bno further (contact|emails)\b/i,
];

/** Does this reply ask us to stop? Drives automatic suppression. */
export function readsAsUnsubscribe(text: string): boolean {
  return UNSUBSCRIBE_PHRASES.some((pattern) => pattern.test(text));
}
