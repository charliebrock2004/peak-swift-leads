# PeakSwift Leads — transformation report

Branch `claude/production-overhaul`, 26 commits on top of `main`, one per phase (A–K plus fixes). Nothing has been promoted to production. Every commit passed typecheck, lint and a production build locally before it was pushed.

North star: **minutes of your time → a real conversation → a customer → £ revenue.**

---

## 1. What changed

### Phase A: production and source safety
- **Companies House:** now uses the official public data API (`COMPANIES_HOUSE_API_KEY`, Basic auth, never in a URL). Search is by SIC code and town, with name search as fallback. It reads the company profile and officers (names and roles only). A shared database budget stays under the 600 requests / 5 minutes limit.
- **Discovery sources:** the undocumented "bizdata" source and Bing (retired by Microsoft) are removed. Tavily and Brave remain.
- **Unsubscribe:** every email carries a signed, non-expiring one-click unsubscribe link and `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058). The GET request changes nothing, so mail scanners can't unsubscribe anyone. The POST suppresses the address permanently and withdraws any queued email to it.
- **Logging:** structured JSON logs that redact credentials by field name and by value shape.

### Phase B: data model, evidence, contactability
- **Provenance:** source records, and evidence items that each have a source, URL, date and confidence. Old evidence is superseded, never overwritten.
- **Legal form:** classified as CORPORATE, INDIVIDUAL, UNKNOWN or REVIEW_REQUIRED from Companies House, the name suffix (configurable), and mailbox and name signals. **UNKNOWN is never email-eligible.**
- **Email rules:** a personal mailbox counts as an individual subscriber, so the app suggests a call instead. A verifier result of "invalid" blocks the email. A catch-all address is never treated as valid.
- **Call rules:** a number is ELIGIBLE only when screened clear of both TPS and CTPS within the last 28 days, or when they asked for the call. There is an internal do-not-call list, and recorded objections cannot be removed.
- **Entity resolution:** never merges two businesses on similar names alone, never merges two company numbers, and respects a ruling you made.

### Phase C: Website Opportunity Engine
- **The audit:** fetches the homepage through the public-address guard, plus robots.txt, the sitemap, internal links and Google PageSpeed (mobile). Findings are dated measurements ("PageSpeed measured 42/100 on 30 Sept"), never opinions. The audit history is kept.
- **Website states:** VERIFIED_NO_WEBSITE, WEBSITE_FOUND, NOT_CONFIRMED, SOCIAL_ONLY, DIRECTORY_ONLY or UNREACHABLE. The app only says a business has no website after a recent, successful search that found none.
- **Audit page:** a full audit page per business.

### Phase D: one scoring model
- **Four scorers became one.** The previous four competing scorers are replaced by a single one (`scoring/prospect-score.ts`) with three parts:
  - **Need:** measured website evidence.
  - **Value:** trade tier, reviews, active company, and your profile.
  - **Reach:** the same email and call verdicts the send gate enforces.
- **What it outputs:** one band (STRONG, GOOD, WEAK or NONE) and one action (CALL, EMAIL, REVIEW, SKIP or WAIT), with blockers and the evidence behind them. Stale evidence counts for less, and the app says so.

### Phase E: background jobs
- **Jobs table:** leases, per-step checkpoints, retries with backoff, and one active job per type per account.
- **What runs as a job:** Find, website audit batches, Companies House batches, reply polling and data retention.
- **What keeps jobs moving:** the browser while it is open, a self-chaining `/api/jobs/tick` (protected by `CRON_SECRET`), and a daily cron. **Closing the tab no longer stops a run.**
- **Find:** stages, an outcome summary, and a best-first list.

### Phases F–H: Today, calling, pipeline
- **Today:** "what to do now", in the order sales are won: replies, warm conversations, quotes, meetings, calls, emails, then finding more prospects.
- **Call mode:**
  - One business per screen.
  - A call brief: why this business, an opener, likely objections, the ask and a fallback.
  - One-tap outcomes, with dictated notes.
  - Each outcome creates the right task and moves the sale's stage.
- **Business page:** a timeline (calls, notes, emails, replies, audits, stage changes), tasks and the sale.
- **Pipeline:** Contacted, Conversation, Meeting, Quote sent, Won, Lost and Nurture, with values in £. The stage moves forward on its own from evidence; a closed stage you set always stands.

### Phase I: AI personalisation 2.0 and replies
- **One angle per email:** each email has one angle (no website, reputation gap, missing enquiry form, mobile, speed, …) chosen from evidence. The writer only sees that angle's evidence.
- **Claim checking in code:** every claim about their site needs a measured audit finding for this business. Numbers must match the measurement. Search ranking or SEO is never claimed. Sales-speak, fake compliments and shouting are refused.
- **Reply intents:** positive, neutral, negative, objection, out of office, unsubscribe, referral, wrong person, later. Each creates the right task. **Nothing is ever sent automatically.**
- **Background reply checks:** every 15 minutes while the app is open, plus the daily cron.
- **Verification before sending:** email verification just before an email becomes send-ready. It uses DNS by default; ZeroBounce or NeverBounce are optional.

### Phase J: legacy cleanup
- **One business list:** the old browser-held `/leads` sheet is retired, and there is one server-held business list.
- **Migration of local data:** businesses saved in the browser are pushed to the account once, then the local copy is removed. `/leads` redirects to Businesses.
- **On the server:** add, edit, remove, CSV import (duplicates are merged, not added) and CSV export (with the unified score and a guard against spreadsheet formula injection).

### Revenue analytics and the north star (task 16)
- **Funnel:** Found → Contactable → Contacted → Conversation → Meeting → Quote → Won, built from evidence. A lost sale keeps how far it got.
- **Money:** £ won (all time and this month), open pipeline, quotes out, and average job.
- **Breakdowns:** time between steps (median), where conversations come from (email or phone, with emails or calls per conversation), and performance by trade, town and email angle.
- **Minutes per conversation, minutes per customer and £ per hour of prospecting**, from measured time only:
  - App time counts while the app is visible and in use.
  - Call time is the minutes you confirm when logging a call; the timer starts when you tap Call.
- **Sample-size rules:** a figure is withheld until it has enough data behind it. Rates need 5, timings 5, per-conversation figures 3 conversations, and per-customer figures and £/hour 2 customers.

### Feedback loop, workspace profile, welcome (task 17)
- **Ten marks** on any business: good, useful, bad, irrelevant, not in the trade, wrong business, duplicate, wrong website, already has a good website, contact details wrong.
- **What the marks do, by fixed rules (no model is trained):**
  - **Rejecting marks:** the business leaves every queue, is refused at the send gate (follow-ups included), and Find won't add it again even after you remove it.
  - **Wrong website:** the site comes off the record and is never attached to that business again. An email address on that site's domain stops being used, and audits of that site are ignored.
  - **Contact details wrong:** the email and phone aren't used until you edit them.
  - **Good marks:** a small, labelled lift in the score.
  - **Sources:** a discovery source you mostly reject ranks lower (only after 5 marks).
  - **Trades:** a trade search you mostly reject is flagged on the Find form.
- **Workspace profile:** target areas and trades, preferred and excluded trades, typical and minimum job, how you make first contact, past work and business address.
  - Find starts from your areas and trades.
  - Scoring respects your preferred and excluded trades, your minimum job, and your channels.
  - Today drops cold calls if you only email.
  - The writer may mention one piece of your past work.
  - Insights compares your average won job with the typical job you gave.
- **Welcome (`/welcome`):** seven questions on one screen, then "Find my first 20 prospects".

### Phase K: performance, security, observability
See sections 4 and 6.

### Testing (task 19)
- The nine critical journeys, end to end (section 7).

---

## 2. What was removed
- **Discovery sources:** the "bizdata" source (undocumented third-party endpoint) and Bing Web Search.
- **Multiplayer scaffolding:** the unused WebRTC module.
- **Scorers:** three of the four scorers (`decideProspect` HOT/WARM, `explainOpportunity`/`computeOpportunity`, the discovery pool's own ranking) and `decision.ts`.
- **The legacy lead sheet:**
  - Files: `components/leads/*`, `pages/leads.tsx`, `store/leads-store.ts` (the zustand local store), `lib/use-lead-sync.ts` and its tests.
  - Helpers: `computePriority`, `priorityReason`, `compareLeads`, `summarise`, `websiteSignal`, `SAMPLE_LEADS`.
- **Not removed:** every send-safety mechanism (duplicate prevention, claim locks, suppression, Gmail proof, Message-ID, reconciliation, limits, human approval, bounce and unsubscribe handling) is intact and still tested.

---

## 3. Database changes
All migrations are additive (new tables or new nullable/defaulted columns), safe to apply while the previous release is serving, and safe to re-run. Old code ignores the new columns and tables.

| Migration | What |
|---|---|
| 0010 `evidence_contactability` | `source_records`, `evidence_items`, `phone_screening`, `call_suppression` (do-not-call), `email_verifications`, `entity_overrides`; company and legal-form columns on `leads` |
| 0011 `website_audits` | `website_audits` (history: findings, PageSpeed, key findings, opportunity) |
| 0012 `jobs` | `jobs` (leases, checkpoints, retries, idempotency) |
| 0013 `sales` | `interactions`, `tasks`, `opportunities` |
| 0014 `angles_reply_intent` | `outreach_emails.angle`, `outreach_emails.reply_intent` |
| 0015 `time_log` | `time_log` (measured seconds per day and kind) |
| 0016 `workspace_feedback` | Ten profile columns on `business_profile` (incl. `onboarded_at`); `prospect_feedback` |

- **Rollback:** reverting the code leaves these tables unused and harmless. Dropping them is only necessary if you want the data gone.
- **Mid-migration safety:** loading businesses and the profile still works if 0016 hasn't run yet (they fall back to the older shape).
- **Tests:** a migration-upgrade test applies all migrations to a database holding older data.

---

## 4. Architecture: before → after

| Area | Before | After |
|---|---|---|
| Business data | Browser-held sheet synced to the server, plus a server copy | One server-held list; the browser copy is migrated once, then removed |
| Long work (Find) | Ran in the browser tab, and died with it | Resumable server jobs (leases, checkpoints, retries), with cron and self-chaining |
| Prospect quality | "No website field on a map listing" | Website verification + measured audit + legal form + contactability, each with provenance |
| Scoring | Four scorers that disagreed | One model (need × value, reach), with evidence and an action |
| AI | Free-form email from loose facts | One evidence-backed angle, then the draft, then claims checked in code, then human review |
| Sales | Emails only | Today, tasks, calls, interactions, timeline, pipeline, revenue |
| App state on tab return | Full reload of everything (≈7.7 MB at 3,000 businesses) every time | One fingerprint query; a full load only if something changed |
| Send queue | Quadratic (359 ms at 460 queued) | Linear (64 ms), verified identical |
| Logs | `console.error` strings | Named JSON events with account, job, business and email ids; secrets redacted |

---

## 5. UX: before → after
- **Navigation:** Today, Businesses, Pipeline, Insights and Settings (five tabs on mobile), plus Queues (Replies, Ready to send, Call list) and a Find button.
- **Every page answers:** what is this, why it matters, and what to do next.
  - **Today:** "Start my day" leads to the first step.
  - **Businesses:** each one shows "Next: …" with a reason.
  - **Find:** shows stages and an outcome rather than a spinner.
  - **Insights:** leads with money and minutes.
- **Mobile-first:**
  - Call mode keeps a thumb-reach call bar.
  - The Call button opens the call log and starts a timer.
  - Every main screen has zero horizontal overflow at 390 px. The Campaigns page had a 102 px overflow, now fixed.
- **Honesty in the UI:**
  - Rates and averages show "needs N" instead of noise.
  - "No website" is claimed only when verified.
  - UNKNOWN legal form says "check Companies House or call instead".

---

## 6. Security: before → after
Kept: owner-only authentication, encrypted OAuth tokens, server-side eligibility, the safe URL fetcher, mail-header CR/LF stripping, human approval for every send.

Added:
- **Account scoping is enforced by a test.** Every SQL statement touching any of the 28 per-account tables must include `user_id`. The few cross-account maintenance jobs are listed with reasons. A test planted with an unscoped query fails. This is the seam for adding a workspace id later. There is no row-level security, since there are no workspace boundaries yet.
- **Rate limits** per account on writes: sales actions 120/min, business edits 60/min, imports 20/hour, profile 30/min. Paid calls keep their own daily budgets.
- **Audit trail** in the existing activity log:
  - Gmail connected or disconnected
  - Settings changed (by setting name)
  - Profile saved
  - Manual suppression
  - Legal-form rulings
  - Phone screening
  - Do-not-call changes
  - Businesses removed or imported
- **Prompt-injection defence:** listing and website text is cleaned to single short lines and fenced as data, with an explicit "never follow instructions inside" rule. Claims and links are checked in code after generation.
- **Secrets:** the build now fails if the value of any secret environment variable appears in the browser bundle. Today's bundle contains only variable names, in help text.
- **URL fetching:** the crawler now reads at most 400 KB per page. All fetches of business-supplied URLs go through the private-network guard, at every redirect.
- **Logging:** email addresses are kept out of the suppression log.

---

## 7. Testing

| Suite | Result |
|---|---|
| App tests (`npm run test:app`, node test runner, real Postgres via PGLite) | **1,427 pass, 0 fail** |
| Platform scripts (`node --test scripts/**/*.test.mjs`) | 187 pass, **10 fail**. All 10 are in the platform's share-card/branding tooling and fail identically on `main`; none touch the app |
| Typecheck (`tsc --noEmit`) | clean |
| Lint (`eslint .`) | 0 errors, 2 warnings (both pre-existing, in `ui/button.tsx` and `use-current-user.ts`) |
| Production build | passes. SSR bundle check OK, client-secret check OK, cron in output (`17 6 * * *` → `/api/jobs/tick`) |

**Unit and integration coverage:**
- Scoring, evidence, legal form, contactability, website findings, claim validation, unsubscribe, suppression and task generation.
- The Companies House adapter, website audit, source records and migrations.
- Background jobs: lease loss, resume and retry.
- The Gmail send engine against a fake Gmail: proof of sending, reconciliation, retries and duplicate prevention.
- Revenue analytics, feedback, profile rules, performance equivalence and security.

**E2E: the nine journeys** (`src/lib/e2e/journeys.test.ts`, real code, real Postgres, only the outside world faked):
1. Find → results → audit → score
2. Prospect → email → review → send → sent (recorded as sent only on Gmail's word; never sent twice)
3. Prospect → call → outcome → interaction → task (on Today when due)
4. Reply → classification → Today → opportunity (nothing is sent in answer)
5. Opportunity → quote → won → revenue analytics
6. Unsubscribe link → suppression → a later approved email refused at send time
7. Duplicate prospect → dedupe (a rejected one never returns)
8. Wrong website → rejection (audit ignored, email refused, domain never re-adopted)
9. Unknown legal status → email refused at review and at send; offered as a call

**Browser checks:** done with Playwright in the sandbox on desktop (1280 px) and mobile (390 px), not committed as a suite.
- Today, Businesses, a business page, Pipeline, Insights, Find, Calls, Send, Replies, Settings, Welcome, Runs and Campaigns.
- No console errors, and no horizontal overflow after the Campaigns fix.
- Flows driven by hand:
  - The welcome form through to the Find run
  - Feedback marks and their effects
  - Call minutes, from tapping Call to the logged total
  - Find defaults coming from the profile
  - The tab-return fingerprint: 74.5 KB → 253 bytes on the test account

---

## 8. Real-world tests: what was actually tested
**Honestly: none against real businesses.**
- **Why:** this sandbox's network policy refuses every data source. That includes OpenStreetMap (Nominatim, Photon, Overpass), Companies House and the businesses' own websites. Every real Find run here ends with "the map lookup service could not be reached". The failure path was verified, and the success path was verified with fakes.
- **Not checked live:** Gmail sending and xAI drafting. Tests use a fake Gmail and a fake generator, and there is no xAI key in this environment.
- **Where to run it:** the Vercel preview deployment does have internet access. Run section 10's validation protocol there before trusting any score.

---

## 9. Remaining limitations (brutally honest)
1. **Scoring is untested against real data.** The thresholds (STRONG ≥ 70, audit weights, trade tiers) are reasoned, not fitted. Expect to adjust them after the first 20 real businesses. The feedback marks exist precisely so you can see where it's wrong.
2. **Latest preview builds not checked.**
   - Every commit builds locally, but I couldn't check the Vercel preview builds for the last commits: the Vercel connector lost access to your team mid-session.
   - The Phase D preview was READY; Phase E was building at the last check.
3. **Previews may migrate your production database.** The build runs `db:migrate` against whatever `DATABASE_URL` the deployment has. If preview deployments use your production Neon database, these additive migrations may already have been applied there. They are safe, but confirm which database previews use, and ideally give previews a Neon branch.
4. **First load is still everything.** Returning to the tab is now cheap, but the first load still fetches every business and email. That's fine to a few thousand businesses; beyond that the Businesses list needs server-side paging.
5. **Measured time starts at deploy.**
   - Minutes per conversation counts only measured time from deploy onward: in-app activity, plus call minutes you confirm.
   - Quoting and site visits outside the app aren't counted.
   - Conversations from before measuring began are excluded on purpose.
6. **The feedback loop is deliberately slow to act.** A source or trade needs 5 marks before anything moves. Excluded trades are scored out and never queued, but an email you had already approved before excluding the trade isn't re-blocked at send time.
7. **Reply polling** runs every 15 minutes while the app is open, plus once a day by cron. Vercel Hobby allows only daily crons. With the app closed, a reply can wait up to a day to reach Today.
8. **Email verification** defaults to a DNS check. It confirms the domain takes mail, not that the mailbox exists, unless you configure ZeroBounce or NeverBounce.
9. **The scoping test** reads SQL in template literals. SQL assembled some other way would escape it. None exists today.
10. **Browser checks aren't in CI.** The journeys are in CI-able tests; the browser checks were run by hand in this session.
11. **Pre-existing test failures and warnings** remain: 10 platform-tooling test failures and 2 lint warnings, both unrelated to this work.

### Legal questions for professional review (conservative defaults are in place)
- **Legal form:** treating any business not confirmed as a company (UNKNOWN) as an individual subscriber, so no marketing email is sent without consent (PECR reg. 22).
- **"Ltd" in the name:** counts as a company until checked. This is a setting you can switch off.
- **Calls:** 28-day validity for TPS/CTPS screening; calls are allowed only when screened clear of both registers.
- **Data retention:** for prospect data, interaction notes and measured time. Retention prunes jobs (30 days), old audit history and superseded evidence. A retention period for prospects is a decision for you.
- **Unsubscribe and identification wording:** the opt-out sentence and footer link, and whether your business address must appear (it is optional in the profile).
- **Officer names:** Companies House officer names are shown for context only and are never emailed. Confirm your lawful-interest assessment.

---

## 10. Production deployment steps (exactly)

**1. Re-authorise Vercel access**, if you want me to check builds and logs for you. Otherwise, check the Deployments tab yourself.

**2. Environment variables in Vercel → Project → Settings → Environment Variables (Production):**

| Variable | Status | Purpose |
|---|---|---|
| `DATABASE_URL` | already set | Neon |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_OWNER_EMAIL`, `VITE_AUTH_ENABLED=true` | already set | sign-in |
| `TOKEN_ENCRYPTION_KEY` | recommended | encrypts Gmail tokens. If unset, the key comes from `DATABASE_URL` or `BETTER_AUTH_SECRET`; whichever is in use must never change, or you will have to reconnect Gmail |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | required | Gmail. Optional: `GOOGLE_REDIRECT_URI`, `GMAIL_SENDER` to pin the sending account |
| `APP_URL` | required | your custom domain, so unsubscribe links never point at a preview URL |
| `CRON_SECRET` | **new** | protects `/api/jobs/tick` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | if Deployment Protection is on | lets jobs chain themselves |
| `COMPANIES_HOUSE_API_KEY` | **new**, free | developer.company-information.service.gov.uk |
| `PAGESPEED_API_KEY` | recommended, free | Google Cloud; keyless works at a small quota |
| `TAVILY_API_KEY` (or `BRAVE_SEARCH_API_KEY`) | recommended | website search; without it "no website" can never be verified |
| `XAI_API_KEY` | optional | AI drafts; templates are used without it. `XAI_MODEL` is optional |
| `EMAIL_VERIFIER=zerobounce`/`neverbounce` + `EMAIL_VERIFIER_API_KEY` | optional | mailbox-level verification |

**3. Open a pull request** from `claude/production-overhaul` to `main`. Ask me and I'll open it. Read the preview, then sign in on it.

**4. On the preview:**
- Settings → Gmail shows a passing health check.
- "Send a test email" (Settings → Gmail) to your own address. Check it arrives, and check its unsubscribe link points at `APP_URL`.
- Walk the welcome, then run the validation protocol below.

**5. Merge to `main`.** The production build applies migrations 0010–0016 itself.

**6. After deploy:**
- In Neon, `select count(*) from prospect_feedback` returns (the table exists).
- Vercel → Crons shows `/api/jobs/tick` daily.
- The logs show `job_finished` after your first Find.

### Production promotion checklist (do not skip)
- [ ] All variables above set in **Production**. The token key (`TOKEN_ENCRYPTION_KEY`, or `DATABASE_URL`/`BETTER_AUTH_SECRET` if it is unset) is unchanged.
- [ ] Confirmed which database preview deployments use (a Neon branch, ideally).
- [ ] Preview: sign-in, Gmail health check, test email received, unsubscribe link correct and working (click it on the test email, then check Settings → Compliance → Suppression list).
- [ ] Preview: one real Find (20 businesses) completed with the tab closed part-way.
- [ ] Preview: validation protocol passed (below), with at most 2 of 20 STRONG/GOOD prospects that are clearly wrong.
- [ ] No email sent to a real prospect from the preview.
- [ ] Merged. Production build green. Migrations confirmed in Neon.
- [ ] Production: Gmail health check passes, test email received, cron listed.
- [ ] Legal items in section 9 reviewed, or accepted as conservative defaults.

### Real-world validation protocol (20 Perthshire businesses)
- **Setup:** Welcome → areas "Perth, Crieff". Trades: your best two.
- **Run:** Find my first 20 prospects.
- **For each of the 20 business pages, check:**
  1. **Business:** a real business, in this trade and town?
  2. **Website:** is the site on record actually theirs? "No website" — is that true when you search yourself?
  3. **Audit:** do the findings match what you see on the site, on your phone?
  4. **Contact:** is the email genuinely theirs and published by them? Is the phone right?
  5. **Legal form:** does it agree with Companies House?
  6. **Score and channel:** would you contact them, and how?
  7. **Evidence:** is every reason shown true?
- **Mark each one** good or not (and why) with "Your verdict". Those marks are the data that tunes it.
- **Target:** no clearly wrong STRONG prospect. Fewer than 10% wrong websites. Zero guessed emails.

---

## 11. The next 7 days
1. **Day 1:** set the variables, open the PR, walk the welcome on the preview, and send yourself the test email.
2. **Day 2:** run the 20-business validation and mark every one. Note anything systematically wrong (a trade, a source) and tell me.
3. **Day 3:**
   - Screen the shortlisted numbers against TPS/CTPS (Calls → Screen first).
   - Confirm legal forms for the held businesses.
   - Audit the sites you would write about.
4. **Day 4:** with production live, approve and send 5–10 emails to confirmed companies only, each read by you. Ring 5 screened numbers in call mode, and confirm the minutes on each call.
5. **Day 5:** work Today top to bottom: replies first, then follow-ups, then callbacks.
6. **Days 6–7:** read Insights.
   - Which trade or town produced conversations?
   - Which email angle got replies?
   - Adjust your target trades and areas, then run the next 20.

Do not send more than you can personally follow up. Quality over volume.

---

## 12. Metrics to watch (all in the app)

| Metric | Where |
|---|---|
| Prospects reviewed | Insights → Prospect quality (marks); Businesses |
| Contactable, contacted, conversations, meetings, quotes, wins | Insights → From found to won |
| Revenue: won, this month, open pipeline, quotes out | Insights → top tiles; Pipeline |
| **Minutes per conversation, minutes per customer, £ per hour of prospecting** | Insights → Your time |
| Where conversations come from (email vs phone) | Insights → Where conversations come from |
| What works by trade, town and email angle | Insights → What works |
| How long it takes (first contact → conversation → quote → won) | Insights → How long it takes |
| Reply rate and delivery failures | Insights → Email outreach |

Optimise for conversations and £, never for open rates or the number of emails sent.
