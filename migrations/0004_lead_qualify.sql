-- Phase 2 website quality + public email discovery.
-- Outreach columns exist so Phase 3 can add sending later; they stay empty.

alter table leads add column if not exists website_quality text not null default '';
alter table leads add column if not exists website_score integer;
alter table leads add column if not exists website_analysis text not null default '';
alter table leads add column if not exists website_checked_at text not null default '';
alter table leads add column if not exists email_source text not null default '';
alter table leads add column if not exists email_confidence text not null default '';
alter table leads add column if not exists email_found_at text not null default '';
alter table leads add column if not exists opportunity_score integer;
alter table leads add column if not exists outreach_status text not null default '';
alter table leads add column if not exists unsubscribed text not null default '';
alter table leads add column if not exists last_emailed_at text not null default '';
