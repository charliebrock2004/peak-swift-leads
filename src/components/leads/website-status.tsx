import { cn } from "@/lib/utils";
import {
  WEBSITE_SIGNAL_LABEL,
  websiteSignal,
  type WebsiteStatus,
} from "@/lib/leads";

const STYLES: Record<ReturnType<typeof websiteSignal>, string> = {
  green: "bg-site/15 text-site",
  yellow: "bg-warm-lead/15 text-warm-lead",
  red: "bg-hot/15 text-hot",
  unclear: "bg-surface-2 text-subtle",
};

export function WebsiteStatusBadge({
  status,
  className,
}: {
  status: WebsiteStatus;
  className?: string;
}) {
  const signal = websiteSignal(status);
  return (
    <span
      title={status}
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        STYLES[signal],
        className,
      )}
    >
      {WEBSITE_SIGNAL_LABEL[signal]}
    </span>
  );
}