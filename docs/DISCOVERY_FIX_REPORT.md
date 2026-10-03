# Discovery fix: "138 listings, 0 new, READY"

Branch `claude/production-overhaul`, commit `b267bb7`. Not merged, not deployed.

## 1. What actually happened in the failed run

Rebuilt from the code (the production database and logs were not readable from the build environment):

| Reported | What it really was |
|---|---|
| 138 listings | rows from every source in 4 overlapping town searches (and a second trade) |
| 100 "unique" | a **sum of per-town counts** — the same business counted once per town |
| 54 duplicates across areas and trades | the same businesses returned by towns 25 miles apart (Perth, Crieff, Auchterarder, Pitlochry all covered each other) |
| 35 already on the sheet / 11 contacted | businesses earlier runs had already saved, from the same first towns |
| 0 new | — |

The 138 were: **38** second-source records merged inside a town search (never shown), **54** repeats across towns/trades, **35** on the sheet, **11** contacted → **46 distinct businesses, none new**. The run then ticked every stage and showed READY.

## 2. Root causes

1. **The same towns every run.** `distribute()` always took the first N towns of a region list. Nothing remembered which towns had been searched or had run dry, so each run re-harvested Perth, Crieff, Auchterarder and Pitlochry.
2. **Every town searched with the user's 25-mile radius**, so neighbouring towns returned nearly identical results; Companies House was asked about the same 8-town ring for every area.
3. **Multi-place input not split.** "Perthshire, Fife" (from onboarding and campaigns) was geocoded as one place.
4. **Narrow search vocabulary** (1–3 words per trade), the same words every run.
5. **Per-trade quota not passed on** when one trade under-delivered.
6. **False duplicates.** The dedupe index matched on (a) map coordinates — Companies House rows carry the *postcode centre*, so every company registered at one accountant's office became "one business"; (b) a long name anywhere in the country; (c) website hosts shared by many businesses (Wix and similar builder subdomains, directories not in the list). Imports ignored website, email and address.
7. **Accounting that could not explain itself.** "Unique" was summed per area; source merges were hidden; rows refused by sources (chains, streets, out of area) vanished uncounted; an earlier trade's prospects were counted as "already on your sheet"; per-area fetch budgets silently cut results.
8. **Zero results shown as success.** A run that ended with nothing new finished with status `done` → stage READY.

## 3. Code changes

**Deduplication — evidence only**
- `src/lib/identity-index.ts` (rewritten): blocking keys narrow candidates; the entity resolver decides. Returns `same` / `possible` with reasons. Map links are no longer evidence. Common name words stop being keys once more than 40 entries share them; the whole name and its distinctive part always remain keys (4,000-row pools stay fast).
- `src/lib/entity/resolve.ts`: `websiteIdentity()` treats each website-builder subdomain as its own site and a bare builder domain as no identity; `postcodeIn()`; `distinctiveTokens()`; numbers in names are never "spelling variants"; same name in different towns with different phone numbers → different businesses; phone parsing cached.
- `src/lib/leads.ts`: directory host list extended (Yelp, Tripadvisor, Nextdoor, Fresha, Treatwell, Endole, Companies House mirrors, …); the old exact-key `findDuplicate` removed.
- Every caller moved to the resolver: Find, manual add, CSV import (now also compares website, email and address), save step.
- `loadKnownBusinesses()` and rejected identities now carry the Companies House number, so a company re-found under a trading name is still recognised.

**One outcome per listing**
- `src/lib/discovery-ledger.ts` (new): outcomes `duplicate_in_search`, `in_database`, `contacted`, `suppressed`, `invalid` (with reason: chain, not a business, wrong trade, outside area, inactive), `needs_review`, `accepted`, `beyond_target`; a row per town × trade; `reconcileLedger()` checks totals, reasons, duplicate kinds and every row.
- `src/lib/discovery-reasons.ts` (new) and `osm-discover.ts` / `companies-house.ts`: every source counts the rows it refuses; Nominatim/Overpass no longer collapse same-named records before the resolver sees them; Companies House no longer truncates; area results are no longer cut by a fetch budget.
- `prospect-pool.ts`: `same` → duplicate/suppressed/contacted/in database; `possible` → review item with the matched business and reason; outcomes attributed to the search that found each listing; earlier trades passed as `inRun`.
- `run-search.ts` builds the ledger; `find-steps.ts` carries it through save (a prospect that turns out to be on the sheet moves `accepted → in_database`); `run-funnel.ts` reads its discovery numbers from the ledger and reconciles `listings = invalid + duplicates + known + contacted + suppressed + review + new`.

**Search diversity**
- `scotland-places.ts`: `splitLocations()`; much longer town lists (Perthshire 34, Fife 32, Stirlingshire 22, Lothian 28, Aberdeenshire 23, …); districts for Glasgow, Edinburgh, Aberdeen, Dundee; new regions (Falkirk, Renfrewshire & Inverclyde, Dunbartonshire, Argyll & Bute, Northumberland, East Yorkshire); per-area radius 7 miles (districts 3) and one Companies House town per area when a plan covers several towns; `rotateAreas()` (never-searched first, then least recent, resting towns left out); `widenCandidates()` / `planWiden()` (rest of the region, then neighbouring regions, then profile areas — never across a border not named or configured).
- `osm-discover.ts`: wider vocabularies per trade (e.g. plumber → plumber, plumbing, heating engineer, gas engineer…; 7 new trades); Nominatim words rotate on repeat searches.
- `migrations/0017_search_coverage.sql`, `discovery-coverage.ts` / `.server.ts`: per town × trade memory; nothing new → rest 30 days, empty → 45 days, failed search → not recorded.
- `find.server.ts`: per-trade quota recomputed from what is still wanted; up to 2 widening rounds when short of target (option "Search further afield when short", on by default); never searches a town twice in one run.

**Zero-result handling**
- New run status `empty`: ends at the stage that lost the prospects, never READY. Every source failing is `failed` ("nothing was searched").
- `run-diagnosis.ts`: discovery / de-duplication / contactability / scoring, with details, rested searches, failed searches, towns reached by widening, and suggestions (unsearched nearby towns, other profile trades).
- Find screen: diagnosis card with one-tap "Search these"; "Needs your decision" list (Different — add it / Same business); "Every listing accounted for" with the per-search table. Run history shows the same ledger and diagnosis.

## 4. Before and after

### Real-world numbers
**None could be produced from the build environment.** Its network policy refuses every discovery host (Nominatim, Photon, Overpass, Companies House, postcodes.io — proxy 403, and the web fetch tool is blocked too); no provider keys are present; Vercel runtime logs returned 403. No real business was searched or verified, and no result below is real.

### Simulation (clearly not real data)
The previous code (commit `8cabd86`) and the new code were run against **one synthetic Perthshire joinery market** shaped like the failed run: 127 firms in 23 towns, 65% mapped, 45% limited companies of which a third are registered at one accountant's postcode, the first-harvested towns ~85% on the sheet, 11 contacted. Sources simulated; planners, pools and dedupe are the real code.

| Same request (one trade, share of 7) | Before | After, first run | After, with memory + widening |
|---|---|---|---|
| Towns searched | Perth, Crieff, Auchterarder, Pitlochry @ 25 mi | same 4 @ 7 mi | Blairgowrie, Aberfeldy, Kinross, Comrie @ 7 mi |
| Listings | 458 | 110 | 47 |
| Repeats of businesses already counted | 367 (80%) | 26 (24%) | 5 (11%) |
| Genuinely new businesses among those seen | 53 | 27 | 29 |
| Genuinely new **lost as false duplicates** | **8** | **0** | **0** |
| Held for your decision | — | 13 | 12 |
| Delivered as new / actually already yours | 7 / 0 | 7 / 0 | 7 / 0 |
| Listings without an outcome | not measurable | 0 | 0 |

What it shows: the old engine spent 80% of its listings re-finding the same businesses and silently discarded 15% of the genuinely new ones; the new engine discards none, goes somewhere new once a town is worked out, and accounts for every listing. It also shows a cost: in this synthetic market (a small pool of Scottish surnames) every review item was in fact a different business with a similar name — the new code asks rather than guesses, so expect a review list.

## 5. Remaining limitations

- **Not verified against real providers.** Yield, website/email/phone rates and false-positive rate are unknown until a live run (protocol below).
- **Review volume.** Similar names in different towns (common Scottish surnames) are held for a decision, not merged. Decisions are not yet remembered as resolver rulings.
- **Legal vs trading name.** A company registered at an accountant's under a name unlike its trading name cannot be linked to its map listing without a shared phone, website or number; it may appear as two businesses until the Companies House check links it.
- **Same exact name, same town, no other details** is still treated as one business.
- **Town tables are hand-maintained**; widening follows a neighbour map, not distances.
- Coverage memory is per account and per trade word; "Joiner" and "Joinery" are separate memories.
- 10 pre-existing failures in the platform-template script tests (brand/OG tooling) are unchanged.

## 6. Real-world test to run after deploying a preview

Run on a **preview** with the real `COMPANIES_HOUSE_API_KEY` and a copy of the data (not production):

1. Find: "Blairgowrie, Kinross, Aberfeldy" · Plumber, Electrician · target 20 (towns not heavily worked).
2. Run detail → "Every listing accounted for" must say "each with exactly one outcome"; note listings, distinct, accepted, review.
3. Verify at least 20 accepted businesses by hand (map/Companies House/website): real and trading, in the trade, not already on the sheet; website working / missing; public email; phone.
4. Work every "Needs your decision" item; count how many were truly the same business.
5. Re-run the same search: rested towns must be left out (Activity log) and towns must differ.
6. Report: new businesses, % working website, % no website, % public email, % verified phone, duplicate rate (repeats ÷ listings), false-positive rate (accepted that were not new or not in trade), worthwhile opportunities.

## 7. Gates

- App tests: 1474 / 1474 pass (dedupe regressions, ledger reconciliation incl. the 138-listing run, diversity/rotation/widening/coverage, Find job empty/failed/widening paths).
- Script tests: 187 / 197 — the same 10 pre-existing platform-template failures as before.
- Typecheck clean; lint: 0 errors, 2 pre-existing warnings; production build passes (SSR check, client-secret check).
- Browser: empty-run screen and Find form checked at 1280 px and 390 px — no page overflow, no app console errors.
