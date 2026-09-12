-- Phase 5 — named campaigns.
--
-- A campaign is a named piece of work that chooses what to look for and keeps
-- the score. It is not a second outreach pipeline: discovery, qualification,
-- eligibility, duplicate protection and sending are all the existing tables and
-- the existing code, and nothing here grants a campaign its own permission to
-- send.
--
-- Additive only. Two new tables and one new column with a default, so no
-- existing row is rewritten, no existing column changes type, and re-running is
-- a no-op. Nothing is dropped, truncated or reset.
--
-- Progress counters are deliberately NOT stored. Prospects reached, emails
-- sent, replies received and jobs won are all derivable from `leads` and
-- `outreach_emails`, and a stored copy would be a second version of the truth
-- that drifts. The campaign row holds intent; the funnel is always computed.

create table if not exists campaigns (
  user_id          text        not null,
  id               text        not null,
  name             text        not null default '',
  -- DRAFT | ACTIVE | PAUSED | COMPLETED | ARCHIVED
  status           text        not null default 'DRAFT',
  -- Comma-separated, the same shape the search inputs already accept.
  locations        text        not null default '',
  trades           text        not null default '',
  target_prospects integer     not null default 50,
  -- Works with the account's daily limit, never around it: the smaller of the
  -- two wins at send time, which is enforced in code, not here.
  daily_target     integer     not null default 10,
  batch_size       integer     not null default 5,
  -- prepare | send. Creating a campaign never starts sending.
  send_mode        text        not null default 'prepare',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists campaigns_user_status_idx
  on campaigns (user_id, status, updated_at desc);

-- Which prospects belong to which campaign.
--
-- A join table rather than a column on `leads`, because one business can
-- legitimately be worked by two campaigns over time. The primary key is what
-- makes adding a prospect idempotent: re-running discovery for a campaign
-- re-adds nothing and, crucially, cannot reset any outreach state, because this
-- table holds membership only and never status.
create table if not exists campaign_prospects (
  user_id     text        not null,
  campaign_id text        not null,
  lead_id     text        not null,
  added_at    timestamptz not null default now(),
  primary key (user_id, campaign_id, lead_id)
);

create index if not exists campaign_prospects_campaign_idx
  on campaign_prospects (user_id, campaign_id);

create index if not exists campaign_prospects_lead_idx
  on campaign_prospects (user_id, lead_id);

-- Which campaign an email was sent under.
--
-- Empty for every email written before campaigns existed, and for any email
-- written outside one. It is a label on the outreach event, not a second route
-- to sending: the unique index that stops a business being emailed twice is
-- deliberately NOT scoped by campaign, so global duplicate protection keeps
-- applying across campaigns exactly as it did before.
alter table outreach_emails
  add column if not exists campaign_id text not null default '';

create index if not exists outreach_emails_campaign_idx
  on outreach_emails (user_id, campaign_id);
