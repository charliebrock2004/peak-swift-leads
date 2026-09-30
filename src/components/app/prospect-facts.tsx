/**
 * The facts about one prospect, as a card section: website (with how it was
 * verified), reviews, email (with confidence and where it was published), and
 * why the prospect scored what it did. Every line comes from a field or a
 * recorded check — nothing here is inferred for display.
 */
import { CircleCheck, ExternalLink, Globe, Mail, Phone, Star } from "lucide-react";
import { Badge, ScoreBadge } from "./ui";
import { explainOpportunity, opportunityLabel, resolveWebsiteStatus, websiteHref, type Lead } from "@/lib/leads";
import { websiteTicks, type LeadEvidence } from "@/lib/outreach/evidence-record";
import type { OutreachLead } from "@/lib/outreach/types";
import { websiteLine } from "./format";

export function ScoreHeader({ lead }: { lead: OutreachLead }) {
  const { score } = explainOpportunity(lead as Lead);
  return (
    <div className="flex items-center gap-2">
      <ScoreBadge score={score} />
      <span className="hidden text-xs text-muted sm:inline">{opportunityLabel(score)}</span>
    </div>
  );
}

export function WhyThisProspect({ lead }: { lead: OutreachLead }) {
  const { points, capped } = explainOpportunity(lead as Lead);
  return (
    <ul className="flex flex-wrap gap-1.5">
      {points
        .filter((point) => point.points !== 0 && point.label !== "Local business")
        .map((point) => (
          <li key={point.label}>
            <Badge tone={point.points > 0 ? "neutral" : "warn"}>
              {point.label}
              <span className="text-subtle tabular">{point.points > 0 ? `+${point.points}` : point.points}</span>
            </Badge>
          </li>
        ))}
      {capped ? (
        <li>
          <Badge tone="warn">{capped}</Badge>
        </li>
      ) : null}
    </ul>
  );
}

function confidenceTone(confidence: string): "good" | "warn" | "bad" {
  return confidence === "HIGH" ? "good" : confidence === "MEDIUM" ? "warn" : "bad";
}

export function ProspectFacts({ lead, evidence }: { lead: OutreachLead; evidence?: LeadEvidence }) {
  const href = websiteHref(lead.website);
  const verified = evidence?.website?.verified && evidence.website.url;
  const ticks = websiteTicks(evidence?.website);
  const emailEvidence = evidence?.email && evidence.email.email?.toLowerCase() === lead.email.toLowerCase() ? evidence.email : undefined;
  return (
    <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
      <div className="flex min-w-0 gap-2.5">
        <dt className="mt-0.5 text-subtle">
          <Globe className="size-4" aria-label="Website" />
        </dt>
        <dd className="min-w-0">
          {href && (resolveWebsiteStatus(lead as Lead) === "Proper Website" || resolveWebsiteStatus(lead as Lead) === "Basic Website" || resolveWebsiteStatus(lead as Lead) === "Unclear") ? (
            <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 truncate text-fg underline-offset-2 hover:underline">
              <span className="truncate">{lead.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="text-fg">{websiteLine(lead)}</span>
          )}
          {verified ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-good">
              <CircleCheck className="size-3.5" /> Verified{ticks.length ? ":" : ""}
              {ticks.map((tick) => (
                <span key={tick}>✓ {tick}</span>
              ))}
            </p>
          ) : lead.websiteAnalysis ? (
            <p className="mt-0.5 text-xs text-muted">{lead.websiteAnalysis}</p>
          ) : null}
        </dd>
      </div>
      <div className="flex min-w-0 gap-2.5">
        <dt className="mt-0.5 text-subtle">
          <Mail className="size-4" aria-label="Email" />
        </dt>
        <dd className="min-w-0">
          {lead.email ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-fg">{lead.email}</span>
              {lead.emailConfidence ? <Badge tone={confidenceTone(lead.emailConfidence)}>{lead.emailConfidence}</Badge> : null}
            </span>
          ) : (
            <span className="text-muted">No public email found</span>
          )}
          {emailEvidence?.evidence ? (
            <p className="mt-0.5 truncate text-xs text-muted" title={emailEvidence.sourceUrl}>
              {emailEvidence.evidence}
              {emailEvidence.sourceUrl ? ` — ${emailEvidence.sourceUrl.replace(/^https?:\/\/(www\.)?/, "")}` : ""}
            </p>
          ) : lead.emailSource ? (
            <p className="mt-0.5 text-xs text-muted">{lead.emailSource}</p>
          ) : null}
        </dd>
      </div>
      {typeof lead.reviews === "number" && lead.reviews > 0 ? (
        <div className="flex gap-2.5">
          <dt className="mt-0.5 text-subtle">
            <Star className="size-4" aria-label="Reviews" />
          </dt>
          <dd className="text-fg tabular">
            {typeof lead.rating === "number" ? `${lead.rating} ★ · ` : ""}
            {lead.reviews} reviews
          </dd>
        </div>
      ) : null}
      {lead.phone ? (
        <div className="flex gap-2.5">
          <dt className="mt-0.5 text-subtle">
            <Phone className="size-4" aria-label="Phone" />
          </dt>
          <dd>
            <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="text-fg tabular underline-offset-2 hover:underline">
              {lead.phone}
            </a>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
