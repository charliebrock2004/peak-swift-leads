import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";

/**
 * Better Auth's HTTP endpoints, at the origin the rest of the app expects.
 *
 * `src/lib/auth/server.ts`, `client.ts`, `verify.server.ts` and `preview.ts` all
 * describe this app as running "its OWN Better Auth at same-origin
 * `/api/auth/*`" — but nothing actually mounted it, so every request to
 * `/api/auth/get-session`, `/sign-in/email` and `/oauth2/callback/*` fell
 * through to the SPA and came back as a 200 page of HTML that the auth client
 * could only read as failure.
 *
 * Nothing depended on it while the app ran with `VITE_AUTH_ENABLED=false`,
 * because that path resolves a dev user without ever asking the server. The
 * moment sign-in is real — which a public deployment requires — it is the first
 * thing needed, and its absence looks exactly like "the database is missing".
 *
 * `ANY` because Better Auth routes internally by method and path: GET for
 * `get-session` and the OAuth callback, POST for the credentialed calls. The
 * splat keeps every one of those on this single handler.
 */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      ANY: ({ request }) => auth.handler(request),
    },
  },
});
