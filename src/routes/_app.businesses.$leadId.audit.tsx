import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "@/components/pages/audit";

export const Route = createFileRoute("/_app/businesses/$leadId/audit")({
  component: AuditPage,
});
