-- Phase E — background jobs.
--
-- Additive only: one new table. Safe to apply while the previous release is
-- serving; re-running is a no-op.
--
-- A job is work that outlives one request: a Find run (discover → save →
-- verify → enrich → qualify → draft), a batch of audits or Companies House
-- checks, reply polling, retention. Each runs in short slices. A slice claims
-- the job with a lease, does as much as its time budget allows, and writes a
-- checkpoint (`state`) after every unit of work, so a slice killed half-way is
-- resumed by the next one from the last checkpoint — never restarted, never
-- run twice at once.
--
-- `attempts` counts failed or abandoned slices, not slices: a job that keeps
-- crashing stops at `max_attempts` with its error, instead of looping forever.
-- `idempotency_key` makes "start" safe to retry: while a job with the same key
-- is queued or running, starting it again returns that job.
create table if not exists jobs (
  user_id          text        not null,
  id               text        not null,
  type             text        not null check (type in ('find', 'audit_batch', 'company_batch', 'reply_poll', 'retention')),
  status           text        not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  idempotency_key  text,
  input            jsonb       not null default '{}'::jsonb,
  state            jsonb       not null default '{}'::jsonb,
  progress         jsonb       not null default '{}'::jsonb,
  result           jsonb,
  error            text        not null default '',
  attempts         integer     not null default 0,
  max_attempts     integer     not null default 5,
  cancel_requested boolean     not null default false,
  -- Who holds the lease. Every write from a slice names its claim, so a
  -- slice that outlived its lease cannot overwrite the one that took over.
  claim_id         text,
  lease_until      timestamptz,
  run_after        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  primary key (user_id, id)
);

create unique index if not exists jobs_active_key_idx
  on jobs (user_id, idempotency_key)
  where idempotency_key is not null and status in ('queued', 'running');

create index if not exists jobs_runnable_idx
  on jobs (run_after)
  where status in ('queued', 'running');

create index if not exists jobs_user_recent_idx
  on jobs (user_id, created_at desc);
