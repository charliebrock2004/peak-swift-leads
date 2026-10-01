import { useMemo, useRef, useState } from "react";
import { ArrowLeft, FileUp, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  guessColumnMap,
  parseDelimited,
  planImport,
  summarizePlan,
  type ImportAction,
  type ImportEntry,
  type ImportField,
} from "@/lib/csv-import";
import { mergePatch } from "@/lib/csv-import";
import { todayIso, type Lead } from "@/lib/leads";
import { cn } from "@/lib/utils";

type Step = "paste" | "map" | "review";

/** How the imported rows are labelled so they can be told apart later. */
const IMPORT_SOURCE = "Spreadsheet";

const ACTION_LABELS: Record<ImportAction, string> = {
  add: "Add",
  merge: "Merge",
  skip: "Skip",
};

/**
 * Bringing a research spreadsheet in without breaking what is already here.
 *
 * Three steps, and nothing is written before the last one: paste (or pick a
 * file), confirm which column is which, then review every row's verdict. A row
 * that matches a lead you already have is a merge that only fills blanks — your
 * call history is never touched.
 */
export function ImportPanel({
  leads,
  onClose,
  onApply,
}: {
  leads: Lead[];
  onClose: () => void;
  onApply: (result: { adds: Partial<Lead>[]; merges: { id: string; patch: Partial<Lead> }[] }) => void;
}) {
  const [step, setStep] = useState<Step>("paste");
  const [text, setText] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [map, setMap] = useState<(ImportField | null)[]>([]);
  const [actions, setActions] = useState<Record<number, ImportAction>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => (text.trim() ? parseDelimited(text) : []), [text]);
  const headers = hasHeader && rows.length > 0 ? rows[0] : [];
  const bodyRows = useMemo(() => (hasHeader ? rows.slice(1) : rows), [rows, hasHeader]);

  const plan = useMemo(
    () => (step === "review" ? planImport(bodyRows, map, leads) : null),
    // `leads` is read once when the plan is built — re-planning on every keystroke
    // elsewhere in the app would fight the review screen's per-row choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step, bodyRows, map],
  );

  const entries = plan?.entries ?? [];
  const effective = entries.map((entry, index) => actions[index] ?? entry.action);
  const counts = summarizePlan(entries.map((entry, index) => ({ ...entry, action: effective[index] })));

  function readParsed(next: string) {
    setText(next);
    const parsed = parseDelimited(next);
    if (parsed.length > 0) setMap(guessColumnMap(parsed[0]));
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      readParsed(await file.text());
      toast(`Read ${file.name}`);
    } catch {
      toast("Could not read that file");
    }
  }

  function goToMap() {
    if (rows.length === 0) {
      toast("Paste some rows first");
      return;
    }
    if (map.length === 0) setMap(guessColumnMap(rows[0]));
    setStep("map");
  }

  function goToReview() {
    if (!map.includes("businessName")) {
      toast("Choose which column holds the business name");
      return;
    }
    setActions({});
    setStep("review");
  }

  function setAllMerges(action: ImportAction) {
    const next: Record<number, ImportAction> = {};
    entries.forEach((entry, index) => {
      if (entry.existing) next[index] = action;
    });
    setActions((current) => ({ ...current, ...next }));
  }

  function apply() {
    const adds: Partial<Lead>[] = [];
    const merges: { id: string; patch: Partial<Lead> }[] = [];
    const stamp = `${IMPORT_SOURCE} ${todayIso()}`;

    entries.forEach((entry, index) => {
      const action = effective[index];
      if (action === "add") {
        adds.push({ ...entry.draft, source: entry.draft.source || stamp });
        return;
      }
      if (action !== "merge" || !entry.existing) return;
      const patch = mergePatch(entry.existing, entry.draft);
      if (Object.keys(patch).length > 0) merges.push({ id: entry.existing.id, patch });
    });

    onApply({ adds, merges });
  }

  return (
    <div className="find-overlay flex flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        {step === "paste" ? (
          <span className="w-9" />
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            onClick={() => setStep(step === "review" ? "map" : "paste")}
          >
            <ArrowLeft />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg leading-tight font-medium">Import spreadsheet</h2>
          <p className="truncate text-xs text-muted">
            {step === "paste" ? "Paste your rows or choose a file" : null}
            {step === "map" ? `${bodyRows.length} rows — check the columns` : null}
            {step === "review" ? `${counts.added} new · ${counts.merged} merge · ${counts.skipped} skip` : null}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close import" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {step === "paste" ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            <p className="text-sm text-muted">
              In Excel or Google Sheets select everything, copy, and paste it below. A CSV file works
              too. Nothing is saved until you have reviewed what it will do.
            </p>
            <textarea
              value={text}
              onChange={(event) => readParsed(event.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={"Business Name\tTown\tTrade\tPhone\tWebsite Status\nThe Wee Bakehouse\tCrieff\tBakery\t01764 652184\tNo website"}
              className="w-full resize-y rounded-md bg-surface px-3 py-2 font-mono text-xs text-fg shadow-(--shadow-border) outline-none placeholder:text-subtle focus-visible:shadow-(--shadow-focus)"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
                className="hidden"
                onChange={(event) => void pickFile(event.target.files?.[0])}
              />
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                <FileUp />
                Choose a file
              </Button>
              <span className="text-sm text-muted">
                {rows.length > 0 ? `${rows.length} rows read` : "Nothing pasted yet"}
              </span>
              <Button className="ml-auto h-12 sm:h-10" disabled={rows.length === 0} onClick={goToMap}>
                Next
              </Button>
            </div>
          </div>
        ) : null}

        {step === "map" ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-accent)]"
                checked={hasHeader}
                onChange={(event) => {
                  setHasHeader(event.target.checked);
                  if (event.target.checked && rows.length > 0) setMap(guessColumnMap(rows[0]));
                }}
              />
              First row is a header
            </label>
            <ul className="flex flex-col gap-2">
              {(hasHeader ? headers : rows[0] ?? []).map((header, column) => (
                <li
                  key={column}
                  className="flex items-center gap-3 rounded-md bg-surface px-3 py-2 shadow-(--shadow-border)"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {hasHeader ? header || `Column ${column + 1}` : `Column ${column + 1}`}
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {bodyRows[0]?.[column] || "—"}
                    </p>
                  </div>
                  <select
                    aria-label={`Field for ${header || `column ${column + 1}`}`}
                    className="h-11 shrink-0 rounded-md bg-bg px-2 text-sm text-fg shadow-(--shadow-border) outline-none"
                    value={map[column] ?? ""}
                    onChange={(event) => {
                      const value = (event.target.value || null) as ImportField | null;
                      setMap((current) =>
                        current.map((field, index) => {
                          if (index === column) return value;
                          // One field per column: taking it here releases it there.
                          return value && field === value ? null : field;
                        }),
                      );
                    }}
                  >
                    <option value="">Ignore</option>
                    {IMPORT_FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {IMPORT_FIELD_LABELS[field]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            <Button className="h-12 self-end sm:h-10" onClick={goToReview}>
              Review {bodyRows.length} rows
            </Button>
          </div>
        ) : null}

        {step === "review" ? (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            <div className="rounded-md bg-surface px-4 py-3 shadow-(--shadow-border)">
              <p className="text-sm">
                <strong className="font-medium">{counts.added}</strong> new leads,{" "}
                <strong className="font-medium">{counts.merged}</strong> merged into leads you already
                have, <strong className="font-medium">{counts.skipped}</strong> skipped.
              </p>
              <p className="mt-1 text-xs text-muted">
                A merge only fills fields that are empty and appends new notes. Called status, call
                result and follow-up dates are never changed by an import.
                {plan && plan.skippedRows > 0
                  ? ` ${plan.skippedRows} row${plan.skippedRows === 1 ? "" : "s"} had no business name and were ignored.`
                  : ""}
              </p>
              {entries.some((entry) => entry.existing) ? (
                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setAllMerges("merge")}>
                    Merge all matches
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setAllMerges("skip")}>
                    Skip all matches
                  </Button>
                </div>
              ) : null}
            </div>

            <ul className="flex flex-col gap-1.5">
              {entries.map((entry, index) => (
                <ImportRow
                  key={entry.rowNumber}
                  entry={entry}
                  action={effective[index]}
                  onAction={(action) => setActions((current) => ({ ...current, [index]: action }))}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {step === "review" ? (
        <footer className="shrink-0 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-2xl gap-2">
            <Button variant="secondary" className="h-12 sm:h-10" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="h-12 flex-1 sm:h-10"
              disabled={counts.added + counts.merged === 0}
              onClick={apply}
            >
              Import {counts.added + counts.merged} rows
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

function ImportRow({
  entry,
  action,
  onAction,
}: {
  entry: ImportEntry;
  action: ImportAction;
  onAction: (action: ImportAction) => void;
}) {
  const options: ImportAction[] = entry.existing ? ["merge", "skip"] : ["add", "skip"];
  return (
    <li className="flex items-center gap-3 rounded-md bg-surface px-3 py-2 shadow-(--shadow-border)">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.draft.businessName}</p>
        <p className="truncate text-xs text-muted">
          {entry.existing
            ? entry.fills.length > 0
              ? `Already on the sheet (${entry.matchedVia}) — adds ${entry.fills.join(", ")}`
              : `Already on the sheet (${entry.matchedVia}) — nothing new`
            : [entry.draft.trade, entry.draft.town].filter(Boolean).join(" · ") || "New lead"}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={action === option}
            onClick={() => onAction(option)}
            className={cn(
              "h-9 rounded-md px-2.5 text-xs font-medium",
              action === option ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            {ACTION_LABELS[option]}
          </button>
        ))}
      </div>
    </li>
  );
}
