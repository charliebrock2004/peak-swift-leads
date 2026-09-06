-- Phase 3 — outreach: Gmail connection, templates, the send queue and history,
-- and a permanent suppression list.
--
-- The lead sheet is NOT changed. `outreach_status`, `unsubscribed` and
-- `last_emailed_at` already exist on `leads` (0004) and stay the lead's own
-- summary of where outreach has got to; the per-email detail lives here, so a
-- lead row never has to carry a history.
--
-- Everything is keyed by `user_id` first, matching `leads`, so one account can
-- never read or write another's outreach.

-- The connected Gmail account. Tokens are server-only: nothing in this table is
-- ever returned to the browser except `email` and `status`.
create table if not exists gmail_accounts (
  user_id       text        not null primary key,
  email         text        not null default '',
  access_token  text        not null default '',
  refresh_token text        not null default '',
  -- When the access token dies. Refreshed server-side well before this.
  expires_at    timestamptz,
  scope         text        not null default '',
  -- connected | needs_attention | disconnected
  status        text        not null default 'disconnected',
  last_error    text        not null default '',
  -- Gmail history id, so reply polling only asks for what is new.
  history_id    text        not null default '',
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Sending controls. One row per account; conservative defaults on purpose.
create table if not exists outreach_settings (
  user_id          text        not null primary key,
  daily_limit      integer     not null default 30,
  batch_size       integer     not null default 5,
  delay_seconds    integer     not null default 45,
  follow_ups_on    boolean     not null default false,
  follow_up_1_days integer     not null default 4,
  follow_up_2_days integer     not null default 7,
  max_follow_ups   integer     not null default 2,
  auto_send        boolean     not null default false,
  -- Low-opportunity leads are only ever offered when this is explicitly on.
  include_low      boolean     not null default false,
  -- "AI Personalised" or a template id.
  default_mode     text        not null default 'ai',
  updated_at       timestamptz not null default now()
);

create table if not exists outreach_templates (
  user_id    text        not null,
  id         text        not null,
  name       text        not null default '',
  -- no-website | improvement | general | follow-up-1 | follow-up-2
  kind       text        not null default 'general',
  subject    text        not null default '',
  body       text        not null default '',
  signature  text        not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- One row per email, from the moment it is generated to the moment it is
-- replied to. The queue and the history are the same table: an email's status
-- is where it has got to, so nothing can be sent twice by living in two places.
create table if not exists outreach_emails (
  user_id          text        not null,
  id               text        not null,
  lead_id          text        not null,
  -- Denormalised so history survives a deleted lead and reads without a join.
  business_name    text        not null default '',
  recipient        text        not null default '',
  subject          text        not null default '',
  body             text        not null default '',
  -- draft | approved | queued | sending | sent | failed | replied | unsubscribed | skipped
  status           text        not null default 'draft',
  -- initial | follow-up-1 | follow-up-2
  kind             text        not null default 'initial',
  -- ai | template:<id> | manual
  generated_by     text        not null default '',
  sending_account  text        not null default '',
  gmail_message_id text        not null default '',
  gmail_thread_id  text        not null default '',
  error            text        not null default '',
  attempts         integer     not null default 0,
  approved_at      timestamptz,
  sent_at          timestamptz,
  replied_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists outreach_emails_status_idx on outreach_emails (user_id, status);
create index if not exists outreach_emails_lead_idx   on outreach_emails (user_id, lead_id);
create index if not exists outreach_emails_sent_idx   on outreach_emails (user_id, sent_at);
create index if not exists outreach_emails_thread_idx on outreach_emails (user_id, gmail_thread_id);

-- Duplicate protection, enforced by the database as well as in code.
--
-- One live email of each kind per recipient. "Live" excludes draft, failed and
-- skipped, so a failed send can be retried and an unapproved draft replaced,
-- but a business that has been sent an initial email can never be sent another.
create unique index if not exists outreach_emails_one_live_per_recipient_idx
  on outreach_emails (user_id, lower(recipient), kind)
  where status in ('approved', 'queued', 'sending', 'sent', 'replied');

-- Permanent suppression. Separate from `leads.unsubscribed` on purpose: a
-- suppression must outlive the lead row it came from, so deleting and
-- re-importing a business cannot resurrect it as a valid target.
create table if not exists outreach_suppression (
  user_id       text        not null,
  -- Always lowercased before insert.
  email         text        not null,
  reason        text        not null default '',
  lead_id       text        not null default '',
  business_name text        not null default '',
  created_at    timestamptz not null default now(),
  primary key (user_id, email)
);

-- The daily counter is derived from sent_at rather than stored, so it can never
-- drift from what was actually sent. This index is what makes that cheap.
create index if not exists outreach_emails_sent_day_idx
  on outreach_emails (user_id, sent_at)
  where status in ('sent', 'replied');
