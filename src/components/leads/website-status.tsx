import { cn } from "@/lib/utils";
import type { WebsiteStatus } from "@/lib/leads";

const STYLES: Record<WebsiteStatus, string> = {
  "Proper Website": "bg-surface-2 text-muted",
  "Social Only": "bg-warm-lead/15 text-warm-lead",
  "Directory Only": "bg-surface-2 text-cold-lead",
  "No Website Found": "bg-hot/15 text-hot",
  Unclear: "bg-surface-2 text-subtle",
};

export function WebsiteStatusBadge({
  status,
  className,
}: {
  status: WebsiteStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        STYLES[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
