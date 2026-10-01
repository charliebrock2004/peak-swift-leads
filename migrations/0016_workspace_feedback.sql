-- Workspace profile and prospect-quality feedback.
--
-- Additive only. Safe to apply while the previous release is serving (it
-- neither reads nor writes these columns or the new table); re-running is a
-- no-op.

-- ── The workspace profile ─────────────────────────────────────────────────────
-- business_profile already holds who you are and how you write (0009). These
-- say who you sell to: where Find searches, which trades are worth your time,
-- the size of job you take, and whether you email, phone or both. Text, like
-- the rest of the profile: lists are comma-separated, prices are whole pounds.
alter table business_profile add column if not exists target_areas     text not null default '';
alter table business_profile add column if not exists target_trades    text not null default '';
alter table business_profile add column if not exists preferred_trades text not null default '';
alter table business_profile add column if not exists excluded_trades  text not null default '';
alter table business_profile add column if not exists typical_project  text not null default '';
alter table business_profile add column if not exists minimum_project  text not null default '';
alter table business_profile add column if not exists contact_methods  text not null default '';
alter table business_profile add column if not exists examples         text not null default '';
alter table business_profile add column if not exists business_address text not null default '';
-- When the short welcome was finished (or skipped). Null until then.
alter table business_profile add column if not exists onboarded_at     timestamptz;

-- ── Prospect-quality feedback ─────────────────────────────────────────────────
-- What you said about a business Find gave you: good prospect, wrong website,
-- not actually in the trade, … One row per mark, so a business can be both
-- "good prospect" and "wrong website". Read by deterministic rules only —
-- scoring, Find's source ranking, website matching — never an opaque model.
--
-- `source`, `trade` and `town` are copied from the business when it was
-- marked, so the counts by source and by search survive the business being
-- edited or removed.
create table if not exists prospect_feedback (
  user_id    text        not null,
  lead_id    text        not null,
  verdict    text        not null check (verdict in ('good', 'useful', 'bad', 'irrelevant', 'not_in_trade', 'wrong_business', 'duplicate', 'wrong_website', 'good_website', 'wrong_contact')),
  note       text        not null default '',
  source     text        not null default '',
  trade      text        not null default '',
  town       text        not null default '',
  -- For wrong_website: the site that was wrong, so it is never attached again.
  website    text        not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, lead_id, verdict)
);
create index if not exists prospect_feedback_user_idx on prospect_feedback (user_id, verdict);
