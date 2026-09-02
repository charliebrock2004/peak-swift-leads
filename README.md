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
| Offline | Works fully, syncs when the connection returns | Offline — saved on this device |

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

## Requirements

- Node.js 22+
- npm 10+
- For **Find leads**: `XAI_API_KEY` on the server (injected automatically in Grok Build). Never expose it to the browser.
- For **syncing across devices**: `DATABASE_URL` (provisioned automatically on deploy — `.grok/app-env.json` sets `deploy.database: true`).

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
