import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2, MapPin, Phone, Search, Square } from "lucide-react";
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
  type Priority,
} from "@/lib/leads";
import { describeOutcome, searchProspects, type SearchProgress } from "@/lib/prospect-search";
import { runResearchBatch } from "@/lib/prospect-search-client";
import {
  CITY_NAMES,
  LOCATION_TYPES,
  QUANTITY_OPTIONS,
  REGION_NAMES,
  planSearch,
  type LocationType,
  type Quantity,
} from "@/lib/regions";
import type { Prospect } from "@/lib/research-types";
import { cn } from "@/lib/utils";

const TRADE_CHIPS = [...TRADE_SUGGESTIONS];

type ReviewRow = Prospect & {
  selected: boolean;
  duplicate: ReturnType<typeof findDuplicate>;
};

/** Chips offered for each location type. Scotland needs no picker. */
function suggestionsFor(type: LocationType): readonly string[] {
  if (type === "City") return CITY_NAMES;
  if (type === "District / Region") return REGION_NAMES;
  if (type === "Scotland") return [];
  return TOWN_SUGGESTIONS;
}

const DEFAULT_LOCATION: Record<LocationType, string> = {
  Town: "Crieff",
  City: "Perth",
  "District / Region": "Perthshire",
  Scotland: "Scotland",
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
  const [locationType, setLocationType] = useState<LocationType>("Town");
  const [location, setLocation] = useState("Crieff");
  const [businessType, setBusinessType] = useState("Joiner");
  const [quantity, setQuantity] = useState<Quantity>(25);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [mounted, setMounted] = useState(false);
  // A ref, not state: the sweep polls this between waves and must see the
  // current value, not the one captured when it started.
  const cancelled = useRef(false);

  useEffect(() => {
    setMounted(true);
    return () => {
      cancelled.current = true;
    };
  }, []);

  const plan = useMemo(() => planSearch(locationType, location), [locationType, location]);
  const selectedCount = rows?.filter((row) => row.selected).length ?? 0;
  const scroller = useRef<HTMLDivElement>(null);

  function newSearch() {
    setRows(null);
    setNote("");
    setError("");
    scroller.current?.scrollTo({ top: 0 });
  }

  function chooseType(type: LocationType) {
    setLocationType(type);
    setLocation(DEFAULT_LOCATION[type]);
  }

  async function runSearch() {
    const where = location.trim();
    const trade = businessType.trim();
    if (where.length < 2 || trade.length < 2) {
      setError("Choose a location and a business type.");
      return;
    }
    cancelled.current = false;
    setBusy(true);
    setError("");
    setNote("");
    setRows(null);
    setProgress(null);

    try {
      const outcome = await searchProspects({
        locationType,
        location: where,
        businessType: trade,
        target: quantity,
        runBatch: runResearchBatch,
        onProgress: setProgress,
        isCancelled: () => cancelled.current,
      });

      // Two things at once. Everything found is kept, even when the sweep ended
      // badly — a search that got 40 of 100 and then hit a rate limit must not
      // throw the 40 away. And nothing is selected up front: with a hundred
      // results a pre-selection is something you have to undo, and it would make
      // "Select all HOT" mean "HOT plus whatever was already ticked".
      setRows(
        outcome.prospects.map((prospect) => ({
          ...prospect,
          duplicate: findDuplicate(prospect, leads),
          selected: false,
        })),
      );

      if (
        outcome.stoppedBecause === "failed" ||
        (outcome.prospects.length === 0 && outcome.failures.length > 0)
      ) {
        setError(describeOutcome(outcome, quantity));
      } else {
        setNote(describeOutcome(outcome, quantity));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(index: number) {
    setRows(
      (current) =>
        current?.map((row, i) => (i === index ? { ...row, selected: !row.selected } : row)) ?? null,
    );
  }

  /**
   * Bulk select: a hundred prospects must never need a hundred taps.
   *
   * A band button adds that band to the selection and leaves the rest alone, so
   * HOT then WARM gives you both — the common case — and starting from an empty
   * selection makes each tap's effect exactly what its label says.
   * Leads already on the sheet can never be selected.
   */
  function selectBand(priority: Priority | "ALL" | "NONE") {
    setRows(
      (current) =>
        current?.map((row) => {
          if (priority === "NONE" || row.duplicate) return { ...row, selected: false };
          if (priority === "ALL") return { ...row, selected: true };
          return row.priority === priority ? { ...row, selected: true } : row;
        }) ?? null,
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

  const suggestions = suggestionsFor(locationType);

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

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-8">
          {/* Once there are results, the form folds into one line. On a phone,
              nineteen region chips and twenty-two trade chips between you and
              your hundred prospects is a lot of thumb. */}
          {rows ? (
            <div className="flex items-center gap-3 rounded-md bg-surface px-3 py-2.5 shadow-(--shadow-border)">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {location.trim()} · {businessType.trim()}
                </p>
                <p className="truncate text-xs text-muted">{note || `Up to ${quantity}`}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={newSearch}>
                New search
              </Button>
            </div>
          ) : null}

          <div className={cn(rows && "hidden")}>
            <p className="text-sm text-muted">
              Pick an area and how many prospects you want. A region is swept town by town, and
              every business is researched on the public web — nothing is ever made up to hit the
              number.
            </p>

            <div className="mt-5 grid gap-4">
              <fieldset>
                <legend className="text-xs font-medium text-muted">Search</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {LOCATION_TYPES.map((type) => (
                    <Chip
                      key={type}
                      label={type}
                      active={locationType === type}
                      onClick={() => chooseType(type)}
                    />
                  ))}
                </div>
              </fieldset>

              {locationType === "Scotland" ? (
                <p className="rounded-md bg-surface px-3 py-2.5 text-sm text-muted shadow-(--shadow-border)">
                  Sweeping Scotland&apos;s largest towns and cities, biggest first.
                </p>
              ) : (
                <fieldset>
                  <legend className="text-xs font-medium text-muted">
                    {locationType === "District / Region" ? "Region" : locationType}
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestions.map((name) => (
                      <Chip
                        key={name}
                        label={name}
                        active={location === name}
                        onClick={() => setLocation(name)}
                      />
                    ))}
                  </div>
                  <Input
                    className="mt-3 h-11"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder={`Or type a ${locationType === "District / Region" ? "region" : locationType.toLowerCase()}`}
                    aria-label="Location"
                  />
                </fieldset>
              )}

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

              <fieldset>
                <legend className="text-xs font-medium text-muted">How many</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {QUANTITY_OPTIONS.map((amount) => (
                    <Chip
                      key={amount}
                      label={String(amount)}
                      active={quantity === amount}
                      onClick={() => setQuantity(amount)}
                    />
                  ))}
                </div>
              </fieldset>
            </div>

            {plan.areas.length > 1 ? (
              <p className="mt-4 text-sm text-muted">
                Will sweep {plan.areas.length} places: {plan.areas.slice(0, 6).join(", ")}
                {plan.areas.length > 6 ? ` and ${plan.areas.length - 6} more` : ""}.
              </p>
            ) : null}
            {plan.unknownArea ? (
              <p className="mt-2 text-sm text-muted">
                No town list for “{location.trim()}” — it will be searched directly over several
                passes.
              </p>
            ) : null}

            <Button
              className="mt-5 h-12 w-full md:w-auto"
              onClick={() => void runSearch()}
              disabled={busy}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Search />}
              {busy ? "Searching…" : `Find ${quantity} prospects`}
            </Button>
          </div>

          {error ? <p className="mt-3 text-sm text-hot">{error}</p> : null}

          {/* A search that found nothing has to say so. Silence after a long
              sweep reads as a broken app, and the honest answer — this area has
              no such businesses on the public web — is useful in itself. */}
          {!busy && rows && rows.length === 0 ? (
            <div className="mt-6 rounded-xl bg-surface px-5 py-12 text-center shadow-(--shadow-border)">
              <p className="font-medium">Nothing found</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                {note || "No businesses matched that search."}
              </p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-subtle">
                Try a wider area, a different trade, or a nearby town.
              </p>
            </div>
          ) : null}

          {rows ? <ReviewList rows={rows} onToggle={toggle} onSelectBand={selectBand} /> : null}
        </div>
      </div>

      {/* Pinned while the sweep runs. A hundred prospects is minutes of work
          across many calls, and the progress has to stay in front of you —
          below the fold it reads as a hung app, and Stop is unreachable. */}
      {busy ? (
        <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <ProgressPanel progress={progress} />
            <Button
              variant="secondary"
              className="mt-3 h-12 w-full sm:h-10"
              onClick={() => {
                cancelled.current = true;
              }}
            >
              <Square />
              Stop and keep what&apos;s found
            </Button>
          </div>
        </footer>
      ) : null}

      {!busy && rows && rows.length > 0 ? (
        <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
            <Button variant="ghost" className="h-12 sm:h-10" onClick={() => selectBand("NONE")}>
              Clear
            </Button>
            <Button
              className="h-12 flex-1 sm:h-10"
              onClick={importSelected}
              disabled={selectedCount === 0}
            >
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

/**
 * What a long sweep is doing, while it does it.
 *
 * A hundred prospects is minutes of work across many calls; a spinner alone
 * would look like a hang, and there would be no way to tell a slow search from
 * a broken one.
 */
function ProgressPanel({ progress }: { progress: SearchProgress | null }) {
  const done = progress?.done ?? 0;
  const budget = progress?.budget ?? 1;
  const found = progress?.found ?? 0;
  const target = progress?.target ?? 0;
  const pct = Math.min(100, Math.round((found / Math.max(1, target)) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium tabular-nums">
          {found} of {target} found
        </p>
        <p className="text-xs tabular-nums text-subtle">
          {done}/{budget} searches
        </p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--motion-fast)"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress?.areas.length ? (
        <p className="mt-2 truncate text-xs text-subtle">
          Searched {progress.areas.slice(-4).join(", ")}
          {progress.failed > 0 ? ` · ${progress.failed} retried` : ""}
        </p>
      ) : (
        <p className="mt-2 text-xs text-subtle">Starting…</p>
      )}
      <p className="mt-1 text-xs text-subtle">Keep this screen open.</p>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-10 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
        active
          ? "bg-accent text-accent-fg"
          : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

const BANDS: { key: Priority; label: string; tone: string }[] = [
  { key: "HOT", label: "HOT", tone: "text-hot" },
  { key: "WARM", label: "WARM", tone: "text-warm-lead" },
  { key: "COLD", label: "COLD", tone: "text-cold-lead" },
];

function ReviewList({
  rows,
  onToggle,
  onSelectBand,
}: {
  rows: ReviewRow[];
  onToggle: (index: number) => void;
  onSelectBand: (priority: Priority | "ALL" | "NONE") => void;
}) {
  const counts = useMemo(() => {
    const byBand = { HOT: 0, WARM: 0, COLD: 0 } as Record<Priority, number>;
    let dupes = 0;
    for (const row of rows) {
      byBand[row.priority] += 1;
      if (row.duplicate) dupes += 1;
    }
    return { byBand, dupes };
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <section className="mt-8 pb-8">
      <h3 className="font-display text-xl font-medium">
        {rows.length} prospect{rows.length === 1 ? "" : "s"}
      </h3>

      {/* Counts and bulk selection are the same control: the number you want is
          the thing you tap to select it. */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {BANDS.map((band) => (
          <button
            key={band.key}
            type="button"
            aria-label={`Select all ${band.label}`}
            disabled={counts.byBand[band.key] === 0}
            onClick={() => onSelectBand(band.key)}
            className="rounded-md bg-surface px-3 py-2.5 text-left shadow-(--shadow-border) transition-colors duration-(--motion-quick) hover:bg-surface-2 disabled:opacity-40"
          >
            <p
              className={cn(
                "font-display text-2xl leading-none font-medium tabular-nums",
                band.tone,
              )}
            >
              {counts.byBand[band.key]}
            </p>
            <p className="mt-1 text-xs font-medium text-muted">{band.label} · select</p>
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => onSelectBand("ALL")}>
          Select all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onSelectBand("NONE")}>
          Clear selection
        </Button>
        {counts.dupes > 0 ? (
          <span className="text-xs text-subtle">{counts.dupes} already in your sheet</span>
        ) : null}
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
                  <h4 className="mt-2 leading-snug font-medium">{row.businessName}</h4>
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
