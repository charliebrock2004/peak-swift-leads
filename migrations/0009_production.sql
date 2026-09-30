-- Phase 6 — production hardening.
--
-- Additive only, and safe to apply while the previous release is still
-- serving: every new column has a default, every new table is new, and the
-- invariants below are added NOT VALID — Postgres enforces them on every row
-- written from now on without re-checking (or ever rejecting) a row that
-- already exists. Nothing is dropped, renamed, rewritten or backfilled.
-- Re-running is a no-op.

-- ── The studio's own details ─────────────────────────────────────────────────
-- Who the emails come from, what they offer and how they sign off. Used to be
-- hard-coded ("Charlie", "PeakSwiftStudio", "around Perthshire") in templates,
-- the prompt and the quality gate. Empty fields fall back to those defaults.
create table if not exists business_profile (
  user_id       text        not null primary key,
  business_name text        not null default '',
  sender_name   text        not null default '',
  sender_email  text        not null default '',
  website       text        not null default '',
  services      text        not null default '',
  location      text        not null default '',
  areas_served  text        not null default '',
  tone          text        not null default '',
  cta           text        not null default '',
  portfolio_url text        not null default '',
  signature     text        not null default '',
  opt_out_line  text        not null default '',
  updated_at    timestamptz not null default now()
);

-- ── Budgets for paid calls ───────────────────────────────────────────────────
-- One row per account, per UTC day, per kind of paid call (web search, AI
-- drafts). Incremented with a conditional upsert, so the cap holds under
-- concurrent requests rather than being checked and then exceeded.
create table if not exists usage_counters (
  user_id text    not null,
  day     text    not null,
  kind    text    not null,
  used    integer not null default 0 check (used >= 0),
  primary key (user_id, day, kind)
);

-- ── What discovery actually found, per lead ──────────────────────────────────
-- The verified website and the published email, with the signals behind each,
-- written by the server that found them. Kept off the synced lead row so the
-- sheet on every device stays small; shown wherever a prospect is explained.
create table if not exists lead_evidence (
  user_id    text        not null,
  lead_id    text        not null,
  -- website | email
  kind       text        not null,
  -- JSON, written only by the server.
  data       text        not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, lead_id, kind)
);

-- ── Sending: proof, recovery and reasons ─────────────────────────────────────
alter table outreach_emails add column if not exists rfc822_message_id  text not null default '';
alter table outreach_emails add column if not exists run_id             text not null default '';
-- permanent | transient | auth | rate_limit | uncertain — decides whether and
-- how a failed email may be retried without risking a second copy.
alter table outreach_emails add column if not exists failure_kind       text not null default '';
alter table outreach_emails add column if not exists provider_response  text not null default '';
alter table outreach_emails add column if not exists sending_started_at timestamptz;
alter table outreach_emails add column if not exists personalisation_note text not null default '';

-- ── Replies, as a sales inbox ────────────────────────────────────────────────
alter table outreach_emails add column if not exists reply_from       text not null default '';
alter table outreach_emails add column if not exists reply_subject    text not null default '';
alter table outreach_emails add column if not exists reply_snippet    text not null default '';
-- human | auto_reply | bounce | unsubscribe
alter table outreach_emails add column if not exists reply_kind       text not null default '';
-- new | interested | needs_follow_up | booked | won | not_interested
alter table outreach_emails add column if not exists reply_stage      text not null default '';
alter table outreach_emails add column if not exists reply_suggestion text not null default '';
alter table outreach_emails add column if not exists bounced_at       timestamptz;
alter table outreach_emails add column if not exists auto_reply_at    timestamptz;

create index if not exists outreach_emails_run_idx
  on outreach_emails (user_id, run_id);
create index if not exists outreach_emails_sending_idx
  on outreach_emails (user_id, sending_started_at) where status = 'sending';

-- ── Runs you can open later ──────────────────────────────────────────────────
-- A run row is now created when the run starts and updated as it goes, so a
-- run that was interrupted still has a record. Rows written before this
-- migration read as finished runs, which is what they were.
alter table outreach_runs add column if not exists status      text        not null default 'done';
alter table outreach_runs add column if not exists phase       text        not null default '';
alter table outreach_runs add column if not exists campaign_id text        not null default '';
alter table outreach_runs add column if not exists target      integer     not null default 0;
alter table outreach_runs add column if not exists daily_limit integer     not null default 0;
-- JSON: the reconciling discovery funnel, written by the run.
alter table outreach_runs add column if not exists funnel      text        not null default '';
-- JSON array: which leads this run found, so "View run" can list them.
alter table outreach_runs add column if not exists lead_ids    text        not null default '';
alter table outreach_runs add column if not exists updated_at  timestamptz not null default now();

-- ── Settings ─────────────────────────────────────────────────────────────────
alter table outreach_settings add column if not exists test_recipient      text    not null default '';
alter table outreach_settings add column if not exists search_daily_budget integer not null default 300;
alter table outreach_settings add column if not exists ai_daily_budget     integer not null default 150;

alter table gmail_accounts add column if not exists last_send_at   timestamptz;
alter table gmail_accounts add column if not exists last_health    text not null default '';
alter table gmail_accounts add column if not exists last_health_at timestamptz;

-- ── Invariants the database enforces, not just the code ─────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_emails_status_known') then
    alter table outreach_emails add constraint outreach_emails_status_known
      check (status in ('draft', 'approved', 'queued', 'sending', 'sent', 'failed', 'replied',
                        'unsubscribed', 'skipped', 'bounced', 'test_sent')) not valid;
  end if;

  -- An email is never recorded as delivered without Gmail's own message id and
  -- the moment it went. This is "never mark sent before Gmail confirmed" as a
  -- constraint: no code path can write a sent row Gmail did not acknowledge.
  if not exists (select 1 from pg_constraint where conname = 'outreach_emails_sent_has_proof') then
    alter table outreach_emails add constraint outreach_emails_sent_has_proof
      check (status not in ('sent', 'replied', 'bounced', 'test_sent')
             or (sent_at is not null and gmail_message_id <> '')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'outreach_emails_kind_known') then
    alter table outreach_emails add constraint outreach_emails_kind_known
      check (kind in ('initial', 'follow-up-1', 'follow-up-2', 'test')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'outreach_emails_reply_stage_known') then
    alter table outreach_emails add constraint outreach_emails_reply_stage_known
      check (reply_stage in ('', 'new', 'interested', 'needs_follow_up', 'booked', 'won', 'not_interested')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'outreach_suppression_lowercase') then
    alter table outreach_suppression add constraint outreach_suppression_lowercase
      check (email = lower(email)) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'outreach_settings_sane_limits') then
    alter table outreach_settings add constraint outreach_settings_sane_limits
      check (daily_limit between 0 and 50 and batch_size between 1 and 50) not valid;
  end if;
end
$$;
