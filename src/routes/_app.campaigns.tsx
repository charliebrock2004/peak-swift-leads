import { createFileRoute } from "@tanstack/react-router";
import { CampaignsPage } from "@/components/pages/campaigns";

export const Route = createFileRoute("/_app/campaigns")({
  component: CampaignsPage,
});
