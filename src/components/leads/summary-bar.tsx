import type { LeadSummary } from "@/lib/leads";
import { cn } from "@/lib/utils";

const ITEMS: { key: keyof LeadSummary; label: string; filter?: string }[] = [
  { key: "total", label: "Total leads" },
  { key: "hot", label: "HOT" },
  { key: "notCalled", label: "Not called" },
  { key: "interested", label: "Interested" },
  { key: "callbacks", label: "Callbacks due" },
  { key: "booked", label: "Booked" },
];

export function SummaryBar({
  summary,
  onSelect,
  active,
}: {
  summary: LeadSummary;
  onSelect?: (key: keyof LeadSummary) => void;
  active?: keyof LeadSummary | null;
}) {
  return (
    <section
      aria-label="Lead summary"
      className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-border md:grid-cols-6"
    >
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect?.(item.key)}
          className={cn(
            "bg-surface px-3 py-3 text-left md:px-4",
            active === item.key && "bg-surface-2",
          )}
        >
          <p className="text-xs font-medium text-muted">{item.label}</p>
          <p
            className={`mt-1 font-display text-2xl leading-none font-medium tabular-nums tracking-tight ${item.key === "hot" ? "text-hot" : "text-fg"}`}
          >
            {summary[item.key]}
          </p>
        </button>
      ))}
    </section>
  );
}
