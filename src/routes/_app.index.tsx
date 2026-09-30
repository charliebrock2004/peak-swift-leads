import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/pages/home";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});
