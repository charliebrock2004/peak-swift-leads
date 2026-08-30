# Peak Swift Leads

A prospecting tool for Peak Swift Studios: find local businesses that may need a website, review them, import the good ones, then call.

## Workflow

1. **Find leads** — pick a town and trade. Grok searches the public web.
2. **Review** — website status, HOT/WARM/COLD score, and evidence. Tick the ones you want.
3. **Import** — only selected, non-duplicate prospects join your sheet.
4. **Call** — tap Call / Maps / Website from your phone. Track the result and follow-up.

## Website status

Empty website fields are **not** treated as “no website”. Research classifies:

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

## Install and run

```bash
git clone https://github.com/charliebrock2004/peak-swift-leads.git
cd peak-swift-leads
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

Leads stay in the browser (`localStorage`). No database required.

## Other commands

```bash
npm run typecheck
npm run build
npm test
npm run lint
```

## Deploy

Builds with the Nitro Vercel preset. Set `VITE_AUTH_ENABLED=false`. For Find leads on a self-hosted deploy, set server-only `XAI_API_KEY`.

## License

Private project. All rights reserved.
