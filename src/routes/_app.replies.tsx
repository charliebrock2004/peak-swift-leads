import { createFileRoute } from "@tanstack/react-router";
import { RepliesPage } from "@/components/pages/replies";

export const Route = createFileRoute("/_app/replies")({
  component: RepliesPage,
  validateSearch: (search: Record<string, unknown>): { campaign?: string } =>
    typeof search.campaign === "string" ? { campaign: search.campaign } : {},
});
