/**
 * Keeping jobs moving without a worker process.
 *
 * Vercel has no long-running workers, so a job advances in slices, started by
 * whichever of these comes first:
 *
 * 1. `waitUntil` — the request that started the job (or asked about it) keeps
 *    its function alive after responding and runs a slice in the background.
 * 2. Self-chaining — a background slice that ran out of time with work left
 *    calls `/api/jobs/tick`, which starts a fresh function for the next slice.
 *    Needs `CRON_SECRET` (and, on a protected preview,
 *    `VERCEL_AUTOMATION_BYPASS_SECRET`); without them this link is skipped.
 * 3. The open app — the Find screen asks the server to advance its job while
 *    it is on screen.
 * 4. The daily cron — picks up anything left, and schedules reply polling and
 *    retention.
 *
 * Leases make all four safe together: whichever claims the job runs it, the
 * others see it leased and leave it alone.
 */
import { getRequest } from "@tanstack/react-start/server";
import { appOrigin } from "../app-origin.ts";
import { log } from "../log.server.ts";
import type { JobType } from "./types.ts";

/** A background slice's time: under the 300s function limit, with room to save. */
export const BACKGROUND_BUDGET_MS = 240_000;

type WaitUntil = (promise: Promise<unknown>) => void;

function platformWaitUntil(request?: Request | null): WaitUntil | null {
  const fromRequest = (request as (Request & { waitUntil?: WaitUntil }) | null | undefined)?.waitUntil;
  if (typeof fromRequest === "function") return fromRequest.bind(request);
  // What @vercel/functions' waitUntil reads: the request context the Vercel
  // runtime installs for every invocation.
  const context = (globalThis as Record<symbol, { get?: () => { waitUntil?: WaitUntil } } | undefined>)[Symbol.for("@vercel/request-context")];
  const fromContext = context?.get?.()?.waitUntil;
  return typeof fromContext === "function" ? fromContext : null;
}

function currentRequest(): Request | null {
  try {
    return getRequest() ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `task` without holding up the response. On Vercel the function is kept
 * alive until it settles (waitUntil); in a long-lived dev server it simply
 * carries on. Returns how it was scheduled, for the logs.
 */
export function afterResponse(task: () => Promise<unknown>, request: Request | null = currentRequest()): "waitUntil" | "detached" {
  const promise = task().catch((error: unknown) => log.warn("background_task_failed", { error }));
  const waitUntil = platformWaitUntil(request);
  if (waitUntil) {
    waitUntil(promise);
    return "waitUntil";
  }
  return "detached";
}

/** Run this user's jobs (or one job) for one background slice, then chain if work is left. */
export async function runInBackground(options: { userId?: string; jobId?: string; types?: readonly JobType[] }): Promise<void> {
  const { getSql } = await import("@/lib/db");
  const { runJobs } = await import("./runner.server.ts");
  const { defaultHandlers } = await import("./handlers.server.ts");
  const sql = await getSql();
  const outcome = await runJobs(sql, { handlers: defaultHandlers, budgetMs: BACKGROUND_BUDGET_MS, ...options });
  if (outcome.ran.length > 0) log.info("jobs_slice", { userId: options.userId ?? "*", ran: outcome.ran, more: outcome.more });
  if (outcome.more) await chainTick(options);
}

/** Ask a fresh function to run the next slice. Best effort: the app and the cron are the fallback. */
export async function chainTick(target: { userId?: string; jobId?: string }): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  const origin = appOrigin(process.env);
  if (!secret || !origin) return false;
  const headers: Record<string, string> = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  try {
    const response = await fetch(`${origin}/api/jobs/tick`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: target.userId ?? "", jobId: target.jobId ?? "" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) log.warn("jobs_chain_refused", { status: response.status });
    return response.ok;
  } catch (error) {
    log.warn("jobs_chain_failed", { error });
    return false;
  }
}

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>`. */
export async function tickAuthorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const { timingSafeEqual } = await import("node:crypto");
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The daily schedule: reply polling for every connected Gmail account, and
 * retention. Idempotency keys are per day, so a cron that fires twice, or a
 * retry, schedules each job once.
 */
export async function scheduleDaily(now = new Date()): Promise<{ replyPolls: number; retention: boolean }> {
  const { getSql } = await import("@/lib/db");
  const store = await import("./store.server.ts");
  const sql = await getSql();
  const day = now.toISOString().slice(0, 10);
  let replyPolls = 0;
  for (const userId of await store.usersWithGmail(sql)) {
    const { created } = await store.createJob(sql, userId, { type: "reply_poll", input: {}, idempotencyKey: `reply_poll:${day}`, maxAttempts: 3 });
    if (created) replyPolls += 1;
  }
  const { created } = await store.createJob(sql, "system", { type: "retention", input: {}, idempotencyKey: `retention:${day}`, maxAttempts: 2 });
  return { replyPolls, retention: created };
}
