import { createFileRoute } from "@tanstack/react-router";
import { PipelinePage } from "@/components/pages/pipeline";

export const Route = createFileRoute("/_app/pipeline")({
  component: PipelinePage,
});
