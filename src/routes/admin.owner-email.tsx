import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import {
  getOwnerEmailState,
  renameOwnerEmail,
  type OwnerEmailState,
} from "@/lib/auth/owner-email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/owner-email")({ component: OwnerEmailAdmin });

/**
 * TEMPORARY: correct the owner's own email address.
 *
 * Not linked from anywhere — reached by typing the path — and gated by the same
 * `authMiddleware` as everything else, so a signed-out or non-owner visitor gets
 * nothing but the refusal. Delete this file and `@/lib/auth/owner-email` once
 * the address is right.
 */
function OwnerEmailAdmin() {
  const [state, setState] = useState<OwnerEmailState | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(async () => {
    try {
      setState(await getOwnerEmailState());
    } catch (err) {
      setState({ ok: false, error: err instanceof Error ? err.message : "Could not load." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await renameOwnerEmail({ data: { from, to } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(
        `Done. The owner is now ${result.email} (user id ${result.userId}, unchanged). ` +
          `${result.accountsUpdated} linked credential row updated.`,
      );
      setFrom("");
      setTo("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10 text-fg">
      <div className="w-full max-w-md rounded-xl bg-surface px-6 py-7 shadow-(--shadow-border)">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift · temporary</p>
        <h1 className="mt-3 font-display text-xl font-medium">Correct the owner email</h1>
        <p className="mt-2 text-sm text-muted">
          Changes only the address on your own account. The user id, your password, every lead and all
          outreach data are left exactly as they are.
        </p>

        {state === null ? (
          <Loader2 className="mx-auto mt-8 size-6 animate-spin text-muted" />
        ) : !state.ok ? (
          <div className="mt-5 flex items-start gap-2 rounded-md bg-hot/10 px-3 py-3 text-sm text-hot">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </div>
        ) : (
          <>
            <dl className="mt-5 flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">Current owner</dt>
                <dd className="min-w-0 truncate text-right font-medium">{state.email}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">User id (will not change)</dt>
                <dd className="min-w-0 truncate text-right font-mono text-xs">{state.userId}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">Leads on this account</dt>
                <dd className="tabular-nums font-medium">{state.leads}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">Outreach emails</dt>
                <dd className="tabular-nums font-medium">{state.outreachEmails}</dd>
              </div>
            </dl>

            {done ? (
              <div className="mt-5 flex items-start gap-2 rounded-md bg-accent/10 px-3 py-3 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <span>{done}</span>
              </div>
            ) : (
              <form className="mt-5 space-y-3" onSubmit={submit}>
                <label className="block text-sm text-muted" htmlFor="from">
                  Current address, to confirm
                </label>
                <Input
                  id="from"
                  type="email"
                  required
                  autoComplete="off"
                  placeholder={state.email}
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
                <label className="block text-sm text-muted" htmlFor="to">
                  New address
                </label>
                <Input
                  id="to"
                  type="email"
                  required
                  autoComplete="off"
                  placeholder="you@example.com"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
                {error ? <p className="text-sm text-hot">{error}</p> : null}
                <Button type="submit" disabled={busy} className="h-11 w-full">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Change the owner email
                </Button>
              </form>
            )}
          </>
        )}

        <a href="/" className="mt-6 block text-center text-sm text-muted underline-offset-4 hover:underline">
          Back to leads
        </a>
      </div>
    </div>
  );
}
