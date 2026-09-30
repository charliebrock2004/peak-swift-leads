import { createFileRoute } from "@tanstack/react-router";
import { ProspectsPage } from "@/components/pages/prospects";

export const Route = createFileRoute("/_app/prospects")({
  component: ProspectsPage,
  validateSearch: (search: Record<string, unknown>): { campaign?: string; filter?: string } => ({
    ...(typeof search.campaign === "string" ? { campaign: search.campaign } : {}),
    ...(typeof search.filter === "string" ? { filter: search.filter } : {}),
  }),
});
