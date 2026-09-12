import { useState } from "react";
import { ClipboardCopy, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findLeadEmail } from "@/lib/qualify-server";
import { REASON_LABELS, type DiscoveryResult } from "@/lib/email-discovery";
import { SEARCH_FAILURE_LABELS } from "@/lib/search-provider";
import { cn } from "@/lib/utils";

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
                          <li key={signal} className="text-subtle">· {signal}</li>
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
                  ? `${result.email} (+${result.alternatives.length} other)`
                  : result.alternatives.length > 0
                    ? `${result.alternatives.length} found, none usable`
                    : "none published on any page read"
              }
            >
              {result.alternatives.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {result.alternatives.map((alt) => (
                    <li key={alt.email} className="break-all">
                      {alt.email} · {alt.confidence} {alt.score}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No address was published on any page that was read.</p>
              )}
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
    for (const signal of candidate.signals) add(`      · ${signal}`);
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
  if (!result.email && result.alternatives.length === 0) add("  (none published on any page read)");
  if (result.email) add(`  chosen: ${result.email}`);
  for (const alt of result.alternatives) add(`  other:  ${alt.email} (${alt.confidence} ${alt.score})`);
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
