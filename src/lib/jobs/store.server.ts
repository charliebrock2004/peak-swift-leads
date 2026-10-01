/**
 * The jobs table (migration 0012): create, claim, checkpoint, finish.
 *
 * A job is claimed with a lease and a claim id. Every write a slice makes names
 * its claim id, so a slice that ran past its lease — and was taken over — finds
 * its write refused (`LostLease`) instead of overwriting newer progress. All
 * times are the database's clock, so two servers with skewed clocks agree on
 * whose lease has expired.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import type { JobStatus, JobType, JobView } from "./types.ts";

export type Job<I = unknown, S = unknown, P = unknown, R = unknown> = {
  userId: string;
  id: string;
  type: JobType;
  status: JobStatus;
  idempotencyKey: string;
  input: I;
  state: S;
  progress: P;
  result: R | null;
  error: string;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  claimId: string;
  leaseUntil: string;
  runAfter: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string;
};

type JobRow = {
  user_id: string;
  id: string;
  type: string;
  status: string;
  idempotency_key: string | null;
  input: unknown;
  state: unknown;
  progress: unknown;
  result: unknown;
  error: string;
  attempts: number;
  max_attempts: number;
  cancel_requested: boolean;
  claim_id: string | null;
  lease_until: unknown;
  run_after: unknown;
  created_at: unknown;
  started_at: unknown;
  updated_at: unknown;
  finished_at: unknown;
};

/** A slice's lease was taken over by another runner; it must stop at once. */
export class LostLease extends Error {
  constructor(id: string) {
    super(`Job ${id} is now being run elsewhere`);
    this.name = "LostLease";
  }
}

function iso(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function fromRow(row: JobRow): Job {
  return {
    userId: row.user_id,
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    idempotencyKey: row.idempotency_key ?? "",
    input: json(row.input) ?? {},
    state: json(row.state) ?? {},
    progress: json(row.progress) ?? {},
    result: json(row.result),
    error: row.error ?? "",
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 0,
    cancelRequested: Boolean(row.cancel_requested),
    claimId: row.claim_id ?? "",
    leaseUntil: iso(row.lease_until),
    runAfter: iso(row.run_after),
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    updatedAt: iso(row.updated_at),
    finishedAt: iso(row.finished_at),
  };
}

/** What a browser may see: no claim id, nothing internal to the runner. */
export function toView<P = unknown, R = unknown>(job: Job): JobView<P, R> {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress as P,
    result: job.result as R | null,
    error: job.error,
    attempts: job.attempts,
    cancelRequested: job.cancelRequested,
    running: job.status === "running" && Boolean(job.leaseUntil) && Date.parse(job.leaseUntil) > Date.now(),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

const COLUMNS = `user_id, id, type, status, idempotency_key, input, state, progress, result, error,
  attempts, max_attempts, cancel_requested, claim_id, lease_until, run_after,
  created_at, started_at, updated_at, finished_at`;

/**
 * Create a job, or return the active one with the same idempotency key.
 *
 * The partial unique index makes this race-free: two "start" clicks that land
 * together create one job, and both callers get it back.
 */
export async function createJob(
  sql: Sql,
  userId: string,
  spec: { type: JobType; input: unknown; idempotencyKey?: string; maxAttempts?: number; progress?: unknown; id?: string },
): Promise<{ job: Job; created: boolean }> {
  const id = spec.id || randomUUID();
  const key = spec.idempotencyKey?.trim().slice(0, 200) || null;
  const rows = await sql.query<JobRow>(
    `insert into jobs (user_id, id, type, idempotency_key, input, progress, max_attempts)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     on conflict do nothing
     returning ${COLUMNS}`,
    [userId, id, spec.type, key, JSON.stringify(spec.input ?? {}), JSON.stringify(spec.progress ?? {}), spec.maxAttempts ?? 5],
  );
  if (rows[0]) return { job: fromRow(rows[0]), created: true };
  const existing = key
    ? await sql.query<JobRow>(
        `select ${COLUMNS} from jobs
          where user_id = $1 and idempotency_key = $2 and status in ('queued', 'running')
          order by created_at desc limit 1`,
        [userId, key],
      )
    : await sql.query<JobRow>(`select ${COLUMNS} from jobs where user_id = $1 and id = $2`, [userId, id]);
  if (!existing[0]) throw new Error("Could not create the job.");
  return { job: fromRow(existing[0]), created: false };
}

export async function loadJob(sql: Sql, userId: string, id: string): Promise<Job | null> {
  const rows = await sql.query<JobRow>(`select ${COLUMNS} from jobs where user_id = $1 and id = $2`, [userId, id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** The newest job of a type that has not finished, if any. */
export async function activeJob(sql: Sql, userId: string, type: JobType): Promise<Job | null> {
  const rows = await sql.query<JobRow>(
    `select ${COLUMNS} from jobs
      where user_id = $1 and type = $2 and status in ('queued', 'running')
      order by created_at desc limit 1`,
    [userId, type],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function recentJobs(sql: Sql, userId: string, type: JobType | null, limit = 10): Promise<Job[]> {
  const rows = await sql.query<JobRow>(
    `select ${COLUMNS} from jobs
      where user_id = $1 and ($2::text is null or type = $2)
      order by created_at desc limit $3`,
    [userId, type, Math.max(1, Math.min(50, limit))],
  );
  return rows.map(fromRow);
}

/**
 * Claim the next runnable job (optionally one user's, or one job).
 *
 * Runnable: queued or running, due, and with no live lease. A job found
 * `running` with an expired lease was abandoned by a slice that died, so the
 * claim counts that as a failed attempt — a job that kills its runner every
 * time stops at `max_attempts` instead of looping for ever.
 */
export async function claimJob(
  sql: Sql,
  options: { userId?: string; jobId?: string; types?: readonly JobType[]; leaseMs: number },
): Promise<Job | null> {
  const claim = randomUUID();
  const rows = await sql.query<JobRow>(
    `update jobs set
        status = 'running',
        claim_id = $1,
        lease_until = now() + ($2::text || ' milliseconds')::interval,
        started_at = coalesce(started_at, now()),
        attempts = attempts + case when status = 'running' then 1 else 0 end,
        updated_at = now()
      where (user_id, id) = (
        select user_id, id from jobs
         where status in ('queued', 'running')
           and run_after <= now()
           and (lease_until is null or lease_until < now())
           and ($3::text is null or user_id = $3)
           and ($4::text is null or id = $4)
           and ($5::text[] is null or type = any($5::text[]))
         order by run_after, created_at
         limit 1
         for update skip locked
      )
      returning ${COLUMNS}`,
    [claim, String(Math.max(1000, Math.round(options.leaseMs))), options.userId ?? null, options.jobId ?? null, options.types ? [...options.types] : null],
  );
  const job = rows[0] ? fromRow(rows[0]) : null;
  if (!job) return null;
  // An abandoned job that has used up its attempts is failed, not run again.
  if (job.attempts >= job.maxAttempts) {
    await sql.query(
      `update jobs set status = 'failed', claim_id = null, lease_until = null, finished_at = now(), updated_at = now(),
              error = case when error = '' then 'Stopped after repeated interruptions.' else error end
        where user_id = $1 and id = $2 and claim_id = $3`,
      [job.userId, job.id, claim],
    );
    return claimJob(sql, options);
  }
  return job;
}

/**
 * Save a checkpoint and extend the lease. Returns whether a cancel has been
 * requested since; throws `LostLease` if this slice no longer holds the job.
 */
export async function checkpoint(sql: Sql, job: Job, update: { state: unknown; progress: unknown; leaseMs: number }): Promise<{ cancelRequested: boolean }> {
  const rows = await sql.query<{ cancel_requested: boolean }>(
    `update jobs set state = $4::jsonb, progress = $5::jsonb, updated_at = now(),
            lease_until = now() + ($6::text || ' milliseconds')::interval
      where user_id = $1 and id = $2 and claim_id = $3 and status = 'running'
      returning cancel_requested`,
    [job.userId, job.id, job.claimId, JSON.stringify(update.state ?? {}), JSON.stringify(update.progress ?? {}), String(Math.round(update.leaseMs))],
  );
  if (!rows[0]) throw new LostLease(job.id);
  return { cancelRequested: Boolean(rows[0].cancel_requested) };
}

/** End this slice with work left: back to the queue, lease released. */
export async function release(sql: Sql, job: Job, update: { state: unknown; progress: unknown; delayMs?: number }): Promise<void> {
  const rows = await sql.query(
    `update jobs set status = 'queued', claim_id = null, lease_until = null, state = $4::jsonb, progress = $5::jsonb,
            run_after = now() + ($6::text || ' milliseconds')::interval, updated_at = now()
      where user_id = $1 and id = $2 and claim_id = $3 and status = 'running'
      returning id`,
    [job.userId, job.id, job.claimId, JSON.stringify(update.state ?? {}), JSON.stringify(update.progress ?? {}), String(Math.max(0, update.delayMs ?? 0))],
  );
  if (!rows[0]) throw new LostLease(job.id);
}

export async function finish(
  sql: Sql,
  job: Job,
  update: { status: "done" | "cancelled" | "failed"; state: unknown; progress: unknown; result?: unknown; error?: string },
): Promise<void> {
  const rows = await sql.query(
    `update jobs set status = $4, claim_id = null, lease_until = null, state = $5::jsonb, progress = $6::jsonb,
            result = $7::jsonb, error = $8, finished_at = now(), updated_at = now()
      where user_id = $1 and id = $2 and claim_id = $3 and status = 'running'
      returning id`,
    [
      job.userId,
      job.id,
      job.claimId,
      update.status,
      JSON.stringify(update.state ?? {}),
      JSON.stringify(update.progress ?? {}),
      update.result === undefined ? null : JSON.stringify(update.result),
      (update.error ?? "").slice(0, 1000),
    ],
  );
  if (!rows[0]) throw new LostLease(job.id);
}

/**
 * A slice threw. Count the attempt; retry later with backoff, or fail the job
 * for good once its attempts are used up.
 */
export async function failAttempt(sql: Sql, job: Job, error: string, retryInMs: number): Promise<"retry" | "failed"> {
  const rows = await sql.query<{ status: string }>(
    `update jobs set
        attempts = attempts + 1,
        error = $4,
        claim_id = null,
        lease_until = null,
        status = case when attempts + 1 >= max_attempts then 'failed' else 'queued' end,
        finished_at = case when attempts + 1 >= max_attempts then now() else null end,
        run_after = now() + ($5::text || ' milliseconds')::interval,
        updated_at = now()
      where user_id = $1 and id = $2 and claim_id = $3
      returning status`,
    [job.userId, job.id, job.claimId, error.slice(0, 1000), String(Math.max(0, Math.round(retryInMs)))],
  );
  return rows[0]?.status === "failed" ? "failed" : "retry";
}

/** Ask a job to stop. It stops at its next checkpoint, tidily. */
export async function requestCancel(sql: Sql, userId: string, id: string): Promise<boolean> {
  const rows = await sql.query(
    `update jobs set cancel_requested = true, run_after = least(run_after, now()), updated_at = now()
      where user_id = $1 and id = $2 and status in ('queued', 'running')
      returning id`,
    [userId, id],
  );
  return rows.length > 0;
}

/** Finished jobs older than `days`. Active jobs are never touched. */
export async function pruneJobs(sql: Sql, days: number): Promise<number> {
  const rows = await sql.query(
    `delete from jobs where status in ('done', 'failed', 'cancelled')
        and coalesce(finished_at, updated_at) < now() - ($1::text || ' days')::interval
      returning id`,
    [String(Math.max(1, Math.round(days)))],
  );
  return rows.length;
}

/** Users with Gmail connected, for the scheduled reply poll. */
export async function usersWithGmail(sql: Sql): Promise<string[]> {
  const rows = await sql.query<{ user_id: string }>(`select user_id from gmail_accounts where status = 'connected'`).catch(() => []);
  return rows.map((row) => row.user_id);
}
