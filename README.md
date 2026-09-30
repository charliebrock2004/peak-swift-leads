# Peak Swift Leads

AI prospecting and Gmail outreach for a local web studio: find real local
businesses that need a website, verify them, find the email they publish, write
each one a personal email from the evidence, and send it from your own Gmail —
with every number traceable and nothing sent that you have not seen.

## The workflow

1. **Find** (`/find`) — choose an area, up to four trades, how many prospects,
   and how many emails a day. The run shows each stage live — Discovering,
   Deduplicating, Verifying businesses, Checking websites, Finding emails,
   Qualifying, Personalising, Ready to send — and its counts reconcile: every
   business found is accounted for (duplicate, already known, emailable, call,
   held, good website, no way to contact…). Nothing is sent by a run.
2. **Review & send** (`/send`) — each email shows the business, its website and
   how that was verified, its opportunity score and why, the email address with
   its confidence and where it was published, and the email itself with the
   evidence it was written from. Edit, regenerate, skip or approve; then
   **Send N emails**, confirm, and watch "Sending 3 of 10" until "10 sent".
   A failure is named per email and can be retried safely.
3. **Call list** (`/calls`) — good prospects with no public email, and
   follow-ups whose day has come. Tap to ring; one tap records the outcome and
   sets the next date.
4. **Replies** (`/replies`) — every reply, with a suggested stage (New,
   Interested, Needs follow-up, Booked, Won, Not interested). You answer in
   Gmail — the app never replies for you. Bounces and out-of-office replies are
   kept separately and never counted as replies.
5. **Home** answers "what needs me today"; **Prospects**, **Campaigns**,
   **Run history** (open any run to see where every business went) and
   **Analytics** (rates hidden until there are enough emails to mean anything)
   cover the rest. The original **Lead sheet** is still there at `/leads`.

## Where your leads are stored

The app is **local-first**. Every device keeps a full copy of the sheet in
`localStorage`, so it opens instantly and keeps working with no signal.

When a database is configured, that copy also **syncs to your account**, which is
what makes the same sheet appear on your phone and your laptop:

| Situation | What happens | What the badge says |
| --- | --- | --- |
| Deployed with a database | Leads sync to Postgres, scoped to your account | Saved to your account |
| Local `npm run dev` | Syncs to an embedded database that resets on restart | Preview storage |
| Signed out / no database | Works fully, this browser only | This device only |
| Sync failed | Works fully, retry later | Could not sync — saved on this device |

The badge in the header never overstates things — tap it for the detail and a
retry. Nothing is ever deleted locally because a sync failed.

How it reconciles: each device tracks the leads it has changed but not yet
pushed, sends those, then pulls everything changed elsewhere since its cursor.
An unpushed local edit always wins over an incoming copy. Deletes travel as
tombstones so removing a lead on one device removes it everywhere. The rules
live in `src/lib/leads-sync.ts` and are unit-tested; the SQL is in
`src/lib/leads-server.ts` and `migrations/0002_leads.sql`.

## Importing a spreadsheet

**Import** takes a paste straight out of Excel or Google Sheets, or a CSV/TSV
file. Three steps, and nothing is written until the last one:

1. Paste or choose a file.
2. Confirm which column is which — the common headings are matched for you
   ("Business Name", "Contact Information", "Verification Notes", …).
3. Review every row's verdict: **Add**, **Merge** or **Skip**.

A row matching a lead you already have is a **merge**, never a replace:

- only fields that are currently **empty** get filled;
- notes are **appended**, and repeated notes are ignored;
- **called status, call result and follow-up dates are never touched** — that is
  your work, not the spreadsheet's.

Re-importing the same file is therefore safe: the second run has nothing to do.

## Website status

Empty website fields are **not** treated as "no website". Research classifies:

- Proper Website — live independent site confirmed
- Social Only — Facebook / Instagram / similar
- Directory Only — Yell, Checkatrade, Maps, etc.
- No Website Found — search found the business, but no site
- Unclear — mixed or unconfirmed evidence

**HOT** = no proper website, 20+ reviews, rating 4.5+.
**WARM** = no proper website with some reviews, or social/directory only.
**COLD** = already has a proper site, or not enough evidence.

## Sending, and why nothing goes out by accident

- A prospect is only emailable with a **public email published by the business
  itself** (HIGH or MEDIUM confidence — never a guess), a real website
  opportunity, and no previous contact, opt-out, Not Interested, booking or win.
- Sole traders and personal mailboxes (`gmail.com`, `btinternet.com`, …) are
  **held** for you to look at, never emailed automatically.
- Every email passes a **quality gate** twice — at approval and in the second
  before Gmail is handed it. It refuses unfilled placeholders, emails that never
  name the business or the sender, no opt-out, insults, invented facts (review
  counts or ratings that do not match the record, "trading since", testimonials,
  statistics), generic openers and buzzwords, and — for AI drafts — any link or
  address that is not your site, your portfolio or theirs. Each refusal says
  what to fix.
- **Sent means Gmail confirmed it.** An email is only marked sent once Gmail
  returns its message id; the database refuses a sent row without one. Each
  email carries its own Message-ID, so an answer lost on the way back is found
  in your Sent folder before anything is retried — a retry can never produce a
  second copy. Two tabs pressing Send at once still send once.
- Daily limit (30 maximum) and a per-campaign daily pace are enforced in the
  same database statement that claims the email, so they cannot be raced past.
  Test emails never count against them.
- One live email of each kind per address, across every campaign.
- Follow-ups (off by default; 4 and 7 days after the last email unless you change it, at most two) stop on
  any reply, bounce, opt-out or call outcome, and are never sent without you.

## Business profile

**Settings → Business** holds who the emails are from: business name, your
name, sending address, website, services, area, tone, call to action, portfolio
link, signature and opt-out line. The AI prompt, the templates, the From name
("Charlie at PeakSwiftStudio") and the quality gate all use it — nothing about
the sender is hard-coded.

## Checking Gmail works

- **Settings → Gmail → Check connection** refreshes the token, reads the mailbox
  profile and checks the scopes, the sender identity, token encryption and the
  last successful send. It never sends.
- **Send test email** sends one plain email to an address you choose.
- **Run end-to-end test** runs the real pipeline once — a synthetic prospect,
  the real email writer, the quality gate, approval, Gmail, the record, and
  Gmail confirming it is in Sent — to **your test address only** (Settings →
  Gmail → Test address, or the connected account). It refuses any other
  recipient, and the synthetic prospect never reaches your sheet or analytics.

### Connecting Gmail (one-time, and it needs you)

The app needs its own Google OAuth client. This part cannot be automated:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create
   a project (e.g. "PeakSwift Leads").
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → fill in the app name
   and your email → add yourself under **Test users**. (Staying in "Testing" is
   fine for one account; tokens then expire every 7 days, so publish the app
   when you are happy with it.)
4. Add these scopes: `gmail.send`, `gmail.readonly`, `userinfo.email`.
5. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorised redirect URIs** add, exactly:
   - `https://<your-deployed-domain>/oauth/gmail`
   - `http://localhost:8080/oauth/gmail` (only if you want it locally)
6. Copy the client ID and secret into the deployment's environment as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then redeploy.
7. In the app: **Settings → Gmail → Connect Gmail**, approve, press **Check
   connection**, then **Run end-to-end test** before contacting anyone.
8. While the consent screen is in "Testing", Google expires the refresh token
   after 7 days; publish it (Production) once you are happy, or reconnect weekly.

### Signing in when deployed outside the Grok platform

On `grok.me` the platform identifies visitors with a signed header, and on the
sandbox preview the shared broker client does it. Neither exists on a plain
Vercel domain: `preview.ts` defaults the broker secret to `""`, so
`authConfigured` is false there whatever `VITE_AUTH_ENABLED` says.

So this app also carries Better Auth's own **email and password** sign-in
(`src/lib/auth/email-password.ts`), served at `/api/auth/*`, which needs no
external identity provider and works on any origin. The **lead sheet stays
available signed out**. Outreach, sync and sending need a session.

On [peak-swift-leads.vercel.app](https://peak-swift-leads.vercel.app):

1. **Vercel → the project → Storage → Create Database → Neon Postgres.**
   Accept the defaults. This injects `DATABASE_URL` for Production (and
   Preview). Do not paste the connection string into the app.
2. **Deployments → ⋯ → Redeploy** the Production deployment (or push to `main`).
3. Hard-refresh the site, open `/login`, **Create the owner account** — do this
   promptly, because the first account created claims the app.
4. Open **Settings → Gmail → Connect Gmail**, then **Check connection** and
   **Run end-to-end test** before contacting anyone.
5. Fill in **Settings → Business** so emails are signed as you.

**`DATABASE_URL` is the only variable this needs.** Everything else is derived:

- Sign-in switches itself on whenever a database is configured, so
  `VITE_AUTH_ENABLED` no longer has to be flipped. (It still forces sign-in off
  when there is *no* database — which is exactly local `npm run dev`.)
- `BETTER_AUTH_SECRET` is derived from `DATABASE_URL` when unset: stable across
  serverless instances, which a random per-process secret is not.
- `BETTER_AUTH_URL` falls back to `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`,
  which Vercel injects into every deployment.
- `APP_OWNER_EMAIL` falls back to "the first account created owns the app".

Set any of them explicitly and the explicit value wins. `APP_OWNER_EMAIL` is
still worth setting if you want no window at all between going live and claiming
the app.

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `XAI_API_KEY` are already on the
production project. Do not rotate them unless you have to.

Two separate questions, deliberately: Better Auth decides *who you are*,
`APP_OWNER_EMAIL` decides *whether you may be here* (`src/lib/auth/owner.ts`).
Anyone can create an account — the endpoint is public — but only the owner gets
past `requireUserId`, so a stranger's account can read nothing, send nothing,
and spend nothing. The owner is `APP_OWNER_EMAIL` when set, and otherwise the
first account created on the deployment.

## Requirements

- Node.js 22+
- npm 10+
- For **syncing across devices and all of Outreach**: `DATABASE_URL` (provisioned
  automatically on deploy — `.grok/app-env.json` sets `deploy.database: true`).

### Environment variables

Server-only. None of these is ever sent to the browser, and none belongs in git.

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Sync, and everything in Outreach | Injected by Vercel when you attach Neon under Storage. Do not put it in git |
| `VITE_AUTH_ENABLED` | Optional | Only forces sign-in **off**, and only when no database is configured. With `DATABASE_URL` present, sign-in is on regardless |
| `BETTER_AUTH_SECRET` | Optional | Derived from `DATABASE_URL` when unset. Set it explicitly to rotate sessions independently of the database password |
| `BETTER_AUTH_URL` | Optional | Falls back to the URL Vercel injects. Set it for a custom domain, with no trailing slash |
| `APP_OWNER_EMAIL` | Optional | The only address allowed to use the app. Unset, the first account created owns it. Set it to close even that window |
| `GOOGLE_CLIENT_ID` | Connecting Gmail | From your Google Cloud OAuth client |
| `GOOGLE_CLIENT_SECRET` | Connecting Gmail | Same. **Never** prefix with `VITE_` |
| `GMAIL_SENDER` | Optional | Pins the account, e.g. `PeakSwiftStudio@gmail.com`. Connecting any other account is then refused |
| `GOOGLE_REDIRECT_URI` | Optional | Defaults to `<origin>/oauth/gmail`, which is right for most deploys |
| `XAI_API_KEY` | Optional — AI-written emails | Without it, outreach uses the templates and says so |
| `XAI_MODEL` | Optional | Overrides the model used for drafts |
| `TOKEN_ENCRYPTION_KEY` | Recommended | Encrypts stored Gmail tokens (AES-256-GCM). Unset, a key is derived from `DATABASE_URL`, then `BETTER_AUTH_SECRET` — changing whichever one is in use means reconnecting Gmail once |
| `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` | Optional — better website discovery | Without one, websites come from map listings and domain checks only. Searches are capped by a daily budget (Settings → Discovery) |

Two more exist **only** so the end-to-end test can point at a local stand-in for
Google, and must never be set in production: `GOOGLE_OAUTH_BASE` and
`GMAIL_API_BASE_URL`.

## Install and run

```bash
git clone https://github.com/charliebrock2004/peak-swift-leads.git
cd peak-swift-leads
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

## Other commands

```bash
npm run typecheck   # tsc
npm run test:app    # this app's unit tests
npm test            # app tests, then the platform template's script tests
npm run build       # production build + migrations
npm run lint
```

## Deploy

Builds with the Nitro Vercel preset, and applies `migrations/*.sql` during the
build. Without a `DATABASE_URL` the deployed app still runs — it just stays
local to each browser and says so.

## License

Private project. All rights reserved.
