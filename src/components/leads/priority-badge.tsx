import { cn } from "@/lib/utils";
import type { Priority } from "@/lib/leads";

const STYLES: Record<Priority, string> = {
  HOT: "bg-hot/15 text-hot",
  WARM: "bg-warm-lead/15 text-warm-lead",
  COLD: "bg-surface-2 text-cold-lead",
};

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-14 items-center justify-center rounded-full px-2 text-xs font-medium tracking-wide",
        STYLES[priority],
        className,
      )}
    >
      {priority}
    </span>
  );
}
