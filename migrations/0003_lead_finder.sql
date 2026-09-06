-- Phase 1 finder fields. Local-first still stores these on the device; this
-- keeps them when the sheet syncs so later outreach phases have a stable id,
-- address, date found and listing status.

alter table leads add column if not exists address text not null default '';
alter table leads add column if not exists place_id text not null default '';
alter table leads add column if not exists found_at text not null default '';
alter table leads add column if not exists business_status text not null default '';
