import type { LeadSummary } from "@/lib/leads";

const ITEMS: { key: keyof LeadSummary; label: string }[] = [
  { key: "total", label: "Total leads" },
  { key: "hot", label: "Hot leads" },
  { key: "notCalled", label: "Not called" },
  { key: "interested", label: "Interested" },
  { key: "callbacks", label: "Callbacks" },
  { key: "booked", label: "Booked" },
];

export function SummaryBar({ summary }: { summary: LeadSummary }) {
  return (
    <section
      aria-label="Lead summary"
      className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-border md:grid-cols-6"
    >
      {ITEMS.map((item) => (
        <div key={item.key} className="bg-surface px-3 py-3 md:px-4">
          <p className="text-xs font-medium text-muted">{item.label}</p>
          <p
            className={`mt-1 font-display text-2xl leading-none font-medium tabular-nums tracking-tight ${item.key === "hot" ? "text-hot" : "text-fg"}`}
          >
            {summary[item.key]}
          </p>
        </div>
      ))}
    </section>
  );
}
