import { createFileRoute } from "@tanstack/react-router";

/**
 * The background-job heartbeat.
 *
 * GET is Vercel Cron (daily): schedule reply polling and retention, then run
 * whatever is waiting. POST is a job chaining itself: run the next slice of
 * one job. Both require `Authorization: Bearer <CRON_SECRET>` — Vercel Cron
 * sends exactly that when CRON_SECRET is set — and both answer at once,
 * doing the work after the response (waitUntil), so the caller never holds a
 * connection open for minutes.
 *
 * Without CRON_SECRET this endpoint refuses everything; jobs still run while
 * the app is open, and from the request that started them.
 *
 * Server-only modules are imported inside the handlers, as `api/auth/$.ts`
 * explains, so none of them reach the browser bundle.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/jobs/tick")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const background = await import("@/lib/jobs/background.server");
        if (!(await background.tickAuthorized(request))) return json({ ok: false }, 401);
        const scheduled = await background.scheduleDaily().catch(() => ({ replyPolls: 0, retention: false }));
        background.afterResponse(() => background.runInBackground({}), request);
        return json({ ok: true, scheduled }, 202);
      },
      POST: async ({ request }) => {
        const background = await import("@/lib/jobs/background.server");
        if (!(await background.tickAuthorized(request))) return json({ ok: false }, 401);
        const body = (await request.json().catch(() => ({}))) as { userId?: unknown; jobId?: unknown };
        const userId = typeof body.userId === "string" ? body.userId.slice(0, 200) : "";
        const jobId = typeof body.jobId === "string" ? body.jobId.slice(0, 64) : "";
        background.afterResponse(() => background.runInBackground({ userId: userId || undefined, jobId: jobId || undefined }), request);
        return json({ ok: true }, 202);
      },
    },
  },
});
