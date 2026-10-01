/**
 * Server functions for background jobs. Owner-only: every query is scoped to
 * the signed-in account, and a job id from the browser is only ever looked up
 * under that account.
 *
 * Jobs travel to the browser as JSON text — their progress is whatever the
 * job type measures, and the server-function boundary only carries values it
 * can prove serialisable.
 *
 * Server-only modules are imported inside the handlers, so none of them
 * reach the browser bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import type { JobType } from "./types.ts";

type Fail = { ok: false; error: string };
type JobReply = { ok: true; job: string; alreadyRunning?: boolean } | Fail;

const STARTABLE: readonly JobType[] = ["find", "audit_batch", "company_batch", "reply_poll"];
/** The shortest gap between two reply checks for one account. */
const REPLY_POLL_MIN_GAP_MS = 10 * 60 * 1000;
/** An inline slice from the open app: short, so the screen hears back often. */
const INLINE_BUDGET_MS = 25_000;

function idOf(input: unknown): string {
  const id = (input as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id.trim().slice(0, 64) : "";
}

function failure(error: unknown, fallback: string): Fail {
  const message = error instanceof Error ? error.message : "";
  if (/relation "jobs" does not exist/i.test(message)) return { ok: false, error: "Background jobs need the latest database migration. Redeploy to apply it." };
  return { ok: false, error: message || fallback };
}

async function deps() {
  const { getSql } = await import("@/lib/db");
  const store = await import("./store.server.ts");
  return { sql: await getSql(), store };
}

/**
 * Start a job. One of each type at a time per account: starting a second Find
 * while one is running returns the running one (`alreadyRunning`), so a double
 * click or a retried request never starts two.
 */
export const startJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { type?: unknown; input?: unknown };
    const type = String(source.type ?? "") as JobType;
    if (!STARTABLE.includes(type)) throw new Error("Unknown job type.");
    return { type, input: source.input ?? {} };
  })
  .handler(async ({ data, context }): Promise<JobReply> => {
    try {
      const { sql, store } = await deps();
      let input: unknown = {};
      if (data.type === "find") {
        const outreach = await import("@/lib/outreach/store.server");
        const { sanitizeFindInput, findInputProblem } = await import("./find.server.ts");
        const settings = await outreach.loadSettings(sql, context.userId);
        const find = sanitizeFindInput(data.input, settings.dailyLimit);
        const problem = findInputProblem(find);
        if (problem) return { ok: false, error: problem };
        input = find;
      } else if (data.type === "audit_batch" || data.type === "company_batch") {
        const source = (data.input ?? {}) as { leadIds?: unknown; limit?: unknown };
        const leadIds = Array.isArray(source.leadIds) ? source.leadIds.filter((id): id is string => typeof id === "string").map((id) => id.slice(0, 64)).slice(0, 200) : [];
        const limit = Number(source.limit);
        input = { leadIds, limit: Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.round(limit))) : 50 };
      }
      // Reply polling is rate-limited per account: a check that finished in
      // the last ten minutes is answer enough, however many tabs ask.
      if (data.type === "reply_poll") {
        const [last] = await store.recentJobs(sql, context.userId, "reply_poll", 1);
        if (last && last.status === "done" && Date.parse(last.finishedAt) > Date.now() - REPLY_POLL_MIN_GAP_MS) {
          return { ok: true, job: JSON.stringify(store.toView(last)), alreadyRunning: false };
        }
      }
      const { job, created } = await store.createJob(sql, context.userId, {
        type: data.type,
        input,
        idempotencyKey: data.type,
        maxAttempts: data.type === "find" ? 6 : 4,
      });
      const { afterResponse, runInBackground } = await import("./background.server.ts");
      afterResponse(() => runInBackground({ userId: context.userId, jobId: job.id }));
      const { log } = await import("@/lib/log.server");
      log.info("job_started", { userId: context.userId, jobId: job.id, type: job.type, created });
      return { ok: true, job: JSON.stringify(store.toView(job)), alreadyRunning: !created };
    } catch (error) {
      return failure(error, "Could not start that.");
    }
  });

/** One job by id, or the newest of a type (an unfinished one first). */
export const getJob = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { id?: unknown; type?: unknown };
    const type = String(source.type ?? "");
    return { id: idOf(source), type: (STARTABLE.includes(type as JobType) ? type : "") as JobType | "" };
  })
  .handler(async ({ data, context }): Promise<JobReply | { ok: true; job: null }> => {
    try {
      const { sql, store } = await deps();
      const job = data.id
        ? await store.loadJob(sql, context.userId, data.id)
        : data.type
          ? ((await store.activeJob(sql, context.userId, data.type)) ?? (await store.recentJobs(sql, context.userId, data.type, 1))[0] ?? null)
          : null;
      return job ? { ok: true, job: JSON.stringify(store.toView(job)) } : { ok: true, job: null };
    } catch (error) {
      return failure(error, "Could not load that job.");
    }
  });

/**
 * Move a job on while its screen is open. If nobody holds it, run a short
 * slice now (and leave a background slice to carry on); if a runner holds it,
 * just report where it has got to.
 */
export const advanceJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ id: idOf(input) }))
  .handler(async ({ data, context }): Promise<JobReply> => {
    try {
      const { sql, store } = await deps();
      const before = await store.loadJob(sql, context.userId, data.id);
      if (!before) return { ok: false, error: "That job no longer exists." };
      const leased = before.leaseUntil && Date.parse(before.leaseUntil) > Date.now();
      const due = !before.runAfter || Date.parse(before.runAfter) <= Date.now();
      if ((before.status === "queued" || before.status === "running") && !leased && due) {
        const { runJobs } = await import("./runner.server.ts");
        const { defaultHandlers } = await import("./handlers.server.ts");
        const outcome = await runJobs(sql, { handlers: defaultHandlers, budgetMs: INLINE_BUDGET_MS, userId: context.userId, jobId: data.id });
        if (outcome.more) {
          const { afterResponse, runInBackground } = await import("./background.server.ts");
          afterResponse(() => runInBackground({ userId: context.userId, jobId: data.id }));
        }
      }
      const after = await store.loadJob(sql, context.userId, data.id);
      return after ? { ok: true, job: JSON.stringify(store.toView(after)) } : { ok: false, error: "That job no longer exists." };
    } catch (error) {
      return failure(error, "Could not move the job on.");
    }
  });

/** Ask a job to stop. It stops tidily at its next checkpoint, keeping what it made. */
export const cancelJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ id: idOf(input) }))
  .handler(async ({ data, context }): Promise<JobReply> => {
    try {
      const { sql, store } = await deps();
      await store.requestCancel(sql, context.userId, data.id);
      const job = await store.loadJob(sql, context.userId, data.id);
      if (!job) return { ok: false, error: "That job no longer exists." };
      // Nobody running it: finish the stop now rather than waiting for a runner.
      if ((job.status === "queued" || job.status === "running") && !(job.leaseUntil && Date.parse(job.leaseUntil) > Date.now())) {
        const { runJobs } = await import("./runner.server.ts");
        const { defaultHandlers } = await import("./handlers.server.ts");
        await runJobs(sql, { handlers: defaultHandlers, budgetMs: INLINE_BUDGET_MS, userId: context.userId, jobId: data.id });
      }
      const after = await store.loadJob(sql, context.userId, data.id);
      return after ? { ok: true, job: JSON.stringify(store.toView(after)) } : { ok: false, error: "That job no longer exists." };
    } catch (error) {
      return failure(error, "Could not stop that job.");
    }
  });
