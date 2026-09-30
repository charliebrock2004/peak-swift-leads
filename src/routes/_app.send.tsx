import { createFileRoute } from "@tanstack/react-router";
import { SendPage } from "@/components/pages/send";

export const Route = createFileRoute("/_app/send")({
  component: SendPage,
  validateSearch: (search: Record<string, unknown>): { campaign?: string; view?: string } => ({
    ...(typeof search.campaign === "string" ? { campaign: search.campaign } : {}),
    ...(typeof search.view === "string" ? { view: search.view } : {}),
  }),
});
