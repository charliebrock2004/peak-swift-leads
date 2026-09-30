# PeakSwift Leads — Product, Engineering & Business Audit

*September 2026 · audit of branch `claude/production-overhaul` (commit `0f53c8e`) and production `main` (`fbf4b69`). No code was changed for this document.*

The question every section answers: **does PeakSwift get a salesperson from zero → real prospect → real conversation → real customer faster and more reliably than the alternatives?**

Short answer today: **for one person selling websites to local UK businesses, it is already better at the "safe, honest outreach" half than any off-the-shelf tool, and noticeably weaker at the "find the right businesses and prove why" half — which is the half that decides revenue.** The engineering is careful where it matters least commercially (sending safety) and thin where it matters most (prospect quality evidence).

---

## 1. Executive summary

**What you have built.** A ~35k-line TanStack Start app on Vercel + Neon with ~12.7k lines of tests (1,193 passing). It discovers local businesses from free open data (OpenStreetMap, Companies House, a third-party "bizdata" endpoint), looks for their website and a *published* email, scores them, writes a personalised email (xAI Grok or templates) behind a strict quality gate, and sends one email at a time from your Gmail with idempotency, limits and reply/bounce detection. It has a call list, a replies inbox, campaigns, run history and analytics.

**What is genuinely excellent (keep and build on):**
- The send path. Idempotent claims, Gmail-confirmed "sent", Message-ID reconciliation after lost answers, DB constraints, suppression, sole-trader holds. This is better engineered than what most small outbound tools ship.
- Honesty as a design value: evidence shown next to every email, "never guess an email", counts that reconcile, rates hidden on tiny samples. This is the seed of the product's differentiation.
- Refusing to invent facts in AI copy, enforced by code, not by prompt hope.

**What is weak (and matters most):**
1. **Prospect evidence is shallow.** Discovery sources don't return reviews, ratings, or website quality, so the scoring that is supposed to say "why this business" is mostly running on *absence of a website* plus *has a phone*. Discovered leads never have review counts (`research.ts` sets `reviews: ""`) — only spreadsheet imports do. The "HOT = 20+ reviews at 4.5+" rule effectively never fires for leads the app finds itself.
2. **There is no website audit.** "Basic website / could do more" is a heuristic label, not a finding you can put in front of a business owner. For a web-design seller, this is the single biggest missing capability.
3. **Fragile and legally questionable data sources.** Companies House is read by scraping its public HTML search pages rather than the free official API; a third-party `bizdata-web.vercel.app` endpoint of unknown ownership sits in the discovery path; public Nominatim is used in a way its usage policy doesn't intend for a product.
4. **Everything long-running runs in the browser tab.** Discovery runs and send sessions stop if the tab closes; reply/bounce checking happens only when you press a button. No scheduled jobs exist.
5. **Two products in one.** The old local-first lead sheet (`/leads`, its own store, sync engine, CSV import) and the new server-side outreach world both describe "a prospect". Two sources of truth, two UIs, several scoring systems (`decision.ts`, `explainOpportunity`, `prospect-pool.scoreProspect`, eligibility bands).
6. **Not yet a sales pipeline.** No deal value, no opportunities, no tasks, no contact entity (a business *is* its one email address), no revenue. The app stops at "Booked/Won" as a label.
7. **Production isn't running any of the new work.** `main` is weeks behind the branch; production users see the old overlay.

**The strategic recommendation (detail in §30):** do not build "another Apollo". Build **the local-business website-opportunity engine for UK web designers and small agencies**: *"Show me the 20 businesses in Perthshire most worth contacting this week, prove why with a real audit, tell me whether to email or ring, and give me the words."* Phone-first where the law and the data point that way, email where a corporate address is published, a daily queue as the home screen, and revenue as the only metric that counts. Use it to win PeakSwiftStudio clients for 60–90 days before designing for anyone else.

---

## 2. Current architecture

### 2.1 Stack

| Layer | What it is | Notes |
|---|---|---|
| App | TanStack Start (React 19, file routes, `createServerFn`), Vite 8/rolldown, Tailwind v4 | Server bundle forced into one chunk to dodge a rolldown bug (`vite.config.ts`, `scripts/check-ssr-bundle.mjs`). |
| Hosting | Vercel (Nitro `vercel` preset), `iad1` region, `maxDuration: 300` | Region is US-East; users and data subjects are UK. |
| DB | Neon Postgres via `pg`; PGLite in dev | Migrations `0001`–`0009`, applied at build. No transactions in the `Sql` interface — correctness relies on single-statement conditional updates (done well). |
| Auth | Better Auth (email/password) + owner allowlist (`requireUserId`) | Effectively single-tenant: first account or `APP_OWNER_EMAIL` owns the app. |
| Client state | zustand lead store, local-first with push/pull sync (`leads-sync*.ts`) | The old sheet's model; now a second source of truth. |
| AI | xAI Responses API (`XAI_API_KEY`, `XAI_MODEL`), drafts only | Budgeted per day. |
| Search | Tavily / Brave / Bing (whichever key exists) for website + email search | **Microsoft retired the Bing Search APIs in August 2025** — the Bing path is dead code. |
| Email | Gmail API (send, readonly), OAuth per user, tokens AES-GCM sealed | Single mailbox, pinned to `peakswiftstudio@gmail.com`. |
| Open data | Nominatim, Photon, Overpass (OSM), Open-Meteo geocoding, postcodes.io, Companies House (HTML), `bizdata-web.vercel.app` | All free, all rate-limited or policy-limited (see §7). |

### 2.2 Data model (tables)

`user/session/account/verification` (auth) · `leads` (the business record, ~35 columns, per user) · `lead_evidence` (JSON website/email evidence) · `lead_reviews` (operator decisions) · `campaigns`, `campaign_prospects` · `outreach_emails` (queue *and* history, ~40 columns incl. reply fields) · `outreach_suppression` · `outreach_settings`, `outreach_templates`, `business_profile` · `gmail_accounts` · `outreach_runs` (with reconciling funnel JSON) · `activity_events` · `usage_counters`.

Missing as first-class entities: **contact/person, interaction (call, note, email) timeline, opportunity/deal, task, source record, website audit, workspace/organisation.**

### 2.3 Data flow as built

```
FIND (browser-orchestrated, use-prospect-run.ts)
  geocode area → towns (scotland-places.ts) → per town & trade:
    OSM Nominatim + Photon + Overpass + bizdata  → mergePlaces (dedupe)
    Companies House HTML search → postcodes.io geocode → in-area filter
  → prospect-pool: cross-area dedupe, drop known/contacted/suppressed, rank, cap to target
  → saved to the *client* lead store → pushed to server (sync) ← run fails if sync fails
ENRICH (one server call per lead, 3 concurrent, from the browser)
  checkLeadWebsite: listing hint → search provider (budgeted) → fetch candidate pages (SSRF-guarded) → verify identity (name/town/phone)
  findLeadEmail: crawl site/contact pages/sitemap, deobfuscate, score; else search provider → evidence row
QUALIFY  decideProspect (HOT/WARM/CALL/LOW/SKIP) + checkEligibility (email rules, sole-trader hold, suppression…)
PERSONALISE generateEmails (4 at a time): evidence facts → Grok prompt → quality gate → template fallback
REVIEW    /send: sendQueue classification, edit/regenerate/approve
SEND      sendEmail per email: re-gate → claimWithinLimits → Gmail → markSent (proof) / reconcile
REPLY     "Check for replies" (manual): thread polling → bounce/auto-reply/human/unsubscribe → suppression, stage
FOLLOW-UP followUpsDue (4/7 days) → you write & send them from /send
PIPELINE  reply stage + lead.callResult (Interested/Booked/Won labels) — no deal object
CUSTOMER  "Won" label; no value, no attribution
```

### 2.4 Dependencies & failure points

| Dependency | Failure mode | Current handling |
|---|---|---|
| Browser tab | Closed tab kills a run or a send session | Runs marked `interrupted` after 30 min; sends reconciled on next visit. Work is lost, not corrupted. |
| Client→server sync | Offline or auth problem blocks a run at "saving prospects" | Run fails with the sync message. |
| Nominatim/Photon/Overpass | Rate-limited, policy-blocked, slow | Multiple mirrors for Overpass; geocoder outage now reported honestly. |
| Companies House HTML | Markup change or blocking breaks CH silently to zero | Source tally shows a zero. |
| `bizdata-web.vercel.app` | Unknown operator; can disappear, change, or log your queries | None. |
| Search provider | Quota/outage | Daily budget, failure classification. |
| xAI | Outage, cost, bad output | Template fallback, quality gate, budget. |
| Gmail | Token expiry (7-day in "Testing" consent), rate limits, lost answers | Classified failures, reconciliation, health check. |
| Vercel env | Variables not reaching a build | Now named in-app. |

---

## 3. Current product strengths

1. **Send safety is best-in-class for its size.** Double gate, conditional claim with limits in one statement, Gmail-proof constraint, Message-ID recovery, cross-campaign duplicate index, suppression that outlives the lead, sole-trader hold. Nothing in Instantly/Lemlist's marketing claims more; most of them allow far more damage.
2. **Evidence is shown, not asserted.** Website verification ticks (name/town/phone), "published as … on …" for emails, "why this email was written". This is the correct product instinct.
3. **Fabrication is blocked in code.** Review counts must match the record, ratings must match, no "trading since", no testimonials, no stray links. AI copy can't invent facts about the business.
4. **Reconciling funnel.** Every discovered business is accounted for. Rare and valuable: it tells you *where* the pipeline leaks.
5. **Honest analytics.** Rates hidden below 5 sends; out-of-office not counted as replies.
6. **Sole-trader awareness.** Personal-mailbox detection feeding a manual hold aligns with PECR (§20).
7. **Test discipline.** Integration tests against real Postgres, mutation-checked key tests, a migration-upgrade test with dirty legacy data.

## 4. Current weaknesses (brutally)

1. **The prospect list isn't convincing.** A list of joiners with "no independent website found" and a phone number is what D7 Lead Finder, Outscraper and a dozen "no-website leads" tools already sell for tens of dollars. The *why* is thin because the data is thin.
2. **"No website found" is not the same as "has no website".** It means your sources and search didn't find one. Without a search key it is mostly OSM's `website` tag being empty — and most small UK businesses' OSM entries have no website tag *even when they have one*. Risk: you email "I couldn't find a website" to a business with a website. The quality gate allows that claim whenever status is "No Website Found", so it is only as good as discovery.
3. **Website quality is a guess.** Categories like "Basic Website" come from coarse checks, not a measured audit. Nothing checks mobile, speed, HTTPS, forms, booking, copyright year, etc.
4. **No reviews/rating/activity data** for discovered leads (see §1). Scoring rules keyed on reviews are dormant for them.
5. **Too many surfaces for one person.** 11 nav items + settings with 9 sections. Campaigns, Run history, Analytics and Prospects overlap heavily at your volume (tens of emails/day).
6. **Campaigns don't earn their keep.** For a single user sending ≤30/day, a campaign is a saved search + a daily cap. The concept adds statuses (DRAFT/ACTIVE/PAUSED/COMPLETED/ARCHIVED), membership tables and UI for little decision value.
7. **The old lead sheet** duplicates Prospects, owns a separate client-side store and sync engine, and is where CSV import lives. It is the largest source of architectural complexity with the least forward value.
8. **Calling is second-class.** The call list is a queue with outcome buttons. No brief, no talking points, no objection handling, no history, no call notes timeline.
9. **No pipeline after "Interested".** You can't record a quote, a value, a proposal date, or why you lost.
10. **Replies are polled by hand** and follow-ups are manual — acceptable for safety, but "nobody pressed the button" currently means bounces and opt-outs are not processed.
11. **Single Gmail consumer account.** Cold outreach from `@gmail.com` looks less professional and has no domain authentication you control (see §12).
12. **Production drift.** The live app is the old version; the new version has never been used for real.

## 5. Biggest risks

| Risk | Why it matters | Severity |
|---|---|---|
| Emailing sole traders/partnerships | Under PECR, unsolicited marketing email to *individual* subscribers (sole traders, most English partnerships) needs consent; only *corporate* subscribers (companies, LLPs, Scottish partnerships) are exempt from consent. Many local trades are sole traders. Fines were raised to UK-GDPR levels (£17.5m/4%) by the Data (Use and Access) Act 2025. ([ICO B2B guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/), [Mondaq on DUAA](https://www.mondaq.com/uk/privacy-protection/1649782/data-use-and-access-act-2025-key-privacy-law-changes-for-uk-businesses)) | **High** — the app's sole-trader detection is heuristic (mailbox domain, name looks personal). A joiner using `info@smithjoinery.co.uk` who is a sole trader passes. |
| Calling TPS/CTPS-registered numbers | Unsolicited sales calls to numbers on TPS (individuals incl. sole traders) or CTPS (corporates) are unlawful without consent. Not screened at all. | **High** for the phone-first strategy — must be designed in before scaling calls. |
| Companies House HTML scraping | Brittle, and CH asks developers to use the API; banning is possible. | Medium |
| Unknown `bizdata` endpoint | Data provenance unknown → lawful basis for processing that data unknown; availability unknown. | Medium |
| Nominatim usage policy | Public Nominatim forbids heavy/bulk use and requires a valid identifying User-Agent; a SaaS built on it will be blocked. | Medium now, **high** if commercial |
| Consumer Gmail sender | Reputation damage lands on your only address; no DMARC you control; Google can suspend consumer accounts for cold-sending patterns. | Medium |
| Wrong "no website" claim | Embarrassing, trust-destroying first impression; can read as spam. | Medium |
| Browser-tab orchestration | Runs die; operations can't be scheduled; multi-user impossible. | Medium (becomes high for SaaS) |

## 6. Biggest opportunities

1. **Website Opportunity Audit** — a measured, shareable audit per business (PageSpeed/Lighthouse via the free PageSpeed Insights API — 25k queries/day with a key ([ref](https://freeapihub.com/apis/pagespeed-insights-api)) — plus your own HTML checks). Converts "you have a basic website" into "your site takes 9.1s on mobile, has no enquiry form and still says © 2016". This is the email opener, the call talking point and the proposal outline in one artefact.
2. **Evidence-backed "why this business" score** consolidated into one explainable model.
3. **Daily sales queue** as the home screen: the app decides the next best action per business (email / call / follow up / answer reply / chase quote).
4. **Phone-first for sole traders**, email for corporate addresses — turning the PECR constraint into a routing rule rather than a blocker.
5. **Pipeline with money**: quotes and won value make analytics real ("£3,400 won from 212 contacts; trades beat hospitality 3:1").

---

## 7. Discovery engine audit

### 7.1 Sources in use

| Source | Gives you | Quality for UK local SMBs | Terms/limits |
|---|---|---|---|
| OSM Overpass | Mapped businesses by tag near a point | Good for shops/hospitality in towns; **sparse for trades** (joiners, roofers, electricians often unmapped or mapped without contact tags) | Public instances are shared; heavy use discouraged; mirrors used. |
| Nominatim / Photon | Name search near a point | Same data as OSM; fine for geocoding, weak for business discovery | Nominatim policy: max 1 req/s, no bulk, identifying UA. Photon (komoot) similar spirit. |
| Companies House (HTML) | Registered companies by name keyword + registered office | Strong for *existence and legal form* (Ltd/LLP ⇒ corporate subscriber). Weak for location (registered office ≠ trading address; many trades use accountants' addresses) and for sole traders (absent entirely). | Official REST API is free with a key, 600 req / 5 min ([CH rate limits](https://developer-specs.company-information.service.gov.uk/guides/rateLimiting)). Use it; stop scraping HTML. |
| bizdata-web.vercel.app | Unknown aggregated business rows | Unknown | Unknown operator. Remove or replace. |
| Search (Tavily/Brave) | Website candidates, email mentions | Good when budgeted | Per-query cost; Bing is retired. |

### 7.2 Answers to the specific questions

- **Comprehensiveness:** Low-to-moderate. For "Joiner, Perth" you'll get the OSM-mapped fraction plus CH companies whose *name* contains a trade word. Businesses named "J. Smith" or "Tay Property Services" doing joinery are missed; sole traders not on OSM are invisible.
- **Accuracy:** OSM entries can be years stale; CH status is accurate for companies (active/dissolved).
- **Freshness:** No "last verified" concept per source field.
- **Duplication:** Handled carefully (identity index, name/phone/domain matching, known-lead exclusion). This part is good.
- **Scotland vs England:** `scotland-places.ts` hard-codes Scottish town expansion for regions ("Perthshire" → towns). England has no equivalent region expansion → searches for "Yorkshire" or "Cotswolds" will behave worse. Postcodes.io works UK-wide.
- **Rural:** Radius search around towns works; very rural businesses registered to a farmhouse address rarely appear on OSM.
- **No website:** Recorded as "No Website Found" when discovery + search can't find one (see weakness 2).
- **Facebook-only:** Detected when a listing links a social URL ("Social Only"). Not found when Facebook exists but isn't linked from a listing, unless the search provider surfaces it.
- **Weak websites:** Only coarse classification.
- **Worth contacting:** `decideProspect` + eligibility make a reasonable first cut on the fields available; limited by missing signals.
- **Irrelevant listings:** Chain/merchant name lists, OSM tag rejections, CH name filters — decent.
- **Closed businesses:** CH dissolved status filtered; OSM `disused`/closed tags partially; no Google business-status signal.
- **Chains/franchises:** Hard-coded national-chain list; fine for the obvious ones.
- **Sole traders:** Inferred only from personal mailbox domains / personal-looking names. **CH absence is a strong, unused signal**: a business not on Companies House is very likely a sole trader or partnership (⇒ individual subscriber under PECR ⇒ phone-first).
- **Decision maker:** Not identified. For micro-businesses the owner *is* the decision maker; the useful thing is the owner's *name* (CH officers API gives directors' names for Ltd companies — lawful to use carefully for addressing, legal review advised).

### 7.3 Should you use Google Places?

It is the best source of *existence, category, phone, website URL, rating, review count and business status* for UK SMBs. But:
- Text Search (Pro) is ~$32 per 1,000 after 5,000 free/month per SKU (free caps replaced the $200 credit in March 2025) ([Woosmap](https://www.woosmap.com/en-gb/blog/google-maps-api-pricing-breakdown), [openplacesapi](https://openplacesapi.com/blog/google-places-api-pricing)).
- **Terms forbid caching/storing Places content beyond `place_id`** (lat/lng up to 30 days); name, address, rating, reviews may not be stored in your database ([Places policies](https://developers.google.com/maps/documentation/places/web-service/policies?authuser=6), [summary](https://openplacesapi.com/blog/can-you-store-places-api-results)). A lead database built from Places data is a terms problem.

**Recommendation:** use Places as a *live verification lens*, not a data source: store only `place_id`; fetch details on demand when you open a prospect or build a call brief (cost ≈ a few cents per prospect you actually work). Legal/terms review before relying on it commercially. Do **not** use Maps scrapers (Outscraper/Apify actors) in the product — terms risk you can't pass on to customers.

### 7.4 Proposed discovery architecture

```
SOURCES (pluggable adapters, each returns SourceRecord{source, sourceId, fetchedAt, fields, licence})
  Companies House API (companies + SIC + officers, status)       — legal form, existence, directors
  OSM Overpass (self-hosted or commercial mirror when commercial)  — mapped premises, tags
  Search provider (Tavily/Brave)                                   — website & social discovery
  Google Places (optional, place_id only, live details)           — status, rating, reviews, phone, website
  User import (CSV/manual)                                          — your own knowledge
        ↓
NORMALISATION   name folding, UK phone E.164, postcode, domain, trade taxonomy (SIC ↔ OSM tag ↔ your trades)
        ↓
ENTITY RESOLUTION   business = cluster of SourceRecords (phone, domain, postcode+name, CH number); keep all source rows
        ↓
ENRICHMENT (server job, queued)   website verify → website AUDIT → contact discovery → legal form → TPS/CTPS screen
        ↓
VALIDATION   active? in area? not a chain? not a customer/suppressed? contactable lawfully by which channel?
        ↓
SCORING   one explainable model (§10) → band + reasons
        ↓
PROSPECT  with evidence, recommended channel, and next action
```

Key change: **store source records and evidence separately from the merged business**, so every field on screen can say where it came from and when.

---

## 8. Data & enrichment audit (email + contact)

**How many layers:** effectively four: (1) email on the listing, (2) crawl of the verified website — homepage, contact links, sitemap contact URLs, Cloudflare/obfuscation decoding, script-literal joining, HTML entities, (3) search-provider queries for the business + email, (4) scoring/ranking of candidates with rejection reasons. It **never guesses** (`info@domain` is not invented) — correct.

**Verification:** there is *no mailbox verification* (no SMTP/verifier API). Confidence = where and how it was published (HIGH: on the business's own verified site; MEDIUM: directory/listing/profile). That is a sound *provenance* confidence but not a *deliverability* confidence. Bounces are then discovered by sending — which costs sender reputation.

**Multiple emails:** ranked; alternatives stored in evidence; one chosen.

**Generic vs personal:** role mailboxes (info@, enquiries@) are *preferred* for B2B (they're corporate addresses, arguably the safer PECR target); personal-provider mailboxes (gmail/btinternet) trigger the sole-trader hold. Named-person emails on a company domain aren't distinguished — they should be (UK GDPR applies to named individuals at corporates).

**Missing emails:** routed to the call list when a phone exists — good; make it the norm (§12).

**Recommendation:** add a *verification* step only for emails you are about to send (not for every discovered lead): a verifier API at ~$3–8 per 1,000 ([BounceZero comparison](https://bouncezero.io/best-email-verifier-2026)). Treat catch-all as "unknown", never as "valid". A waterfall à la Clay (try provider A, then B…) is overkill for local SMBs: the published-on-own-site signal is stronger than any B2B database for this segment, and databases barely cover micro-businesses.

**Phone:** comes from listings only. Add: phone from the verified website (tel: links, schema.org), and Places on demand. Normalise to E.164; flag mobiles (07…) as likely sole traders.

---

## 9. Website audit / opportunity engine

This should become the product's centre of gravity for the web-design use case.

**Automatable reliably (cheap, deterministic):**
- PageSpeed Insights API (mobile): performance score, LCP/CLS/INP, accessibility score, SEO score, "tap targets too small", "text too small" — free with a key.
- Own fetch + HTML parse (already have the SSRF-safe fetcher): HTTPS/redirect, valid cert, `<title>`/meta description, viewport meta, H1, `tel:`/`mailto:` links, contact form presence, booking widget signatures (Calendly/Booksy/Fresha/etc.), copyright year, last-modified hints, CMS/builder fingerprint (Wix/Squarespace/WordPress version, "Powered by"), social links, schema.org LocalBusiness, broken internal links (first N), images without alt, mixed content, parked-domain detection.
- Google presence: Places status/rating (live, optional).

**Needs AI or human judgement (label as opinion, not fact):**
- Visual dated-ness, brand quality, copy quality, "clear services/CTA". A multimodal model on a screenshot can produce *reasons* but must be shown as "assessment", never quoted to the prospect as fact without your review.

**Output:** a structured `website_audit` record (score per dimension + findings with evidence URLs/metrics + timestamp) and a one-page shareable audit (link or PDF) you can send after a positive reply or bring to a call. Findings feed scoring (§10), email personalisation ("your homepage takes 7.8s to load on a phone") and the call brief.

**Guardrail:** emails may cite only *measured* findings; never "your site is outdated/ugly". The existing gate already forbids insults — extend it so any performance/mobile claim must match an audit finding (today it bans such claims outright because nothing measures them).

---

## 10. Prospect scoring

**Today:** at least four overlapping systems (`decideProspect` levels, `explainOpportunity` points, `prospect-pool.scoreProspect` ranking, eligibility `band`). They disagree in edge cases and are hard to explain together.

**Proposal: one model, three independent axes, each with reasons.**

1. **Need** — how much would a website help them? (no site > social-only > directory-only > site with measured problems > decent site). Evidence: audit findings, verified absence (searched with provider X on date Y).
2. **Value** — how much is the job likely worth / likely to close? Trade value tier (configurable per workspace: e.g. builders/roofers/joiners high, takeaways low), evidence of activity (recent reviews, active social, CH filings current), size proxies (review count, multiple staff, Ltd vs sole trader).
3. **Reachability** — can you lawfully and practically reach the decision maker? Corporate email published (HIGH) / phone not on TPS-CTPS / sole trader ⇒ phone-only / nothing ⇒ drop.

**Priority = Need × Value, gated by Reachability**, displayed as band + the top reasons, e.g.:

> **Call today · Strong (82)** — no website found (searched Tavily 12 Sep); 48 Google reviews at 4.8 (Places, live); Ltd company active since 2014 (CH); roofer = high-value trade; mobile number not on TPS.

Rules for resistance to bad data: a missing signal contributes nothing (never negative by default); every positive signal carries a source + date; stale evidence (>90 days) decays; user overrides are recorded and win.

Signals **not worth building** now: "SEO quality" beyond Lighthouse SEO basics, backlink data, ad-spend intelligence, social follower counts, technographics beyond CMS fingerprint.

---

## 11. AI personalisation

**Audit of the current engine:**
- Good: evidence-only prompt, sender profile, 70–120 words, Scottish plain voice, bans on flattery/buzzwords/openers, fabrication checks, template fallback, stray-link rejection.
- Weak: the evidence it's fed is thin (see §4), so emails converge on one pattern — "I noticed X has N reviews but no website that I could find… would a quick 10-minute call be useful?". Across 30 emails/day to one town, businesses talk; sameness is a real risk. No angle selection, no A/B of angles, no measurement of which angle gets replies.
- The template fallback is used silently at volume when AI is off — the review screen shows it, but analytics don't split AI vs template performance.

**Proposed architecture:**

```
RESEARCH (sources + audit) → EVIDENCE ITEMS {claim, value, source, date, confidence}
→ ANGLE SELECTION (rule-based first): no-site | social-only | slow-mobile | no-enquiry-form | outdated | reviews-without-site
→ DRAFT (LLM, only given evidence items for the chosen angle)
→ CLAIM CHECK (code: every factual sentence maps to an evidence item; else reject)
→ HUMAN REVIEW (with evidence highlighted inline)
```

Record the angle on each email; analytics then answer "which angle gets replies". Keep AI at *draft + classify* level; do not let it choose recipients or send.

Call prep and follow-ups use the same evidence items — one research pass, three outputs (email, call brief, follow-up).

---

## 12. Outreach (email) audit

**Solid:** duplicate prevention (DB unique index + claim), retries without duplicates, failed-send handling, limits (30/day global, per-campaign pace), suppression incl. bounces, opt-out language required, threading for follow-ups, token encryption, OAuth state signing, pinned sender, sole-trader hold.

**Gaps / risks:**
- **Sender identity:** `peakswiftstudio@gmail.com` is a consumer mailbox. Move outreach to a Google Workspace mailbox on your own domain (e.g. `charlie@peakswift.studio`) with SPF, DKIM and DMARC; keep volume ≤30/day/mailbox. Gmail's bulk-sender rules formally apply above 5,000/day, but the spam-complaint threshold (keep <0.1%, never ≥0.3%) and authentication expectations apply to reputation generally ([Gmail/Yahoo requirements summary](https://bird.com/en-de/docs/knowledge-base/deliverability/gmail-yahoo-requirements)).
- **No `List-Unsubscribe` / `List-Unsubscribe-Post` headers.** Not strictly required for 1:1 cold email at this volume, but cheap, lowers complaints, and is expected. Add, with a signed one-click endpoint that writes to suppression.
- **Reply/bounce detection is manual.** A bounce not processed is a second email risk to a dead address (follow-ups check bounced status, but only after a poll). Needs a scheduled poll (Vercel Cron every 15–30 min).
- **Existing customers:** only protected if the lead is marked Won/Booked. Add a "customer/do-not-contact domain" list and CH-number match.
- **Sending the wrong message:** mitigated by review; add a final preview-per-recipient in the confirm dialog for >1 email (currently names only).
- **Wrong account:** now pinned.
- **Legal:** see §20 — the sole-trader rule is the big one; the current heuristic is not enough.

**Deliverability practice for this product:** plain text, no tracking pixels, no link shorteners, one link max (your site), real signature with business address, ≤30/day/mailbox ramped from ~10, consistent sending window, stop on any bounce rate >3% or complaint.

---

## 13. Follow-up system

**Today:** follow-up 1 at +4 days, follow-up 2 at +7 days (defaults; off by default), stops on reply/bounce/opt-out/call outcomes, never sent without you. Reply classifier distinguishes bounce/auto-reply/human/unsubscribe and suggests a stage.

**Ideal:**

| Situation | Automatic effect | Human action surfaced |
|---|---|---|
| No reply, day 4 | Draft follow-up 1 (short, new angle or audit link) into Today | Approve |
| No reply, day 10 | Draft final follow-up ("closing the loop") | Approve |
| OOO with return date | Pause sequence until return date + 1 | none |
| Bounce | Suppress address, try phone route | Call task if phone |
| Unsubscribe / "stop" | Suppress everywhere, end sequence | none |
| Positive / question | End sequence, create "Reply now" task (same day) | Reply in Gmail |
| "Not now / later" | End sequence, reminder at stated time (default 90 days) | — |
| Wrong person / referral | End sequence, create contact from referral | Confirm contact |
| Negative | End sequence, mark lost with reason | — |
| Meeting booked / quote sent / won / lost | Pipeline stage change; no more automated outreach | — |

Every human-attention reply **freezes** all automation for that business (already true for replies; make it an explicit invariant with a test). AI classification into positive/neutral/negative/objection/OOO/unsubscribe/referral/wrong-person is worth doing — it's cheap and high-value — but it only *suggests*; stage changes that stop outreach can be automatic, stage changes that *start* anything need you.

---

## 14. Calling / human outreach

You intend to cold call; for sole traders it is also the more defensible channel (subject to TPS/CTPS). Today calling is a list with outcome buttons.

**Design:**

- **Call mode (mobile-first):** one business per screen, big Call button, and above the fold: business name, who to ask for (director name from CH where applicable), why they're a prospect (top 3 evidence items), last contact, next action. Swipe/next.
- **Call brief (AI, from evidence only):**
  > *Why call:* no website; 31 reviews at 4.9; Ltd since 2016. *Opening:* "Hi, is that Craig? It's Charlie from PeakSwift in Perth — I build websites for trades round here. I noticed you've got great reviews but when I searched I couldn't find a website for you…" *Likely objection:* "We get enough work from word of mouth." *Response:* "Makes sense — most of my clients said the same; the site mostly helps the reviews you already have do the selling…" *Ask:* 10 minutes this week to show two examples.
- **Outcome capture in one tap + optional voice note** (speech-to-text) → structured note on the timeline.
- **Compliance:** TPS/CTPS screening before a number enters the queue (TPS data licence ~£ per year via TPS Ltd — verify; legal review), and a "do not call" flag.
- **Recording/transcription:** **don't build now.** Two-party consent expectations, storage and GDPR burden outweigh value for a solo seller. Revisit only with a telephony partner.

---

## 15. CRM / pipeline

**Decision:** become a *lightweight CRM for the prospect-to-close journey only* — not a general CRM. The reason: attribution and "what should I do today" need the post-reply stages; handing off to HubSpot at "Interested" loses both.

**Pipeline for a web studio:**

`Prospect → Contacted → Conversation (replied/answered call) → Meeting booked → Quote sent (value) → Won (value, start date) / Lost (reason) / Nurture (revisit date)`

Minimal objects: **Business, Contact, Interaction (email/call/note/meeting), Opportunity (stage, value, expected close, lost reason), Task (due, type)**. Every interaction attributes to its source run/search, angle and channel so revenue can be traced back.

What not to build: custom fields, custom pipelines, email marketing, invoicing, project management. Export/sync to HubSpot free tier if needed later.

---

## 16. Analytics

**Today:** counts and reply rates by campaign/trade/town, funnel bars, small-sample guard. Honest, but vanity-adjacent: stops at "replied/booked".

**Target (business outcomes first):**

1. **Revenue:** won £, pipeline £ (quotes), by source/trade/town/angle/channel.
2. **Conversion ladder:** found → contactable (lawful channel exists) → contacted → conversation → meeting → quote → won, with time between steps.
3. **Effort:** minutes spent (runs, reviews, calls) per won client; emails and calls per conversation.
4. **Quality control:** bounce rate, complaint/unsubscribe rate, "no website" claims later found wrong.
5. **Learning:** reply rate by angle and subject — only shown with sample-size caveats (already a pattern you have).

Drop from the main view: per-campaign tables, delivery failure tiles on Home.

---

## 17. AI agents — where they earn their place

| Agent | Input → Output | Tools/permissions | Human approval | Failure modes | Cost/latency | Verdict |
|---|---|---|---|---|---|---|
| Discovery | ICP + area → candidate businesses | Source adapters (read) | No (it only proposes) | Misses, duplicates | Low, minutes | **Yes, but deterministic code, not an LLM agent** |
| Research/Audit | Business → evidence + audit | Safe fetch, PSI API, Places (read) | No | Wrong site matched, stale data | ~$0.01, 10–40s | **Yes (core)** |
| Contact | Business → emails/phones with provenance | Crawl, search, verifier | No | Wrong mailbox, catch-all | ~$0.01 | **Yes (exists; add verification)** |
| Qualification | Evidence → score + channel | Pure code | Override anytime | Bad weights | ~0 | **Yes, as code, not LLM** |
| Personalisation | Evidence + angle → draft | LLM (no tools) | **Always** | Generic/invented | <$0.001/email | **Yes (exists)** |
| Reply classifier | Reply → class + suggested stage | LLM + rules | For anything that starts outreach | Misclassify sarcasm/"not now" | <$0.001 | **Yes** |
| Call prep | Evidence + history → brief | LLM | Read-only | Over-scripted | <$0.001 | **Yes** |
| Follow-up | History → next action | Rules | Yes to send | Nagging | ~0 | **Rules, not agent** |
| Pipeline | Opportunities → stale alerts | Rules | n/a | — | ~0 | **Rules** |
| Daily sales | Everything → today's ordered queue | Rules + LLM summary line | n/a | Wrong priorities | ~0 | **Yes — it's the Home screen** |
| Autonomous SDR (find+write+send) | — | Send permission | — | Spam, PECR breach, brand damage | — | **No** |

Principle: **LLMs write and classify; code decides and acts; you approve anything that contacts a human.**

---

## 18. The "daily sales machine"

Yes — make it the central UX philosophy. Home becomes **Today**:

```
TODAY · Tue 30 Sep
  3 replies need you            → Reply (opens Gmail thread + suggested stage)
  2 quotes to chase             → Call/email
  7 calls (best 11:00–12:00)    → Start calling
  5 emails ready (reviewed?)    → Review & send 5
  2 follow-ups due              → Approve 2
  ─────────
  Pipeline: £4,200 in quotes · £1,800 won this month
  Top up: "Find 20 more in Crieff/Comrie roofers" (1 tap, runs in background)
```

"Start my day" walks the queue in priority order: replies → hot opportunities → calls in their window → emails → follow-ups → prospecting top-up. Each item one screen, one decision. This removes Campaigns, Run history and most of Analytics from daily attention.

Prerequisite: background jobs (§22) so prospecting top-ups and reply polling happen without the tab open.

---

## 19. UX / UI audit by screen

| Screen | Purpose | Works | Doesn't | Change |
|---|---|---|---|---|
| **Home** | What needs me today | Attention list, honest stats | 10 stat tiles compete with the list; no money; items aren't ordered by value | Replace with Today queue (§18); 3 numbers max |
| **Find** | Start a run | Clear form, live stages, reconciling counts | Runs in the tab; "campaign" choice is a detour; target presets vs custom; radius hidden; can't see *why* results are good until later | Background job; ICP presets; results page shows top 20 with reasons first |
| **Review & send** | Approve & send | Evidence beside email, confirm dialog, per-email failures | Very long cards on mobile; 4 tabs; blocked reasons buried | Compact card with evidence chips; one list sorted by readiness; keyboard shortcuts (A approve, E edit, S skip) |
| **Call list** | Ring | Big buttons, one-tap outcome | No brief, no history, no notes timeline, no ordering by time-of-day | Call mode (§14) |
| **Replies** | Handle replies | Stage chips, suggestion, "reply in Gmail" | Manual polling; no snippet of full thread; stage ≠ pipeline | Auto-poll; show thread; stages → opportunity |
| **Prospects** | Browse everything | Filters, reasons for not emailable, review queue | Overlaps with lead sheet; 9 filter chips; no bulk "call these" | Becomes the single Business list with saved views |
| **Campaigns** | Group runs | Honest counts | Low decision value for one user | Demote to a filter/tag ("Perthshire roofers, Oct") |
| **Run history** | Audit runs | Reconciling funnel is great | Rarely needed daily | Keep as a detail page from a prospect/search, drop from nav |
| **Analytics** | Learn | Small-sample honesty | No revenue; campaign table duplicates Campaigns | Revenue-first (§16) |
| **Settings** | Configure | Health check, E2E test, profile | 9 sections; discovery/AI budgets exposed to a solo user | Group into Workspace (ICP/offer/profile), Channels (Gmail, phone), Limits, Compliance |
| **/leads** | Legacy sheet | Import, offline | Duplicate world | Fold import into Businesses; retire the sheet |
| **Auth** | Sign in | Works | First-account-owns-app is surprising for SaaS | Proper workspace sign-up later |
| **Gmail connect** | OAuth | Now deterministic redirect, health check | Consumer Gmail | Workspace mailbox guidance |

Cross-cutting: typography and tokens are consistent; mobile bottom nav is good; accessibility basics (focus-visible, labels) present, but long cards and chip rows need keyboard shortcuts and fewer tab stops. Empty states are honest but instruct rather than *do* ("Run Find" should be a one-tap default search).

---

## 20. Onboarding

**Today:** new user lands on Home with setup warnings; profile is optional; no ICP.

**Ideal (10 minutes to first real prospect):**
1. What do you sell & typical price? (pre-filled "Websites for local businesses, £800–£3,000")
2. Where? (map/area picker; Scotland region expansion; England counties)
3. Who? (trade picks with value tiers pre-set)
4. Your website & examples (used in emails and the audit page)
5. How do you like to reach people? (Call / Email / Both; hours for calls)
6. Connect mailbox (Workspace recommended) — skippable
7. **First 20 prospects, generated in the background while you finish step 5**, shown with reasons
8. Pick 5 → review drafts → send or call
9. Today screen from then on

---

## 21. Workspace / ICP profile

Yes — make it the central concept. Expand `business_profile` into a **Workspace** record: offer, price range, target areas, target trades with value tiers, excluded trades/chains, preferred channels, tone, calendar link, sending identity, compliance settings (legal entity, address for signature, retention period). Every stage reads it: discovery (areas/trades), scoring (value tiers), personalisation (offer/tone), analytics (deal size). It is also the natural multi-tenant boundary (§23).

---

## 22. Security review

Much was hardened in the recent overhaul (token sealing, OAuth state HMAC, SSRF guard with DNS + redirect checks, auth on every server function, same-site checks, header-injection-safe MIME, stray-link rejection, quality gate against injected claims). Remaining:

| Area | Finding | Recommendation |
|---|---|---|
| Multi-tenant isolation | Queries scoped by `user_id` in code; no DB-level enforcement; owner allowlist hides this | Introduce `workspace_id`; add Postgres RLS or a single scoped query layer + cross-tenant tests before a second customer |
| Rate limiting | None on server functions (owner-only today) | Per-workspace limits on discovery/AI/send endpoints before opening sign-up |
| Prompt injection | Scraped text enters prompts; output gated for links/claims | Keep; also strip instructions-like text from evidence, cap evidence length, log rejected drafts |
| Secrets | Server-only, not in bundle (verified) | Set `TOKEN_ENCRYPTION_KEY` explicitly (currently derived from `DATABASE_URL`) |
| Third-party data endpoints | `bizdata` receives your search terms | Remove |
| Webhooks | None today (good); unsubscribe endpoint will need HMAC-signed links | Design with signatures + idempotency |
| XSS | React escaping; email bodies rendered as text (`.email-preview`) | Keep; never `dangerouslySetInnerHTML` for prospect data |
| Auth | Email/password only; no 2FA | Add passkeys/2FA before multi-user |
| Audit log | `activity_events` exists but not a security audit log | Add who-did-what for sends, deletes, settings |
| Region | Vercel `iad1` (US) processes UK personal data | Move functions to `lhr1`/`dub1`; Neon in EU; document transfers |

---

## 23. Compliance design (not legal advice — needs professional review)

| Topic | Product safeguard | Legal review needed on |
|---|---|---|
| PECR email to individual subscribers (sole traders, most English partnerships) | Legal-form detection: CH lookup (Ltd/LLP/Scottish partnership ⇒ corporate) vs not-on-CH ⇒ treat as individual ⇒ **phone/letter only by default**; personal mailbox ⇒ hold (exists) | Whether role inboxes of sole traders count as individual subscribers (ICO position: yes, sole traders are individuals) |
| PECR calls | TPS/CTPS screening before calling; internal do-not-call list | TPS licensing, frequency of screening (28 days is the usual expectation) |
| UK GDPR lawful basis | Legitimate interests assessment (LIA) template stored in Workspace; data minimisation (business data only; named individuals only where needed) | The LIA itself |
| Article 14 transparency (data not obtained from the subject) | Privacy notice link in every first email; notice explains source (CH/OSM/website), purpose, retention, rights | Wording; "disproportionate effort" is not a safe harbour here |
| Opt-out | Required line (exists) + one-click unsubscribe + suppression (exists) | — |
| Retention | Auto-delete never-contacted prospects after N months; contacted-no-reply after 12–24 months; keep suppression minimal forever | Periods |
| Access/erasure requests | "Find by email/phone/company" + export + erase (keeping a hashed suppression entry) | Process |
| Processor role (SaaS) | If PeakSwift becomes SaaS, customers are controllers, PeakSwift is processor: DPA, sub-processor list (Vercel, Neon, Google, xAI, search provider) | DPA, ToS |
| Data sources' licences | OSM ODbL attribution/share-alike implications for stored derived data; CH is open; Places terms forbid storage | ODbL obligations for a commercial database |

---

## 24. Performance

- `getOutreachState` loads *all* leads, emails (limit 5,000), suppression and campaigns in one call and re-sends it on every reload/visibility change. Fine at hundreds; will be the first thing to break (payload size, client memory) at a few thousand. Paginate and add per-screen queries.
- `sendQueue` runs `decideApproval` with `autoContext` rebuilt per email over all emails — O(n²) client-side. Fine at <200 drafts; memoise the context once.
- Discovery runs make many sequential calls from the browser; moving to a server job queue fixes both reliability and speed.
- AI calls are small and budgeted; no issue.
- No N+1 in the send path (single conditional update). Reply polling: one Gmail call per thread, capped at 40 per poll — fine.
- The server bundle is ~1.5MB single chunk (forced) → cold starts are heavier than they need be; acceptable until the rolldown issue is fixed upstream.

## 25. Scalability — what breaks first

| Users | First bottleneck | Fix |
|---|---|---|
| 1–10 | Public OSM/Nominatim policies; CH HTML blocking; Google OAuth "Testing" user cap (100) and verification for restricted scopes (`gmail.readonly` is a *restricted* scope → security assessment required for public apps) | Official CH API; OSM via own Overpass or provider; plan Google verification early (weeks + possible CASA assessment cost) |
| 100 | Browser-orchestrated runs; no job queue; `getOutreachState` payloads; shared search/AI budgets | Job queue (Inngest/Trigger.dev/Vercel Queues/QStash); per-workspace budgets; paginated APIs |
| 1,000 | Data costs (Places lookups, verifier, PSI quota 25k/day/project), support load around deliverability | Cache audits per domain (shared across tenants — website audits are not personal data); per-tenant credit metering |
| 10,000 | Gmail API per-project quotas, Postgres size of emails/evidence, observability | Partition by workspace, archive, dedicated queue workers |

Don't over-engineer: a single Postgres + a hosted job queue carries you to ~1,000 workspaces.

## 26. Cost model (estimates; verify current prices)

| Unit | Main costs | Estimate |
|---|---|---|
| Discovered business | OSM/CH free; own compute | ≈ £0.00 |
| Researched business (website found & verified) | 1–3 search calls (Tavily/Brave ≈ $0.005–0.01 each), fetches | ≈ £0.01–0.03 |
| Audited business | PSI free (quota), fetch, optional screenshot+LLM | ≈ £0.00–0.01 |
| Live Places check (optional) | Text/Details Pro ~$0.032 after 5k free/month | ≈ £0.00 (first 5k) – £0.03 |
| Personalised email | Grok 4 Fast-class model ≈ $0.20/M in, $0.50/M out ([pricing](https://www.morphllm.com/grok-api-pricing)); ~2k in/300 out | < £0.001 |
| Email verification (at send) | $3–8 per 1,000 | ≈ £0.005 |
| Call brief / reply classification | LLM | < £0.001 each |
| Fixed | Vercel Pro ~$20, Neon from ~$19, Workspace mailbox ~£6–12/user, TPS licence | ≈ £60–100/month solo |

**Cost per qualified prospect ≈ 3–5p; per contacted ≈ 5–10p.** At 1 client per ~150–300 contacts, *data/AI cost per customer is ~£10–30* — negligible against a £1–3k website. **The real cost is your time**; optimise the product for minutes-per-conversation, not API pennies. Expensive-at-scale features: Places lookups, LLM screenshot audits, verification of every discovered email (do it only at send).

---

## 27. Competitive landscape (2026)

| Category | Examples | What they do well | What users still struggle with | Relevance to PeakSwift |
|---|---|---|---|---|
| B2B contact databases | Apollo ($0–149/user/mo), ZoomInfo, Cognism, RocketReach | Huge people/company data, filters, sequences (Apollo) | Micro-SMB/sole-trader coverage is poor; UK local trades barely present; data decay; credit metering | Don't compete; they don't serve your segment |
| Enrichment orchestration | Clay ($185/mo "Launch" after its March 2026 reset) | Waterfalls, AI research columns, flexibility | Complexity, credit burn (teams pay ~3× headline) ([costbench](https://costbench.com/compare/clay-vs-apollo/), [docket](https://docket.io/resources/research/clay-alternatives)) | Borrow the *evidence column* idea, not the spreadsheet |
| Cold-email volume engines | Instantly (~$94/mo), Smartlead, Lemlist (from ~$55/mo) | Inbox rotation, warm-up, sequences, multichannel (Lemlist) | Volume culture → deliverability arms race; weak research; poor fit for UK PECR/sole traders | Explicitly *not* this |
| CRMs / engagement | HubSpot, Salesloft, Outreach | Pipeline, tasks, calling (enterprise) | Heavy, expensive, empty until you bring prospects | Integrate/export later, don't rebuild |
| Local-lead finders | D7 Lead Finder (~$45/mo), Outscraper (PAYG), "no-website" finders (NoSiteSearch, Webleadr, Apify actors) ([gtmdirectory](https://thegtmdirectory.com/compare/d7-lead-finder-vs-outscraper), [Apify](https://apify.com/webdata_labs/google-maps-no-website-leads-scraper.md)) | Cheap lists of local businesses, often from Google Maps | Lists without evidence, audit, compliance or workflow; many rely on scraping Maps (terms risk); US-centric | **Closest competitors**; beat them on evidence, audit, UK compliance and daily workflow |
| AI SDRs | many | Autonomous outreach promises | Real cost 3–10× entry price; brand/spam risk ([marketbetter](https://marketbetter.ai/blog/ai-sdr-pricing-real-cost-2026/)) | Avoid |

**Waste of time to copy:** contact databases, inbox rotation/warm-up networks, open/click tracking, LinkedIn automation, spintax, massive sequence builders, AI SDR autonomy, dialers with power-dial.

## 28. Differentiation & positioning

Strongest positioning found:

> **"PeakSwift finds the local businesses that need a better website, proves it, and tells you who to call and what to say — UK-compliant by design."**

Why it's defensible:
1. **Website Opportunity Audit** as a first-class artefact — useful in prospecting *and* in the sale (the audit becomes the proposal's first page).
2. **Evidence-backed scoring** with provenance — trust that list tools don't offer.
3. **Compliance as a routing feature** (corporate email vs sole-trader phone, TPS/CTPS, Article 14 notice) — a real UK advantage over US tools.
4. **Daily queue** — outcome-oriented UX rather than a database.
5. Narrow ICP (web designers/agencies selling to local SMBs) — the workflow fits exactly; later adjacent sellers (SEO, signage, bookkeeping for trades) reuse the engine with a different "need" axis.

## 29. Kill list — things we should NOT build (or should remove)

**Remove:**
- `src/lib/multiplayer/p2p.ts` (WebRTC mesh scaffolding from the app template; unused).
- The Bing search provider path (API retired).
- `bizdata-web.vercel.app` source.
- Companies House HTML scraping (replace with API).
- The legacy `/leads` sheet as a separate world and its client-side sync engine, once import lives in Businesses.
- Campaign lifecycle statuses beyond "active/archived"; campaign-specific pages.
- `auto_send` column and any path toward unattended sending.
- Settings exposing search/AI budgets to a solo user (keep as internal guardrails).

**Don't build:** autonomous AI SDR; inbox rotation/warm-up; open/click tracking pixels; LinkedIn/WhatsApp automation; SMS marketing (PECR consent for individuals; low value); call recording; a contact database; custom CRM fields/pipelines; invoicing/projects; Chrome extension; "AI-generated demo website" for every prospect (expensive, legally and ethically awkward to send unsolicited, rarely converts at scale — maybe later as a manual one-off for hot prospects); spintax; A/B frameworks beyond angle tagging; a mobile native app (PWA is enough).

## 30. Prioritised roadmap

### P0 — Critical (before relying on it)

| Item | Problem | Solution | Why | Deps | Complexity | Risk | Impact | Test | Schema | Ext. API | UX |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P0.1 Ship one version | Production runs old `main`; branch untested live | Merge branch, run in-app E2E test on production, delete stale previews | Everything else assumes the new app | none | S | Migration 0009 on prod DB (additive, tested) | High | E2E test + health check on prod | no (0009 already) | no | no |
| P0.2 Legal-form routing | Emailing sole traders risks PECR breach | CH API lookup → `legal_form` (corporate/individual/unknown); unknown/individual ⇒ call-only by default; email allowed only to corporate + role/company-domain address | Biggest legal risk | CH API key | M | Over-blocking | High | Unit (classification), integration (eligibility) | yes (`legal_form`, `ch_number`) | CH API | small |
| P0.3 Replace CH HTML scraping & bizdata | Brittle/unknown sources | CH official API; remove bizdata | Reliability, provenance | CH key | S–M | Fewer results short-term | Med | Contract tests with recorded fixtures | no | yes | no |
| P0.4 Workspace mailbox + auth records | Consumer Gmail sender | Move to Workspace domain mailbox; SPF/DKIM/DMARC; update pin | Deliverability, professionalism | domain | S (ops) | — | High | Health check verifies domain & DMARC | no | Google | no |
| P0.5 Scheduled reply/bounce polling | Bounces/opt-outs unprocessed until a click | Vercel Cron → poll per connected mailbox | Prevents mailing dead/opted-out addresses | P0.1 | S | Gmail quota | High | Integration with stand-in; cron idempotency | no | Gmail | no |
| P0.6 Unsubscribe header + endpoint | Missing List-Unsubscribe | HMAC-signed one-click endpoint → suppression | Complaints, compliance | — | S | — | Med | Unit + integration | no | no | no |
| P0.7 TPS/CTPS screen before calls | Unlawful calls risk | Licence + import + check; block numbers | Required for phone-first | P0.2 | M | Licence cost | High | Unit | yes (`tps_checked_at`, flags) | TPS data | small |
| P0.8 Privacy notice + retention job | Article 14, retention | Notice page + link in first email; nightly purge | Compliance | legal review | S | — | Med | Unit | small | no | small |

### P1 — High value (core workflow)

| Item | Problem | Solution | Deps | Complexity | Impact | Schema/API/UX |
|---|---|---|---|---|---|---|
| P1.1 Background job queue | Runs die with tab; no scheduling | Hosted queue (Inngest/Trigger.dev/Vercel Queues); move discovery + enrichment + audit server-side; UI subscribes to progress | P0.1 | M–L | High | new `jobs` table or provider; UX change on Find |
| P1.2 Website audit engine | No measured website evidence | PSI API + own HTML checks → `website_audits`; shareable audit page | P1.1 | M | **Very high** | new table; PSI API; new UI |
| P1.3 One scoring model | 4 scoring systems, starved signals | Need/Value/Reachability with reasons & provenance; remove old scorers | P1.2 | M | High | `lead_scores` or computed; UX everywhere |
| P1.4 Today queue (Home) | App is a set of screens | Rules-based next-action engine + "Start my day" | P1.3 | M | **Very high** | `tasks` table; Home redesign |
| P1.5 Call mode + brief | Calling second-class | Mobile call screen, AI brief from evidence, voice notes, timeline | P1.3 | M | High | `interactions` table |
| P1.6 Pipeline with money | No deals | `opportunities` (stage, value, dates, lost reason), attribution | P1.4 | M | High | new tables; Replies → pipeline |
| P1.7 Reply classification v2 | Binary-ish classes | LLM+rules classes incl. referral/later/wrong-person; auto-freeze automation | P0.5 | S | Med | enum change |
| P1.8 Evidence items + angles | Samey emails | Evidence items table, angle selection, claim-check, angle attribution | P1.2 | M | Med–High | `evidence_items`; email `angle` |
| P1.9 Merge lead sheet into Businesses | Two worlds | CSV import into server model; retire client store | P1.1 | M | Med (simplicity) | deletes code; migration for any local-only data |

### P2 — Important (after the core is excellent)

Workspace/ICP profile + onboarding (§20–21) · email verification at send · Places live lookups (place_id only) · England region expansion · revenue analytics · customer/do-not-contact domain list · Google OAuth verification for public use · EU/UK region hosting · security audit log · keyboard-first review UI.

### P3 — Future (only with proven demand)

Multi-tenant workspaces + billing · shareable audit landing pages with tracking of *their* visits (consent-safe) · adjacent verticals (SEO, signage) via the Need axis · HubSpot export · direct-mail letters for sole traders (PECR-friendly channel) · second mailbox per workspace · team seats.

## 31. Implementation phases

**Phase 0 — Stabilise & comply (1–2 weeks).** P0.1–P0.8. Files: `src/lib/companies-house.ts` (API client), `src/lib/osm-discover.ts` (remove bizdata), `src/lib/outreach/eligibility.ts` (legal-form rules), `src/lib/gmail/mime.ts` (List-Unsubscribe), new `src/routes/api/unsubscribe.ts`, `vercel.json` crons, new migration `0010_compliance.sql` (`legal_form`, `ch_number`, `tps_*`, retention). Tests: eligibility matrix for legal forms, unsubscribe signature, cron idempotency, CH contract fixtures. Done when: production runs the new app, first 10 real emails sent from a domain mailbox via the E2E-tested path, no sole-trader email possible by default, bounces processed within 30 min.

**Phase 1 — Prove the prospect (3–4 weeks).** P1.1–P1.3. Job queue; `website_audits`, `source_records`, `evidence_items`; unified scorer in `src/lib/scoring/`; delete `decision.ts`/pool scorer overlaps. Tests: audit parsers on saved HTML fixtures, PSI response fixtures, scoring reasons snapshot tests, job retry semantics. Done when: "Find 20 in Perthshire roofers" completes in the background and every result shows ≥3 sourced reasons, with a measured audit for any business with a site.

**Phase 2 — Work the day (3 weeks).** P1.4–P1.7. `tasks`, `interactions`, `opportunities`; Today screen; Call mode; reply classes. E2E (Playwright) for Today → call → outcome → task. Done when: a full day's work (replies, calls, sends, follow-ups) happens from Today on a phone without visiting other screens.

**Phase 3 — Better words (2 weeks).** P1.8 + verification at send. Done when: every factual sentence in an AI draft links to an evidence item, and angle-level reply rates appear once samples allow.

**Phase 4 — Simplify (1–2 weeks).** P1.9 + kill list removals; nav reduced to Today, Businesses, Pipeline, Insights, Settings. Done when: one data model, one scoring model, one list.

**Phase 5 — Workspace & onboarding (2–3 weeks).** P2 items needed for a second user. Done when: a new account reaches first 20 scored prospects in <10 minutes.

**Phase 6 — Commercial readiness (only after PeakSwiftStudio revenue proves it).** Multi-tenancy, RLS, billing, Google OAuth verification, DPA, UK/EU hosting.

## 32. 7 / 30 / 60 / 90-day plan

**Next 7 days**
- Merge the branch; run Settings → Gmail → *Run end-to-end test* on production; delete stale preview deployments.
- Set up a Workspace mailbox on your domain with SPF/DKIM/DMARC; reconnect Gmail to it; set `GMAIL_SENDER`.
- Get a Companies House API key; replace HTML scraping (small, contained change).
- Remove `bizdata`, the Bing path and `multiplayer/p2p.ts`.
- Add List-Unsubscribe + signed unsubscribe endpoint; Vercel Cron for reply polling.
- Use the app for real: 10 emails/day to *corporate* addresses only; 10 calls/day to Ltd companies. Log time spent.
- Book a one-hour review with a UK data-protection solicitor on the PECR/sole-trader and TPS questions (§23).

**Next 30 days**
- Legal-form routing + TPS/CTPS screening live.
- Background job queue; discovery/enrichment server-side.
- Website audit v1 (PSI + 12 HTML checks) and audit-cited email angle.
- Unified scoring with reasons.
- Target outcome: ≥5 real conversations, ≥1 quote from app-sourced prospects; measure minutes per conversation.

**Next 60 days**
- Today queue as Home; Call mode with briefs and notes; pipeline with values.
- Retire the lead sheet; CSV import into Businesses.
- Shareable audit page for positive replies/calls.
- Target: first won client attributable end-to-end in the app.

**Next 90 days**
- Workspace/ICP profile + onboarding; England region expansion.
- Revenue analytics; angle learning.
- Decide on commercialisation using your own numbers: conversations/week, win rate, £ per hour. Only then start Phase 6 (and Google OAuth verification, which takes weeks).

---

## 33. If this were my product

**Core product:** a *website-opportunity sales assistant* for people who sell websites to local UK businesses. Not a database, not a mailer — a daily workflow that turns an area and a trade into conversations, with proof.

**Who first:** you (PeakSwiftStudio) for 60–90 days; then 5–10 freelance web designers/small agencies in Scotland you can talk to directly. They share your problem exactly, value the audit artefact, and can't justify Apollo/Clay/HubSpot.

**Problem to own:** "Which local businesses should I contact this week, how do I prove to them they need a better website, and how do I do it legally?"

**Main workflow:** Today → call or email the top items → log outcome in one tap → pipeline moves → app tops up prospects in the background.

**Remove:** the lead sheet world, campaigns as a concept, multiplayer scaffolding, dead providers, unknown data sources, anything that sends without you.

**Build:** background jobs, website audit, one explainable score, legal-form + TPS routing, Today queue, Call mode, pipeline with £, revenue analytics.

**Don't build:** autonomous AI outreach, volume sending infrastructure, databases, LinkedIn automation, recording, custom CRM.

**AI:** research summaries, email drafts from evidence, call briefs, reply classification, the one-line "why" per prospect. Never deciding who to contact, never sending.

**Interaction model:** phone-first, one decision per screen, evidence always one tap away, everything logged without typing.

**Difference:** proof (measured audits + sourced reasons), UK compliance baked into routing, and a daily queue that ends in revenue — none of which the list tools or the volume mailers do.

**Money (later, after your own results):**
| Model | Pros | Cons |
|---|---|---|
| Flat monthly (e.g. £39–79/seat) | Simple, predictable, matches small agencies | Heavy users cost more (audits, Places) |
| Credits | Aligns with data costs | Users hate metering (Clay/Apollo complaint) |
| Hybrid: plan includes N audited prospects/month, top-ups | Predictable + fair | Slightly more complex |
| Pay-per-lead | Easy to sell | Incentivises volume over quality — against the product's thesis |
| Agency plan (multi-seat, white-label audit PDFs) | Higher ACV | Needs multi-tenancy + branding |

Recommendation: **hybrid** — a plan with a generous monthly allowance of *audited, scored* prospects (the valuable unit), unlimited sending within safe limits, top-ups for audits. Avoid pay-per-lead.

**Personal weapon vs product now:** build as a personal weapon with product-shaped foundations (workspace boundary, job queue, source provenance). Designing for strangers now would pull effort into onboarding, billing and Google OAuth verification before you know the workflow wins clients.

## 34. Ideal future architecture

```
Browser (PWA)  ── Today / Businesses / Pipeline / Insights / Settings
   │  server functions (auth, workspace-scoped)
   ▼
App server (Vercel, lhr1)
   ├─ Query layer (workspace_id enforced; RLS)
   ├─ Job queue (discovery, enrichment, audit, reply polling, retention, digests)
   ├─ Source adapters: CompaniesHouse · OSM(Overpass) · Search · Places(live, place_id only) · Import
   ├─ Entity resolution → businesses + source_records
   ├─ Enrichment: website verify → audit (PSI + HTML) → contacts → legal form → TPS
   ├─ Scoring (Need/Value/Reachability, reasons with provenance)
   ├─ Channels: Gmail/Workspace (send, poll), Phone (tel:, notes), Unsubscribe endpoint
   ├─ AI service (drafts, briefs, classification) behind claim-check + budgets
   └─ Observability: structured logs, metrics, alerts
Postgres (Neon EU): workspaces, users, businesses, source_records, contacts, website_audits,
  evidence_items, scores, interactions, messages, opportunities, tasks, suppression, jobs, audit_log
```

### Schema changes (summary)
New: `workspaces`, `workspace_members`, `source_records`, `contacts`, `website_audits`, `evidence_items`, `interactions`, `opportunities`, `tasks`, `jobs` (if not provider-managed), `audit_log`, `dnc_numbers`. Changed: `leads` → `businesses` (+ `workspace_id`, `legal_form`, `ch_number`, `place_id`, `tps_status`, `last_verified_at`); `outreach_emails` (+ `angle`, `contact_id`, `opportunity_id`); retire `campaign_prospects` into tags/saved searches.

### Observability
Structured JSON logs with `workspace_id`, `job_id`, `email_id`; metrics: sends, bounces, complaints, reply rate, job failures, source zero-yields, AI rejections, Gmail auth failures. Alerts: any Gmail `auth` failure; bounce rate >3% in 24h; a source returning zero for a day; job failure rate >10%; AI budget exhausted; cron not run for 2 intervals. Tools: Vercel logs + drains to a hosted log service (e.g. Axiom/Better Stack), Sentry for errors, a daily digest email to you. Skip full APM.

### Testing strategy additions
Keep the unit/integration base (it's strong). Add: recorded-fixture contract tests for each source adapter; Playwright E2E for Today/Call/Send on the built app; a nightly staging job that runs discovery for one fixed area and asserts yields; a weekly *real* Gmail round-trip to a test mailbox; cross-tenant isolation tests before a second customer; migration upgrade test per new migration (pattern exists).

## 35. Ideal future user journey

1. **Sign up** with email or Google; create workspace "PeakSwiftStudio".
2. **Onboard** (5 questions, 3 minutes): offer & price, areas (map), trades (value tiers), channels & calling hours, your site & examples. The first discovery job starts in the background during step 3.
3. **Define ICP** — saved as the workspace profile; editable any time; every score explains which ICP rule it used.
4. **Find businesses** — Top 20 appear within minutes, each with a one-line why and a channel badge (Email / Call / Letter).
5. **Qualify** — open one: Need/Value/Reachability with sources; audit summary; legal form; TPS status. Override if you know better.
6. **Research** — the audit page (speed, mobile, forms, booking, copyright year, Google status) — shareable.
7. **Contact** — email drafts citing only measured facts, reviewed in a compact list; send 5–10 from your domain mailbox; or…
8. **Call** — Call mode on your phone: brief, opener, likely objection; one-tap outcome + voice note.
9. **Reply** — replies arrive automatically, classified; automation freezes; Today shows "3 replies need you" with suggested next step.
10. **Follow up** — approved, evidence-refreshed follow-ups on day 4/10; OOO pauses; bounces reroute to phone.
11. **Close** — meeting → quote (value) → won/lost with reason; the audit becomes page one of your proposal.
12. **Revenue** — Insights shows £ won, £ in pipeline, and which trades/areas/angles/channels produced it, and how many hours each client took. The weekly digest suggests next week's areas.

---

## Sources

- ICO — Business-to-business marketing: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/
- Mondaq — Data (Use and Access) Act 2025 changes: https://www.mondaq.com/uk/privacy-protection/1649782/data-use-and-access-act-2025-key-privacy-law-changes-for-uk-businesses
- Telerivet — PECR, B2B exemption and DUAA 2025: https://www.telerivet.com/blog/uk-sms-compliance-pecr-gdpr-duaa
- Companies House API rate limiting: https://developer-specs.company-information.service.gov.uk/guides/rateLimiting
- Google Places pricing (2025 free caps): https://www.woosmap.com/en-gb/blog/google-maps-api-pricing-breakdown · https://openplacesapi.com/blog/google-places-api-pricing
- Google Places storage/caching policies: https://developers.google.com/maps/documentation/places/web-service/policies?authuser=6 · https://openplacesapi.com/blog/can-you-store-places-api-results
- Gmail/Yahoo sender requirements: https://bird.com/en-de/docs/knowledge-base/deliverability/gmail-yahoo-requirements · https://suped.com/email-deliverability/answers/how-is-gmail-enforcing-its-new-sender-requirements-and-what-impact-are-senders-seeing
- PageSpeed Insights API quota: https://freeapihub.com/apis/pagespeed-insights-api
- Email verification pricing/accuracy: https://bouncezero.io/best-email-verifier-2026
- xAI pricing: https://www.morphllm.com/grok-api-pricing
- Apollo vs Clay pricing 2026: https://costbench.com/compare/clay-vs-apollo/ · Clay alternatives: https://docket.io/resources/research/clay-alternatives
- AI SDR real cost: https://marketbetter.ai/blog/ai-sdr-pricing-real-cost-2026/
- Local lead finders: https://thegtmdirectory.com/compare/d7-lead-finder-vs-outscraper · https://apify.com/webdata_labs/google-maps-no-website-leads-scraper.md

*Prices and third-party terms change frequently; verify each before committing money or architecture. Nothing in §5, §12, §14 or §23 is legal advice.*
