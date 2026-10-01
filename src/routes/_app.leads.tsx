import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old lead sheet. Everything it did — add, edit, import, export, check
 * websites and emails — lives on Businesses now, against the one list on the
 * account, so old links and bookmarks land there.
 */
export const Route = createFileRoute("/_app/leads")({
  beforeLoad: () => {
    throw redirect({ to: "/prospects" });
  },
});
