/**
 * Email templates and the variables they fill in.
 *
 * Templates are the fallback and the editable baseline; AI personalisation is
 * the default. Both end up as plain text that goes through the same quality
 * gate, so a template can never send `{{business_name}}` to a real person.
 *
 * The wording rules are not decoration. Nothing here says a website is bad,
 * because we cannot know that from a page fetch, and because insulting someone
 * is a poor way to start a conversation about paying you.
 */
import type { OutreachLead, OutreachTemplate, TemplateKind } from "./types.ts";

export const TEMPLATE_VARIABLES = [
  "business_name",
  "location",
  "category",
  "website_status",
  "website_reason",
  "sender_name",
  "sender_studio",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export const SENDER_NAME = "Charlie";
export const SENDER_STUDIO = "PeakSwift Studio";

/**
 * The opt-out. A plain sentence, not a link: an unsubscribe URL we do not
 * actually serve would be worse than none at all, and a reply is something this
 * app can genuinely act on (see `replies.ts`).
 */
export const OPT_OUT_LINE = "If you'd rather I didn't contact you again, just let me know and I won't.";

export const DEFAULT_SIGNATURE = `${SENDER_NAME}\n${SENDER_STUDIO}`;

/** Plain-English website state, safe to put in front of the business owner. */
export function websiteStatusPhrase(lead: OutreachLead): string {
  if (lead.websiteStatus === "No Website Found") return "no website";
  if (lead.websiteStatus === "Social Only") return "a Facebook page but no website";
  if (lead.websiteStatus === "Directory Only") return "a directory listing but no website";
  if (lead.websiteQuality === "poor" || lead.websiteStatus === "Basic Website") return "a basic website";
  if (lead.websiteQuality === "improve") return "a website that could do more";
  if (lead.websiteQuality === "good") return "a good website";
  return "an online presence";
}

/**
 * One short, factual reason drawn from what was actually observed. Never a
 * judgement we cannot support — "unable to analyse" produces nothing rather
 * than a guess.
 */
export function websiteReasonPhrase(lead: OutreachLead): string {
  const analysis = lead.websiteAnalysis.trim();
  if (lead.websiteStatus === "No Website Found") {
    return "I couldn't find a website for you anywhere online";
  }
  if (lead.websiteStatus === "Social Only") {
    return "I could only find you on social media";
  }
  if (lead.websiteStatus === "Directory Only") {
    return "I could only find you on directory listings";
  }
  if (analysis && lead.websiteQuality !== "unable" && lead.websiteQuality !== "good") {
    return analysis.replace(/\.$/, "");
  }
  return "there may be room to get more out of your online presence";
}

export function variablesFor(lead: OutreachLead): Record<TemplateVariable, string> {
  return {
    business_name: lead.businessName.trim(),
    location: lead.town.trim(),
    category: lead.trade.trim().toLowerCase(),
    website_status: websiteStatusPhrase(lead),
    website_reason: websiteReasonPhrase(lead),
    sender_name: SENDER_NAME,
    sender_studio: SENDER_STUDIO,
  };
}

/**
 * Fill a template in. Unknown variables are left exactly as written so the
 * quality gate can catch them — silently blanking a typo would send a sentence
 * with a hole in it.
 */
export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name: string) => {
    const value = values[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

/** Any `{{…}}` left after rendering. Non-empty means the email must not send. */
export function leftoverVariables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((match) => match[1]);
}

export const DEFAULT_TEMPLATES: OutreachTemplate[] = [
  {
    id: "no-website",
    name: "No website",
    kind: "no-website",
    subject: "A website for {{business_name}}?",
    body: `Hi,

I'm {{sender_name}}, I build websites for small businesses around Perthshire.

I came across {{business_name}} in {{location}} and {{website_reason}}. If that's right, it means people searching for a {{category}} nearby probably aren't finding you.

I could put together a simple site that shows what you do, your area and how to get in touch. Happy to mock something up so you can see it before deciding anything.

Would that be worth a quick chat?

${OPT_OUT_LINE}`,
    signature: DEFAULT_SIGNATURE,
  },
  {
    id: "improvement",
    name: "Website improvement",
    kind: "improvement",
    subject: "Quick thought on the {{business_name}} website",
    body: `Hi,

I'm {{sender_name}} — I build websites for small businesses around Perthshire.

I had a look at {{business_name}} in {{location}} and noticed {{website_reason}}. Nothing wrong with what you've got; I just think it could be working harder at bringing you {{category}} work.

I'd be glad to show you what a refresh might look like, with no obligation either way.

Worth a quick chat?

${OPT_OUT_LINE}`,
    signature: DEFAULT_SIGNATURE,
  },
  {
    id: "general",
    name: "General website offer",
    kind: "general",
    subject: "Website for {{business_name}}",
    body: `Hi,

I'm {{sender_name}}, I build websites for small local businesses.

I came across {{business_name}} in {{location}} and wondered whether your website is bringing you as much {{category}} work as it could.

I can build something clean and quick that makes it easy for people to see what you do and get in touch. Happy to show you an example first.

Would you like me to?

${OPT_OUT_LINE}`,
    signature: DEFAULT_SIGNATURE,
  },
  {
    id: "follow-up-1",
    name: "Follow-up 1",
    kind: "follow-up-1",
    subject: "Re: {{business_name}}",
    body: `Hi,

Just following up on my note about a website for {{business_name}} — I know how easily these things get buried.

Still happy to put a mock-up together so you can see it before deciding anything.

${OPT_OUT_LINE}`,
    signature: DEFAULT_SIGNATURE,
  },
  {
    id: "follow-up-2",
    name: "Follow-up 2",
    kind: "follow-up-2",
    subject: "Re: {{business_name}}",
    body: `Hi,

Last one from me — I don't want to clutter your inbox.

If a website for {{business_name}} is ever something you want to look at, just reply and I'll pick it up from there. Otherwise all the best with the {{category}} work.

${OPT_OUT_LINE}`,
    signature: DEFAULT_SIGNATURE,
  },
];

/** The template that fits this lead's situation, when none was chosen by hand. */
export function templateForLead(lead: OutreachLead, templates: readonly OutreachTemplate[]): OutreachTemplate {
  const wanted: TemplateKind =
    lead.websiteStatus === "No Website Found" ||
    lead.websiteStatus === "Social Only" ||
    lead.websiteStatus === "Directory Only"
      ? "no-website"
      : lead.websiteQuality === "poor" || lead.websiteQuality === "improve" || lead.websiteStatus === "Basic Website"
        ? "improvement"
        : "general";
  return (
    templates.find((template) => template.kind === wanted) ??
    templates.find((template) => template.kind === "general") ??
    DEFAULT_TEMPLATES[2]
  );
}

export type ComposedEmail = { subject: string; body: string; generatedBy: string };

/** Render one template against one lead, signature and opt-out included. */
export function composeFromTemplate(lead: OutreachLead, template: OutreachTemplate): ComposedEmail {
  const values = variablesFor(lead);
  const body = renderTemplate(template.body, values).trim();
  const signature = renderTemplate(template.signature || DEFAULT_SIGNATURE, values).trim();
  return {
    subject: renderTemplate(template.subject, values).trim(),
    body: `${body}\n\n${signature}`,
    generatedBy: `template:${template.id}`,
  };
}
