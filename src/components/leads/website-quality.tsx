import { cn } from "@/lib/utils";
import {
  WEBSITE_QUALITY_LABEL,
  computeOpportunity,
  opportunityBand,
  type Lead,
  type WebsiteQuality,
} from "@/lib/leads";

const QUALITY_STYLES: Record<Exclude<WebsiteQuality, "">, string> = {
  good: "bg-site/15 text-site",
  improve: "bg-warm-lead/15 text-warm-lead",
  poor: "bg-hot/15 text-hot",
  unable: "bg-surface-2 text-subtle",
};

export function WebsiteQualityBadge({
  quality,
  score,
  analysis,
  className,
}: {
  quality: WebsiteQuality;
  score?: number | "";
  analysis?: string;
  className?: string;
}) {
  if (!quality) return null;
  return (
    <span
      title={analysis || (typeof score === "number" ? `${score}/100` : undefined)}
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        QUALITY_STYLES[quality],
        className,
      )}
    >
      {WEBSITE_QUALITY_LABEL[quality]}
      {typeof score === "number" ? ` · ${score}` : ""}
    </span>
  );
}

export function OpportunityBadge({ lead, className }: { lead: Lead; className?: string }) {
  const score = computeOpportunity(lead);
  const band = opportunityBand(score);
  return (
    <span
      title="Website opportunity — rules-based, not an AI prediction"
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        band === "High"
          ? "bg-hot/15 text-hot"
          : band === "Medium"
            ? "bg-warm-lead/15 text-warm-lead"
            : "bg-surface-2 text-subtle",
        className,
      )}
    >
      {score} · {band}
    </span>
  );
}
