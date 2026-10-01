import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { KeyRound, Loader2, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SETUP_COPY } from "@/lib/outreach/setup-state";
import type { OutreachState } from "@/lib/outreach/server";

import { EmptyState, LoadingPage } from "./ui";
import { useAppData } from "@/components/app/app-data";

/**
 * Screens that need the server render through this: a loading state while the
 * first load is in flight, the actual cause and fix when it cannot load (signed
 * out, wrong account, no database, schema not migrated), and the screen itself
 * once there is state to show.
 */
export function WithState({ children }: { children: (state: OutreachState) => ReactNode }) {
  const { state, loading, setup, error, reload } = useAppData();
  if (state) return <>{children(state)}</>;
  if (loading) return <LoadingPage />;
  const reason = setup ?? "unknown";
  const copy = SETUP_COPY[reason];
  const signIn = reason === "signed-out" || reason === "not-owner";
  return (
    <EmptyState
      icon={signIn ? <KeyRound /> : <ServerCrash />}
      title={copy.title}
      action={
        signIn ? (
          <>
            <Link to="/login">
              <Button>Sign in</Button>
            </Link>
          </>
        ) : (
          <>
            <Button onClick={() => void reload()}>
              {loading ? <Loader2 className="animate-spin" /> : null}
              Try again
            </Button>
          </>
        )
      }
    >
      <p>{copy.detail}</p>
      {copy.fix ? <p className="mt-2 text-subtle">{copy.fix}</p> : null}
      {!copy.fix && error && reason === "unknown" ? <p className="mt-2 text-subtle">{error}</p> : null}
    </EmptyState>
  );
}
