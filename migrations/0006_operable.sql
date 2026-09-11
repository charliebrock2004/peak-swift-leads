-- Phase 4 — activity log, stored run summaries, and per-lead review decisions.
-- The lead sheet itself is unchanged. Extra sales state lives beside it so a
-- missing column cannot break sync of the existing rows.

create table if not exists activity_events (
  user_id      text        not null,
  id           text        not null,
  at           timestamptz not null default now(),
  event_type   text        not null,
  lead_id      text        not null default '',
  lead_name    text        not null default '',
  result       text        not null default '',
  reason       text        not null default '',
  confidence   integer,
  error        text        not null default '',
  metadata     text        not null default '',
  primary key (user_id, id)
);

create index if not exists activity_events_user_at_idx
  on activity_events (user_id, at desc);

create table if not exists outreach_runs (
  user_id         text        not null,
  id              text        not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  location        text        not null default '',
  business_type   text        not null default '',
  mode            text        not null default 'prepare',
  found           integer     not null default 0,
  qualified       integer     not null default 0,
  hot             integer     not null default 0,
  warm            integer     not null default 0,
  call_count      integer     not null default 0,
  low_count       integer     not null default 0,
  skipped         integer     not null default 0,
  emails_found    integer     not null default 0,
  prepared        integer     not null default 0,
  sent            integer     not null default 0,
  replies         integer     not null default 0,
  errors          integer     not null default 0,
  bottleneck      text        not null default '',
  summary         text        not null default '',
  primary key (user_id, id)
);

create index if not exists outreach_runs_user_started_idx
  on outreach_runs (user_id, started_at desc);

-- Operator decisions on uncertain AI verdicts. Does not replace the lead row.
create table if not exists lead_reviews (
  user_id      text        not null,
  lead_id      text        not null,
  decision     text        not null default 'pending',
  note         text        not null default '',
  decided_at   timestamptz not null default now(),
  primary key (user_id, lead_id)
);
