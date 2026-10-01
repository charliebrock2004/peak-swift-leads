import { createFileRoute } from "@tanstack/react-router";
import { CallsPage } from "@/components/pages/calls";

export const Route = createFileRoute("/_app/calls")({
  component: CallsPage,
  validateSearch: (search: Record<string, unknown>): { lead?: string } => (typeof search.lead === "string" && search.lead ? { lead: search.lead.slice(0, 64) } : {}),
});
