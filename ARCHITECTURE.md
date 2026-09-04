# Architecture notes

Shared context for anyone — or any AI — picking this repo up. The code is the
source of truth; this file explains the decisions the code cannot state itself.

## What this app is for

Finding local businesses without a proper website and turning them into paying
website clients:

```
FIND → QUALIFY → CALL → RECORD THE OUTCOME → FOLLOW UP → DEMO → WIN
```

Every feature should answer "does this help win a website customer faster?".
It is deliberately **not** a CRM.

## Find leads (live web research)

`src/lib/research.ts` is a **server-only** `createServerFn`. It calls the xAI
Responses API with `grok-4.5` and `web_search`, then verifies candidate websites
with a live fetch before scoring HOT / WARM / COLD.

The production copy used to call `grok-4.20-0309-non-reasoning` with a 55s abort
and treated unverified independent URLs as Proper Website. Both of those made
Crieff joiners unreliable: searches timed out, and dead domains looked like they
already had a site. Current rules:

- `XAI_API_KEY` is read only on the server. A missing key is an explicit error,
  not "no leads found".
- Unconfirmed independent URLs are **Unclear**, never Proper Website.
- Empty website is **not** "No Website Found".
- The Vercel function is given `maxDuration: 300` so a real search can finish.

## The data layer

### How it used to be

Leads lived only in `localStorage` (zustand `persist`). The repo also carried
`pg`, `kysely` and `better-auth` — Grok App Builder template scaffolding that
nothing imported. There was no database, and `.grok/app-env.json` had
`deploy.database: false`, so none was provisioned on deploy either. A lead
recorded on the phone did not exist on the laptop, and Safari's storage eviction
could take the lot.

### How it is now

**Local-first with server sync.** Unchanged: the browser holds a full copy and
the app works offline. Added: that copy reconciles with a Postgres table scoped
to the signed-in owner.

| Piece | File |
| --- | --- |
| Reconciliation rules (pure, unit-tested) | `src/lib/leads-sync.ts` |
| Server function: push changes, pull deltas | `src/lib/leads-server.ts` |
| Row ↔ `Lead` mapping | `src/lib/leads-row.ts` |
| Failure translation for the client | `src/lib/leads-sync-client.ts` |
| Store, dirty tracking, debounced push | `src/store/leads-store.ts` |
| When to sync (open / focus / online) | `src/lib/use-lead-sync.ts` |
| Schema | `migrations/0002_leads.sql` |

Key decisions:

- **The server stamps `updated_at`, not the client.** It is the cursor devices
  page from, so a phone with a wrong clock must not be able to skip rows. The
  cursor is handed back five seconds behind `now()`, and the pull uses `>=`, so
  a row committed moments after a read is re-read rather than lost. Merges are
  idempotent, so overlap is free.
- **Primary key `(user_id, id)`.** A client cannot reach another account's row by
  guessing its id.
- **Deletes are tombstones.** Otherwise a delete on one device is silently undone
  by the next pull from another. Pruned after 60 days.
- **An unpushed local edit always beats an incoming copy.** The pull may have
  been served before this device's change arrived.
- **Failure is a value, not an exception.** Signed out, offline, or no database
  all leave the app fully working and the header badge honest. This is why the
  app does not gate itself behind a sign-in screen.

### Identity

Auth stays "off" in `.grok/app-env.json`, which is what the workspace and the
Grok preview use: server-side that resolves the shared dev owner, so sync is
testable locally against the embedded database.

Deployed, the platform sets `VITE_AUTH_ENABLED=true` itself and the Grok gate
injects a verified identity header, which `better-auth` turns into a real
session inside `auth.api.getSession` — **no sign-in screen is needed, and none is
built**. If the app is ever deployed somewhere without that gate, signed-out
visitors simply get the local-only mode described above rather than an error.

### Two production bugs found by building, not by reading

Both were in template code that nothing had exercised until leads needed a
database. Kept here because they are easy to reintroduce:

1. **Unhandled rejections killed the server.** `src/lib/db.ts` re-threw from a
   fire-and-forget bootstrap `.catch`, and `src/lib/auth/server.ts` used
   `void ensureDbReady()`. A promise nobody awaits that rejects takes down the
   whole Node process — every request, not just database ones.
2. **PGLite must not run in a production build.** Its WASM data file is not
   carried into the bundled Vercel function, so it threw on load. Even if it
   loaded, each serverless instance would get its own empty in-memory database
   and silently drop every write. `dbSource` is now `"none"` for a production
   build with no `DATABASE_URL`: a clear failure beats a database that forgets.

## Product decisions

- **One tap records a whole call.** The six outcome chips on a lead card set
  called status, result and a sensible follow-up date together
  (`callOutcomePatch` in `src/lib/leads.ts`). Three dropdowns per lead was the
  wrong shape for someone standing outside a job.
- **A follow-up is due whenever its date has arrived and the lead is still
  open** — not only callbacks. "Interested, send the demo Thursday" is exactly
  the one that must not slip.
- **Filters fold away on a phone.** Six selects between you and the next call is
  clutter; they stay open on a laptop where there is room.
- **No auto-seeded sample leads.** A fresh device seeding fourteen examples would
  push them straight into the real account. Examples are now one explicit tap in
  the empty state.

## Groundwork, not yet built

`Lead` carries `email` and `demoUrl`, both stored, editable, importable and
exported. They are the hooks for demo links and email outreach later. Nothing
else about outreach is built, on purpose.

## Testing

- `npm run test:app` — the app's own unit tests (leads, sync, CSV import).
- `npm test` — those, then the platform template's script tests. Several of the
  latter fail in a plain checkout because they read `.grok/skills/**`, which
  exists only inside the Grok sandbox. That is pre-existing and unrelated to the
  app.
- Browser QA is done by driving the real app in Chromium against both the dev
  server and the built output — a passing build is not evidence that a page
  renders.
