-- North-star metrics — minutes of your time per conversation and per customer.
--
-- Additive only: one new table. Safe to apply while the previous release is
-- serving; re-running is a no-op.
--
-- Seconds of measured time per account, per UTC day, per kind:
--   app  — the app was open, visible, and being used (input in the last minute)
--   call — from tapping Call to logging what happened, as you confirmed it
-- Totals, not a trail: nothing records which screen or when within the day.
create table if not exists time_log (
  user_id  text    not null,
  day      date    not null,
  kind     text    not null check (kind in ('app', 'call')),
  seconds  integer not null default 0 check (seconds >= 0),
  primary key (user_id, day, kind)
);
