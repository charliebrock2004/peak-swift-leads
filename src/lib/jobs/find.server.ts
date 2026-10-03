/**
 * Find, as a background job.
 *
 * The same run the Find screen used to drive from the browser — search, save,
 * check websites and emails, Companies House and website audits, score, write
 * drafts — now runs on the server in checkpointed steps, so it carries on when
 * the tab is closed or the phone locks. It still stops at READY: drafts wait
 * for a person on the Send screen. Nothing here sends an email, and every
 * draft goes through the same eligibility gate and quality check as before.
 *
 * Every step is safe to repeat (see runner.server.ts): new leads get their ids
 * before they are written, lead updates are narrow patches, drafts are one per
 * lead and kind, and budgets are spent in the database before each call.
 */
import type { Sql } from "@/lib/db";
import { discoveryIsFresh, REASON_LABELS as DISCOVERY_REASON_LABELS } from "../email-discovery.ts";
import { newLeadId, type Lead } from "../leads.ts";
import { discoveredWebsitePatch, emailPatch, websitePatch } from "../qualify.ts";
import type { CheckWebsiteResult, FindEmailInput, FindEmailResult } from "../qualify-server.ts";
import type { Prospect, ResearchInput, ResearchResult } from "../research.ts";
import { runPlannedSearch } from "../run-search.ts";
import { SEARCH_FAILURE_LABELS } from "../search-provider.ts";
import { friendlyServerError } from "../server-errors.ts";
import { AUDITS_PER_DAY } from "../audit/findings.ts";
import { websiteVerificationOf } from "../audit/website-state.ts";
import { legalFormOf } from "../contactability/lead.ts";
import type { CompanyCheckOutcome } from "../contactability/company-check.server.ts";
import { autoContext, planTargets, searchBreadth } from "../outreach/auto-run.ts";
import { clampCampaign, campaignProblem, newCampaign } from "../outreach/campaigns.ts";
import { allowance } from "../outreach/limits.ts";
import { effectiveProfile, scoringProfile } from "../outreach/profile.ts";
import { sourceWeights } from "../feedback/quality.ts";
import { log as slog } from "../log.server.ts";
import { domainOf } from "../feedback/verdicts.ts";
import { discoveryFromLedger, emptyFunnel, reconcileFunnel, tallyOutcomes, type RunFunnel } from "../outreach/run-funnel.ts";
import { emptyLedger, reconcileLedger, type DiscoveryLedger } from "../discovery-ledger.ts";
import { tradeKey } from "../discovery-coverage.ts";
import { diagnoseRun, type RunDiagnosis, type SearchSuggestion } from "../run-diagnosis.ts";
import { areaKey, planSearch, planWiden, rotateAreas, splitLocations, widenCandidates } from "../scotland-places.ts";
import type { KnownBusiness } from "../prospect-pool.ts";
import type { GeneratedRow, GenerateInput } from "../outreach/server.ts";
import type { LeadWithFacts } from "../outreach/types.ts";
import { scoreAll } from "../scoring/records.ts";
import { absorbSearch, appendEvent, countChecks, finishLine, planSave, summarise, type SavePlan } from "./find-steps.ts";
import { insertLeads, loadKnownBusinesses, loadSheetLeads, patchLead } from "./lead-writes.server.ts";
import type { JobHandler, StepContext, StepResult } from "./runner.server.ts";
import {
  emptyEnrichment,
  FIND_STAGES,
  type FindInput,
  type FindProgress,
  type FindResult,
  type FindStage,
  type FindSummary,
  type FindTopProspect,
} from "./types.ts";

export type FindDeps = {
  research: (input: ResearchInput, userId: string) => Promise<ResearchResult>;
  checkWebsite: (data: { website: string; businessName: string }) => Promise<CheckWebsiteResult>;
  findEmail: (data: FindEmailInput, userId: string) => Promise<FindEmailResult>;
  checkCompany: (sql: Sql, userId: string, lead: LeadWithFacts) => Promise<CompanyCheckOutcome>;
  audit: (sql: Sql, userId: string, lead: LeadWithFacts) => Promise<{ status: string; opportunity: string }>;
  generate: (data: GenerateInput, userId: string) => Promise<{ ok: true; rows: GeneratedRow[] } | { ok: false; error: string }>;
};

type Step = "setup" | "discover" | "plan_save" | "write" | "verify" | "count" | "enrich" | "qualify" | "draft" | "finish";

export type FindState = {
  step: Step;
  runId: string;
  campaignId: string;
  activateWhenFilled: boolean;
  tradeIndex: number;
  prospects: Prospect[];
  rediscovered: Prospect[];
  seen: string[];
  /**
   * Every new business an earlier trade (or round) of this run kept, as
   * identities: a later trade that finds one again counts a duplicate within
   * this search, never "already in your database".
   */
  inRun: KnownBusiness[];
  /** Towns searched this run, per trade (`tradeKey` → `areaKey`s): never searched twice in one run. */
  searched: Record<string, string[]>;
  /** 0 = the places asked for; 1+ = widening rounds further afield. */
  widenRound: number;
  /** Towns reached by widening. */
  widenedTo: string[];
  /** Towns left out because a recent search found nothing new there. */
  resting: string[];
  errors: string[];
  save: SavePlan | null;
  leadIds: string[];
  cursor: number;
  verified: string[];
  whyNoEmail: Record<string, string>;
  chStopped: string;
  auditStopped: string;
  draftIds: string[];
  callLeadIds: string[];
  readyEmailIds: string[];
  attempted: number;
  summary: FindSummary | null;
  top: FindTopProspect[];
};

const STAGE_OF: Record<Step, FindStage> = {
  setup: "discovering",
  discover: "discovering",
  plan_save: "deduplicating",
  write: "deduplicating",
  verify: "verifying",
  count: "verifying",
  enrich: "enriching",
  qualify: "qualifying",
  draft: "personalising",
  finish: "ready",
};

/** How long each step may take, so a slice does not start one it cannot finish. */
const NEEDS: Record<Step, number> = {
  setup: 10_000,
  discover: 150_000,
  plan_save: 20_000,
  write: 20_000,
  verify: 70_000,
  count: 10_000,
  enrich: 90_000,
  qualify: 30_000,
  draft: 100_000,
  finish: 15_000,
};

/** A discovery step stops searching further areas past this, keeping what it found. */
const DISCOVERY_STEP_MAX_MS = 200_000;
const CHECK_BATCH = 3;
const ENRICH_BATCH = 3;
const DRAFT_BATCH = 3;
const COMPANY_RECHECK_DAYS = 90;
const AUDIT_FRESH_DAYS = 30;
const REDISCOVERED_MAX = 300;
/** Identities kept for cross-trade duplicate checks; enough for any target. */
const IN_RUN_MAX = 1200;
/** Widening rounds a run may take when the places asked for are out of new businesses. */
export const MAX_WIDEN_ROUNDS = 2;

type Snapshot = { input: FindInput; state: FindState; progress: FindProgress };

export function sanitizeFindInput(raw: unknown, accountDailyLimit = 50): FindInput {
  const source = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  const trades = Array.isArray(source.trades)
    ? [...new Set(source.trades.map((trade) => text(trade, 60)).filter((trade) => trade.length >= 2))].slice(0, 4)
    : [];
  if (source.mode === "enrich") {
    const leadIds = Array.isArray(source.leadIds) ? [...new Set(source.leadIds.filter((id): id is string => typeof id === "string").map((id) => id.slice(0, 64)))].slice(0, 500) : [];
    return { location: "Your businesses", trades: [], target: leadIds.length, dailyLimit: num(source.dailyLimit, 10, 1, Math.max(1, accountDailyLimit)), radiusMiles: 0, campaignId: "", campaignName: "", mode: "enrich", leadIds };
  }
  return {
    location: text(source.location, 80),
    trades,
    target: num(source.target, 50, 1, 200),
    dailyLimit: num(source.dailyLimit, 10, 1, Math.max(1, accountDailyLimit)),
    radiusMiles: num(source.radiusMiles, 25, 5, 50),
    campaignId: text(source.campaignId, 40),
    campaignName: text(source.campaignName, 60),
    widen: source.widen !== false,
  };
}

export function findInputProblem(input: FindInput): string {
  if (input.mode === "enrich") return input.leadIds?.length ? "" : "Choose some businesses to check.";
  if (input.location.length < 2 || splitLocations(input.location).length === 0) return "Choose an area.";
  if (input.trades.length === 0) return "Choose at least one trade.";
  if (!input.campaignId && input.campaignName.length < 2) return "Name the campaign.";
  return "";
}

function initialProgress(input: FindInput, runId: string, now: Date): FindProgress {
  return {
    status: "running",
    stage: "discovering",
    completed: [],
    detail: `Searching ${input.location} for ${input.trades.join(", ")}…`,
    progress: { done: 0, total: 0 },
    funnel: emptyFunnel(),
    ledger: emptyLedger(),
    diagnosis: null,
    enrichment: emptyEnrichment(),
    config: input,
    log: [],
    startedAt: now.toISOString(),
    finishedAt: "",
    runId,
    result: null,
    reconcileProblems: [],
  };
}

function at(progress: FindProgress, step: Step, detail: string, done = 0, total = 0): FindProgress {
  const stage = STAGE_OF[step];
  return { ...progress, stage, completed: FIND_STAGES.slice(0, FIND_STAGES.indexOf(stage)), detail, progress: { done, total } };
}

function log(progress: FindProgress, text: string, tone: "info" | "good" | "warn" | "bad" = "info"): FindProgress {
  return { ...progress, log: appendEvent(progress.log, text, tone) };
}

async function stores() {
  const store = await import("../outreach/store.server.ts");
  const contacts = await import("../contactability/store.server.ts");
  return { store, contacts };
}

/** The run record on the Runs screen. Never allowed to stop the run itself. */
async function persistRun(sql: Sql, userId: string, snap: Snapshot, status: string, extra: { summary?: string; finishedAt?: string } = {}) {
  const { store } = await stores();
  const { input, state, progress } = snap;
  const funnel = progress.funnel;
  await store
    .upsertRun(sql, userId, {
      id: state.runId,
      startedAt: progress.startedAt,
      finishedAt: extra.finishedAt ?? "",
      location: input.location,
      businessType: input.trades.join(", "),
      mode: "prepare",
      status,
      phase: progress.stage,
      campaignId: state.campaignId,
      target: input.target,
      dailyLimit: input.dailyLimit,
      found: funnel.selected,
      qualified: funnel.eligible,
      hot: state.summary?.strong ?? 0,
      warm: state.summary?.good ?? 0,
      callCount: funnel.call,
      lowCount: funnel.lowOpportunity,
      skipped: Math.max(0, funnel.checked - funnel.eligible - funnel.call),
      emailsFound: funnel.emailsFound,
      prepared: funnel.prepared,
      sent: 0,
      replies: 0,
      errors: funnel.checkErrors + funnel.prepareFailed,
      bottleneck: "",
      summary: extra.summary ?? "",
      funnel: JSON.stringify({ ...funnel, enrichment: progress.enrichment, ledger: progress.ledger, diagnosis: progress.diagnosis }),
      leadIds: state.leadIds,
      updatedAt: "",
    })
    .catch(() => undefined);
}

async function end(
  ctx: StepContext,
  snap: Snapshot,
  status: "done" | "empty" | "stopped" | "failed",
  text: string,
  result: FindResult | null,
): Promise<StepResult<FindState, FindProgress, FindResult | null>> {
  const finishedAt = new Date().toISOString();
  const problems = [...reconcileFunnel(snap.progress.funnel), ...(snap.input.mode === "enrich" ? [] : reconcileLedger(snap.progress.ledger))];
  let progress = snap.progress;
  if (problems.length > 0) {
    progress = log(progress, `The run's numbers do not add up: ${problems.join("; ")}`, "bad");
    slog.error("find_ledger_unreconciled", { userId: ctx.userId, jobId: ctx.jobId, problems });
  }
  progress = log(
    {
      ...progress,
      status,
      stage: status === "done" ? "ready" : progress.stage,
      completed: status === "done" ? [...FIND_STAGES] : status === "empty" && progress.stage === "ready" ? FIND_STAGES.filter((stage) => stage !== "ready") : progress.completed,
      detail: text,
      finishedAt,
      result,
      reconcileProblems: problems,
    },
    text,
    status === "done" ? "good" : status === "failed" ? "bad" : "warn",
  );
  if (progress.diagnosis) for (const line of progress.diagnosis.details) progress = log(progress, line, "warn");
  const finished = { ...snap, progress };
  await persistRun(ctx.sql, ctx.userId, finished, status, { summary: text, finishedAt });
  const { store } = await stores();
  await store
    .recordActivity(ctx.sql, ctx.userId, {
      id: newLeadId(),
      type: "SEARCH_COMPLETED",
      result: status,
      reason: text,
      metadata: JSON.stringify({ runId: snap.state.runId, found: progress.funnel.selected, prepared: progress.funnel.prepared, outcome: status, stage: progress.diagnosis?.stage ?? "" }),
    })
    .catch(() => undefined);
  if (status === "failed") return { kind: "failed", state: snap.state, progress, error: text };
  return { kind: "done", state: snap.state, progress, result };
}

function resultOf(state: FindState, progress: FindProgress): FindResult {
  return {
    runId: state.runId,
    campaignId: state.campaignId,
    leadIds: state.leadIds,
    readyEmailIds: state.readyEmailIds,
    callLeadIds: state.callLeadIds,
    summary: { ...(state.summary ?? { found: state.leadIds.length, strong: 0, good: 0, weak: 0, rejected: 0, callReady: 0, review: 0, emailReady: 0 }), emailReady: progress.funnel.prepared },
    top: state.top,
  };
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function setup(ctx: StepContext, snap: Snapshot): Promise<Snapshot> {
  const { store } = await stores();
  const { input } = snap;
  let state = { ...snap.state };
  let progress = snap.progress;
  const now = new Date().toISOString();
  const settings = await store.loadSettings(ctx.sql, ctx.userId);
  const limits = { dailyMax: settings.dailyLimit, batchMax: settings.batchSize };
  // A campaign is only switched on once this run has put prospects into it,
  // and a run with the same name reuses its campaign instead of duplicating.
  const name = (input.campaignName || `${input.location} ${input.trades.join(", ")}`).trim().slice(0, 60);
  if (input.campaignId) {
    const existing = await store.loadCampaign(ctx.sql, ctx.userId, input.campaignId).catch(() => null);
    if (existing) state.campaignId = existing.id;
  }
  if (!state.campaignId) {
    const campaigns = await store.loadCampaigns(ctx.sql, ctx.userId).catch(() => []);
    const same = campaigns.find(
      (campaign) => campaign.name.trim().toLowerCase() === name.toLowerCase() && ["DRAFT", "ACTIVE", "PAUSED"].includes(campaign.status),
    );
    if (same) {
      state = { ...state, campaignId: same.id, activateWhenFilled: same.status === "DRAFT" };
      progress = log(progress, `Adding to the existing campaign "${same.name}".`);
    }
  }
  if (!state.campaignId) {
    const campaign = clampCampaign(
      { ...newCampaign(newLeadId(), now), name, locations: input.location, trades: input.trades.join(", "), targetProspects: input.target, dailyTarget: input.dailyLimit, batchSize: 5, sendMode: "prepare" },
      limits,
      now,
    );
    const problem = campaignProblem(campaign);
    if (!problem) {
      await store.upsertCampaign(ctx.sql, ctx.userId, campaign).catch(() => undefined);
      state = { ...state, campaignId: campaign.id, activateWhenFilled: true };
      progress = log(progress, `Campaign "${name}" created.`);
    }
  }
  state.step = "discover";
  const next = { ...snap, state, progress: at(progress, "discover", `Searching ${input.location} for ${input.trades.join(", ")}…`) };
  await persistRun(ctx.sql, ctx.userId, next, "running");
  return next;
}

/** Where-to-look-next suggestions for a run that ran dry: unsearched towns nearby, and other trades you sell to. */
async function suggestionsFor(ctx: StepContext, snap: Snapshot, configuredAreas: string[], profileTrades: string[]): Promise<SearchSuggestion[]> {
  const { input, state } = snap;
  const out: SearchSuggestion[] = [];
  const { loadCoverage } = await import("../discovery-coverage.server.ts");
  const candidates = widenCandidates(input.location, configuredAreas);
  // A town is worth suggesting when, for every trade asked, it was neither
  // searched in this run nor is resting after an empty search.
  let open = candidates;
  for (const trade of input.trades) {
    const coverage = await loadCoverage(ctx.sql, ctx.userId, trade).catch(() => new Map());
    const skip = new Set(state.searched[tradeKey(trade)] ?? []);
    const { ordered } = rotateAreas(open, { coverage, skip });
    const keep = new Set(ordered.map(areaKey));
    open = open.filter((town) => keep.has(areaKey(town)));
  }
  if (open.length > 0) {
    out.push({ location: open.slice(0, 4).join(", "), trades: [...input.trades], why: `Not yet searched for ${input.trades.join(", ").toLowerCase()}` });
    if (open.length > 4) out.push({ location: open.slice(4, 8).join(", "), trades: [...input.trades], why: "Further out, also not yet searched" });
  }
  const asked = new Set(input.trades.map(tradeKey));
  const others = profileTrades.filter((trade) => !asked.has(tradeKey(trade))).slice(0, 3);
  if (others.length > 0) out.push({ location: input.location, trades: others, why: "Other trades you sell to, not searched in this run" });
  return out.slice(0, 4);
}

/** Should the run look further afield? Only when it is short, may widen, and widening can reach somewhere new. */
function shouldWiden(snap: Snapshot): boolean {
  const { input, state } = snap;
  if (input.widen === false || state.widenRound >= MAX_WIDEN_ROUNDS) return false;
  if (state.prospects.length >= searchBreadth(input.target)) return false;
  // Every search failing means the sources are down: more towns cannot help.
  const rows = snap.progress.ledger.searches;
  return rows.length === 0 || rows.some((row) => !row.error);
}

async function discover(ctx: StepContext, snap: Snapshot, deps: FindDeps): Promise<Snapshot> {
  const { input } = snap;
  const trade = input.trades[snap.state.tradeIndex]!;
  const tkey = tradeKey(trade);
  const sheet = await loadKnownBusinesses(ctx.sql, ctx.userId);
  // Businesses you rejected stay out, even after you removed them; and the
  // sources whose results you keep rejecting rank lower (feedback/quality.ts).
  const feedback = await import("../feedback/store.server.ts");
  const coverageStore = await import("../discovery-coverage.server.ts");
  const [rejected, marks, coverage] = await Promise.all([
    feedback.rejectedIdentities(ctx.sql, ctx.userId).catch(() => []),
    feedback.loadFeedback(ctx.sql, ctx.userId).catch(() => []),
    coverageStore.loadCoverage(ctx.sql, ctx.userId, trade).catch(() => new Map()),
  ]);
  // Each list is checked in turn — suppressed, then contacted, then the rest
  // of the sheet — and only a certain match ("same") excludes a business.
  const suppressed: KnownBusiness[] = [...sheet.filter((lead) => lead.unsubscribed.trim()), ...rejected];
  const contacted: KnownBusiness[] = sheet.filter((lead) => lead.lastEmailedAt.trim() || (lead.called && lead.called !== "Not Called"));
  const known: KnownBusiness[] = sheet;

  // The run's target is shared by the trades left in this round, and whatever
  // an earlier trade did not use passes on to the next.
  const wanted = Math.max(0, searchBreadth(input.target) - snap.state.prospects.length);
  const tradesLeft = Math.max(1, input.trades.length - snap.state.tradeIndex);
  const perTrade = Math.max(6, Math.ceil(wanted / tradesLeft));
  const skip = new Set(snap.state.searched[tkey] ?? []);
  let configured: string[] = [];
  if (snap.state.widenRound > 0) {
    const { store } = await stores();
    const profile = await store.loadProfile(ctx.sql, ctx.userId).catch(() => null);
    configured = (profile?.targetAreas ?? "").split(",").map((area: string) => area.trim()).filter(Boolean);
  }
  const plan =
    snap.state.widenRound > 0
      ? planWiden(input.location, perTrade, configured, { radiusMiles: input.radiusMiles, coverage, skip })
      : planSearch(input.location, perTrade, { radiusMiles: input.radiusMiles, coverage, skip });

  let progress = { ...snap.progress };
  const funnel: RunFunnel = { ...snap.progress.funnel };
  const searched = { ...snap.state.searched, [tkey]: [...skip, ...plan.areas.map((area) => areaKey(area.name))] };
  let state: FindState = { ...snap.state, searched, resting: [...new Set([...snap.state.resting, ...plan.restingAreas])].slice(0, 40) };
  if (plan.restingAreas.length > 0) {
    progress = log(progress, `${trade}: left out ${plan.restingAreas.length} towns searched recently with nothing new (${plan.restingAreas.slice(0, 5).join(", ")}${plan.restingAreas.length > 5 ? "…" : ""}).`);
  }

  if (plan.areas.length > 0) {
    const started = Date.now();
    const search = await runPlannedSearch({
      location: input.location,
      businessType: trade,
      limit: perTrade,
      plan,
      known,
      suppressed,
      contacted,
      inRun: snap.state.inRun,
      sourceWeights: sourceWeights(marks),
      concurrency: 2,
      shouldCancel: () => Date.now() - started > DISCOVERY_STEP_MAX_MS,
      research: (query) =>
        deps.research(
          {
            location: query.location,
            businessType: query.businessType,
            limit: query.limit,
            radiusMiles: query.radiusMiles ?? input.radiusMiles,
            ...(query.chTowns ? { chTowns: query.chTowns } : {}),
            variant: query.variant ?? 0,
          },
          ctx.userId,
        ),
    });
    await coverageStore.recordCoverage(ctx.sql, ctx.userId, search.ledger.searches).catch((error: unknown) => slog.warn("coverage_not_saved", { userId: ctx.userId, jobId: ctx.jobId, error }));
    // What each source gave, so a failing or empty source is visible in the logs.
    const ids = { userId: ctx.userId, jobId: ctx.jobId, trade, location: input.location, round: snap.state.widenRound };
    slog.info("discovery_search", { ...ids, areas: search.funnel.areas, listings: search.ledger.listings, outcomes: search.ledger.outcomes, rawBySource: search.funnel.rawBySource, errors: search.errors.length });
    for (const error of search.errors.slice(0, 5)) slog.warn("discovery_source_failed", { ...ids, error });
    if (search.funnel.queriesSent > 0) {
      for (const [source, rows] of Object.entries(search.funnel.rawBySource)) if (rows === 0) slog.info("discovery_zero_yield_source", { ...ids, source });
    }
    const seen = new Set(snap.state.seen);
    const absorbed = absorbSearch(snap.progress.ledger, search, seen);
    discoveryFromLedger(funnel, absorbed.ledger);
    const o = search.ledger.outcomes;
    const fresh = o.accepted + o.beyond_target;
    progress = log(
      { ...progress, ledger: absorbed.ledger, funnel },
      `${trade}${snap.state.widenRound ? " (further afield)" : ""}: ${search.ledger.listings} listings in ${search.ledger.searches.length} searches → ${fresh} new` +
        ` · ${o.in_database} already yours · ${o.contacted} contacted · ${o.suppressed} opted out or rejected · ${o.needs_review} to check · ${o.duplicate_in_search} repeats · ${o.invalid} not businesses in the trade.`,
      fresh > 0 ? "info" : "warn",
    );
    if (search.cancelled) progress = log(progress, `${trade}: stopped after ${search.funnel.areas} areas to keep the run moving; the rest can be searched in another run.`, "warn");
    const keptIds: KnownBusiness[] = search.kept.map((item) => ({ businessName: item.businessName, town: item.town, phone: item.phone, mapsLink: "", website: item.website, email: item.email, placeId: item.placeId, address: item.address, sourceIds: item.sourceIds }));
    state = {
      ...state,
      prospects: [...state.prospects, ...absorbed.added],
      rediscovered: [...state.rediscovered, ...absorbed.rediscovered].slice(0, REDISCOVERED_MAX),
      seen: [...seen],
      inRun: [...state.inRun, ...keptIds].slice(0, IN_RUN_MAX),
      errors: [...new Set([...state.errors, ...search.errors])].slice(0, 20),
      widenedTo: snap.state.widenRound > 0 ? [...new Set([...state.widenedTo, ...plan.areas.map((area) => area.name)])].slice(0, 40) : state.widenedTo,
    };
  } else {
    progress = log(progress, `${trade}${snap.state.widenRound ? " (further afield)" : ""}: no town left that has not been searched recently.`, "warn");
  }

  state = { ...state, tradeIndex: state.tradeIndex + 1 };
  const snapNext: Snapshot = { ...snap, state, progress };
  if (state.tradeIndex < input.trades.length) {
    return { ...snapNext, progress: at(progress, "discover", `Searching for ${input.trades[state.tradeIndex]}…`, state.tradeIndex, input.trades.length) };
  }
  if (shouldWiden(snapNext)) {
    const round = state.widenRound + 1;
    const short = searchBreadth(input.target) - state.prospects.length;
    progress = log(
      progress,
      state.prospects.length === 0
        ? `Nothing new around ${input.location} — searching further afield (round ${round} of ${MAX_WIDEN_ROUNDS}).`
        : `${short} short of your target — searching further afield (round ${round} of ${MAX_WIDEN_ROUNDS}).`,
      "warn",
    );
    return { ...snapNext, state: { ...state, tradeIndex: 0, widenRound: round }, progress: at(progress, "discover", `Searching further afield for ${input.trades[0]}…`, 0, input.trades.length) };
  }
  for (const problem of state.errors.slice(0, 3)) progress = log(progress, friendlyServerError(new Error(problem)), "warn");
  return {
    ...snapNext,
    state: { ...state, step: "plan_save" },
    progress: at(progress, "plan_save", `${funnel.rawFound} listings → ${funnel.unique} distinct businesses → ${state.prospects.length} new to you`),
  };
}

async function planSaveStep(ctx: StepContext, snap: Snapshot): Promise<Snapshot> {
  const sheet = await loadKnownBusinesses(ctx.sql, ctx.userId);
  const funnel: RunFunnel = { ...snap.progress.funnel };
  const ledger: DiscoveryLedger = structuredClone(snap.progress.ledger);
  const save = planSave(ledger, snap.state.prospects, snap.state.rediscovered, sheet, new Date().toISOString());
  discoveryFromLedger(funnel, ledger);
  // The plan (with the new leads' ids) is checkpointed before anything is
  // written, so a repeat of the write step writes the same rows.
  return {
    ...snap,
    state: { ...snap.state, step: "write", save, leadIds: save.ids, prospects: [], rediscovered: [], inRun: [] },
    progress: at({ ...snap.progress, funnel, ledger }, "write", `Saving ${save.fresh.length} new prospects…`),
  };
}

async function write(ctx: StepContext, snap: Snapshot): Promise<Snapshot> {
  const { store } = await stores();
  const save = snap.state.save ?? { fresh: [], merges: [], ids: [] };
  await insertLeads(ctx.sql, ctx.userId, save.fresh);
  for (const merge of save.merges) await patchLead(ctx.sql, ctx.userId, merge.id, merge.patch);
  if (snap.state.campaignId && save.ids.length > 0) {
    await store.addCampaignProspects(ctx.sql, ctx.userId, snap.state.campaignId, save.ids).catch(() => undefined);
    if (snap.state.activateWhenFilled) {
      const campaign = await store.loadCampaign(ctx.sql, ctx.userId, snap.state.campaignId).catch(() => null);
      if (campaign && campaign.status === "DRAFT") {
        await store.upsertCampaign(ctx.sql, ctx.userId, { ...campaign, status: "ACTIVE", updatedAt: new Date().toISOString() }).catch(() => undefined);
      }
    }
  }
  let progress = log(
    snap.progress,
    `${save.fresh.length} new prospects saved${save.merges.length ? ` · ${save.merges.length} existing leads topped up` : ""}.`,
    "good",
  );
  progress = at(progress, "verify", "Checking each business's website and public email…", 0, snap.state.leadIds.length);
  const next = { ...snap, state: { ...snap.state, step: "verify" as const, save: null, cursor: 0 }, progress };
  await persistRun(ctx.sql, ctx.userId, next, "running");
  return next;
}

async function verify(ctx: StepContext, snap: Snapshot, deps: FindDeps): Promise<Snapshot> {
  const ids = snap.state.leadIds.slice(snap.state.cursor, snap.state.cursor + CHECK_BATCH);
  const leads = await loadSheetLeads(ctx.sql, ctx.userId, ids);
  // Sites you said were not theirs are never attached to them again.
  const marks = await (await import("../feedback/store.server.ts")).loadFeedback(ctx.sql, ctx.userId).catch(() => []);
  const wrongSites = new Map<string, string[]>();
  for (const mark of marks) {
    const domain = mark.verdict === "wrong_website" ? domainOf(mark.website ?? "") : "";
    if (domain) wrongSites.set(mark.leadId, [...(wrongSites.get(mark.leadId) ?? []), domain]);
  }
  const funnel: RunFunnel = { ...snap.progress.funnel };
  const verified = new Set(snap.state.verified);
  const whyNoEmail = { ...snap.state.whyNoEmail };
  const notes: { text: string; tone: "warn" }[] = [];

  await Promise.all(
    leads.map(async (lead) => {
      if (discoveryIsFresh(lead)) return;
      let working: Lead = lead;
      try {
        if (lead.website.trim()) {
          const site = await deps.checkWebsite({ website: lead.website, businessName: lead.businessName });
          if (site.ok) {
            const patch = websitePatch(working, site.check, site.checkedAt);
            working = { ...working, ...patch };
            await patchLead(ctx.sql, ctx.userId, lead.id, patch);
          }
        }
        const mail = await deps.findEmail(
          {
            leadId: lead.id,
            website: working.website,
            existingEmail: working.email,
            existingSource: working.emailSource,
            businessName: working.businessName,
            town: working.town,
            trade: working.trade,
            phone: working.phone,
            address: working.address,
            rejectedDomains: wrongSites.get(lead.id),
          },
          ctx.userId,
        );
        if (mail.ok) {
          const email = emailPatch(working, mail.found, mail.foundAt);
          const site = discoveredWebsitePatch({ ...working, ...email }, mail.website);
          await patchLead(ctx.sql, ctx.userId, lead.id, { ...email, ...site });
          if (mail.website) verified.add(lead.id);
          funnel.websitesRejected += mail.rejectedCandidates?.length ?? 0;
          funnel.emailsRejected += mail.rejectedEmails?.length ?? 0;
          if (mail.searchFailure) slog.warn("email_discovery_failed", { userId: ctx.userId, jobId: ctx.jobId, leadId: lead.id, source: "web_search", reason: mail.searchFailure });
          if (!mail.found && mail.discovery.reason) {
            const note = mail.searchFailure ? ` (${SEARCH_FAILURE_LABELS[mail.searchFailure] ?? mail.searchFailure})` : "";
            whyNoEmail[lead.id] = `${DISCOVERY_REASON_LABELS[mail.discovery.reason] ?? mail.discovery.reason}${note}`;
          }
        }
      } catch (error) {
        funnel.checkErrors += 1;
        slog.warn("email_discovery_failed", { userId: ctx.userId, jobId: ctx.jobId, leadId: lead.id, error });
        notes.push({ text: `${lead.businessName}: ${friendlyServerError(error, "check failed")}`, tone: "warn" });
      }
    }),
  );

  let progress = { ...snap.progress, funnel };
  for (const note of notes) progress = log(progress, note.text, note.tone);
  const cursor = Math.min(snap.state.leadIds.length, snap.state.cursor + CHECK_BATCH);
  const done = cursor >= snap.state.leadIds.length;
  const state: FindState = { ...snap.state, cursor, verified: [...verified], whyNoEmail, step: done ? "count" : "verify" };
  return { ...snap, state, progress: at(progress, "verify", `Checked ${cursor} of ${snap.state.leadIds.length}`, cursor, snap.state.leadIds.length) };
}

async function count(ctx: StepContext, snap: Snapshot): Promise<Snapshot> {
  const leads = await loadSheetLeads(ctx.sql, ctx.userId, snap.state.leadIds);
  const funnel: RunFunnel = { ...snap.progress.funnel };
  countChecks(funnel, leads, new Set(snap.state.verified));
  let progress = { ...snap.progress, funnel };
  progress = log(
    progress,
    `${funnel.websiteVerified} websites verified · ${funnel.emailsFound} public emails found (${funnel.emailsHigh} high, ${funnel.emailsMedium} medium confidence).`,
    funnel.emailsFound > 0 ? "good" : "warn",
  );
  const next = {
    ...snap,
    state: { ...snap.state, step: "enrich" as const, cursor: 0 },
    progress: at(progress, "enrich", "Checking Companies House and auditing websites…", 0, snap.state.leadIds.length),
  };
  await persistRun(ctx.sql, ctx.userId, next, "running");
  return next;
}

async function enrich(ctx: StepContext, snap: Snapshot, deps: FindDeps): Promise<Snapshot> {
  const { store } = await stores();
  const ids = snap.state.leadIds.slice(snap.state.cursor, snap.state.cursor + ENRICH_BATCH);
  const settings = await store.loadSettings(ctx.sql, ctx.userId);
  const enrichment = { ...snap.progress.enrichment, stopped: [...snap.progress.enrichment.stopped] };
  let chStopped = snap.state.chStopped;
  let auditStopped = snap.state.auditStopped;
  const now = Date.now();
  const leads = await store.loadLeadsByIds(ctx.sql, ctx.userId, ids);

  await Promise.all(
    leads.map(async (lead) => {
      // Companies House: only where the legal form is still unknown, and not
      // re-asked within 90 days. It is what lets a limited company be emailed.
      if (!chStopped && !lead.facts.legalFormOverride) {
        const form = legalFormOf(lead, settings.contactRules).form;
        const checked = Date.parse(lead.facts.companyCheckedAt);
        const recent = Number.isFinite(checked) && checked > now - COMPANY_RECHECK_DAYS * 86_400_000;
        if ((form === "UNKNOWN" || form === "REVIEW_REQUIRED") && !recent) {
          const outcome = await deps.checkCompany(ctx.sql, ctx.userId, lead).catch((error: unknown) => ({ status: "error" as const, error: String(error), kind: "" }));
          enrichment.companiesChecked += 1;
          if (outcome.status === "confirmed") enrichment.companiesConfirmed += 1;
          else if (outcome.status === "ambiguous") enrichment.companiesAmbiguous += 1;
          else if (outcome.status === "error" && (outcome.kind === "no-key" || outcome.kind === "budget" || outcome.kind === "rate-limited")) {
            enrichment.companiesChecked -= 1;
            chStopped = outcome.error;
          }
        }
      }
      // Website audit: an own website, not audited in the last 30 days.
      const website = websiteVerificationOf(lead);
      const owns = lead.website.trim() && (website.state === "WEBSITE_FOUND" || website.state === "WEBSITE_NOT_CONFIRMED" || website.state === "WEBSITE_UNREACHABLE");
      const last = lead.facts.audit;
      const fresh = last && last.status === "ok" && Date.parse(last.finishedAt) > now - AUDIT_FRESH_DAYS * 86_400_000;
      if (!auditStopped && owns && !fresh) {
        const allowed = await store.consumeBudget(ctx.sql, ctx.userId, "audit", 1, AUDITS_PER_DAY).catch(() => 1);
        if (allowed === null) {
          auditStopped = `Today's ${AUDITS_PER_DAY} website audits are used up.`;
          return;
        }
        try {
          const audit = await deps.audit(ctx.sql, ctx.userId, lead);
          if (audit.status === "ok") enrichment.audited += 1;
          else {
            enrichment.auditFailed += 1;
            slog.warn("website_audit_failed", { userId: ctx.userId, jobId: ctx.jobId, leadId: lead.id, status: audit.status });
          }
        } catch (error) {
          enrichment.auditFailed += 1;
          slog.warn("website_audit_failed", { userId: ctx.userId, jobId: ctx.jobId, leadId: lead.id, error });
        }
      }
    }),
  );

  let progress = { ...snap.progress, enrichment };
  if (chStopped && !snap.state.chStopped) {
    enrichment.stopped.push(`Companies House: ${chStopped}`);
    progress = log(progress, `Companies House checks stopped: ${chStopped}`, "warn");
  }
  if (auditStopped && !snap.state.auditStopped) {
    enrichment.stopped.push(auditStopped);
    progress = log(progress, auditStopped, "warn");
  }
  const cursor = Math.min(snap.state.leadIds.length, snap.state.cursor + ENRICH_BATCH);
  const done = cursor >= snap.state.leadIds.length;
  if (done) {
    progress = log(
      progress,
      `${enrichment.companiesConfirmed} confirmed on Companies House${enrichment.companiesAmbiguous ? ` (${enrichment.companiesAmbiguous} need you to pick the match)` : ""} · ${enrichment.audited} websites audited.`,
      "info",
    );
  }
  const state: FindState = { ...snap.state, cursor, chStopped, auditStopped, step: done ? "qualify" : "enrich" };
  return {
    ...snap,
    state,
    progress: done
      ? at(progress, "qualify", "Deciding who can be emailed, who to ring, and who to leave…")
      : at(progress, "enrich", `Checked ${cursor} of ${snap.state.leadIds.length}`, cursor, snap.state.leadIds.length),
  };
}

async function qualify(ctx: StepContext, snap: Snapshot): Promise<Snapshot> {
  const { store, contacts } = await stores();
  const [settings, emails, suppression, screenings, doNotCall, profile] = await Promise.all([
    store.loadSettings(ctx.sql, ctx.userId),
    store.loadEmails(ctx.sql, ctx.userId),
    store.suppressedSet(ctx.sql, ctx.userId),
    contacts.loadScreenings(ctx.sql, ctx.userId).catch(() => new Map()),
    contacts.loadDoNotCall(ctx.sql, ctx.userId).catch(() => new Map()),
    store.loadProfile(ctx.sql, ctx.userId).catch(() => null),
  ]);
  const ids = new Set(snap.state.leadIds);
  const leads = await store.loadLeadsByIds(ctx.sql, ctx.userId, [...ids]);
  const context = autoContext(emails, [...suppression], settings);
  const outcomes = tallyOutcomes(leads, context);
  const funnel: RunFunnel = {
    ...snap.progress.funnel,
    eligible: outcomes.eligible,
    call: outcomes.call,
    manualReview: outcomes.manualReview,
    goodWebsite: outcomes.goodWebsite,
    lowOpportunity: outcomes.lowOpportunity,
    alreadyInTouch: outcomes.alreadyInTouch,
    optedOut: outcomes.optedOut,
    closed: outcomes.closed,
    noWayToContact: outcomes.noWayToContact,
    otherSkipped: outcomes.otherSkipped,
  };
  const plan = planTargets(leads, context, Number.MAX_SAFE_INTEGER, ids, new Map(Object.entries(snap.state.whyNoEmail)));
  const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
  const scores = scoreAll(leads, {
    screenings,
    doNotCall,
    suppressed: suppression,
    contacted: new Set(emails.filter((email) => email.kind === "initial" && live.has(email.status)).map((email) => email.leadId)),
    rules: settings.contactRules,
    profile: scoringProfile(effectiveProfile(profile)),
  });
  const { summary, top } = summarise(leads, scores, 0);
  let progress = { ...snap.progress, funnel };
  progress = log(
    progress,
    `${summary.strong} strong · ${summary.good} good · ${summary.weak} weak · ${summary.rejected} not worth contacting. ${funnel.eligible} can be emailed · ${summary.callReady} to call · ${summary.review} need a check from you.`,
    funnel.eligible || summary.callReady ? "good" : "warn",
  );
  // Checking businesses you already have writes no drafts: that is a decision
  // for the Businesses page, one business or a selection at a time.
  const draftIds = snap.input.mode === "enrich" ? [] : plan.leadIds;
  const state: FindState = { ...snap.state, step: "draft", cursor: 0, draftIds, callLeadIds: plan.ringing.map((entry) => entry.id), summary, top };
  const next = { ...snap, state, progress: at(progress, "draft", draftIds.length ? `Writing ${draftIds.length} personalised drafts…` : "Wrapping up…", 0, draftIds.length) };
  await persistRun(ctx.sql, ctx.userId, next, "running");
  return next;
}

async function draft(ctx: StepContext, snap: Snapshot, deps: FindDeps): Promise<Snapshot> {
  const { store } = await stores();
  const chunk = snap.state.draftIds.slice(snap.state.cursor, snap.state.cursor + DRAFT_BATCH);
  const funnel: RunFunnel = { ...snap.progress.funnel };
  let progress = snap.progress;
  const readyEmailIds = [...snap.state.readyEmailIds];
  if (chunk.length > 0) {
    const settings = await store.loadSettings(ctx.sql, ctx.userId);
    const written = await deps
      .generate({ leadIds: chunk, mode: settings.defaultMode || "ai", kind: "initial", campaignId: snap.state.campaignId, runId: snap.state.runId }, ctx.userId)
      .catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
    if (!written.ok) {
      funnel.prepareFailed += chunk.length;
      progress = log(progress, written.error, "bad");
    } else {
      for (const row of written.rows) {
        if (row.ok && row.emailId) {
          if (!readyEmailIds.includes(row.emailId)) readyEmailIds.push(row.emailId);
          funnel.prepared += 1;
          if (row.note) progress = log(progress, `${row.subject}: ${row.note}`, "warn");
        } else {
          funnel.prepareFailed += 1;
          progress = log(progress, `Could not write to a prospect: ${row.error ?? "unknown reason"}`, "warn");
        }
      }
    }
  }
  const cursor = Math.min(snap.state.draftIds.length, snap.state.cursor + DRAFT_BATCH);
  const attempted = cursor;
  const done = cursor >= snap.state.draftIds.length;
  const state: FindState = { ...snap.state, cursor, attempted, readyEmailIds, step: done ? "finish" : "draft" };
  progress = { ...progress, funnel };
  return { ...snap, state, progress: at(progress, done ? "finish" : "draft", `Written ${funnel.prepared} of ${snap.state.draftIds.length}`, cursor, snap.state.draftIds.length) };
}

async function finishStep(ctx: StepContext, snap: Snapshot) {
  const { store } = await stores();
  const [settings, emails] = await Promise.all([store.loadSettings(ctx.sql, ctx.userId), store.loadEmails(ctx.sql, ctx.userId)]);
  const funnel: RunFunnel = { ...snap.progress.funnel };
  funnel.notWritten = Math.max(0, funnel.eligible - snap.state.attempted);
  const room = allowance(emails, settings).remaining;
  funnel.readyToday = Math.min(funnel.prepared, Math.max(0, snap.input.dailyLimit), Math.max(0, room));
  funnel.heldForTomorrow = funnel.prepared - funnel.readyToday;
  const progress = { ...snap.progress, funnel };
  const done = { ...snap, progress };
  const summary = snap.state.summary;
  if (snap.input.mode === "enrich") {
    const line = `Checked ${snap.state.leadIds.length} businesses — ${summary?.strong ?? 0} strong, ${funnel.eligible} can be emailed, ${summary?.callReady ?? 0} to call.`;
    return end(ctx, done, "done", line, resultOf(snap.state, progress));
  }
  // New businesses were saved, but if none can be emailed, rung or checked,
  // the run has nothing for you to act on: it says why rather than "Ready".
  const actionable = funnel.prepared + funnel.eligible + (summary?.callReady ?? funnel.call) + (summary?.review ?? funnel.manualReview);
  if (actionable === 0) {
    const diagnosis = await diagnosisFor(ctx, done);
    if (diagnosis) {
      const flagged = { ...done, progress: { ...done.progress, diagnosis } };
      return end(ctx, flagged, "empty", diagnosis.headline, resultOf(snap.state, progress));
    }
  }
  return end(ctx, done, "done", finishLine(funnel, summary?.callReady ?? 0), resultOf(snap.state, progress));
}

async function profileLists(ctx: StepContext): Promise<{ areas: string[]; trades: string[] }> {
  const { store } = await stores();
  const profile = await store.loadProfile(ctx.sql, ctx.userId).catch(() => null);
  const list = (text: string | undefined) => (text ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return { areas: list(profile?.targetAreas), trades: [...new Set([...list(profile?.preferredTrades), ...list(profile?.targetTrades)])] };
}

async function diagnosisFor(ctx: StepContext, snap: Snapshot): Promise<RunDiagnosis | null> {
  const diagnosis = diagnoseRun(snap.progress.ledger, snap.progress.funnel, { location: snap.input.location, trades: snap.input.trades, widenedTo: snap.state.widenedTo });
  if (!diagnosis) return null;
  const { areas, trades } = await profileLists(ctx);
  diagnosis.suggestions = await suggestionsFor(ctx, snap, areas, trades).catch(() => []);
  return diagnosis;
}

/** A discovery that found nothing new: ends at the stage that lost it, with the reason and the next searches. */
async function endEmpty(ctx: StepContext, snap: Snapshot): Promise<StepResult<FindState, FindProgress, FindResult | null>> {
  const diagnosis = await diagnosisFor(ctx, snap);
  const ledger = snap.progress.ledger;
  const sourcesDown = ledger.listings === 0 && ledger.searches.length > 0 && ledger.searches.every((row) => row.error);
  const step: Step = diagnosis?.stage === "deduplication" ? "plan_save" : "discover";
  const why = diagnosis?.headline ?? `No new ${snap.input.trades.join(", ").toLowerCase()} businesses found around ${snap.input.location}.`;
  const ended = { ...snap, progress: at({ ...snap.progress, diagnosis }, step, why) };
  // Sources that never answered are a failure; an area worked out is an empty result.
  return end(ctx, ended, sourcesDown ? "failed" : "empty", why, null);
}

/** Stopped by a person: say how far it got, keep everything it made. */
async function stop(ctx: StepContext, snap: Snapshot): Promise<StepResult<FindState, FindProgress, FindResult | null>> {
  const step = snap.state.step;
  const text =
    step === "setup" || step === "discover" || step === "plan_save"
      ? "Stopped before anything was saved."
      : step === "write" || step === "verify" || step === "count"
        ? "Stopped after saving the new prospects."
        : step === "enrich" || step === "qualify"
          ? "Stopped after checking websites and emails."
          : `Stopped while writing — ${snap.progress.funnel.prepared} drafts are ready to review.`;
  const funnel = { ...snap.progress.funnel, notWritten: step === "draft" || step === "finish" ? Math.max(0, snap.progress.funnel.eligible - snap.state.attempted) : snap.progress.funnel.notWritten };
  const progress = { ...snap.progress, funnel };
  const result = step === "draft" || step === "finish" ? resultOf(snap.state, progress) : null;
  const out = await end(ctx, { ...snap, progress }, "stopped", text, result);
  return out.kind === "done" ? { kind: "cancelled", state: out.state, progress: out.progress, result: result } : out;
}

export function findHandler(deps: FindDeps): JobHandler<FindInput, FindState, FindProgress, FindResult | null> {
  return {
    init: (input) => {
      const runId = newLeadId();
      const enrich = input.mode === "enrich";
      const progress = initialProgress(input, runId, new Date());
      return {
        state: {
          step: enrich ? "verify" : "setup",
          runId,
          campaignId: "",
          activateWhenFilled: false,
          tradeIndex: 0,
          prospects: [],
          rediscovered: [],
          seen: [],
          inRun: [],
          searched: {},
          widenRound: 0,
          widenedTo: [],
          resting: [],
          errors: [],
          save: null,
          leadIds: enrich ? (input.leadIds ?? []) : [],
          cursor: 0,
          verified: [],
          whyNoEmail: {},
          chStopped: "",
          auditStopped: "",
          draftIds: [],
          callLeadIds: [],
          readyEmailIds: [],
          attempted: 0,
          summary: null,
          top: [],
        },
        progress: enrich ? at(progress, "verify", `Checking ${input.leadIds?.length ?? 0} businesses…`, 0, input.leadIds?.length ?? 0) : progress,
      };
    },
    needs: (state) => NEEDS[state.step] ?? 30_000,
    cancel: (ctx, snap) => stop(ctx, snap),
    failed: async (ctx, snap, error) => {
      const out = await end(ctx, snap, "failed", friendlyServerError(new Error(error), "The run stopped unexpectedly."), null);
      return out.progress;
    },
    step: async (ctx, snap): Promise<StepResult<FindState, FindProgress, FindResult | null>> => {
      const { state } = snap;
      let next: Snapshot;
      switch (state.step) {
        case "setup":
          next = await setup(ctx, snap);
          break;
        case "discover":
          next = await discover(ctx, snap, deps);
          if (next.state.step === "plan_save" && next.state.prospects.length === 0) {
            // Nothing new to save. This is not a finished run with results:
            // say which stage lost everything, what was searched, and where to
            // look next — and stop at that stage rather than ticking it off.
            return endEmpty(ctx, next);
          }
          break;
        case "plan_save":
          next = await planSaveStep(ctx, snap);
          break;
        case "write":
          next = await write(ctx, snap);
          break;
        case "verify":
          next = await verify(ctx, snap, deps);
          break;
        case "count":
          next = await count(ctx, snap);
          break;
        case "enrich":
          next = await enrich(ctx, snap, deps);
          break;
        case "qualify":
          next = await qualify(ctx, snap);
          break;
        case "draft":
          next = await draft(ctx, snap, deps);
          break;
        case "finish":
          return finishStep(ctx, snap);
        default:
          return { kind: "failed", state, progress: snap.progress, error: `Unknown step ${String(state.step)}` };
      }
      return { kind: "continue", state: next.state, progress: next.progress };
    },
  };
}

/** The real network, AI and register behind a Find job. Imported lazily: server only. */
export async function realFindDeps(): Promise<FindDeps> {
  const [{ researchCore }, qualify, { generateEmailsCore }, { checkCompanyForLead }, audits, { sharedChLimiter }] = await Promise.all([
    import("../research.ts"),
    import("../qualify-server.ts"),
    import("../outreach/server.ts"),
    import("../contactability/company-check.server.ts"),
    import("../audit/run.server.ts"),
    import("../sources/ch-limiter.server.ts"),
  ]);
  let network: Awaited<ReturnType<typeof audits.realNetwork>> | null = null;
  return {
    research: (input, userId) => researchCore(input, { userId }),
    checkWebsite: (data) => qualify.checkLeadWebsiteCore(data),
    findEmail: (data, userId) => qualify.findLeadEmailCore(data, { userId }),
    checkCompany: async (sql, userId, lead) => checkCompanyForLead(sql, userId, lead, { limiter: await sharedChLimiter() }),
    audit: async (sql, userId, lead) => {
      network ??= await audits.realNetwork();
      const audit = await audits.runWebsiteAudit(sql, userId, lead, network);
      return { status: audit.status, opportunity: audit.opportunity };
    },
    generate: (data, userId) => generateEmailsCore(data, { userId }),
  };
}
