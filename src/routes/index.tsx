import { createFileRoute } from "@tanstack/react-router";
import { LeadApp } from "@/components/leads/lead-app";

export const Route = createFileRoute("/")({ component: Home });

/**
 * The lead sheet is local-first and must stay reachable signed out. Outreach,
 * sync and sending still sit behind `authMiddleware` — this page is not a
 * bypass; it is the product.
 */
function Home() {
  return <LeadApp />;
}
