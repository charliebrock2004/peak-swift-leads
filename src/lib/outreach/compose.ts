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
import {
  evidenceFacts,
  gatherEvidence,
  hasRealPersonalisation,
  strongestEvidence,
  type Evidence,
} from "./evidence.ts";
import { checkEmailQuality, unexpectedLinks } from "./quality.ts";
import {
  composeFromTemplate,
  DEFAULT_SIGNATURE,
  DEFAULT_TEMPLATES,
  templateForLead,
  type ComposedEmail,
} from "./templates.ts";
import type { EmailKind, OutreachLead, OutreachTemplate } from "./types.ts";
import { effectiveProfile, profileSignature, type BusinessProfile } from "./profile.ts";

/** Only what we actually know. Anything absent is simply not mentioned. */
export function leadFacts(lead: OutreachLead): string[] {
  return evidenceFacts(lead);
}

/** The evidence an email was built on, for storing and for the Review screen. */
export function evidenceFor(lead: OutreachLead): Evidence[] {
  return strongestEvidence(gatherEvidence(lead));
}

/** Is there enough to write something genuinely personal? */
export function canPersonalise(lead: OutreachLead): boolean {
  return hasRealPersonalisation(gatherEvidence(lead));
}

const KIND_BRIEF: Record<EmailKind, string> = {
  initial: "This is the first email. They have never heard from us.",
  "follow-up-1":
    "This is a short follow-up to an earlier email that got no reply. Two or three sentences. Be low-pressure. Do not repeat the whole pitch.",
  "follow-up-2":
    "This is the final follow-up. Very short and gracious, and make clear you will not write again unless they reply.",
};

/**
 * The instruction sent to the model.
 *
 * The constraints are the point: no invented facts, no insults, no claims the
 * website check did not support, and a required opt-out line. A model that
 * ignores them is caught by the quality gate afterwards, and the template is
 * used instead.
 *
 * Everything about the sender comes from the business profile, so the studio,
 * the area, what is on offer and how the email ends are the owner's words.
 */
export function buildPrompt(lead: OutreachLead, kind: EmailKind = "initial", stored?: Partial<BusinessProfile>): string {
  const profile = effectiveProfile(stored);
  const about = [
    `Name: ${profile.senderName}`,
    `Studio: ${profile.businessName}`,
    `Based in: ${profile.location}`,
    profile.areasServed ? `Works across: ${profile.areasServed}` : "",
    profile.services ? `What the studio offers: ${profile.services}` : "",
    profile.portfolioUrl ? `Examples of past work (may be linked once, optional): ${profile.portfolioUrl}` : "",
    `The next step to offer: ${profile.cta}`,
  ]
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");

  return `Write a short cold email to a small UK business about building or improving their website.

Who is writing:
${about}

What we actually know about the business (nothing else is known):
${leadFacts(lead)
  .map((fact) => `- ${fact}`)
  .join("\n")}

${KIND_BRIEF[kind]}

How it should read: ${profile.tone}. Like one person who has had a look at their business writing to another — short, human, direct and specific. Three or four short paragraphs, 70 to 120 words, British English.

The email should quickly cover, in plain words:
1. why you are writing to THEM (one of the observations above, in your own words);
2. what you noticed — only what is listed above;
3. what you could do for them, briefly;
4. a low-pressure next step, based on: "${profile.cta}".

Rules — every one of them matters:
- Write as ${profile.senderName} from ${profile.businessName}. Name ${profile.businessName} in the body so it is obvious who is writing.
- Use ONLY the facts above. Never invent a detail, a service they offer, a statistic, a percentage, a competitor, a date, how long they have traded, or a compliment.
- If you mention reviews or a rating, use exactly the numbers above. If none are listed, do not mention reviews at all.
- Never claim anything about speed, mobile, design age, search ranking or traffic, and do not mention SEO. Nothing above measures those.
- Never pretend to have spoken to them, used their services, been recommended to them, or know the owner. Never invent a first name — address the business, not a person, unless a name appears above.
- If they have no website, say plainly that you could not find one — do not assume why.
- If they have a website, be respectful about it. Never call it bad, old, ugly, broken or embarrassing. Suggest it could do more for them, at most.
- No flattery ("amazing", "blown away", "stunning work"), no urgency, no buzzwords ("next level", "boost your online presence", "leverage"), no bullet lists, no exclamation marks.
- Never open with "I hope this email finds you well" or "I hope you're well". Start with "Hi," and get to the point.
- The goal is only to start a conversation, not to close a sale.
- Mention the business by name at least once.
- End the message body with this sentence exactly: "${profile.optOutLine}"
- The body must NOT include a sign-off or signature — that is added separately.
- Subject: short and specific, five words or fewer, no clickbait, no exclamation mark.

Reply with JSON only, no code fence:
{"subject": "...", "body": "...", "personalisation": "One sentence saying which of the facts above you used and how."}`;
}

/** What a provider must give back. Anything else is treated as a failure. */
export type AiDraft = { subject: string; body: string; personalisation?: string };

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
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { subject?: unknown; body?: unknown; personalisation?: unknown };
    const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (!subject || !body) return null;
    const personalisation =
      typeof parsed.personalisation === "string" ? parsed.personalisation.trim().slice(0, 300) : "";
    return personalisation ? { subject, body, personalisation } : { subject, body };
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
  /** The studio's profile. Absent means the built-in defaults. */
  profile?: Partial<BusinessProfile>;
};

export type ComposeResult = ComposedEmail & {
  /** Set when AI was asked for and could not be used. Shown, not hidden. */
  fellBackBecause?: string;
  /** What the email was personalised from, in one sentence, for the Review screen. */
  personalisation: string;
};

/** The personalisation note for a template: which situation it was chosen for. */
function templateNote(lead: OutreachLead, template: OutreachTemplate): string {
  const facts = [lead.trade.trim() && `trade (${lead.trade.trim()})`, lead.town.trim() && `town (${lead.town.trim()})`]
    .filter(Boolean)
    .join(" and ");
  return `Template "${template.name}" chosen for their website situation${facts ? `, filled with their ${facts}` : ""}.`;
}

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
  const profile = options.profile ? effectiveProfile(options.profile) : undefined;

  const fromTemplate = (template: OutreachTemplate): ComposedEmail & { personalisation: string } => ({
    ...composeFromTemplate(lead, template, profile),
    personalisation: templateNote(lead, template),
  });

  const templateFallback = () => {
    const chosen =
      kind === "initial"
        ? templateForLead(lead, templates)
        : (templates.find((template) => template.kind === kind) ??
          DEFAULT_TEMPLATES.find((template) => template.kind === kind) ??
          templateForLead(lead, templates));
    return fromTemplate(chosen);
  };

  const wantsTemplate = options.mode && options.mode !== "ai";
  if (wantsTemplate) {
    const chosen = templates.find((template) => template.id === options.mode);
    if (chosen) return fromTemplate(chosen);
    return templateFallback();
  }

  if (!options.generate) {
    return { ...templateFallback(), fellBackBecause: "AI is not configured — used a template." };
  }

  let draft: AiDraft | null = null;
  try {
    draft = await options.generate(buildPrompt(lead, kind, profile));
  } catch {
    draft = null;
  }
  if (!draft) {
    return { ...templateFallback(), fellBackBecause: "AI did not respond — used a template." };
  }

  const signature = profile ? profileSignature(profile) : DEFAULT_SIGNATURE;
  const body = `${draft.body.trim()}\n\n${signature}`;
  const sender = effectiveProfile(profile);
  const strayLinks = unexpectedLinks(`${draft.subject}\n${draft.body}`, [
    sender.website,
    sender.portfolioUrl,
    sender.senderEmail,
    lead.website,
    lead.email,
  ]);
  if (strayLinks.length > 0) {
    return {
      ...templateFallback(),
      fellBackBecause: `AI draft rejected (it pointed to ${strayLinks[0]}, which is neither your site nor theirs) — used a template.`,
    };
  }
  const verdict = checkEmailQuality({
    subject: draft.subject,
    body,
    recipient: lead.email,
    lead,
    studio: profile?.businessName,
  });
  if (!verdict.ok) {
    // Only the text's own faults should force a fallback. A problem with the
    // lead (no address, suppressed) is not something a template would fix, and
    // the send-time gate will catch it anyway. A fabricated, invented or
    // unsupported claim IS the text's fault: storing that draft only moved the
    // refusal to the Approve button.
    const textProblems = verdict.problems.filter((problem) =>
      [
        "placeholder",
        "broken",
        "insulting",
        "short-body",
        "long-body",
        "no-subject",
        "long-subject",
        "not-personalised",
        "unidentified",
        "no-opt-out",
        "fabricated",
        "generic",
        "invented",
        "unsupported",
      ].includes(problem.code),
    );
    if (textProblems.length > 0) {
      return {
        ...templateFallback(),
        fellBackBecause: `AI draft rejected (${textProblems[0].message}) — used a template.`,
      };
    }
  }

  return {
    subject: draft.subject,
    body,
    generatedBy: "ai",
    personalisation: draft.personalisation || "Written by AI from the evidence listed.",
  };
}
