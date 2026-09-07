import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { LeadApp } from "@/components/leads/lead-app";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

/**
 * The app, behind whatever identity this deployment uses.
 *
 * With auth disabled (`VITE_AUTH_ENABLED=false`, local dev) `useCurrentUserState`
 * hands back the dev user and never pends, so this guard is transparent there and
 * `npm run dev` is unchanged. On the deployment it keeps strangers out of a tool
 * that spends the owner's API quota and sends from the owner's mailbox.
 *
 * `isPending` is waited out before deciding: treating "still resolving" as
 * "signed out" bounces a signed-in owner to /login on every hard reload.
 */
function Home() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg text-fg">
        <Loader2 className="size-6 animate-spin text-muted" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;
  return <LeadApp />;
}
