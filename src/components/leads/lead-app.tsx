import { useMemo, useState } from "react";
import { Download, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { FindLeadsPanel } from "@/components/leads/find-leads";
import { LeadCards } from "@/components/leads/lead-cards";
import { LeadFormDialog } from "@/components/leads/lead-form";
import { LeadTable } from "@/components/leads/lead-table";
import { SummaryBar } from "@/components/leads/summary-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CALLED_OPTIONS,
  CALL_RESULT_OPTIONS,
  TOWN_SUGGESTIONS,
  TRADE_SUGGESTIONS,
  WEBSITE_STATUS_OPTIONS,
  compareLeads,
  computePriority,
  downloadCsv,
  findDuplicate,
  isFollowUpDue,
  resolveWebsiteStatus,
  summarise,
  type CallResult,
  type CalledStatus,
  type Lead,
  type LeadSummary,
  type Priority,
  type SortDir,
  type SortKey,
  type WebsiteStatus,
} from "@/lib/leads";
import type { Prospect } from "@/lib/research";
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
  const addLeads = useLeadsStore((state) => state.addLeads);
  const updateLead = useLeadsStore((state) => state.updateLead);
  const removeLead = useLeadsStore((state) => state.removeLead);

  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"ALL" | Priority>("ALL");
  const [calledFilter, setCalledFilter] = useState<"ALL" | CalledStatus>("ALL");
  const [resultFilter, setResultFilter] = useState<"ALL" | CallResult>("ALL");
  const [townFilter, setTownFilter] = useState("ALL");
  const [tradeFilter, setTradeFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | WebsiteStatus>("ALL");
  const [dueOnly, setDueOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Lead | null>(null);
  const [finding, setFinding] = useState(false);
  const [summaryKey, setSummaryKey] = useState<keyof LeadSummary | null>(null);

  const towns = useMemo(() => {
    const set = new Set<string>(TOWN_SUGGESTIONS);
    for (const lead of leads) if (lead.town.trim()) set.add(lead.town.trim());
    return [...set].sort((a, b) => a.localeCompare(b, "en-GB"));
  }, [leads]);

  const trades = useMemo(() => {
    const set = new Set<string>(TRADE_SUGGESTIONS);
    for (const lead of leads) if (lead.trade.trim()) set.add(lead.trade.trim());
    return [...set].sort((a, b) => a.localeCompare(b, "en-GB"));
  }, [leads]);

  const visibleLeads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return leads
      .filter((lead) => {
        if (priorityFilter !== "ALL" && computePriority(lead) !== priorityFilter) return false;
        if (calledFilter !== "ALL" && lead.called !== calledFilter) return false;
        if (resultFilter !== "ALL" && lead.callResult !== resultFilter) return false;
        if (townFilter !== "ALL" && lead.town.trim() !== townFilter) return false;
        if (tradeFilter !== "ALL" && lead.trade.trim() !== tradeFilter) return false;
        if (statusFilter !== "ALL" && resolveWebsiteStatus(lead) !== statusFilter) return false;
        if (dueOnly && !isFollowUpDue(lead)) return false;
        if (!needle) return true;
        return [lead.businessName, lead.trade, lead.town, lead.phone, lead.notes, lead.website]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => compareLeads(a, b, sortKey, sortDir));
  }, [
    leads,
    query,
    priorityFilter,
    calledFilter,
    resultFilter,
    townFilter,
    tradeFilter,
    statusFilter,
    dueOnly,
    sortKey,
    sortDir,
  ]);

  const summary = useMemo(() => summarise(leads), [leads]);
  const filtersOn =
    query.trim() !== "" ||
    priorityFilter !== "ALL" ||
    calledFilter !== "ALL" ||
    resultFilter !== "ALL" ||
    townFilter !== "ALL" ||
    tradeFilter !== "ALL" ||
    statusFilter !== "ALL" ||
    dueOnly;

  function clearFilters() {
    setQuery("");
    setPriorityFilter("ALL");
    setCalledFilter("ALL");
    setResultFilter("ALL");
    setTownFilter("ALL");
    setTradeFilter("ALL");
    setStatusFilter("ALL");
    setDueOnly(false);
    setSummaryKey(null);
  }

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
    const duplicate = findDuplicate(lead, leads);
    if (duplicate) {
      toast(`Already on the sheet as ${duplicate.lead.businessName}`);
    }
    addLead(lead);
    toast("Lead added");
  }

  function importProspects(prospects: Prospect[]) {
    const fresh = prospects.filter((prospect) => !findDuplicate(prospect, leads));
    addLeads(
      fresh.map((prospect) => ({
        businessName: prospect.businessName,
        trade: prospect.trade,
        town: prospect.town,
        phone: prospect.phone,
        rating: prospect.rating,
        reviews: prospect.reviews,
        website: prospect.website,
        mapsLink: prospect.mapsLink,
        websiteStatus: prospect.websiteStatus,
        source: prospect.source,
        notes: [prospect.reason, prospect.notes].filter(Boolean).join(" "),
        called: "Not Called",
      })),
    );
    setFinding(false);
    toast(`Imported ${fresh.length} prospect${fresh.length === 1 ? "" : "s"}`);
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    removeLead(pendingDelete.id);
    toast(`Deleted ${pendingDelete.businessName || "lead"}`);
    setPendingDelete(null);
  }

  function handleSummary(key: keyof LeadSummary) {
    clearFilters();
    setSummaryKey(key);
    if (key === "hot") setPriorityFilter("HOT");
    if (key === "notCalled") setCalledFilter("Not Called");
    if (key === "interested") setResultFilter("Interested");
    if (key === "callbacks") setDueOnly(true);
    if (key === "booked") setResultFilter("Booked");
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg md:h-dvh md:overflow-hidden">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-5 px-4 py-6 md:min-h-0 md:px-6 md:py-8">
        <header className="flex shrink-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift</p>
            <h1 className="mt-1 font-display text-3xl leading-tight font-medium tracking-tight md:text-4xl">
              Leads
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted">
              Find local businesses without a proper website, import the good ones, then call them.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="h-12 sm:h-10" onClick={() => setFinding(true)}>
              <Search />
              Find new leads
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => downloadCsv(leads)}>
                <Download />
                Export CSV
              </Button>
              <Button variant="secondary" onClick={openNew}>
                <Plus />
                Add lead
              </Button>
            </div>
          </div>
        </header>

        <SummaryBar summary={summary} onSelect={handleSummary} active={summaryKey} />

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
            <FilterSelect
              label="Town"
              value={townFilter}
              onChange={setTownFilter}
              options={towns}
            />
            <FilterSelect
              label="Trade"
              value={tradeFilter}
              onChange={setTradeFilter}
              options={trades}
            />
          </div>
          <div className="flex flex-col gap-3 md:flex-row">
            <FilterSelect
              label="Website"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as "ALL" | WebsiteStatus)}
              options={[...WEBSITE_STATUS_OPTIONS]}
            />
            <FilterSelect
              label="Called"
              value={calledFilter}
              onChange={(value) => setCalledFilter(value as "ALL" | CalledStatus)}
              options={[...CALLED_OPTIONS]}
            />
            <FilterSelect
              label="Result"
              value={resultFilter}
              onChange={(value) => setResultFilter(value as "ALL" | CallResult)}
              options={[...CALL_RESULT_OPTIONS]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PRIORITY_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => {
                  setPriorityFilter(filter.id);
                  setSummaryKey(filter.id === "HOT" ? "hot" : null);
                }}
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
              <button type="button" className="h-9 px-2 text-sm text-muted hover:text-fg" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
            <span className="ml-auto text-xs tabular-nums text-subtle">{visibleLeads.length} shown</span>
          </div>
        </div>

        {visibleLeads.length === 0 ? (
          <div className="rounded-xl bg-surface px-5 py-16 text-center shadow-(--shadow-border)">
            <p className="font-medium">
              {leads.length === 0 ? "No leads yet" : "No leads match these filters"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {leads.length === 0
                ? "Find local businesses that may need a website."
                : "Try another search or clear the filters."}
            </p>
            <div className="mt-5 flex justify-center gap-2">
              {leads.length === 0 ? (
                <Button onClick={() => setFinding(true)}>
                  <Search />
                  Find new leads
                </Button>
              ) : (
                <Button variant="secondary" onClick={clearFilters}>
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

      <LeadFormDialog open={formOpen} onOpenChange={setFormOpen} initial={editing} onSave={saveLead} />

      {finding ? (
        <FindLeadsPanel leads={leads} onClose={() => setFinding(false)} onImport={importProspects} />
      ) : null}

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

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex h-11 min-w-0 items-center gap-2 rounded-md bg-surface px-3 shadow-(--shadow-border) md:w-52">
      <span className="shrink-0 text-xs font-medium text-muted">{label}</span>
      <select
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="ALL">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
