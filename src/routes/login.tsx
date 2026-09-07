import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({ component: Login });

/**
 * Sign in to Peak Swift.
 *
 * This deployment has no external identity provider — see
 * `@/lib/auth/email-password` for why — so the way in is an email and a
 * password held in the app's own Better Auth tables. Whether an account may
 * then *use* the app is a separate decision made server-side against
 * `APP_OWNER_EMAIL`, so creating an account here grants nothing on its own.
 *
 * The "create the owner account" mode is shown rather than hidden: Better Auth's
 * sign-up endpoint is reachable regardless of what this page renders, so hiding
 * it would buy no security and would leave the owner with no way to register on
 * a fresh database.
 */
function Login() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Already signed in — nothing to do here. Waits out `isPending` so a hard
  // reload does not flash the form at someone who has a valid session.
  useEffect(() => {
    if (!isPending && user) void navigate({ to: "/" });
  }, [isPending, user, navigate]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email: email.trim(), password })
          : await authClient.signUp.email({
              email: email.trim(),
              password,
              name: email.trim().split("@")[0] || "Owner",
            });
      if (result.error) {
        setError(result.error.message ?? "That did not work.");
        return;
      }
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg text-fg">
        <Loader2 className="size-6 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 text-fg">
      <div className="w-full max-w-sm rounded-xl bg-surface px-6 py-8 shadow-(--shadow-border)">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift</p>
        <h1 className="mt-3 font-display text-xl font-medium">
          {mode === "sign-in" ? "Sign in" : "Create the owner account"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {mode === "sign-in"
            ? "Outreach and the account copy of your sheet live behind this. The lead sheet on this phone still works signed out."
            : "Use the address set as APP_OWNER_EMAIL — any other account is refused."}
        </p>

        <form className="mt-6 space-y-3" onSubmit={submit}>
          <Input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? <p className="text-sm text-hot">{error}</p> : null}
          <Button type="submit" disabled={busy} className="h-11 w-full">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          className="mt-5 w-full text-sm text-muted underline-offset-4 hover:underline"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError("");
          }}
        >
          {mode === "sign-in" ? "First time here? Create the owner account" : "Back to sign in"}
        </button>
      </div>
    </div>
  );
}
