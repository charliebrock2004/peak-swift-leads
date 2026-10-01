/**
 * The job runner: claim a job, run it in steps until the slice's time is up,
 * checkpoint after every step, release or finish.
 *
 * A handler is a state machine. `step` does one unit of work (search one
 * trade, check three websites, write three drafts) and returns the new state;
 * the runner saves it before the next step starts. So a slice killed by the
 * platform loses at most the step it was in, and the next slice resumes from
 * the last checkpoint. Steps must therefore be safe to repeat — every write a
 * step makes is keyed (fixed lead ids, one draft per lead and kind), so a
 * repeated step updates rather than duplicates.
 */
import type { Sql } from "@/lib/db";
import { log } from "../log.server.ts";
import * as store from "./store.server.ts";
import { LostLease, type Job } from "./store.server.ts";
import type { JobType } from "./types.ts";

/** Longer than the longest a function may live (300s), so a live slice never loses its lease. */
export const LEASE_MS = 330_000;
/** The default time a step is assumed to need before one is started late in a slice. */
const DEFAULT_STEP_MS = 30_000;

export type JobSnapshot<I, S, P> = { input: I; state: S; progress: P };

export type StepResult<S, P, R> =
  | { kind: "continue"; state: S; progress: P }
  /** Yield and come back after a pause (rate-limited, waiting on something). */
  | { kind: "wait"; state: S; progress: P; delayMs: number }
  | { kind: "done"; state: S; progress: P; result: R }
  /** Finished, but not successfully — a final answer, not a crash to retry. */
  | { kind: "failed"; state: S; progress: P; error: string }
  | { kind: "cancelled"; state: S; progress: P; result?: R };

export type StepContext = {
  sql: Sql;
  userId: string;
  jobId: string;
  attempts: number;
  /** Milliseconds left in this slice. */
  timeLeft: () => number;
};

export type JobHandler<I = unknown, S = unknown, P = unknown, R = unknown> = {
  /** The first state and progress, for a job that has not run yet. */
  init: (input: I, ctx: StepContext) => { state: S; progress: P };
  step: (ctx: StepContext, job: JobSnapshot<I, S, P>) => Promise<StepResult<S, P, R>>;
  /** Tidy finish when a person asked the job to stop. */
  cancel: (ctx: StepContext, job: JobSnapshot<I, S, P>) => Promise<StepResult<S, P, R>>;
  /** The progress to show once the job has failed for good. */
  failed?: (ctx: StepContext, job: JobSnapshot<I, S, P>, error: string) => Promise<P>;
  /** Roughly how long the next step needs; a slice with less left yields first. */
  needs?: (state: S) => number;
};

export type SliceOutcome = "done" | "failed" | "cancelled" | "yielded" | "waiting" | "retrying" | "lost";

function isEmpty(value: unknown): boolean {
  return !value || (typeof value === "object" && Object.keys(value as object).length === 0);
}

/** 15s, 30s, 60s… capped at ten minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(600_000, 15_000 * 2 ** Math.max(0, attempts));
}

export async function runSlice(sql: Sql, job: Job, handler: JobHandler, budgetMs: number): Promise<SliceOutcome> {
  const deadline = Date.now() + budgetMs;
  const ctx: StepContext = { sql, userId: job.userId, jobId: job.id, attempts: job.attempts, timeLeft: () => deadline - Date.now() };
  let snapshot: JobSnapshot<unknown, unknown, unknown> = { input: job.input, state: job.state, progress: job.progress };
  if (isEmpty(job.state)) snapshot = { input: job.input, ...handler.init(job.input, ctx) };
  let cancel = job.cancelRequested;
  let steps = 0;

  try {
    while (true) {
      if (!cancel && steps > 0 && ctx.timeLeft() < (handler.needs?.(snapshot.state) ?? DEFAULT_STEP_MS)) {
        await store.release(sql, job, { state: snapshot.state, progress: snapshot.progress });
        return "yielded";
      }
      const out = cancel ? await handler.cancel(ctx, snapshot) : await handler.step(ctx, snapshot);
      steps += 1;
      snapshot = { input: job.input, state: out.state, progress: out.progress };
      switch (out.kind) {
        case "done":
          await store.finish(sql, job, { status: "done", state: out.state, progress: out.progress, result: out.result });
          log.info("job_finished", { userId: job.userId, jobId: job.id, type: job.type, attempts: job.attempts });
          return "done";
        case "cancelled":
          await store.finish(sql, job, { status: "cancelled", state: out.state, progress: out.progress, result: out.result });
          log.info("job_cancelled", { userId: job.userId, jobId: job.id, type: job.type });
          return "cancelled";
        case "failed":
          await store.finish(sql, job, { status: "failed", state: out.state, progress: out.progress, error: out.error });
          log.warn("job_failed", { userId: job.userId, jobId: job.id, type: job.type, error: out.error });
          return "failed";
        case "wait":
          await store.release(sql, job, { state: out.state, progress: out.progress, delayMs: out.delayMs });
          return "waiting";
        case "continue": {
          const saved = await store.checkpoint(sql, job, { state: out.state, progress: out.progress, leaseMs: LEASE_MS });
          cancel = cancel || saved.cancelRequested;
        }
      }
    }
  } catch (error) {
    if (error instanceof LostLease) return "lost";
    const message = error instanceof Error ? error.message : String(error);
    const outcome = await store.failAttempt(sql, job, message, backoffMs(job.attempts)).catch(() => "retry" as const);
    if (outcome === "failed") log.error("job_failed", { userId: job.userId, jobId: job.id, type: job.type, attempts: job.attempts + 1, error: message });
    else log.warn("job_retry", { userId: job.userId, jobId: job.id, type: job.type, attempt: job.attempts + 1, retryInMs: backoffMs(job.attempts), error: message });
    if (outcome === "failed" && handler.failed) {
      const progress = await handler.failed(ctx, snapshot, message).catch(() => snapshot.progress);
      await sql
        .query(`update jobs set progress = $3::jsonb, updated_at = now() where user_id = $1 and id = $2`, [job.userId, job.id, JSON.stringify(progress)])
        .catch(() => undefined);
    }
    return outcome === "failed" ? "failed" : "retrying";
  }
}

export type HandlerLookup = (type: JobType) => Promise<JobHandler | null>;

/**
 * Run jobs until the budget is spent or nothing is runnable.
 *
 * Scoped to one user, or one job, when given — a user's request never spends
 * its time on somebody else's work.
 */
export async function runJobs(
  sql: Sql,
  options: { handlers: HandlerLookup; budgetMs: number; userId?: string; jobId?: string; types?: readonly JobType[] },
): Promise<{ ran: { id: string; type: JobType; outcome: SliceOutcome }[]; more: boolean }> {
  const deadline = Date.now() + options.budgetMs;
  const ran: { id: string; type: JobType; outcome: SliceOutcome }[] = [];
  let more = false;
  while (deadline - Date.now() > 5_000) {
    const job = await store.claimJob(sql, { userId: options.userId, jobId: options.jobId, types: options.types, leaseMs: LEASE_MS });
    if (!job) break;
    const handler = await options.handlers(job.type);
    if (!handler) {
      await store.finish(sql, job, { status: "failed", state: job.state, progress: job.progress, error: `No handler for ${job.type} jobs.` });
      ran.push({ id: job.id, type: job.type, outcome: "failed" });
      continue;
    }
    const outcome = await runSlice(sql, job, handler, deadline - Date.now());
    ran.push({ id: job.id, type: job.type, outcome });
    if (outcome === "yielded" || outcome === "waiting" || outcome === "retrying") {
      more = true;
      // One job per call when a job id was named; otherwise leave the rest
      // of the queue for the next runner rather than starting work this
      // slice cannot finish.
      break;
    }
    if (options.jobId) break;
  }
  return { ran, more };
}
