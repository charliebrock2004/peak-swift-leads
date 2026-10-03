-- Search coverage memory: which towns have been searched for which trades,
-- what each search found, and which are worked out for now.
--
-- Additive only. Safe to apply while the previous release is serving (it
-- neither reads nor writes this table); re-running is a no-op.
--
-- Find used to choose the same first towns of a region on every run, so a
-- second run re-searched the businesses the first had already saved and
-- reported "0 new". With this, each run starts with towns never searched for
-- that trade, then the least recently searched, and rests a town whose last
-- search returned nothing new (exhausted_until) instead of searching it again.
-- `searches` also rotates the search words, so a repeat asks different ones.
create table if not exists search_coverage (
  user_id          text        not null,
  -- Folded town and trade ("bridge of earn", "joiner"): the keys a plan looks up.
  area_key         text        not null,
  trade_key        text        not null,
  -- As last written, for showing to a person.
  area             text        not null default '',
  trade            text        not null default '',
  searches         integer     not null default 0,
  last_searched_at timestamptz,
  -- Totals over every search, and the last search on its own.
  listings         integer     not null default 0,
  new_found        integer     not null default 0,
  last_listings    integer     not null default 0,
  last_new         integer     not null default 0,
  -- The last search found nothing new: leave this town alone until then.
  exhausted_until  timestamptz,
  primary key (user_id, area_key, trade_key)
);
create index if not exists search_coverage_trade_idx on search_coverage (user_id, trade_key);
