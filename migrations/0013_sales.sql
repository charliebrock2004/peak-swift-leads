-- Phases F–H — the sales loop: interactions, tasks and opportunities.
--
-- Additive only: three new tables. Safe to apply while the previous release
-- is serving; re-running is a no-op.
--
-- Deliberately small. This is not a CRM: it is just enough to carry a
-- prospect from first contact to a won (or lost) job, and to remember every
-- conversation on the way.

-- Everything that happened with a business that is not already recorded
-- elsewhere: calls and their outcomes, notes, meetings, quotes, stage
-- changes. Emails, replies, audits and discovery are already rows of their
-- own and are merged into the timeline when it is read, not copied here.
create table if not exists interactions (
  user_id      text        not null,
  id           text        not null,
  lead_id      text        not null,
  type         text        not null check (type in ('call', 'note', 'meeting', 'quote', 'stage_change', 'email', 'reply', 'system')),
  -- For a call: no_answer | interested | not_interested | call_back |
  -- meeting_booked | wrong_person | wrong_number. Free text otherwise.
  outcome      text        not null default '',
  summary      text        not null default '',
  detail       jsonb       not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists interactions_lead_idx on interactions (user_id, lead_id, occurred_at desc);

-- A to-do that moves a prospect through the sale. Not project management.
-- `source_key` makes automatic tasks idempotent: the same call outcome or
-- reply never creates the same task twice.
create table if not exists tasks (
  user_id       text        not null,
  id            text        not null,
  lead_id       text        not null default '',
  type          text        not null check (type in ('CALL', 'REPLY', 'FOLLOW_UP', 'MEETING', 'QUOTE', 'CHECK_BACK', 'REVIEW', 'OTHER')),
  title         text        not null default '',
  contact       text        not null default '',
  due_at        timestamptz,
  priority      text        not null default 'normal' check (priority in ('high', 'normal', 'low')),
  status        text        not null default 'open' check (status in ('open', 'done', 'cancelled')),
  notes         text        not null default '',
  source        text        not null default 'user',
  source_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  primary key (user_id, id)
);
create unique index if not exists tasks_source_key_idx on tasks (user_id, source_key) where source_key is not null;
create index if not exists tasks_open_idx on tasks (user_id, status, due_at);
create index if not exists tasks_lead_idx on tasks (user_id, lead_id);

-- One opportunity per business: where the sale stands and what it is worth.
-- Values are whole pence, so totals never pick up floating-point pennies.
create table if not exists opportunities (
  user_id          text        not null,
  lead_id          text        not null,
  stage            text        not null default 'PROSPECT' check (stage in ('PROSPECT', 'CONTACTED', 'CONVERSATION', 'MEETING', 'QUOTE_SENT', 'WON', 'LOST', 'NURTURE')),
  value_pence      integer     check (value_pence is null or value_pence >= 0),
  expected_close   date,
  quote_date       date,
  won_date         date,
  lost_reason      text        not null default '',
  nurture_date     date,
  notes            text        not null default '',
  stage_changed_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, lead_id)
);
create index if not exists opportunities_stage_idx on opportunities (user_id, stage);
