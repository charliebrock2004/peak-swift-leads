import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "@/components/pages/runs";

export const Route = createFileRoute("/_app/runs/")({
  component: RunsPage,
});
