import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findLeadEmail } from "@/lib/qualify-server";
import { REASON_LABELS, type DiscoveryResult } from "@/lib/email-discovery";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DiscoveryResult | null>(null);

  async function run() {
    if (busy || website.trim().length < 4) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const answer = await findLeadEmail({
        data: { website: website.trim(), businessName: businessName.trim(), existingEmail: "", existingSource: "" },
      });
      if (!answer.ok) setError(answer.error);
      else setResult(answer.discovery);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const tone =
    result?.status === "FOUND" ? "text-accent" : result?.status === "LOW_CONFIDENCE" ? "text-warm-lead" : "text-muted";

  return (
    <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
      <h3 className="font-display text-lg font-medium">Test email discovery</h3>
      <p className="mt-1 text-sm text-muted">
        Try one business and see every source the engine checked. Nothing is saved.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Input
          className="h-11"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          placeholder="example.co.uk"
          aria-label="Website to test"
        />
        <Input
          className="h-11"
          value={businessName}
          onChange={(event) => setBusinessName(event.target.value)}
          placeholder="Business name (optional)"
          aria-label="Business name"
        />
      </div>
      <Button className="mt-3 h-11" disabled={busy || website.trim().length < 4} onClick={() => void run()}>
        {busy ? <Loader2 className="animate-spin" /> : <Search />}
        Run discovery
      </Button>

      {error ? <p className="mt-3 text-sm text-hot">{error}</p> : null}

      {result ? (
        <div className="mt-4 flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3 text-sm">
          <p className={cn("font-medium", tone)}>
            {result.status}
            {result.confidence ? ` · ${result.confidence} confidence` : ""}
            {result.score !== null ? ` · score ${result.score}` : ""}
          </p>
          {result.email ? <p className="font-mono break-all">{result.email}</p> : null}
          {result.source ? (
            <p className="text-muted">
              Source: {result.source.toLowerCase().replace(/_/g, " ")}
              {result.sourceUrl ? ` — ${result.sourceUrl}` : ""}
            </p>
          ) : null}
          {result.evidence ? <p className="text-muted">Evidence: {result.evidence}</p> : null}
          {result.reason ? (
            <p className="text-warm-lead">
              Why not: {REASON_LABELS[result.reason] ?? result.reason} ({result.reason})
            </p>
          ) : null}
          <p className="text-subtle">
            {result.attempts} page{result.attempts === 1 ? "" : "s"} fetched · next action {result.nextAction}
          </p>
          {result.alternatives.length > 0 ? (
            <div>
              <p className="text-muted">Other addresses found:</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.alternatives.map((alt) => (
                  <li key={alt.email} className="font-mono text-xs break-all text-subtle">
                    {alt.email} · {alt.confidence} {alt.score}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.sourcesChecked.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted">
                {result.sourcesChecked.length} page(s) checked
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.sourcesChecked.map((url) => (
                  <li key={url} className="text-xs break-all text-subtle">{url}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
