import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RADIUS_MILES,
  RESULT_LIMITS,
  TOWN_SUGGESTIONS,
  TRADE_SUGGESTIONS,
  type Lead,
  type RadiusMiles,
} from "@/lib/leads";
import { researchProspects, type Prospect } from "@/lib/research";
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
    return "That search took too long. Try a smaller radius, or fewer results, then search again.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Could not reach the lead search server. Check your connection and try again.";
  }
  return message || "Search failed. Try again.";
}

export function FindLeadsPanel({
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
  const [limit, setLimit] = useState(25);
  const [radiusMiles, setRadiusMiles] = useState<RadiusMiles>(25);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [mounted, setMounted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancelled = useRef(false);
  const runId = useRef(0);

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

  function clampLimit(value: number): number {
    if (!Number.isFinite(value)) return 25;
    return Math.min(100, Math.max(1, Math.round(value)));
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
    setStopping(false);
    try {
      const result = await researchProspects({
        data: { location: place, businessType: trade, limit: clampLimit(limit), radiusMiles },
      });
      if (runId.current !== id) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.prospects.length === 0) {
        setError(`No ${trade.toLowerCase()} businesses found within ${radiusMiles} miles of ${place}.`);
        return;
      }
      onImport(result.prospects);
    } catch (err) {
      if (runId.current !== id) return;
      setError(err instanceof Error ? searchFailure(err) : "Search failed. Try again.");
    } finally {
      if (runId.current === id) setBusy(false);
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

  const locationChips = chipsFor(kind);

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
                {stopping ? "Stopping…" : `Searching public records${elapsed ? `… ${elapsed}s` : "…"}`}
              </p>
              <p className="mt-2 text-sm text-muted">
                {businessType} within {radiusMiles} miles of {location}
              </p>
              <p className="mt-2 text-sm text-subtle">
                Companies House and OpenStreetMap. Checking websites next.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted">
                Find local businesses, see whether they have a website, and add them to your sheet.
                Duplicates are skipped. “No website” is only used when the listing actually had no
                site.
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
                  <legend className="text-xs font-medium text-muted">Business category</legend>
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
                    aria-label="Business category"
                    list="trade-list"
                  />
                </fieldset>

                <fieldset>
                  <legend className="text-xs font-medium text-muted">Radius</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {RADIUS_MILES.map((miles) => (
                      <Chip
                        key={miles}
                        label={`${miles} miles`}
                        active={radiusMiles === miles}
                        onClick={() => setRadiusMiles(miles)}
                      />
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="text-xs font-medium text-muted">Number of leads</legend>
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
                  <Input
                    className="mt-3 h-11 w-32"
                    type="number"
                    min={1}
                    max={100}
                    value={limit}
                    onChange={(event) => setLimit(clampLimit(Number(event.target.value)))}
                    aria-label="Number of leads"
                  />
                  <p className="mt-3 text-sm text-subtle">
                    {businessType} within {radiusMiles} miles of {preview.label}. Stops at {clampLimit(limit)}.
                  </p>
                </fieldset>
              </div>

              <Button className="mt-5 h-12 w-full md:w-auto" onClick={() => void runSearch()}>
                <Search />
                Find leads
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
