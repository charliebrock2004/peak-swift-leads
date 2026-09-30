import { createFileRoute } from "@tanstack/react-router";
import { RunDetailPage } from "@/components/pages/run-detail";

export const Route = createFileRoute("/_app/runs/$runId")({
  component: RunDetailPage,
});
