import { useMemo, useRef, useState } from "react";
import { ClipboardCopy, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findLeadEmail } from "@/lib/qualify-server";
import { REASON_LABELS, type DiscoveryResult } from "@/lib/email-discovery";
import { SEARCH_FAILURE_LABELS } from "@/lib/search-provider";
import { cn } from "@/lib/utils";
import {
  BATCH_TEMPLATE,
  batchReport,
  blankRow,
  parseBatch,
  rate,
  summariseBatch,
  VERDICTS,
  type BatchRow,
  type Verdict,
} from "@/lib/validation-batch";

/**
 * Run email discovery against one business and show exactly what happened.
 *
 * The engine tries several sources in order and gives up for one of eleven
 * named reasons. Without somewhere to see that, a disappointing result is just
 * "no public email found" again — this is where you find out whether the site
 * was unreachable, had no contact page, or simply publishes no address.
 *
 * Read-only: it fetches public pages and writes nothing to the sheet.
 */
export function EmailDiscoveryTest() {
  const [website, setWebsite] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [town, setTown] = useState("");
  const [trade, setTrade] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  /** The success shape only: a failure is shown through `error`, not here. */
  const [report, setReport] = useState<
    Extract<Awaited<ReturnType<typeof findLeadEmail>>, { ok: true }> | null
  >(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    if (busy || (website.trim().length < 4 && businessName.trim().length < 3)) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const answer = await findLeadEmail({
        data: {
          website: website.trim(), businessName: businessName.trim(),
          town: town.trim(), trade: trade.trim(), phone: phone.trim(), address: address.trim(),
          existingEmail: "", existingSource: "",
        },
      });
      if (!answer.ok) setError(answer.error);
      else {
        setResult(answer.discovery);
        setReport(answer);
      }
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const inputs = { businessName, town, trade, phone, address, website };


  return (
    <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
      <h3 className="font-display text-lg font-medium">Test email discovery</h3>
      <p className="mt-1 text-sm text-muted">
        Try one business and see every source the engine checked. Nothing is saved.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Input className="h-11" value={businessName} onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Business name" aria-label="Business name" />
        <Input className="h-11" value={town} onChange={(e) => setTown(e.target.value)}
          placeholder="Town" aria-label="Town" />
        <Input className="h-11" value={trade} onChange={(e) => setTrade(e.target.value)}
          placeholder="Trade" aria-label="Trade" />
        <Input className="h-11" value={phone} onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone" aria-label="Phone" />
        <Input className="h-11" value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="Address incl. postcode" aria-label="Address" />
        <Input className="h-11" value={website} onChange={(e) => setWebsite(e.target.value)}
          placeholder="Website (leave blank to discover)" aria-label="Website to test" />
      </div>
      <p className="mt-2 text-xs text-subtle">
        Leave the website blank to watch the full waterfall: search, then domain candidates, then
        the crawl. Phone and postcode are what prove a discovered site is the right business — a
        lead with neither is the hardest case and the one worth testing.
      </p>
      <Button
        className="mt-3 h-11"
        disabled={busy || (website.trim().length < 4 && businessName.trim().length < 3)}
        onClick={() => void run()}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Search />}
        Run discovery
      </Button>

      {error ? <p className="mt-3 text-sm text-hot">{error}</p> : null}

      {result ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(plainReport(inputs, result, report))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              <ClipboardCopy />
              {copied ? "Copied" : "Copy full report"}
            </Button>
            <span className="text-xs text-subtle">
              Paste this back to get the failure diagnosed.
            </span>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <Step
              n={1}
              title="Search"
              done={(report?.searchesRun ?? 0) > 0}
              summary={
                report?.searchProvider
                  ? `${report.searchProvider} · ${report.searchesRun} quer${report.searchesRun === 1 ? "y" : "ies"}`
                  : "no search provider configured"
              }
              problem={
                report?.searchFailure
                  ? (SEARCH_FAILURE_LABELS[report.searchFailure] ?? report.searchFailure)
                  : ""
              }
            >
              {report?.queriesUsed?.length ? (
                <ol className="flex list-inside list-decimal flex-col gap-0.5">
                  {report.queriesUsed.map((query) => (
                    <li key={query} className="break-all">{query}</li>
                  ))}
                </ol>
              ) : (
                <p>No queries were sent.</p>
              )}
            </Step>

            <Step
              n={2}
              title="Candidate websites"
              done={(report?.searchResults?.length ?? 0) > 0}
              summary={`${report?.searchResults?.length ?? 0} result(s) returned`}
            >
              {report?.searchResults?.length ? (
                <ul className="flex flex-col gap-0.5">
                  {report.searchResults.map((entry) => (
                    <li key={entry.url} className="break-all">
                      {entry.title || "(no title)"} — {entry.url}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Nothing came back to consider.</p>
              )}
            </Step>

            <Step
              n={3}
              title="Identity verification"
              done={(report?.candidates?.length ?? 0) > 0}
              summary={`${report?.candidates?.filter((c) => c.accepted).length ?? 0} of ${report?.candidates?.length ?? 0} verified`}
            >
              {report?.candidates?.length ? (
                <ul className="flex flex-col gap-1.5">
                  {report.candidates.map((candidate) => (
                    <li key={candidate.url}>
                      <p className={cn("break-all", candidate.accepted ? "text-accent" : "text-hot")}>
                        {candidate.accepted ? "PASS" : "FAIL"} {candidate.score}/100
                        {candidate.character ? ` · ${candidate.character}` : ""} — {candidate.url}
                      </p>
                      <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
                        {candidate.signals.map((signal) => (
                          <li
                            key={signal}
                            className={isNegative(signal) ? "text-hot" : "text-subtle"}
                          >
                            {isNegative(signal) ? "−" : "+"} {signal}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No candidate site was fetched, so nothing was scored.</p>
              )}
            </Step>

            <Step
              n={4}
              title="Verified website"
              done={Boolean(report?.website)}
              summary={
                report?.website
                  ? `${report.website.url} · identity ${report.website.score}/100 via ${report.discoveryVia?.toLowerCase().replace(/_/g, " ")}`
                  : "none — nothing could be proved to be this business"
              }
            >
              {report?.website?.evidence.length ? (
                <ul className="flex flex-col gap-0.5">
                  {report.website.evidence.map((line) => (
                    <li key={line}>· {line}</li>
                  ))}
                </ul>
              ) : null}
            </Step>

            <Step
              n={5}
              title="Pages crawled"
              done={result.sourcesChecked.length > 0}
              summary={`${result.attempts} page(s) fetched`}
            >
              <ul className="flex flex-col gap-0.5">
                {result.sourcesChecked.map((url) => (
                  <li key={url} className="break-all">{url}</li>
                ))}
              </ul>
            </Step>

            <Step
              n={6}
              title="Emails found"
              done={Boolean(result.email) || result.alternatives.length > 0}
              summary={
                result.email
                  ? `${result.email} (+${result.alternatives.length} other, ${report?.rejectedEmails?.length ?? 0} rejected)`
                  : result.alternatives.length > 0
                    ? `${result.alternatives.length} found, none usable`
                    : `none usable${report?.rejectedEmails?.length ? `, ${report.rejectedEmails.length} rejected` : ""}`
              }
            >
              {result.email ? (
                <p className="break-all">
                  <span className="text-accent">{result.email}</span> · {result.confidence}{" "}
                  {result.score} · {result.source?.toLowerCase().replace(/_/g, " ")} ·{" "}
                  {result.sourceUrl || "no source page"}
                </p>
              ) : null}
              {result.alternatives.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {result.alternatives.map((alt) => (
                    <li key={alt.email} className="break-all">
                      {alt.email} · {alt.confidence} {alt.score} · {alt.method} ·{" "}
                      {alt.sourceUrl || "no source page"}
                    </li>
                  ))}
                </ul>
              ) : null}
              {report?.rejectedEmails?.length ? (
                <div>
                  <p className="text-hot">Rejected addresses</p>
                  <ul className="flex flex-col gap-0.5">
                    {report.rejectedEmails.map((entry) => (
                      <li key={entry.email} className="break-all text-subtle">
                        {entry.email} — {entry.why}
                        {entry.sourceUrl ? ` (${entry.sourceUrl})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {!result.email && result.alternatives.length === 0 && !report?.rejectedEmails?.length ? (
                <p>No address was published on any page that was read.</p>
              ) : null}
            </Step>

            <Step
              n={7}
              title="Final decision"
              done={result.status === "FOUND"}
              summary={`${result.status}${result.confidence ? ` · ${result.confidence} confidence` : ""}${result.score !== null ? ` · score ${result.score}` : ""}`}
              problem={
                result.reason ? `${REASON_LABELS[result.reason] ?? result.reason} (${result.reason})` : ""
              }
            >
              {result.email ? (
                <p className="font-mono break-all">{result.email}</p>
              ) : null}
              {result.source ? (
                <p>
                  Source: {result.source.toLowerCase().replace(/_/g, " ")}
                  {result.sourceUrl ? ` — ${result.sourceUrl}` : ""}
                </p>
              ) : null}
              {result.evidence ? <p>Evidence: {result.evidence}</p> : null}
              <p className="text-subtle">
                Next action {result.nextAction}
                {typeof report?.elapsedMs === "number"
                  ? ` · took ${(report.elapsedMs / 1000).toFixed(1)}s`
                  : ""}
              </p>
            </Step>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * One stage of the waterfall.
 *
 * Every stage is rendered whether or not it produced anything: a stage that
 * found nothing is the most informative thing on the page, and hiding it turns
 * a diagnosable failure back into "no public email found".
 */
function Step({
  n,
  title,
  done,
  summary,
  problem,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  summary: string;
  problem?: string;
  children?: React.ReactNode;
}) {
  return (
    <details className="rounded-md bg-surface-2 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 text-xs font-medium tabular-nums",
            done ? "bg-accent text-accent-fg" : "bg-surface text-muted",
          )}
        >
          {n}
        </span>
        <span className="text-sm font-medium">{title}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs", problem ? "text-hot" : "text-muted")}>
          {problem || summary}
        </span>
      </summary>
      <div className="mt-1.5 flex flex-col gap-1 pl-7 text-xs text-muted">
        {problem ? <p className="text-hot">{problem}</p> : null}
        {children}
      </div>
    </details>
  );
}

/**
 * The whole run as plain text, for pasting back.
 *
 * Deliberately not JSON: this is meant to be read by a person as well as
 * parsed by one, and a wall of braces makes a failure harder to see, not easier.
 */
function plainReport(
  inputs: Record<string, string>,
  result: DiscoveryResult,
  report: Extract<Awaited<ReturnType<typeof findLeadEmail>>, { ok: true }> | null,
): string {
  const lines: string[] = [];
  const add = (text = "") => lines.push(text);

  add("PEAKSWIFT EMAIL DISCOVERY REPORT");
  add("================================");
  add();
  add("INPUT");
  for (const [key, value] of Object.entries(inputs)) add(`  ${key}: ${value || "(blank)"}`);
  add();

  add("1. SEARCH");
  add(`  provider: ${report?.searchProvider ?? "none configured"}`);
  add(`  queries run: ${report?.searchesRun ?? 0}`);
  for (const query of report?.queriesUsed ?? []) add(`    - ${query}`);
  if (report?.searchFailure) add(`  FAILURE: ${report.searchFailure}`);
  add();

  add("2. SEARCH RESULTS");
  if (!report?.searchResults?.length) add("  (none)");
  for (const entry of report?.searchResults ?? []) add(`  - ${entry.title || "(no title)"} :: ${entry.url}`);
  add();

  add("3. IDENTITY VERIFICATION");
  if (!report?.candidates?.length) add("  (no candidate site was fetched)");
  for (const candidate of report?.candidates ?? []) {
    add(`  [${candidate.accepted ? "PASS" : "FAIL"}] ${candidate.score}/100 ${candidate.character ?? ""} ${candidate.url}`);
    for (const signal of candidate.signals) {
      add(`      ${isNegative(signal) ? "NEGATIVE" : "positive"}: ${signal}`);
    }
  }
  add();

  add("4. VERIFIED WEBSITE");
  add(`  ${report?.website ? `${report.website.url} (${report.website.score}/100, via ${report.discoveryVia})` : "none"}`);
  for (const line of report?.website?.evidence ?? []) add(`      · ${line}`);
  add();

  add("5. PAGES CRAWLED");
  add(`  ${result.attempts} fetched`);
  for (const url of result.sourcesChecked) add(`    - ${url}`);
  add();

  add("6. EMAILS FOUND");
  if (!result.email && result.alternatives.length === 0 && !report?.rejectedEmails?.length) {
    add("  (none published on any page read)");
  }
  if (result.email) {
    add(`  chosen: ${result.email}`);
    add(`          confidence ${result.confidence} score ${result.score}`);
    add(`          source ${result.source} :: ${result.sourceUrl || "(no page)"}`);
    add(`          evidence: ${result.evidence}`);
  }
  for (const alt of result.alternatives) {
    add(`  other:  ${alt.email} (${alt.confidence} ${alt.score}, ${alt.method}) :: ${alt.sourceUrl || "(no page)"}`);
    for (const note of alt.notes) add(`            - ${note}`);
  }
  for (const entry of report?.rejectedEmails ?? []) {
    add(`  REJECTED: ${entry.email} — ${entry.why}${entry.sourceUrl ? ` :: ${entry.sourceUrl}` : ""}`);
  }
  add();

  add("7. FINAL DECISION");
  add(`  status: ${result.status}`);
  add(`  confidence: ${result.confidence || "n/a"}`);
  add(`  score: ${result.score ?? "n/a"}`);
  add(`  source: ${result.source || "n/a"}${result.sourceUrl ? ` (${result.sourceUrl})` : ""}`);
  add(`  reason: ${result.reason ?? "n/a"}`);
  add(`  next action: ${result.nextAction}`);
  if (typeof report?.elapsedMs === "number") add(`  elapsed: ${(report.elapsedMs / 1000).toFixed(1)}s`);

  return lines.join("\n");
}

/**
 * Is this signal evidence against the match rather than for it?
 *
 * The scorer emits one list, and a reader scanning a failed candidate needs to
 * see at a glance which lines were the reason. Keyed on the phrases the scorer
 * actually produces for a penalty or a disqualification.
 */
function isNegative(signal: string): boolean {
  return /counted against|held back|not a trading website|not the business's own website|not corroborated|unreachable|no identity signals/i.test(
    signal,
  );
}

/**
 * Run a list of real businesses in one pass.
 *
 * Real-world validation is the only thing that can tell you how this performs,
 * and testing twenty businesses one form at a time is enough friction that it
 * does not get done. Each row goes through the same `findLeadEmail` server
 * function the live pipeline uses — no separate code path, so what is measured
 * here is what actually runs.
 *
 * Read-only, one at a time, and nothing is written to the sheet or sent to
 * anyone. The correctness columns stay UNKNOWN until a person marks them: the
 * run can say it found an address, but only you can say it was the right one.
 */
export function ValidationBatch() {
  const [text, setText] = useState(BATCH_TEMPLATE);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);

  const inputs = useMemo(() => parseBatch(text), [text]);

  async function run() {
    const batch = parseBatch(text);
    if (batch.length === 0 || busy) return;
    setBusy(true);
    setCopied(false);
    cancelled.current = false;
    const results: BatchRow[] = [];
    setRows([]);
    for (const [index, entry] of batch.entries()) {
      if (cancelled.current) break;
      setAt(index + 1);
      const next = blankRow(entry);
      try {
        const answer = await findLeadEmail({
          data: {
            website: entry.website,
            businessName: entry.businessName,
            town: entry.town,
            trade: entry.trade,
            phone: entry.phone,
            address: entry.address,
            existingEmail: "",
            existingSource: "",
          },
        });
        if (!answer.ok) {
          next.error = answer.error;
        } else {
          next.website = answer.website?.url ?? "";
          next.identityScore = answer.website?.score ?? null;
          next.email = answer.discovery.email ?? "";
          next.confidence = answer.discovery.confidence ?? "";
          next.reason = answer.discovery.reason ?? "";
          next.pagesFetched = answer.discovery.attempts;
          next.elapsedMs = answer.elapsedMs ?? 0;
        }
      } catch (err) {
        next.error = err instanceof Error ? err.message : "request failed";
      }
      results.push(next);
      setRows([...results]);
    }
    setBusy(false);
  }

  function mark(index: number, field: "websiteCorrect" | "emailCorrect", value: Verdict) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  const summary = rows.length > 0 ? summariseBatch(rows) : null;

  return (
    <div className="mt-4 rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
      <h3 className="font-display text-lg font-medium">Real-world validation batch</h3>
      <p className="mt-1 text-sm text-muted">
        Paste real businesses, one per line. Each runs through the same discovery the live pipeline
        uses. Nothing is saved and nothing is sent.
      </p>

      <textarea
        className="mt-3 h-40 w-full rounded-md bg-surface-2 px-3 py-2 font-mono text-xs"
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Businesses to test"
        spellCheck={false}
      />
      <p className="mt-1 text-xs text-subtle">
        {inputs.length} business{inputs.length === 1 ? "" : "es"} parsed. Phone and postcode are the
        strongest identity signals — include them wherever you have them.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button className="h-11" disabled={busy || inputs.length === 0} onClick={() => void run()}>
          {busy ? <Loader2 className="animate-spin" /> : <Search />}
          {busy ? `Running ${at} of ${inputs.length}…` : `Run ${inputs.length}`}
        </Button>
        {busy ? (
          <Button variant="ghost" className="h-11" onClick={() => (cancelled.current = true)}>
            Stop
          </Button>
        ) : null}
        {rows.length > 0 && !busy ? (
          <Button
            variant="secondary"
            className="h-11"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(batchReport(rows))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            <ClipboardCopy />
            {copied ? "Copied" : "Copy batch report"}
          </Button>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Business</th>
                <th className="py-1 pr-2 font-medium">Website found</th>
                <th className="py-1 pr-2 font-medium">Right site?</th>
                <th className="py-1 pr-2 font-medium">Email found</th>
                <th className="py-1 pr-2 font-medium">Right email?</th>
                <th className="py-1 pr-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.input.businessName}-${index}`} className="border-t border-border align-top">
                  <td className="py-1.5 pr-2">{row.input.businessName}</td>
                  <td className="py-1.5 pr-2 break-all">
                    {row.error ? <span className="text-hot">error</span> : row.website || "—"}
                    {row.identityScore !== null ? (
                      <span className="text-subtle"> ({row.identityScore})</span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Mark value={row.websiteCorrect} onChange={(v) => mark(index, "websiteCorrect", v)} />
                  </td>
                  <td className="py-1.5 pr-2 break-all">
                    {row.email || "—"}
                    {row.confidence ? <span className="text-subtle"> {row.confidence}</span> : null}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Mark value={row.emailCorrect} onChange={(v) => mark(index, "emailCorrect", v)} />
                  </td>
                  <td className="py-1.5 pr-2 text-subtle">{row.error || row.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {summary ? (
            <div className="mt-3 flex flex-col gap-0.5 text-xs text-muted">
              <p>
                Measured by the run: {rate(summary.websitesVerified, summary.completed)} websites
                verified · {rate(summary.emailsFound, summary.completed)} emails found ·{" "}
                {(summary.averageMs / 1000).toFixed(1)}s average
              </p>
              <p>
                Confirmed by you: {summary.websitesChecked} of {summary.websitesVerified} sites and{" "}
                {summary.emailsChecked} of {summary.emailsFound} emails checked
                {summary.falsePositiveWebsites + summary.falsePositiveEmails > 0 ? (
                  <span className="text-hot">
                    {" "}
                    · {summary.falsePositiveWebsites} wrong site(s),{" "}
                    {summary.falsePositiveEmails} wrong email(s)
                  </span>
                ) : null}
              </p>
              <p className="text-subtle">
                Accuracy is only meaningful once every found row is marked. Mark a row WRONG if the
                site or address is not genuinely that business's — those are the results worth
                sending back.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Mark({ value, onChange }: { value: Verdict; onChange: (value: Verdict) => void }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as Verdict)}
      aria-label="Is this correct?"
      className={cn(
        "rounded-full border-0 px-2 py-0.5 text-xs",
        value === "CORRECT" && "bg-accent text-accent-fg",
        value === "WRONG" && "bg-hot/15 text-hot",
        value === "UNKNOWN" && "bg-surface-2 text-muted",
      )}
    >
      {VERDICTS.map((verdict) => (
        <option key={verdict} value={verdict}>
          {verdict === "UNKNOWN" ? "?" : verdict === "CORRECT" ? "Yes" : "No"}
        </option>
      ))}
    </select>
  );
}
