import { useMemo, useState } from "react";
import { Download, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { LeadCards } from "@/components/leads/lead-cards";
import { LeadFormDialog } from "@/components/leads/lead-form";
import { LeadTable } from "@/components/leads/lead-table";
import { SummaryBar } from "@/components/leads/summary-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CALLED_OPTIONS,
  TOWN_SUGGESTIONS,
  TRADE_SUGGESTIONS,
  compareLeads,
  computePriority,
  downloadCsv,
  summarise,
  type CalledStatus,
  type Lead,
  type Priority,
  type SortDir,
  type SortKey,
} from "@/lib/leads";
import { cn } from "@/lib/utils";
import { useLeadsStore } from "@/store/leads-store";

const PRIORITY_FILTERS: { id: "ALL" | Priority; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "HOT", label: "Hot" },
  { id: "WARM", label: "Warm" },
  { id: "COLD", label: "Cold" },
];

export function LeadApp() {
  const leads = useLeadsStore((state) => state.leads);
  const addLead = useLeadsStore((state) => state.addLead);
  const updateLead = useLeadsStore((state) => state.updateLead);
  const removeLead = useLeadsStore((state) => state.removeLead);

  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"ALL" | Priority>("ALL");
  const [calledFilter, setCalledFilter] = useState<"ALL" | CalledStatus>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Lead | null>(null);

  const visibleLeads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return leads
      .filter((lead) => {
        if (priorityFilter !== "ALL" && computePriority(lead) !== priorityFilter) return false;
        if (calledFilter !== "ALL" && lead.called !== calledFilter) return false;
        if (!needle) return true;
        return [lead.businessName, lead.trade, lead.town, lead.phone, lead.notes, lead.website]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => compareLeads(a, b, sortKey, sortDir));
  }, [leads, query, priorityFilter, calledFilter, sortKey, sortDir]);

  const summary = useMemo(() => summarise(leads), [leads]);
  const filtersOn = query.trim() !== "" || priorityFilter !== "ALL" || calledFilter !== "ALL";

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "rating" || key === "reviews" ? "desc" : "asc");
  }

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(lead: Lead) {
    setEditing(lead);
    setFormOpen(true);
  }

  function saveLead(lead: Lead) {
    const exists = leads.some((item) => item.id === lead.id);
    if (exists) {
      const { id, ...patch } = lead;
      updateLead(id, patch);
      toast("Lead updated");
      return;
    }
    addLead(lead);
    toast("Lead added");
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    removeLead(pendingDelete.id);
    toast(`Deleted ${pendingDelete.businessName || "lead"}`);
    setPendingDelete(null);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg md:h-dvh md:overflow-hidden">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-5 px-4 py-6 md:min-h-0 md:px-6 md:py-8">
        <header className="flex shrink-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift</p>
            <h1 className="mt-1 font-display text-3xl leading-tight font-medium tracking-tight md:text-4xl">
              Lead sheet
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted">
              Local businesses without a proper website. Hot = no site, 20+ reviews, 4.5 or higher.
              Warm = no site with some reviews. Cold = everything else.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => downloadCsv(leads)}>
              <Download />
              Export CSV
            </Button>
            <Button onClick={openNew}>
              <Plus />
              Add lead
            </Button>
          </div>
        </header>

        <SummaryBar summary={summary} />

        <div className="flex shrink-0 flex-col gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, trade, town, phone…"
                className="h-11 bg-surface pl-10"
                aria-label="Search leads"
              />
            </div>
            <label className="flex h-11 items-center gap-2 rounded-md bg-surface px-3 shadow-(--shadow-border) md:w-56">
              <span className="text-xs font-medium text-muted">Called</span>
              <select
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                value={calledFilter}
                onChange={(event) => setCalledFilter(event.target.value as "ALL" | CalledStatus)}
              >
                <option value="ALL">All</option>
                {CALLED_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PRIORITY_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setPriorityFilter(filter.id)}
                className={cn(
                  "h-10 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
                  priorityFilter === filter.id
                    ? "bg-accent text-accent-fg"
                    : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
                )}
              >
                {filter.label}
              </button>
            ))}
            {filtersOn ? (
              <button
                type="button"
                className="h-9 px-2 text-sm text-muted hover:text-fg"
                onClick={() => {
                  setQuery("");
                  setPriorityFilter("ALL");
                  setCalledFilter("ALL");
                }}
              >
                Clear filters
              </button>
            ) : null}
            <span className="ml-auto text-xs tabular-nums text-subtle">
              {visibleLeads.length} shown
            </span>
          </div>
        </div>

        {visibleLeads.length === 0 ? (
          <div className="rounded-xl bg-surface px-5 py-16 text-center shadow-(--shadow-border)">
            <p className="font-medium">
              {leads.length === 0 ? "No leads yet" : "No leads match these filters"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {leads.length === 0
                ? "Add a local business that doesn’t have a proper website."
                : "Try another search or clear the filters."}
            </p>
            <div className="mt-5 flex justify-center gap-2">
              {leads.length === 0 ? (
                <Button onClick={openNew}>
                  <Plus />
                  Add lead
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    setPriorityFilter("ALL");
                    setCalledFilter("ALL");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="hidden min-h-0 flex-1 flex-col md:flex">
              <LeadTable
                leads={visibleLeads}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                onChange={updateLead}
                onDelete={setPendingDelete}
              />
            </div>
            <div className="pb-8 md:hidden">
              <LeadCards
                leads={visibleLeads}
                onChange={updateLead}
                onEdit={openEdit}
                onDelete={setPendingDelete}
              />
            </div>
          </>
        )}
      </div>

      <LeadFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSave={saveLead}
      />

      {pendingDelete ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/70 p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-xl bg-surface p-5 shadow-(--shadow-overlay)">
            <h2 className="font-display text-lg font-medium">Delete this lead?</h2>
            <p className="mt-1 text-sm text-muted">
              {pendingDelete.businessName || "Untitled lead"} will be removed from the sheet.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <datalist id="trade-list">
        {TRADE_SUGGESTIONS.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      <datalist id="town-list">
        {TOWN_SUGGESTIONS.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
    </div>
  );
}
