# Peak Swift Leads

A prospecting tool for Peak Swift Studios: find local businesses that may need a website, review them, import the good ones, then call.

## Workflow

1. **Find leads** — pick a town and trade. Grok searches the public web.
2. **Import** — bring in a research spreadsheet, or tick prospects from a search. Duplicates merge instead of piling up.
3. **Call** — tap Call from your phone, then record the outcome in one tap.
4. **Follow up** — an outcome sets the next date for you; **Due today** shows who is waiting.

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

## Outreach

**Outreach** (button in the header) turns qualified leads into emails sent from
your own Gmail. Five tabs: Overview, Prospects, Review, Replies, Settings.

The path is: pick prospects → write → **read every one** → approve → queue →
send → replies stop follow-ups.

### Nothing sends by accident

- A lead is only offered when it has a **public email found on its own site**
  (HIGH or MEDIUM confidence — never a guess), a real website opportunity, and
  has not been contacted, unsubscribed, marked Not Interested, booked or won.
- Every email is checked **twice**: when you approve it, and again in the second
  before it is handed to Gmail. Leads change; approval can be days old.
- A draft that still contains `{{business_name}}`, never names the business,
  never says who it is from, has no opt-out, or insults them, **cannot be sent**.
- One live email per address per kind, enforced by a database constraint as
  well as in code. The same business can never get two first emails.
- LOW-opportunity leads are hidden unless you explicitly turn them on.

### Manual review

UK marketing rules treat a sole trader like an individual. Leads whose email is
a personal mailbox (`gmail.com`, `btinternet.com`, …) or whose name looks like a
person's are **held** — shown, counted, but not selectable — for you to look at
and send by hand if you are happy to.

### Sending controls

Daily limit (30), emails per batch (5), delay, follow-ups (off by default, max
2), automatic sending (off). The daily count is derived from what actually went
out, so it cannot drift. `12 / 30` is on every screen.

### Replies

The app reads threads it created to notice a reply. It **never answers** — that
is yours. A reply stops follow-ups and moves the lead to Replied. A reply asking
to stop suppresses that address permanently; suppression outlives the lead, so
re-importing the business cannot resurrect it.

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
7. In the app: **Outreach → Settings → Connect Gmail**, approve, and use
   **Send test email** before contacting anyone.

### Signing in when deployed outside the Grok platform

On `grok.me` the platform identifies visitors with a signed header, and on the
sandbox preview the shared broker client does it. Neither exists on a plain
Vercel domain: `preview.ts` defaults the broker secret to `""`, so
`authConfigured` is false there whatever `VITE_AUTH_ENABLED` says.

So this app also carries Better Auth's own **email and password** sign-in
(`src/lib/auth/email-password.ts`), served at `/api/auth/*`, which needs no
external identity provider and works on any origin. Set the four variables
above, deploy, then open `/login` and choose **Create the owner account** using
the address you put in `APP_OWNER_EMAIL`.

Two separate questions, deliberately: Better Auth decides *who you are*,
`APP_OWNER_EMAIL` decides *whether you may be here* (`src/lib/auth/owner.ts`).
Anyone can create an account — the endpoint is public — but only an address on
the allowlist gets past `requireUserId`, so a stranger's account can read
nothing, send nothing, and spend nothing.

## Requirements

- Node.js 22+
- npm 10+
- For **syncing across devices and all of Outreach**: `DATABASE_URL` (provisioned
  automatically on deploy — `.grok/app-env.json` sets `deploy.database: true`).

### Environment variables

Server-only. None of these is ever sent to the browser, and none belongs in git.

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Sync, and everything in Outreach | Provisioned on deploy by the Grok platform; set it by hand on a plain Vercel project |
| `VITE_AUTH_ENABLED` | Sign-in on a public deployment | `"true"`. Left at `"false"` there is no way to tell visitors apart, and adding `DATABASE_URL` makes every request fail closed |
| `BETTER_AUTH_SECRET` | Same | Long random string, and **stable** — without it each serverless instance signs cookies differently and sessions break at random |
| `BETTER_AUTH_URL` | Same | The app's public origin, no trailing slash. Doubles as the trusted origin, so a wrong value reads as "Invalid origin" |
| `APP_OWNER_EMAIL` | Same | The only address allowed to use the app. Sign-up is open, so without this anyone who finds the URL can create an account |
| `GOOGLE_CLIENT_ID` | Connecting Gmail | From your Google Cloud OAuth client |
| `GOOGLE_CLIENT_SECRET` | Connecting Gmail | Same. **Never** prefix with `VITE_` |
| `GMAIL_SENDER` | Optional | Pins the account, e.g. `PeakSwiftStudio@gmail.com`. Connecting any other account is then refused |
| `GOOGLE_REDIRECT_URI` | Optional | Defaults to `<origin>/oauth/gmail`, which is right for most deploys |
| `XAI_API_KEY` | Optional — AI-written emails | Without it, outreach uses the templates and says so |

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
