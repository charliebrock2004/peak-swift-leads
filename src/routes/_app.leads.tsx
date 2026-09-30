import { createFileRoute } from "@tanstack/react-router";
import { LeadsPage } from "@/components/pages/leads";

export const Route = createFileRoute("/_app/leads")({
  component: LeadsPage,
});
