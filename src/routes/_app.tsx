import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppDataProvider } from "@/components/app/app-context";
import { AppShell } from "@/components/app/app-shell";

/**
 * The signed-in app: one shell and one shared data layer around every screen,
 * so a prospecting run keeps going while you look at other pages.
 *
 * The lead sheet inside it stays local-first and usable signed out; screens
 * that need the server say so themselves rather than this layout gating
 * everything behind a sign-in.
 */
export const Route = createFileRoute("/_app")({ component: AppLayout });

function AppLayout() {
  return (
    <AppDataProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </AppDataProvider>
  );
}
