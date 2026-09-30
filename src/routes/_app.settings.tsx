import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/pages/settings";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): { section?: string } =>
    typeof search.section === "string" ? { section: search.section } : {},
});
