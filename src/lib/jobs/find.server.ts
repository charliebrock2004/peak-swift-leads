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
import { autoContext, planTargets, searchBreadth, tradeBreadth } from "../outreach/auto-run.ts";
import { clampCampaign, campaignProblem, newCampaign } from "../outreach/campaigns.ts";
import { allowance } from "../outreach/limits.ts";
import { emptyFunnel, reconcileFunnel, tallyOutcomes, type RunFunnel } from "../outreach/run-funnel.ts";
import type { GeneratedRow, GenerateInput } from "../outreach/server.ts";
import type { LeadWithFacts } from "../outreach/types.ts";
import { scoreAll } from "../scoring/records.ts";
import { absorbSearch, appendEvent, countChecks, finishLine, planSave, summarise, type SavePlan } from "./find-steps.ts";
import { insertLeads, loadSheet, loadSheetLeads, patchLead } from "./lead-writes.server.ts";
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
  return {
    location: text(source.location, 80),
    trades,
    target: num(source.target, 50, 1, 200),
    dailyLimit: num(source.dailyLimit, 10, 1, Math.max(1, accountDailyLimit)),
    radiusMiles: num(source.radiusMiles, 25, 5, 50),
    campaignId: text(source.campaignId, 40),
    campaignName: text(source.campaignName, 60),
  };
}

export function findInputProblem(input: FindInput): string {
  if (input.location.length < 2) return "Choose an area.";
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
      funnel: JSON.stringify({ ...funnel, enrichment: progress.enrichment }),
      leadIds: state.leadIds,
      updatedAt: "",
    })
    .catch(() => undefined);
}

async function end(
  ctx: StepContext,
  snap: Snapshot,
  status: "done" | "stopped" | "failed",
  text: string,
  result: FindResult | null,
): Promise<StepResult<FindState, FindProgress, FindResult | null>> {
  const finishedAt = new Date().toISOString();
  const problems = reconcileFunnel(snap.progress.funnel);
  let progress = snap.progress;
  if (problems.length > 0) progress = log(progress, `The run's numbers do not add up: ${problems.join("; ")}`, "bad");
  progress = log(
    {
      ...progress,
      status,
      stage: status === "done" ? "ready" : progress.stage,
      completed: status === "done" ? [...FIND_STAGES] : progress.completed,
      detail: text,
      finishedAt,
      result,
      reconcileProblems: problems,
    },
    text,
    status === "done" ? "good" : status === "failed" ? "bad" : "warn",
  );
  const finished = { ...snap, progress };
  await persistRun(ctx.sql, ctx.userId, finished, status, { summary: text, finishedAt });
  const { store } = await stores();
  await store
    .recordActivity(ctx.sql, ctx.userId, {
      id: newLeadId(),
      type: "SEARCH_COMPLETED",
      result: status,
      reason: text,
      metadata: JSON.stringify({ runId: snap.state.runId, found: progress.funnel.selected, prepared: progress.funnel.prepared }),
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

async function discover(ctx: StepContext, snap: Snapshot, deps: FindDeps): Promise<Snapshot> {
  const { input } = snap;
  const trade = input.trades[snap.state.tradeIndex]!;
  const sheet = await loadSheet(ctx.sql, ctx.userId);
  const known = sheet;
  const suppressed = sheet.filter((lead) => lead.unsubscribed.trim());
  const contacted = sheet.filter((lead) => lead.lastEmailedAt.trim());
  const funnel: RunFunnel = { ...snap.progress.funnel };
  const started = Date.now();
  const perTrade = tradeBreadth(searchBreadth(input.target), input.trades.length);
  const search = await runPlannedSearch({
    location: input.location,
    businessType: trade,
    limit: perTrade,
    known: [...known, ...snap.state.prospects],
    suppressed,
    contacted,
    concurrency: 2,
    shouldCancel: () => Date.now() - started > DISCOVERY_STEP_MAX_MS,
    research: (query) => deps.research({ location: query.location, businessType: query.businessType, limit: query.limit, radiusMiles: input.radiusMiles }, ctx.userId),
  });
  const seen = new Set(snap.state.seen);
  const { added, rediscovered } = absorbSearch(funnel, search, seen);
  let progress = { ...snap.progress, funnel };
  progress = log(progress, `${trade}: ${search.funnel.rawTotal} listings, ${added.length} new.`);
  if (search.cancelled) progress = log(progress, `${trade}: stopped after ${search.funnel.areas} areas to keep the run moving; the rest can be searched in another run.`, "warn");
  const state: FindState = {
    ...snap.state,
    tradeIndex: snap.state.tradeIndex + 1,
    prospects: [...snap.state.prospects, ...added],
    rediscovered: [...snap.state.rediscovered, ...rediscovered].slice(0, REDISCOVERED_MAX),
    seen: [...seen],
    errors: [...new Set([...snap.state.errors, ...search.errors])].slice(0, 20),
  };
  if (state.tradeIndex < input.trades.length) {
    return { ...snap, state, progress: at(progress, "discover", `Searching for ${input.trades[state.tradeIndex]}…`, state.tradeIndex, input.trades.length) };
  }
  for (const problem of state.errors.slice(0, 3)) progress = log(progress, friendlyServerError(new Error(problem)), "warn");
  return { ...snap, state: { ...state, step: "plan_save" }, progress: at(progress, "plan_save", `${funnel.unique} unique businesses → ${state.prospects.length} new to you`) };
}

async function planSaveStep(ctx: StepContext, snap: Snapshot): Promise<Snapshot> {
  const sheet = await loadSheet(ctx.sql, ctx.userId);
  const funnel: RunFunnel = { ...snap.progress.funnel };
  const save = planSave(funnel, snap.state.prospects, snap.state.rediscovered, sheet, new Date().toISOString());
  // The plan (with the new leads' ids) is checkpointed before anything is
  // written, so a repeat of the write step writes the same rows.
  return {
    ...snap,
    state: { ...snap.state, step: "write", save, leadIds: save.ids, prospects: [], rediscovered: [] },
    progress: at({ ...snap.progress, funnel }, "write", `Saving ${save.fresh.length} new prospects…`),
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
          if (!mail.found && mail.discovery.reason) {
            const note = mail.searchFailure ? ` (${SEARCH_FAILURE_LABELS[mail.searchFailure] ?? mail.searchFailure})` : "";
            whyNoEmail[lead.id] = `${DISCOVERY_REASON_LABELS[mail.discovery.reason] ?? mail.discovery.reason}${note}`;
          }
        }
      } catch (error) {
        funnel.checkErrors += 1;
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
  const leads = (await Promise.all(ids.map((id) => store.loadLead(ctx.sql, ctx.userId, id)))).filter((lead): lead is LeadWithFacts => Boolean(lead));

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
          else enrichment.auditFailed += 1;
        } catch {
          enrichment.auditFailed += 1;
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
  const [settings, emails, suppression, screenings, doNotCall] = await Promise.all([
    store.loadSettings(ctx.sql, ctx.userId),
    store.loadEmails(ctx.sql, ctx.userId),
    store.suppressedSet(ctx.sql, ctx.userId),
    contacts.loadScreenings(ctx.sql, ctx.userId).catch(() => new Map()),
    contacts.loadDoNotCall(ctx.sql, ctx.userId).catch(() => new Map()),
  ]);
  const ids = new Set(snap.state.leadIds);
  const leads = (await Promise.all([...ids].map((id) => store.loadLead(ctx.sql, ctx.userId, id)))).filter((lead): lead is LeadWithFacts => Boolean(lead));
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
  });
  const { summary, top } = summarise(leads, scores, 0);
  let progress = { ...snap.progress, funnel };
  progress = log(
    progress,
    `${summary.strong} strong · ${summary.good} good · ${summary.weak} weak · ${summary.rejected} not worth contacting. ${funnel.eligible} can be emailed · ${summary.callReady} to call · ${summary.review} need a check from you.`,
    funnel.eligible || summary.callReady ? "good" : "warn",
  );
  const state: FindState = { ...snap.state, step: "draft", cursor: 0, draftIds: plan.leadIds, callLeadIds: plan.ringing.map((entry) => entry.id), summary, top };
  const next = { ...snap, state, progress: at(progress, "draft", `Writing ${plan.leadIds.length} personalised drafts…`, 0, plan.leadIds.length) };
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
  return end(ctx, done, "done", finishLine(funnel, snap.state.summary?.callReady ?? 0), resultOf(snap.state, progress));
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
      return {
        state: {
          step: "setup",
          runId,
          campaignId: "",
          activateWhenFilled: false,
          tradeIndex: 0,
          prospects: [],
          rediscovered: [],
          seen: [],
          errors: [],
          save: null,
          leadIds: [],
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
        progress: initialProgress(input, runId, new Date()),
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
            const funnel = next.progress.funnel;
            const why =
              funnel.rawFound === 0
                ? next.state.errors[0]
                  ? friendlyServerError(new Error(next.state.errors[0]))
                  : `No ${snap.input.trades.join(", ").toLowerCase()} businesses found around ${snap.input.location}.`
                : `Found ${funnel.rawFound} listings, but none are new — every one is already on your sheet, contacted or opted out.`;
            // It ended in discovery: say so, rather than ticking discovery off.
            const ended = { ...next, progress: at(next.progress, "discover", why) };
            return end(ctx, ended, funnel.rawFound === 0 ? "failed" : "done", why, null);
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
