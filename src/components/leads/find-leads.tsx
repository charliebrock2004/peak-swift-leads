import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2, MapPin, Phone, Search } from "lucide-react";
import { toast } from "sonner";
import { PriorityBadge } from "@/components/leads/priority-badge";
import { WebsiteStatusBadge } from "@/components/leads/website-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TOWN_SUGGESTIONS,
  TRADE_SUGGESTIONS,
  findDuplicate,
  mapsHref,
  phoneHref,
  websiteHref,
  type Lead,
} from "@/lib/leads";
import { researchProspects, type Prospect } from "@/lib/research";
import { cn } from "@/lib/utils";

const TRADE_CHIPS = [...TRADE_SUGGESTIONS];

type ReviewRow = Prospect & {
  selected: boolean;
  duplicate: ReturnType<typeof findDuplicate>;
};

export function FindLeadsPanel({
  leads,
  onClose,
  onImport,
}: {
  leads: Lead[];
  onClose: () => void;
  onImport: (prospects: Prospect[]) => void;
}) {
  const [location, setLocation] = useState("Crieff");
  const [businessType, setBusinessType] = useState("Joiner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<ReviewRow[] | null>(null);

  const selectedCount = rows?.filter((row) => row.selected).length ?? 0;
  const hotCount = rows?.filter((row) => row.priority === "HOT" && !row.duplicate).length ?? 0;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  async function runSearch() {
    const town = location.trim();
    const trade = businessType.trim();
    if (town.length < 2 || trade.length < 2) {
      setError("Choose a town and a business type.");
      return;
    }
    setBusy(true);
    setError("");
    setRows(null);
    try {
      const result = await researchProspects({ data: { location: town, businessType: trade } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows(
        result.prospects.map((prospect) => {
          const duplicate = findDuplicate(prospect, leads);
          return {
            ...prospect,
            duplicate,
            selected: !duplicate && prospect.priority !== "COLD",
          };
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(index: number, value?: boolean) {
    setRows((current) =>
      current?.map((row, i) =>
        i === index ? { ...row, selected: value ?? !row.selected } : row,
      ) ?? null,
    );
  }

  function selectAll(on: boolean) {
    setRows((current) => current?.map((row) => ({ ...row, selected: on && !row.duplicate })) ?? null);
  }

  function selectHot() {
    setRows(
      (current) =>
        current?.map((row) => ({
          ...row,
          selected: !row.duplicate && row.priority === "HOT",
        })) ?? null,
    );
  }

  function importSelected() {
    if (!rows) return;
    const chosen = rows.filter((row) => row.selected && !row.duplicate);
    if (chosen.length === 0) {
      toast("Select at least one new prospect");
      return;
    }
    onImport(chosen);
  }

  const panel = (
    <div className="find-overlay flex flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
          onClick={onClose}
          aria-label="Back to lead sheet"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift</p>
          <h2 className="font-display text-lg font-medium tracking-tight">Find leads</h2>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-8">
          <p className="text-sm text-muted">
            Choose a town and trade. Grok searches the public web, checks for a proper website, then
            you pick who to import.
          </p>

          <div className="mt-5 grid gap-4">
            <fieldset>
              <legend className="text-xs font-medium text-muted">Location</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {TOWN_SUGGESTIONS.map((town) => (
                  <Chip
                    key={town}
                    label={town}
                    active={location === town}
                    onClick={() => setLocation(town)}
                  />
                ))}
              </div>
              <Input
                className="mt-3 h-11"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Or type a town"
                aria-label="Location"
              />
            </fieldset>

            <fieldset>
              <legend className="text-xs font-medium text-muted">Business type</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {TRADE_CHIPS.map((trade) => (
                  <Chip
                    key={trade}
                    label={trade}
                    active={businessType === trade}
                    onClick={() => setBusinessType(trade)}
                  />
                ))}
              </div>
              <Input
                className="mt-3 h-11"
                value={businessType}
                onChange={(event) => setBusinessType(event.target.value)}
                placeholder="Or type a trade"
                aria-label="Business type"
                list="trade-list"
              />
            </fieldset>
          </div>

          <Button className="mt-5 h-12 w-full md:w-auto" onClick={() => void runSearch()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Search />}
            {busy ? "Searching…" : "Find prospects"}
          </Button>
          {busy ? (
            <p className="mt-3 text-sm text-muted">Usually takes about 30 seconds. Don’t close this screen.</p>
          ) : null}
          {error ? <p className="mt-3 text-sm text-hot">{error}</p> : null}

          {rows ? <ReviewList rows={rows} onToggle={toggle} /> : null}
        </div>
      </div>

      {rows ? (
        <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 md:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => selectAll(true)}>
                Select all
              </Button>
              <Button variant="secondary" size="sm" onClick={selectHot} disabled={hotCount === 0}>
                Select HOT
              </Button>
              <Button variant="ghost" size="sm" onClick={() => selectAll(false)}>
                Clear
              </Button>
            </div>
            <Button className="h-12 sm:h-10" onClick={importSelected} disabled={selectedCount === 0}>
              Import selected ({selectedCount})
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );

  if (!mounted) return null;
  return createPortal(panel, document.body);
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-10 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
        active ? "bg-accent text-accent-fg" : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

function ReviewList({
  rows,
  onToggle,
}: {
  rows: ReviewRow[];
  onToggle: (index: number) => void;
}) {
  const summary = useMemo(() => {
    const hot = rows.filter((row) => row.priority === "HOT").length;
    const warm = rows.filter((row) => row.priority === "WARM").length;
    const dupes = rows.filter((row) => row.duplicate).length;
    return { hot, warm, dupes };
  }, [rows]);

  return (
    <section className="mt-8 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-display text-xl font-medium">Review prospects</h3>
          <p className="mt-1 text-sm text-muted">
            {rows.length} found · {summary.hot} HOT · {summary.warm} WARM
            {summary.dupes ? ` · ${summary.dupes} already in your sheet` : ""}
          </p>
        </div>
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {rows.map((row, index) => {
          const tel = phoneHref(row.phone);
          const maps = mapsHref(row);
          const site = websiteHref(row.website);
          return (
            <li
              key={`${row.businessName}-${row.town}-${index}`}
              className={cn(
                "lead-card",
                row.priority === "HOT" && "lead-card-hot",
                row.priority === "WARM" && "lead-card-warm",
              )}
            >
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  checked={row.selected}
                  disabled={Boolean(row.duplicate)}
                  onChange={() => onToggle(index)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityBadge priority={row.priority} />
                    <WebsiteStatusBadge status={row.websiteStatus} />
                    {row.duplicate ? (
                      <span className="text-xs font-medium text-hot">
                        Already in sheet ({row.duplicate.lead.businessName})
                      </span>
                    ) : null}
                  </div>
                  <h4 className="mt-2 font-medium leading-snug">{row.businessName}</h4>
                  <p className="text-sm text-muted">
                    {[row.trade, row.town].filter(Boolean).join(" · ")}
                  </p>
                  <p className="mt-1 text-sm text-muted">{row.reason}</p>
                  <p className="mt-1 text-sm tabular-nums text-muted">
                    {row.phone || "No phone"}
                    {" · "}
                    {row.rating !== "" ? `${row.rating} rating` : "No rating"}
                    {" · "}
                    {row.reviews !== "" ? `${row.reviews} reviews` : "No reviews"}
                  </p>
                  {row.notes ? <p className="mt-2 text-sm text-muted">{row.notes}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {tel ? (
                      <a
                        href={tel}
                        className="inline-flex h-10 items-center gap-1.5 rounded-md bg-surface-2 px-3 text-sm font-medium"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Phone className="size-3.5" />
                        Call
                      </a>
                    ) : null}
                    {maps ? (
                      <a
                        href={maps}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-10 items-center gap-1.5 rounded-md bg-surface-2 px-3 text-sm font-medium"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <MapPin className="size-3.5" />
                        Maps
                      </a>
                    ) : null}
                    {site ? (
                      <a
                        href={site}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-10 items-center rounded-md bg-surface-2 px-3 text-sm font-medium"
                        onClick={(event) => event.stopPropagation()}
                      >
                        Website
                      </a>
                    ) : null}
                  </div>
                </div>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
