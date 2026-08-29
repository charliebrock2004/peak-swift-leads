import { createFileRoute } from "@tanstack/react-router";
import { LeadApp } from "@/components/leads/lead-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <LeadApp />;
}
