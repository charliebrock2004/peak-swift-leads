import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2, MapPin, Phone, Search } from "lucide-react";
import { toast } from "sonner";
import { PriorityBadge } from "@/components/leads/priority-badge";
import { WebsiteStatusBadge } from "@/components/leads/website-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RESULT_LIMITS,
  TOWN_SUGGESTIONS,
  TRADE_SUGGESTIONS,
  findDuplicate,
  mapsHref,
  phoneHref,
  websiteActionLabel,
  websiteHref,
  type Lead,
  type Priority,
  type ResultLimit,
} from "@/lib/leads";
import { researchProspects, type Prospect } from "@/lib/research";
import { runPlannedSearch, type SearchProgress } from "@/lib/run-search";
import {
  CITY_SUGGESTIONS,
  REGION_SUGGESTIONS,
  locationKindFor,
  planSearch,
  type PlaceKind,
} from "@/lib/scotland-places";
import { cn } from "@/lib/utils";

const TRADE_CHIPS = [...TRADE_SUGGESTIONS];

const KIND_CHIPS: { id: PlaceKind; label: string }[] = [
  { id: "town", label: "Town" },
  { id: "city", label: "City" },
  { id: "region", label: "Region" },
  { id: "nation", label: "Scotland" },
];

const KIND_DEFAULT: Record<PlaceKind, string> = {
  town: "Crieff",
  city: "Perth",
  region: "Perthshire",
  nation: "Scotland",
};

function chipsFor(kind: PlaceKind): readonly string[] {
  if (kind === "region") return REGION_SUGGESTIONS;
  if (kind === "city") return CITY_SUGGESTIONS;
  if (kind === "nation") return ["Scotland"];
  return TOWN_SUGGESTIONS;
}

function searchFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/504|503|502|timeout|timed out|abort/i.test(message)) {
    return "That search took too long on the server. Try a smaller area, or fewer results. Vercel Hobby caps functions at about 10s — Find leads needs Pro (up to 5 minutes).";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Could not reach the lead search server. Check your connection and try again.";
  }
  return message || "Search failed. Try again.";
}

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
  const [kind, setKind] = useState<PlaceKind>("town");
  const [location, setLocation] = useState("Crieff");
  const [businessType, setBusinessType] = useState("Joiner");
  const [limit, setLimit] = useState<ResultLimit>(8);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [mounted, setMounted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancelled = useRef(false);
  const runId = useRef(0);

  const selectedCount = rows?.filter((row) => row.selected).length ?? 0;
  const hotCount = rows?.filter((row) => row.priority === "HOT" && !row.duplicate).length ?? 0;
  const warmCount = rows?.filter((row) => row.priority === "WARM" && !row.duplicate).length ?? 0;
  const coldCount = rows?.filter((row) => row.priority === "COLD" && !row.duplicate).length ?? 0;

  const preview = useMemo(() => planSearch(location.trim() || "Crieff", limit), [location, limit]);

  useEffect(() => {
    setMounted(true);
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  function chooseKind(next: PlaceKind) {
    setKind(next);
    const current = locationKindFor(location);
    if (next === "nation") {
      setLocation("Scotland");
      return;
    }
    if (current !== next) setLocation(KIND_DEFAULT[next]);
  }

  function toRows(prospects: Prospect[]): ReviewRow[] {
    return prospects.map((prospect) => {
      const duplicate = findDuplicate(prospect, leads);
      return {
        ...prospect,
        duplicate,
        selected: !duplicate && prospect.priority !== "COLD",
      };
    });
  }

  async function runSearch() {
    const place = location.trim();
    const trade = businessType.trim();
    if (place.length < 2 || trade.length < 2) {
      setError("Choose a location and a business type.");
      return;
    }
    const id = ++runId.current;
    cancelled.current = false;
    setBusy(true);
    setError("");
    setWarning("");
    setRows(null);
    setProgress(null);
    setStopping(false);
    try {
      const result = await runPlannedSearch({
        location: place,
        businessType: trade,
        limit,
        concurrency: preview.areas.length > 1 ? 2 : 1,
        shouldCancel: () => cancelled.current || runId.current !== id,
        onProgress: (next) => {
          if (runId.current === id) setProgress(next);
        },
        research: (input) => researchProspects({ data: input }),
      });
      if (runId.current !== id) return;
      if (result.cancelled && result.prospects.length === 0) {
        setError("Search cancelled.");
        return;
      }
      if (result.prospects.length === 0) {
        setError(
          result.errors[0] ||
            `No verified ${trade.toLowerCase()} businesses found in ${preview.label}. Try a nearby town.`,
        );
        return;
      }
      setRows(toRows(result.prospects));
      const bits: string[] = [];
      if (result.cancelled) bits.push("Search stopped early. Showing what was found.");
      if (result.errors.length > 0) {
        const failed = result.errors.length;
        const okTowns = result.plan.areas.length - failed;
        bits.push(
          `${okTowns} of ${result.plan.areas.length} towns finished. ${failed} failed. Showing ${result.prospects.length} genuine result${result.prospects.length === 1 ? "" : "s"}.`,
        );
        bits.push(result.errors[0] ?? "");
      }
      setWarning(bits.filter(Boolean).join(" "));
    } catch (err) {
      if (runId.current !== id) return;
      setError(err instanceof Error ? searchFailure(err) : "Search failed. Try again.");
    } finally {
      if (runId.current === id) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  function cancelSearch() {
    cancelled.current = true;
    setStopping(true);
  }

  function closePanel() {
    cancelled.current = true;
    runId.current += 1;
    onClose();
  }

  function toggle(index: number, value?: boolean) {
    setRows(
      (current) =>
        current?.map((row, i) => (i === index ? { ...row, selected: value ?? !row.selected } : row)) ??
        null,
    );
  }

  function selectAll(on: boolean) {
    setRows((current) => current?.map((row) => ({ ...row, selected: on && !row.duplicate })) ?? null);
  }

  function selectPriority(priority: Priority) {
    setRows(
      (current) =>
        current?.map((row) => ({
          ...row,
          selected: !row.duplicate && row.priority === priority,
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

  const locationChips = chipsFor(kind);
  const searchingLabel = progress?.active.length
    ? progress.active.join(" · ")
    : progress?.area || location;

  const panel = (
    <div className="find-overlay flex flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-6">
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
          onClick={closePanel}
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
          {busy ? (
            <div className="rounded-xl bg-surface px-5 py-12 text-center shadow-(--shadow-border)">
              <Loader2 className="mx-auto size-6 animate-spin text-muted" />
              <p className="mt-4 font-medium" aria-live="polite">
                {stopping
                  ? "Stopping after this town…"
                  : `Researching local businesses${elapsed ? `… ${elapsed}s` : "…"}`}
              </p>
              <p className="mt-2 text-sm text-muted">
                {searchingLabel}
                {progress && progress.total > 1
                  ? ` · ${Math.min(progress.index, progress.total)} of ${progress.total}`
                  : ""}
              </p>
              <p className="mt-2 text-sm text-subtle">
                {progress
                  ? `${progress.found} genuine so far · stops at ${progress.target}`
                  : `${location} · ${businessType}`}
              </p>
              {preview.areas.length > 1 ? (
                <p className="mt-2 text-sm text-subtle">
                  Searching {preview.areas.length} towns across {preview.label}. Already-found names
                  are skipped.
                </p>
              ) : (
                <p className="mt-2 text-sm text-subtle">
                  Checking directories, Maps listings and websites. This can take a minute or two.
                </p>
              )}
              {progress?.errors.length ? (
                <p className="mt-3 text-sm text-warm-lead">{progress.errors[progress.errors.length - 1]}</p>
              ) : null}
            </div>
          ) : rows ? (
            <div className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 shadow-(--shadow-border) sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm">
                {preview.label} · {businessType} · {rows.length} found
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setRows(null)}>
                  Change search
                </Button>
                <Button size="sm" onClick={() => void runSearch()}>
                  <Search />
                  Search again
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted">
                Choose where and what to search. Grok researches the public web, checks for a proper
                website, then you pick who to import.
              </p>

              <div className="mt-5 grid gap-4">
                <fieldset>
                  <legend className="text-xs font-medium text-muted">Location type</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {KIND_CHIPS.map((chip) => (
                      <Chip
                        key={chip.id}
                        label={chip.label}
                        active={kind === chip.id}
                        onClick={() => chooseKind(chip.id)}
                      />
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="text-xs font-medium text-muted">Location</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {locationChips.map((place) => (
                      <Chip
                        key={place}
                        label={place}
                        active={location === place}
                        onClick={() => setLocation(place)}
                      />
                    ))}
                  </div>
                  {kind !== "nation" ? (
                    <Input
                      className="mt-3 h-11"
                      value={location}
                      onChange={(event) => {
                        const value = event.target.value;
                        setLocation(value);
                        setKind(locationKindFor(value || "Crieff"));
                      }}
                      placeholder={
                        kind === "region"
                          ? "Or type a region"
                          : kind === "city"
                            ? "Or type a city"
                            : "Or type a town"
                      }
                      aria-label="Location"
                    />
                  ) : null}
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

                <fieldset>
                  <legend className="text-xs font-medium text-muted">How many</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {RESULT_LIMITS.map((count) => (
                      <Chip
                        key={count}
                        label={String(count)}
                        active={limit === count}
                        onClick={() => setLimit(count)}
                      />
                    ))}
                  </div>
                  <p className="mt-3 text-sm text-subtle">
                    {preview.areas.length > 1
                      ? `Searches ${preview.areas.length} towns across ${preview.label}: ${preview.areas
                          .slice(0, 4)
                          .map((area) => area.name)
                          .join(", ")}${preview.areas.length > 4 ? "…" : ""}. Stops at ${limit} genuine businesses.`
                      : `One search in ${preview.label}.`}
                    {limit >= 50 ? " Large searches take several minutes." : ""}
                  </p>
                </fieldset>
              </div>

              <Button className="mt-5 h-12 w-full md:w-auto" onClick={() => void runSearch()}>
                <Search />
                Find prospects
              </Button>
              {error ? (
                <div className="mt-3">
                  <p className="text-sm text-hot">{error}</p>
                  <Button variant="secondary" className="mt-3 h-11" onClick={() => void runSearch()}>
                    Try again
                  </Button>
                </div>
              ) : null}
            </>
          )}

          {rows && !busy ? (
            <>
              {warning ? <p className="mt-3 text-sm text-warm-lead">{warning}</p> : null}
              {error && rows ? <p className="mt-3 text-sm text-hot">{error}</p> : null}
              <ReviewList rows={rows} onToggle={toggle} />
            </>
          ) : null}
        </div>
      </div>

      {busy ? (
        <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <Button variant="secondary" className="h-12 w-full sm:w-auto" onClick={cancelSearch}>
              Stop search
            </Button>
          </div>
        </footer>
      ) : null}

      {rows && !busy ? (
        <footer className="shrink-0 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => selectAll(true)}>
                Select all
              </Button>
              <Button variant="secondary" size="sm" onClick={() => selectPriority("HOT")} disabled={hotCount === 0}>
                Select HOT
              </Button>
              <Button variant="secondary" size="sm" onClick={() => selectPriority("WARM")} disabled={warmCount === 0}>
                Select WARM
              </Button>
              <Button variant="secondary" size="sm" onClick={() => selectPriority("COLD")} disabled={coldCount === 0}>
                Select COLD
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
        "h-11 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
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
    const cold = rows.filter((row) => row.priority === "COLD").length;
    const dupes = rows.filter((row) => row.duplicate).length;
    return { hot, warm, cold, dupes };
  }, [rows]);

  return (
    <section className="mt-8 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-display text-xl font-medium">Review prospects</h3>
          <p className="mt-1 text-sm text-muted">
            {rows.length} found · {summary.hot} HOT · {summary.warm} WARM · {summary.cold} COLD
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
                        Already in sheet
                        {row.duplicate.via === "phone"
                          ? " (same phone)"
                          : row.duplicate.via === "maps"
                            ? " (same Maps listing)"
                            : " (same name)"}
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
                  {row.website ? (
                    <p className="mt-1 truncate text-sm text-subtle">{row.website}</p>
                  ) : null}
                  {row.notes ? <p className="mt-2 text-sm text-muted">{row.notes}</p> : null}
                  {row.source ? <p className="mt-1 text-xs text-subtle">{row.source}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {tel ? (
                      <a
                        href={tel}
                        className="inline-flex h-11 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Phone className="size-3.5" />
                        {row.phone}
                      </a>
                    ) : null}
                    {maps ? (
                      <a
                        href={maps}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-11 items-center gap-1.5 rounded-md bg-surface-2 px-3 text-sm font-medium"
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
                        className="inline-flex h-11 items-center rounded-md bg-surface-2 px-3 text-sm font-medium"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {websiteActionLabel(row.website, row.websiteStatus)}
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
