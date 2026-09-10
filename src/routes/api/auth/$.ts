import { createFileRoute } from "@tanstack/react-router";

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
 *
 * `auth` is imported INSIDE the handler, not at the top of the file. A route
 * module belongs to the route tree, which is bundled for the browser as well as
 * the server; a static import drags `@/lib/auth/server` — and with it `pg`,
 * `better-auth`, `node:crypto` and PGLite — into that graph. Rollup resolved the
 * resulting cycle by emitting an SSR chunk that referenced an export its own
 * dependency never defined, so the whole server bundle failed to evaluate with
 * `SyntaxError: Export 'ssr_exports' is not defined in module` and every request
 * — including the lead sheet — answered 500.
 *
 * This is the same rule `leads-server.ts` and `outreach/server.ts` already
 * follow, and for the same reason they give: server-only modules are loaded
 * when the handler runs, never when the route is defined.
 */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { auth } = await import("@/lib/auth/server");
        return auth.handler(request);
      },
    },
  },
});
