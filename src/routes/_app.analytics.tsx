import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsPage } from "@/components/pages/analytics";

export const Route = createFileRoute("/_app/analytics")({
  component: AnalyticsPage,
});
