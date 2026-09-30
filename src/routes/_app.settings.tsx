import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/pages/settings";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { section?: string; connect?: string } => ({
    ...(typeof search.section === "string" ? { section: search.section } : {}),
    // Set when Connect Gmail moved the tab to the redirect URI's own origin, so
    // the flow carries on there without a second click.
    ...(search.connect === "1" || search.connect === 1 ? { connect: "1" } : {}),
  }),
});
