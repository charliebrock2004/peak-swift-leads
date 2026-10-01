/**
 * The angle: the one reason this email is being written.
 *
 * Code finds the truth (evidence.ts); this picks which true thing to lead with,
 * from what is actually on record, so no prospect is sent every angle at once
 * and none is sent an angle the evidence does not support. The chosen angle is
 * stored with every email so replies can later be counted by angle.
 */
import { websiteVerificationOf } from "../audit/website-state.ts";
import { gatherEvidence, type Evidence } from "./evidence.ts";
import type { OutreachLead } from "./types.ts";

export const ANGLES = [
  "reputation_gap",
  "no_website",
  "social_only",
  "directory_only",
  "website_unreachable",
  "missing_enquiry",
  "website_performance",
  "mobile_experience",
  "outdated_content",
  "general",
] as const;
export type Angle = (typeof ANGLES)[number];

export const ANGLE_LABEL: Record<Angle, string> = {
  reputation_gap: "Strong reputation, weak web presence",
  no_website: "No website",
  social_only: "Social media only",
  directory_only: "Directory listings only",
  website_unreachable: "Website not loading",
  missing_enquiry: "No easy way to enquire",
  website_performance: "Website performance",
  mobile_experience: "Website on phones",
  outdated_content: "Out-of-date website",
  general: "General introduction",
};

/** What each angle asks the writer to do with its evidence. */
export const ANGLE_BRIEF: Record<Angle, string> = {
  reputation_gap: "They are clearly well thought of (the reviews below) but have no site of their own to send new customers to. Lead with that gap, plainly.",
  no_website: "Say plainly that you could not find a website for them. Do not guess why.",
  social_only: "They seem to rely on a social media page. Say that you could only find that, and that a simple site of their own would sit alongside it.",
  directory_only: "You could only find them on directory listings. Say so, without criticising the directories.",
  website_unreachable: "Their website would not load when it was checked. Mention it helpfully — they may not know.",
  missing_enquiry: "Their site has no simple way for a customer to send an enquiry, ask for a quote or book. Mention the one measured gap below.",
  website_performance: "Their site was measured as slow on phones. Mention the one measurement below, with its number, and nothing else about speed.",
  mobile_experience: "Their site was measured as not set up properly for phones. Mention the one measured finding below.",
  outdated_content: "Their site shows signs of not being updated (the measured finding below). Mention it gently and factually.",
  general: "There is no specific measured problem to mention. Introduce yourself briefly and offer to help; make no claims about their website.",
};

const FINDING_ANGLE: Record<string, Angle> = {
  no_enquiry_form: "missing_enquiry",
  no_quote_request: "missing_enquiry",
  no_online_booking: "missing_enquiry",
  no_cta: "missing_enquiry",
  psi_performance: "website_performance",
  slow_lcp: "website_performance",
  slow_response: "website_performance",
  heavy_page: "website_performance",
  slow_interaction: "website_performance",
  no_viewport: "mobile_experience",
  phone_not_tappable: "mobile_experience",
  stale_copyright: "outdated_content",
  unreachable: "website_unreachable",
  http_error: "website_unreachable",
};

/** Which angles each finding licenses — the reverse of the map above, for the quality gate. */
export function findingsFor(angle: Angle): string[] {
  return Object.entries(FINDING_ANGLE)
    .filter(([, value]) => value === angle)
    .map(([kind]) => kind);
}

export type AngleChoice = {
  angle: Angle;
  /** The facts this angle rests on — all the writer is given about their situation. */
  evidence: Evidence[];
  /** One line for the Review screen: why this angle. */
  reason: string;
  /** Other angles the evidence would also support. */
  alternatives: Angle[];
};

/** Reviews strong enough to call a reputation. */
function wellReviewed(lead: Pick<OutreachLead, "reviews" | "rating">): boolean {
  return typeof lead.reviews === "number" && lead.reviews >= 20 && (typeof lead.rating !== "number" || lead.rating >= 4.3);
}

/** Every angle the record supports, strongest first. */
export function availableAngles(lead: OutreachLead): { angle: Angle; evidence: Evidence[] }[] {
  const evidence = gatherEvidence(lead);
  const out: { angle: Angle; evidence: Evidence[]; weight: number }[] = [];
  const of = (kind: Evidence["kind"]) => evidence.filter((item) => item.kind === kind);
  const reviews = of("WELL_REVIEWED");
  const verified = websiteVerificationOf(lead);

  const absent: [Evidence["kind"], Angle][] = [
    ["NO_WEBSITE", "no_website"],
    ["SOCIAL_ONLY", "social_only"],
    ["DIRECTORY_ONLY", "directory_only"],
  ];
  for (const [kind, angle] of absent) {
    // Only a confirmed absence is an angle; "found them on Facebook" alone is not.
    const items = of(kind).filter((item) => item.strength === "STRONG");
    if (items.length === 0) continue;
    if (wellReviewed(lead) && reviews.length) out.push({ angle: "reputation_gap", evidence: [...items, ...reviews], weight: 100 });
    out.push({ angle, evidence: items, weight: 90 - out.length });
  }

  if (verified.state === "WEBSITE_UNREACHABLE") {
    out.push({ angle: "website_unreachable", evidence: [{ kind: "SITE_OBSERVATION", text: verified.reasons[0] ?? "Their website did not load when checked.", strength: "STRONG", source: "website check" }], weight: 80 });
  }

  // Measured findings, grouped into the angle each supports; the strongest
  // group (by its findings' order — keyFindings are ranked by impact) wins.
  const audits = of("AUDIT_FINDING");
  const grouped = new Map<Angle, Evidence[]>();
  for (const item of audits) {
    const angle = FINDING_ANGLE[item.finding ?? ""];
    if (!angle) continue;
    grouped.set(angle, [...(grouped.get(angle) ?? []), item]);
  }
  let rank = 0;
  for (const [angle, items] of grouped) {
    out.push({ angle, evidence: items.slice(0, 1), weight: 70 - rank });
    rank += 1;
  }

  return out.sort((a, b) => b.weight - a.weight).map(({ angle, evidence: items }) => ({ angle, evidence: items }));
}

export function selectAngle(lead: OutreachLead): AngleChoice {
  const options = availableAngles(lead);
  const chosen = options[0];
  if (!chosen) {
    return { angle: "general", evidence: [], reason: "Nothing specific is on record about their web presence, so the email makes no claim about it.", alternatives: [] };
  }
  return {
    angle: chosen.angle,
    evidence: chosen.evidence,
    reason: `${ANGLE_LABEL[chosen.angle]}: ${chosen.evidence.map((item) => item.text).join(" ")}`.slice(0, 300),
    alternatives: options.slice(1).map((option) => option.angle).filter((angle, index, all) => all.indexOf(angle) === index && angle !== chosen.angle),
  };
}
