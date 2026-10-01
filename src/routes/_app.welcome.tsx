import { createFileRoute } from "@tanstack/react-router";
import { WelcomePage } from "@/components/pages/welcome";

export const Route = createFileRoute("/_app/welcome")({
  component: WelcomePage,
});
