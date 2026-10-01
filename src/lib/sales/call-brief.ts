/**
 * A short call brief, built only from what is on record.
 *
 * WHY CALL is the score's own reasons, each with its source. The opener,
 * likely objections and the ask are a starting point in plain words — not a
 * script — and every fact they mention is one the brief also lists as
 * evidence: "I couldn't find a website for you" only after a search actually
 * failed to find one, "your site isn't set up for phones" only from a
 * measured audit finding. Nothing here calls an AI or invents a detail.
 */
import { websiteVerificationOf } from "../audit/website-state.ts";
import type { BusinessProfile } from "../outreach/profile.ts";
import type { OutreachLead } from "../outreach/types.ts";
import type { ProspectScore } from "../scoring/prospect-score.ts";

export type CallBrief = {
  why: { text: string; source: string }[];
  opening: string;
  objections: { objection: string; response: string }[];
  ask: string;
  /** Something low-pressure to offer if they hesitate (the profile's call to action). */
  fallback: string;
  /** The last thing that happened, in a line, or empty. */
  previous: string;
  nextAction: string;
};

function tradeWord(trade: string): string {
  const clean = trade.trim().toLowerCase();
  if (!clean) return "local businesses";
  return /s$/.test(clean) ? clean : `${clean}s`;
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function buildCallBrief(
  lead: OutreachLead,
  score: ProspectScore | undefined,
  profile: Pick<BusinessProfile, "senderName" | "businessName" | "areasServed" | "location" | "cta">,
  options: { previous?: string; now?: Date } = {},
): CallBrief {
  const why: CallBrief["why"] = [];
  for (const reason of score?.why ?? []) {
    if (reason.axis === "reach" && !/phone|call/i.test(reason.text)) continue;
    if (why.length >= 4) break;
    why.push({ text: reason.text, source: reason.source });
  }
  if (lead.phone.trim() && !why.some((line) => /phone/i.test(line.text))) {
    why.push({ text: "Phone number published", source: lead.source ? lead.source.split(/[;,]/)[0]!.trim() : "listing" });
  }

  const me = profile.senderName.trim() || "me";
  const studio = profile.businessName.trim();
  const area = (profile.areasServed || profile.location || lead.town).split(",")[0]!.trim() || "the area";
  const intro = `Hi — is that ${lead.businessName}? It's ${me}${studio ? ` from ${studio}` : ""}. I build websites for ${tradeWord(lead.trade)} around ${area}.`;
  const website = websiteVerificationOf(lead, options.now);
  const finding = lead.facts?.audit?.status === "ok" ? lead.facts.audit.keyFindings[0] : undefined;

  let opening: string;
  let hook = "";
  switch (website.state) {
    case "VERIFIED_NO_WEBSITE":
      opening = `${intro} I was looking for ${tradeWord(lead.trade)} in ${lead.town || area} and couldn't find a website for you — is that something you've thought about?`;
      break;
    case "SOCIAL_ONLY":
      opening = `${intro} I came across your Facebook page but couldn't find a website — is that deliberate, or something you've been meaning to sort?`;
      break;
    case "DIRECTORY_ONLY":
      opening = `${intro} I could only find you on directory listings, not a site of your own — is that deliberate?`;
      break;
    case "WEBSITE_UNREACHABLE":
      opening = `${intro} I tried your website and it wouldn't load for me — did you know?`;
      hook = "your website wouldn't load when I tried it";
      break;
    default:
      if (finding) {
        hook = lowerFirst(finding.title);
        opening = `${intro} I had a look at your website and noticed one thing — ${hook}. Is the site bringing you much work at the moment?`;
      } else {
        opening = `${intro} I help local ${tradeWord(lead.trade)} get more enquiries from their website — have you got a minute?`;
      }
  }

  const objections: CallBrief["objections"] = [];
  if (website.state === "VERIFIED_NO_WEBSITE" || website.state === "SOCIAL_ONLY" || website.state === "DIRECTORY_ONLY") {
    objections.push({
      objection: "We get enough work through word of mouth.",
      response: "That's great — most people I work with said the same. A simple site mostly helps the people who've heard about you check you're the real deal before they ring. Can I send you a couple of examples?",
    });
  } else {
    objections.push({
      objection: "We've already got a website.",
      response: hook
        ? `Of course — I only rang because ${hook}. I can send you a short summary of what I found, no obligation.`
        : "Of course — I can send you a short, free summary of how it looks on a phone, no obligation.",
    });
  }
  objections.push({
    objection: "How much does it cost?",
    response: "It depends what you need, so I'd rather not guess — a quick 15-minute chat and I can give you a proper price.",
  });

  const ask = "Would a quick 15-minute chat later this week work — or shall I email over a couple of examples first?";

  return {
    why,
    opening,
    objections,
    ask,
    fallback: profile.cta.trim(),
    previous: options.previous ?? "",
    nextAction: score?.actionReason ?? "",
  };
}
