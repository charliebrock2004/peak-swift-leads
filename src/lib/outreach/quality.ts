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
import { identifiesSender, leftoverVariables, SENDER_STUDIO } from "./templates.ts";
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
 * Claims nothing in the pipeline can support.
 *
 * The prompt already asks the model not to make these; this is what stops it
 * anyway. Load speed, mobile rendering, search ranking, traffic and conversion
 * are never measured anywhere in this system, so any statement about them is
 * invented — and an invented criticism of someone's business is the single
 * worst thing this product could send.
 *
 * Deliberately NOT banned: talking about a business having no website, or only
 * a social page. Those are recorded observations with a field behind them, and
 * they are the honest reason most of these emails are worth sending at all.
 */
const FABRICATED: [RegExp, string][] = [
  // Each pattern requires a claim ABOUT THEIR SITE, never merely a word that can
  // appear in one. Two rounds of real regressions came from getting this wrong:
  // a bare "slow" refused "winter is a slow month", a bare "converting" refused
  // "converting your Facebook page into a website", a bare "mobile friendly"
  // refused "I build mobile friendly websites", and a bare "seo" refused "I'm
  // not an SEO person". A refused draft never reaches the send queue, so an
  // over-broad rule here silently breaks Approve.
  //
  // The distinction that matters throughout: "I can build a website that is X"
  // is an offer about our own work and is allowed; "your website is X" is a
  // claim about something we never measured and is refused.
  [
    /\b(?:your|the|their)\s+(?:site|website|web ?page)\b[^.!?]{0,30}\b(?:is|runs|feels|loads?|seems|looks)\s+(?:a bit\s+|quite\s+|very\s+|really\s+|pretty\s+)?(?:slow|sluggish|slowly)\b|\byour\s+(?:site|website|page)\b[^.!?]{0,30}\b(?:loads? slowly|load times?|page ?speed)\b|\byour\s+(?:loading times?|load times?|page ?speed|pagespeed)\b|\b(?:loading times?|load times?|page ?speed|pagespeed)\b[^.!?]{0,20}\b(?:could|would|is|are|must)\s+(?:be\s+)?(?:better|improved|faster|slow)\b/i,
    "claims something about load speed, which is never measured",
  ],
  [
    // "your SEO", "improve your SEO", "ranking well" — a claim. Plain "SEO" in
    // "I'm not an SEO person" is not.
    /\byour\s+seo\b|\bseo\b[^.!?]{0,20}\b(?:is|isn'?t|could|would|needs?|suffer)\b|\b(?:improve|fix|sort|boost)\w*\s+your\s+(?:seo|ranking|search)\b|\b(?:search|google) ranking\b|\brank(?:ing|s)?\s+(?:higher|well|poorly|badly|anywhere|on google|in google|in search)\b|\bfirst page of google\b|\byour\b[^.!?]{0,20}\bsearch results?\b/i,
    "claims something about search ranking, which is never measured",
  ],
  [
    // The negation is what makes it a claim. "I build mobile friendly websites"
    // is an offer; "your site isn't mobile friendly" is a verdict on their work.
    /\b(?:not|isn'?t|aren'?t|never|hardly|barely)\s+(?:very\s+|really\s+|that\s+)?mobile[- ]?(?:friendly|responsive|optimised|optimized)\b|\byour\s+(?:site|website|page)\b[^.!?]{0,30}\bmobile[- ]?(?:friendly|responsive|optimised|optimized)\b|\bdoesn'?t work on (?:a )?(?:phone|mobile)\b|\bnot responsive\b/i,
    "claims something about mobile rendering, which is never checked",
  ],
  [
    /\b(?:out ?of ?date|outdated|old[- ]fashioned|looks old|dated)\b[^.!?]{0,30}\b(?:website|site|design|look)\b|\b(?:website|site|design)\b[^.!?]{0,30}\b(?:is|looks|feels|seems|looking|feeling|seeming)\s+(?:a bit\s+|quite\s+|very\s+|really\s+|pretty\s+)?(?:out ?of ?date|outdated|dated|old[- ]fashioned|old|tired)\b/i,
    "claims the site is dated, which is never assessed",
  ],
  [
    /\b(?:conversion rates?|bounce rates?|click[- ]through|visitors? per|page views?|web traffic|site traffic|traffic to your)\b/i,
    "claims something about traffic or conversion, which is never measured",
  ],
  [
    /\bi (?:noticed|saw|see|found) (?:that )?your (?:website|site) (?:is|was|looks|loads|seems)\b/i,
    "asserts an observation about their site that was never made",
  ],
];

/** Openers that announce the email as a circular. */
const GENERIC_OPENERS: [RegExp, string][] = [
  [/\bdear (business owner|sir or madam|sir\/madam|owner|manager|team)\b/i, "opens with a circular's greeting"],
  [/\bto whom it may concern\b/i, "opens with a circular's greeting"],
  [/\bi hope this (email|message) finds you well\b/i, "opens with filler that marks it as a template"],
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
  // Only when it precedes a criticism. "You clearly care about your work" is a
  // compliment, and refusing it blocked a perfectly good email.
  [
    /\byou\s+(?:clearly|obviously)\s+(?:don'?t|do not|haven'?t|have not|aren'?t|are not|need|lack|never)\b/i,
    "is condescending",
  ],
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
  else if (!mentionsBusiness(body, businessName) && !mentionsBusiness(subject, businessName)) {
    add("not-personalised", "The email never mentions the business by name.");
  }

  // Whoever receives this has to be able to tell who sent it. Any spelling of
  // the studio's own name counts — see `identifiesSender`, which exists because
  // an exact match refused the signature the model actually writes.
  if (!identifiesSender(body)) {
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
  for (const [pattern, why] of FABRICATED) {
    if (pattern.test(body) || pattern.test(subject)) {
      add("fabricated", `The generated text ${why}.`);
      break;
    }
  }
  for (const [pattern, why] of GENERIC_OPENERS) {
    if (pattern.test(body) || pattern.test(subject)) {
      add("generic", `The generated text ${why}.`);
      break;
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Does the text tell them how to stop hearing from us?
 *
 * This is a REQUIRED rule, which makes a false negative the dangerous
 * direction: failing to recognise a perfectly good opt-out blocks the email
 * from ever being approved. The first version matched seven fixed phrasings and
 * missed five of seven natural ones — "if you'd prefer I didn't get in touch
 * again", "let me know if you'd like me to stop", "just say the word and I'll
 * leave it there" — all of which plainly give the reader a way out.
 *
 * What matters is that the reader is told they can make it stop. These are the
 * ways an actual person writes that. A body with no such sentence still fails,
 * which is the point of the rule.
 */
export function hasOptOut(body: string): boolean {
  return [
    // "if you'd rather / prefer I didn't ..."
    /\b(?:rather|prefer(?:red)?)\s+(?:i|that i)\s*(?:didn'?t|did not|not|don'?t)\b/i,
    /\brather not hear\b/i,
    /\b(?:you'?d |you would )?(?:rather|prefer) (?:i|me) (?:didn'?t|not|stopped?)\b/i,
    // "don't contact me", "not to contact you"
    /\b(?:not to|don'?t|do not|never)\s+(?:contact|email|write to|get in touch with)\b/i,
    /\bno longer wish\b/i,
    // "let me know / just say / tell me / reply" + "and I'll stop | leave you"
    /\b(?:let me know|just say|say the word|tell me|reply|drop me a line|get back to me)\b[^.!?]{0,60}\b(?:and )?(?:i'?ll |i will |and i )?(?:won'?t|will not|stop|leave (?:you|it)|no more|that'?s the end)\b/i,
    /\b(?:i'?ll|i will|happy to)\s+(?:leave (?:you|it)|stop|not (?:contact|write|email))\b/i,
    /\bleave you (?:be|alone|in peace)\b/i,
    /\breply\b.{0,20}\bstop\b/i,
    // "if you'd like me to stop", "if this isn't welcome"
    /\bif (?:you'?d like|you want) me to stop\b/i,
    /\bif (?:this|it) (?:isn'?t|is not) welcome\b/i,
  ].some((pattern) => pattern.test(body));
}

/**
 * Corporate suffixes that are part of a registered name but not of the name a
 * person writes. A model told to mention "Strathearn Joinery Ltd" very often
 * writes "Strathearn Joinery", and that is the same business.
 */
const NAME_SUFFIXES = /\b(?:ltd|limited|llp|plc|cic|co|company|inc|incorporated|the)\b/gi;

/** The words of a business name that actually identify it. */
function nameTokens(businessName: string): string[] {
  return businessName
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(NAME_SUFFIXES, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}

/**
 * Does this text name the business?
 *
 * An exact substring match refused "Strathearn Joinery" for a lead recorded as
 * "Strathearn Joinery Ltd" — the same over-literal failure that refused
 * "PeakSwift Studio", and on the half of the email the model is most likely to
 * paraphrase. Punctuation, "&" against "and", possessives and a dropped Ltd all
 * describe the same business.
 *
 * Accepts when every identifying word appears, or when one sufficiently
 * distinctive word does — "Strathearn" alone is unmistakably them. A circular
 * that names nobody still fails, which is what the rule is for.
 */
export function mentionsBusiness(text: string, businessName: string): boolean {
  const tokens = nameTokens(businessName);
  if (tokens.length === 0) return true;
  const haystack = text.toLowerCase().replace(/['’]/g, "").replace(/&/g, " and ");
  const present = (token: string) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(haystack);
  if (tokens.every(present)) return true;
  const distinctive = tokens.filter((token) => token.length >= 6).sort((a, b) => b.length - a.length)[0];
  return distinctive !== undefined && present(distinctive);
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
