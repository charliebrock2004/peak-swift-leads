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

## Phase 1 — lead finder

`src/lib/osm-discover.ts` + `src/lib/research.ts` discover real businesses from
**public sources with no API key**:

1. **Companies House** public search JSON/HTML — UK trades (joiners, builders,
   plumbers, electricians, mechanics, …)
2. **OpenStreetMap** via Photon, Nominatim and (last resort) Overpass — shops
   and hospitality that actually appear on the map
3. **postcodes.io / Open-Meteo / Photon** — geocode the town

Google Places and xAI are **not** used. Do not invent businesses, phones,
ratings or websites. Ratings and review counts are only stored when a source
provides them (these free sources almost never do).

### Website traffic lights

| Signal | Means | When |
| --- | --- | --- |
| GREEN — Has website | Independent site that responded | OSM/listing URL, live fetch |
| YELLOW — Needs work | Social, directory, or thin/template site | Facebook/Yell/etc, or a live but basic page |
| RED — No website | Listing was inspected and had no site | OSM tags checked, no website |
| Unclear | We do not know | Companies House has no website field |

Do **not** mark Companies House-only rows as “No website”. CH never publishes a
website. If the same company is later found on OSM with no website tag, that
**is** evidence for red.

`websiteSignal()` maps the detailed `WebsiteStatus` onto those four values.
Later phases can replace the rules with a quality scorer without changing the
lead sheet.

### After search

New businesses are added to the existing lead sheet. Duplicates (place id,
phone, maps URL, name+town) are skipped. The sheet filters for All websites /
No website / Needs work / Has website.

### Time budget

Vercel Hobby functions die around 10 seconds. Discovery + website inspect must
stay inside that. Asking for 50–100 results is allowed; the search may return
fewer if a source is slow.

## Later phases (not built)

Phase 2 (website quality, public email, opportunity) is built. Do not add UI
for these until asked:

1. AI lead analysis / personalised email generation
2. Email preview, outreach queue, sending limits, send history
3. Replies, follow-up automation
4. Unsubscribe / suppression UI — `unsubscribed` already persists empty
5. Outreach analytics — `outreachStatus`, `lastEmailedAt` already persist empty

Nothing is sent. Phase 3 must stay off until the quality of discovered emails
has been inspected.

## Phase 2 — qualify, don't send

`src/lib/qualify.ts` scores a fetched page 0–100 and extracts emails that actually appear on it.
`src/lib/qualify-server.ts` exposes two user-triggered server functions, **one lead per request**:

- `checkLeadWebsite` — fetch the public homepage (skip Facebook/directories without fetching).
- `findLeadEmail` — parse homepage HTML, then one same-origin contact page if linked.

Bulk Check / Find runs on the **client** two-at-a-time so Vercel Hobby (~10s) is never asked to inspect a whole sheet in one function.

Scoring is conservative: a short but complete site is “Could improve”, never “Poor”. Emails are never invented from a domain.

Phase 3 fields (`outreachStatus`, `unsubscribed`, `lastEmailedAt`) persist empty. **Nothing is sent.**

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
| Schema | `migrations/0002_leads.sql`, `migrations/0003_lead_finder.sql` |

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
testable locally against the embedded database. The lead sheet is **not** gated
behind a sign-in screen anywhere — signed-out visitors get local-only mode.

On `grok.me` the platform sets `VITE_AUTH_ENABLED=true` and injects a verified
identity header, which `better-auth` turns into a session inside
`auth.api.getSession`. No sign-in screen is needed there.

On a **plain Vercel domain** (`peak-swift-leads.vercel.app`) there is no Grok
gate and the broker preview secret is `""`, so `authConfigured` is false.
Identity there is Better Auth **email/password** (`src/lib/auth/email-password.ts`),
mounted at `/api/auth/*`, with `APP_OWNER_EMAIL` as the allowlist. Set
`VITE_AUTH_ENABLED=true` (this is baked at **build** time for the client),
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `APP_OWNER_EMAIL`, then create the
owner account at `/login`. Outreach and cross-device sync require that session;
the sheet on this device does not.

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

## Phase 3 — outreach

Sending real email from a real mailbox to real businesses. The whole subsystem
is built around one idea: **the cost of one bad email is much higher than the
cost of refusing to send it.**

| Piece | File |
| --- | --- |
| Who may be emailed, and why not (pure) | `src/lib/outreach/eligibility.ts` |
| The last gate before Gmail (pure) | `src/lib/outreach/quality.ts` |
| Templates, variables, opt-out (pure) | `src/lib/outreach/templates.ts` |
| AI prompt, parsing, fallback (pure) | `src/lib/outreach/compose.ts` |
| Daily limit, batching (pure) | `src/lib/outreach/limits.ts` |
| When a follow-up is due (pure) | `src/lib/outreach/follow-ups.ts` |
| Dashboard figures (pure) | `src/lib/outreach/dashboard.ts` |
| OAuth URLs and expiry maths (pure) | `src/lib/gmail/oauth.ts` |
| RFC 2822 message building (pure) | `src/lib/gmail/mime.ts` |
| Google HTTP — **server only** | `src/lib/gmail/client.server.ts` |
| Every outreach SQL statement — server only | `src/lib/outreach/store.server.ts` |
| Policy: the server functions | `src/lib/outreach/server.ts` |
| Schema | `migrations/0005_outreach.sql` |
| UI | `src/components/outreach/*`, `src/routes/oauth.gmail.tsx` |

Key decisions:

- **Everything is checked twice.** Once when you approve, once immediately
  before Gmail. Approval can be days old, and in between a lead can reply,
  unsubscribe, or be marked Not Interested after a phone call.
- **The server decides who may be emailed**, from its own lead row. A client can
  ask to email lead X; it cannot assert that lead X is eligible. The sheet is
  local-first and therefore not trustworthy as an authorisation input.
- **Duplicate protection is a database constraint, not just code.** A partial
  unique index on `(user_id, lower(recipient), kind)` over the live statuses
  means two paths racing cannot produce two first emails. The code check gives
  the good error message; the index is what makes it true.
- **The daily count is derived, never stored.** A counter drifts on a crash, a
  retry or two tabs; counting rows with today's `sent_at` cannot.
- **Suppression is its own table**, not just `leads.unsubscribed`. It has to
  outlive the lead row, or deleting and re-importing a business would resurrect
  it as a valid target.
- **A failure is a stop, not a retry.** Gmail rejecting a message is permanent;
  the email is marked failed and the batch continues. Only a dead token stops
  the batch, because every remaining send would fail identically.
- **AI is optional and never trusted.** A draft that is insulting, generic,
  placeholder-laden or talking about itself is thrown away and the template used
  instead — and the UI says which happened. With no `XAI_API_KEY` at all,
  outreach works entirely on templates.
- **Sole traders are held, not sent.** UK rules treat them like individuals. The
  heuristic (personal mailbox, or a person's name as the business name) only
  ever adds caution, and a held lead is never selectable.
- **The opt-out is a sentence, not a link.** An unsubscribe URL this app does not
  serve would be worse than none; a reply is something it can genuinely act on.
- **Replies are read, never answered.** `gmail.readonly` is used solely to look
  up threads this app created.

### The one thing that cannot be automated

The app needs its own Google Cloud OAuth client, and creating one requires a
person in a browser at console.cloud.google.com. The README has the steps. Until
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, Settings says so plainly
and Connect is disabled — rather than failing at the moment you try to send.

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

## Outreach, as shipped

Phase 3 is built. Sending is **user-triggered only**: `sendQueued` runs from the
Review tab's Send button, automatic sending is forced off, follow-ups default
off, and the product ceiling is 30 emails/day and 5 per batch. Tokens never
leave the server. Do not add a scheduler.

The lead fields `email`, `demoUrl`, `placeId`, `foundAt` and `businessStatus`
are stored, editable, importable and exported, and are what outreach reads.

## Testing

- `npm run test:app` — the app's own unit tests (leads, sync, CSV import).
- `npm test` — those, then the platform template's script tests. Several of the
  latter fail in a plain checkout because they read `.grok/skills/**`, which
  exists only inside the Grok sandbox. That is pre-existing and unrelated to the
  app.
- Browser QA is done by driving the real app in Chromium against both the dev
  server and the built output — a passing build is not evidence that a page
  renders.
