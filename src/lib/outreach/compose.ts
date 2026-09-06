/**
 * Turning a lead into an email.
 *
 * Two routes, one output. AI personalisation is the default; a template is the
 * fallback and the thing you edit when you want to control the words yourself.
 * Both go through `checkEmailQuality` before anything is stored as sendable, so
 * a bad AI response can never become a real email — it degrades to the template
 * instead, which is always safe because we wrote it.
 *
 * The prompt is built here, in the pure module, so what the model is told can be
 * unit-tested: specifically, that it is only ever given facts we actually hold,
 * and is told in as many words not to invent the rest.
 */
import { computeOpportunity, opportunityBand, type Lead } from "../leads.ts";
import { checkEmailQuality } from "./quality.ts";
import {
  composeFromTemplate,
  DEFAULT_SIGNATURE,
  DEFAULT_TEMPLATES,
  OPT_OUT_LINE,
  SENDER_NAME,
  SENDER_STUDIO,
  templateForLead,
  websiteStatusPhrase,
  type ComposedEmail,
} from "./templates.ts";
import type { EmailKind, OutreachLead, OutreachTemplate } from "./types.ts";

/** Only what we actually know. Anything absent is simply not mentioned. */
export function leadFacts(lead: OutreachLead): string[] {
  const facts: string[] = [`Business name: ${lead.businessName}`];
  if (lead.trade.trim()) facts.push(`Trade: ${lead.trade}`);
  if (lead.town.trim()) facts.push(`Town: ${lead.town}`);
  facts.push(`Website situation: ${websiteStatusPhrase(lead)}`);
  if (lead.website.trim()) facts.push(`Website address: ${lead.website}`);
  if (lead.websiteQuality) facts.push(`Website assessment: ${lead.websiteQuality}`);
  if (lead.websiteAnalysis.trim()) facts.push(`What the site check saw: ${lead.websiteAnalysis}`);
  if (typeof lead.rating === "number") facts.push(`Public rating: ${lead.rating}`);
  if (typeof lead.reviews === "number") facts.push(`Public review count: ${lead.reviews}`);
  const score = computeOpportunity(lead as Lead);
  facts.push(`Opportunity score: ${score} (${opportunityBand(score)})`);
  return facts;
}

const KIND_BRIEF: Record<EmailKind, string> = {
  initial: "This is the first email. They have never heard from us.",
  "follow-up-1":
    "This is a short follow-up to an earlier email that got no reply. Be brief and low-pressure. Do not repeat the whole pitch.",
  "follow-up-2":
    "This is the final follow-up. Be very short, gracious, and make clear you will not write again unless they reply.",
};

/**
 * The instruction sent to the model.
 *
 * The constraints are the point: no invented facts, no insults, no claims the
 * website check did not support, and a required opt-out line. A model that
 * ignores them is caught by the quality gate afterwards.
 */
export function buildPrompt(lead: OutreachLead, kind: EmailKind = "initial"): string {
  return `Write a short cold outreach email to a small UK business about building or improving their website.

What we actually know about them:
${leadFacts(lead)
  .map((fact) => `- ${fact}`)
  .join("\n")}

${KIND_BRIEF[kind]}

Rules — all of them matter:
- Write as ${SENDER_NAME} from ${SENDER_STUDIO}, a small web design studio in Perthshire, Scotland.
- Use ONLY the facts above. Never invent a detail, a service, a statistic, a competitor or a compliment.
- If they have no website, say plainly that you could not find one — do not assume why.
- If they have a website, be respectful about it. Never call it bad, old, ugly, broken or embarrassing. Suggest it could do more, at most.
- No pushy sales language, no urgency, no flattery, no buzzwords, no bullet lists of benefits.
- Sound like one person writing to another. British English. Around 90-140 words.
- The goal is only to start a conversation, not to close a sale.
- End the message body with this sentence exactly: "${OPT_OUT_LINE}"
- Mention the business by name at least once.

Reply with JSON only, no code fence:
{"subject": "...", "body": "..."}
The body must NOT include a sign-off or signature — that is added separately.`;
}

/** What a provider must give back. Anything else is treated as a failure. */
export type AiDraft = { subject: string; body: string };

export type AiGenerator = (prompt: string) => Promise<AiDraft | null>;

/**
 * Pull `{"subject":…,"body":…}` out of a model response, tolerating a code fence
 * or a sentence of preamble. Returns null rather than guessing.
 */
export function parseAiDraft(text: string): AiDraft | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
    const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!subject || !body) return null;
    return { subject, body };
  } catch {
    return null;
  }
}

export type ComposeOptions = {
  kind?: EmailKind;
  /** "ai", or a template id to use instead. */
  mode?: string;
  templates?: readonly OutreachTemplate[];
  /** Absent means template-only, which is what happens with no AI key. */
  generate?: AiGenerator;
};

export type ComposeResult = ComposedEmail & {
  /** Set when AI was asked for and could not be used. Shown, not hidden. */
  fellBackBecause?: string;
};

/**
 * Compose one email.
 *
 * Never throws and never returns something unsendable: if AI is unavailable,
 * refuses, or produces text the quality gate rejects, the template for this
 * lead's situation is used instead and the reason is reported.
 */
export async function composeEmail(
  lead: OutreachLead,
  options: ComposeOptions = {},
): Promise<ComposeResult> {
  const kind = options.kind ?? "initial";
  const templates = options.templates?.length ? options.templates : DEFAULT_TEMPLATES;

  const templateFallback = (): ComposedEmail => {
    const chosen =
      kind === "initial"
        ? templateForLead(lead, templates)
        : (templates.find((template) => template.kind === kind) ??
          DEFAULT_TEMPLATES.find((template) => template.kind === kind) ??
          templateForLead(lead, templates));
    return composeFromTemplate(lead, chosen);
  };

  const wantsTemplate = options.mode && options.mode !== "ai";
  if (wantsTemplate) {
    const chosen = templates.find((template) => template.id === options.mode);
    if (chosen) return composeFromTemplate(lead, chosen);
    return templateFallback();
  }

  if (!options.generate) {
    return { ...templateFallback(), fellBackBecause: "AI is not configured — used a template." };
  }

  let draft: AiDraft | null = null;
  try {
    draft = await options.generate(buildPrompt(lead, kind));
  } catch {
    draft = null;
  }
  if (!draft) {
    return { ...templateFallback(), fellBackBecause: "AI did not respond — used a template." };
  }

  const body = `${draft.body.trim()}\n\n${DEFAULT_SIGNATURE}`;
  const verdict = checkEmailQuality({
    subject: draft.subject,
    body,
    recipient: lead.email,
    lead,
  });
  if (!verdict.ok) {
    // Only the text's own faults should force a fallback. A problem with the
    // lead (no address, suppressed) is not something a template would fix, and
    // the send-time gate will catch it anyway.
    const textProblems = verdict.problems.filter((problem) =>
      ["placeholder", "broken", "insulting", "short-body", "long-body", "no-subject", "long-subject", "not-personalised", "unidentified", "no-opt-out"].includes(
        problem.code,
      ),
    );
    if (textProblems.length > 0) {
      return {
        ...templateFallback(),
        fellBackBecause: `AI draft rejected (${textProblems[0].message}) — used a template.`,
      };
    }
  }

  return { subject: draft.subject, body, generatedBy: "ai" };
}
