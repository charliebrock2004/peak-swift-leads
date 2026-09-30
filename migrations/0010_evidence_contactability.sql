-- Phase B — where every fact came from, and who may be contacted how.
--
-- Additive only, like 0009: new tables, new columns with defaults, and one
-- backfill that only fills empty columns from data already in the row. Safe to
-- apply while the previous release is serving. Re-running is a no-op.
--
-- The model, in one line:
--   business (leads) → source records → evidence items → derived fields → score
--
-- A `leads` row stays the business. What a source said about it is kept
-- verbatim in `source_records`; each individual fact the product relies on
-- ("company active", "email published on /contact", "not on TPS") is an
-- `evidence_items` row naming its source, reference and date. Derived fields
-- (legal form, call eligibility, the score) are computed from those, never
-- typed in — except where a person overrides them, which is recorded as such.

-- ── Source records ───────────────────────────────────────────────────────────
-- One row per record a source returned, keyed by the same stable id discovery
-- already stores in `leads.place_id` ("ch:SC612222", "osm:node:123").
-- `primary_id` is the place id of the record it was merged into during
-- discovery, so a business saved with place id X owns every record whose id or
-- primary_id is X. `lead_id` is set once a record is tied to a business
-- directly (a Companies House check, a person's confirmation).
create table if not exists source_records (
  user_id    text        not null,
  id         text        not null,
  source     text        not null,
  source_id  text        not null,
  primary_id text        not null default '',
  lead_id    text        not null default '',
  name       text        not null default '',
  url        text        not null default '',
  fields     jsonb       not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists source_records_lead_idx on source_records (user_id, lead_id) where lead_id <> '';
create index if not exists source_records_primary_idx on source_records (user_id, primary_id) where primary_id <> '';

-- ── Evidence items ───────────────────────────────────────────────────────────
-- One observed fact. `superseded_at` retires a fact when a newer observation of
-- the same kind replaces it; history is kept rather than overwritten.
create table if not exists evidence_items (
  user_id       text        not null,
  id            text        not null,
  lead_id       text        not null,
  kind          text        not null,
  value         text        not null default '',
  label         text        not null default '',
  source        text        not null,
  source_ref    text        not null default '',
  source_url    text        not null default '',
  confidence    text        not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  observed_at   timestamptz not null default now(),
  detail        jsonb       not null default '{}'::jsonb,
  superseded_at timestamptz,
  created_at    timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists evidence_items_current_idx on evidence_items (user_id, lead_id, kind) where superseded_at is null;

-- ── The business's registered identity (server-owned) ────────────────────────
-- Written only by the server (Companies House checks, a person's override).
-- The browser's lead sync never reads or writes these columns.
alter table leads add column if not exists company_number     text not null default '';
alter table leads add column if not exists company_type       text not null default '';
alter table leads add column if not exists company_status     text not null default '';
alter table leads add column if not exists company_checked_at text not null default '';
-- A person's decision on the legal form, with their reason. Wins over the rules.
alter table leads add column if not exists legal_form_override text not null default ''
  check (legal_form_override in ('', 'CORPORATE', 'INDIVIDUAL', 'UNKNOWN', 'REVIEW_REQUIRED'));
alter table leads add column if not exists legal_form_note    text not null default '';
alter table leads add column if not exists legal_form_set_at  text not null default '';

-- Businesses found through the old Companies House search already carry their
-- company number in `place_id`, and that search only ever returned companies
-- that were active on the day they were found.
update leads
   set company_number = upper(substring(place_id from 4)),
       company_status = case when company_status = '' then 'active' else company_status end,
       company_checked_at = case when company_checked_at = '' then found_at else company_checked_at end
 where place_id like 'ch:%' and company_number = '';

-- ── Phone screening ──────────────────────────────────────────────────────────
-- Screening belongs to a NUMBER, not a business: if a business's number
-- changes, the old screening says nothing about the new one. Numbers are
-- stored in E.164 (+441764123456).
create table if not exists phone_screening (
  user_id     text        not null,
  phone       text        not null,
  tps         text        not null default 'unchecked' check (tps in ('unchecked', 'clear', 'registered')),
  ctps        text        not null default 'unchecked' check (ctps in ('unchecked', 'clear', 'registered')),
  checked_at  timestamptz,
  method      text        not null default '',
  note        text        not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, phone)
);

-- Internal do-not-call list: numbers you must never ring for marketing again,
-- whatever TPS says — an objection on a call, a request, or your own choice.
create table if not exists call_suppression (
  user_id    text        not null,
  phone      text        not null,
  reason     text        not null default '',
  source     text        not null default 'internal' check (source in ('internal', 'objection')),
  lead_id    text        not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, phone)
);

-- ── Email verification (optional provider, only at send-ready) ────────────────
create table if not exists email_verifications (
  user_id    text        not null,
  email      text        not null,
  result     text        not null check (result in ('valid', 'invalid', 'risky', 'catch_all', 'unknown')),
  provider   text        not null default '',
  detail     text        not null default '',
  checked_at timestamptz not null default now(),
  primary key (user_id, email)
);

-- ── Entity resolution overrides ──────────────────────────────────────────────
-- A person's ruling that two businesses are, or are not, the same. `a` < `b`.
create table if not exists entity_overrides (
  user_id    text        not null,
  a          text        not null,
  b          text        not null,
  decision   text        not null check (decision in ('same', 'different')),
  note       text        not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, a, b),
  check (a < b)
);

-- ── Contact rules (configurable product rules; see legal-form.ts) ────────────
alter table outreach_settings add column if not exists contact_rules jsonb not null default '{}'::jsonb;
