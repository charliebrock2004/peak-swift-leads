import { createFileRoute } from "@tanstack/react-router";
import { FindPage } from "@/components/pages/find";

export const Route = createFileRoute("/_app/find")({
  component: FindPage,
  validateSearch: (search: Record<string, unknown>): { campaign?: string } =>
    typeof search.campaign === "string" ? { campaign: search.campaign } : {},
});
