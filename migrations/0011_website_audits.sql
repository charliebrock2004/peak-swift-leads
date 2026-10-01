-- Phase C — website opportunity audits.
--
-- Additive only: one new table. Safe to apply while the previous release is
-- serving; re-running is a no-op.
--
-- One row per audit run, kept as history so "measured 42 in September, 71 in
-- November" stays true and an old audit is visibly old. `findings` is the list
-- of measured findings (see src/lib/audit/findings.ts), each with its own
-- value, source, URL, date and confidence; `facts` is what the homepage check
-- read; `pagespeed` is Google's raw-but-parsed measurement, or null when it
-- could not be run.
create table if not exists website_audits (
  user_id      text        not null,
  id           text        not null,
  lead_id      text        not null,
  url          text        not null,
  final_url    text        not null default '',
  status       text        not null check (status in ('ok', 'unreachable', 'error')),
  http_status  integer     not null default 0,
  response_ms  integer,
  page_bytes   integer,
  redirects    jsonb       not null default '[]'::jsonb,
  facts        jsonb       not null default '{}'::jsonb,
  findings     jsonb       not null default '[]'::jsonb,
  pagespeed    jsonb,
  pagespeed_error text     not null default '',
  opportunity  text        not null default 'none' check (opportunity in ('strong', 'moderate', 'low', 'none', 'unmeasured')),
  points       integer     not null default 0,
  -- The 3–5 findings worth leading with, small enough to load with every
  -- business in a list (the full set stays in `findings`).
  key_findings jsonb       not null default '[]'::jsonb,
  error        text        not null default '',
  started_at   timestamptz not null default now(),
  finished_at  timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists website_audits_latest_idx on website_audits (user_id, lead_id, finished_at desc);
