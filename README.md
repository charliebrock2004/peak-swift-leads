# Peak Swift Leads

A lead sheet for finding and contacting **local businesses that do not have a proper website**.

Built as a TanStack Start + React + Tailwind app. Leads live in the browser (`localStorage`). No account or database is required.

## What it does

Columns:

- Business Name, Trade, Town, Phone Number
- Google Rating, Number of Reviews, Website, Google Maps Link
- Priority (automatic), Called?, Call Result, Follow-Up Date, Notes

**Priority ranks itself as you type:**

| Rank | Rule |
| --- | --- |
| **HOT** | No website + 20 or more reviews + rating 4.5 or higher |
| **WARM** | No website + some reviews |
| **COLD** | Everything else |

Summary at the top: Total Leads, Hot Leads, Not Called, Interested, Callbacks, Booked.

You can search, filter, sort, add/edit/delete leads, and export CSV. On a phone it switches to cards with Call and Maps.

## Requirements

- Node.js 22+
- npm 10+

## Install and run

```bash
git clone https://github.com/charliebrock2004/peak-swift-leads.git
cd peak-swift-leads
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

Optional env file (not required for local use):

```bash
cp .env.example .env
```

## Other commands

```bash
npm run typecheck   # TypeScript
npm run build       # Production build (Vercel output)
npm run preview     # Serve the production build
npm test            # Script / unit tests
npm run lint        # ESLint
```

## Deploy

The Vite config builds with the Nitro **Vercel** preset.

1. Push this repo to GitHub.
2. Import the project in [Vercel](https://vercel.com).
3. Set `VITE_AUTH_ENABLED=false` in the Vercel project env if you want to match local behaviour.
4. Deploy. No database is required for the lead sheet.

If you later add auth or Postgres, set the names in `.env.example` — never commit real values.

## Project layout

```
src/
  routes/                 App routes (TanStack Start)
  components/leads/       Spreadsheet, cards, form, summary
  store/leads-store.ts    Zustand + localStorage
  lib/leads.ts            Types, ranking rules, sample data, CSV
  styles.css              Design tokens
public/favicon.svg
scripts/                  Dev / build helpers used by npm scripts
```

## Notes for reviewers

- Sample Perthshire leads are seeded on first load so the sheet is usable immediately.
- Priority is computed from Website / Reviews / Rating — it is not a stored field.
- Auth, database, and Grok sandbox helpers are in the tree because this was generated on the Grok Build stack. They are unused while `VITE_AUTH_ENABLED=false`.
- Do not commit `.env`, API keys, or OAuth secrets.

## License

Private project. All rights reserved.
