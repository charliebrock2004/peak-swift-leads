-- Peak Swift Leads — the durable lead sheet.
--
-- The app is local-first: every device keeps a full copy in localStorage and
-- stays usable offline. This table is the shared source of truth those copies
-- reconcile against, so a lead added on the phone shows up on the laptop.
--
-- `user_id` is TEXT because the preview/dev owner id is the literal string
-- 'dev-user' (see src/lib/auth/verify.server.ts). `id` is the client-minted
-- UUID, and the primary key is (user_id, id) so one account can never write
-- over another account's row by guessing an id.
--
-- `updated_at` is set by the SERVER on every write, never by the client: it is
-- the cursor clients page from, so a device with a skewed clock must not be
-- able to poison it.

create table if not exists leads (
  user_id        text        not null,
  id             text        not null,
  business_name  text        not null default '',
  trade          text        not null default '',
  town           text        not null default '',
  phone          text        not null default '',
  email          text        not null default '',
  rating         double precision,
  reviews        integer,
  website        text        not null default '',
  maps_link      text        not null default '',
  website_status text        not null default '',
  demo_url       text        not null default '',
  source         text        not null default '',
  called         text        not null default 'Not Called',
  call_result    text        not null default '',
  -- 'YYYY-MM-DD' as typed, kept as text so no timezone can shift the date.
  follow_up_date text        not null default '',
  notes          text        not null default '',
  -- Soft delete: a tombstone so a delete on one device reaches the others.
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, id)
);

-- The only read path: "everything of mine that changed since my last sync".
create index if not exists leads_user_updated_idx on leads (user_id, updated_at);
