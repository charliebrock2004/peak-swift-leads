import { createFileRoute } from "@tanstack/react-router";
import { BusinessPage } from "@/components/pages/business";

export const Route = createFileRoute("/_app/businesses/$leadId/")({
  component: BusinessPage,
});
