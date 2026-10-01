/**
 * Every job type's handler, and the lookup the runner uses.
 *
 * Find is its own module (find.server.ts). The rest are small: work through a
 * queue of businesses a few at a time (audits, Companies House checks), poll
 * Gmail for replies until the backlog is clear, or tidy old rows.
 */
import type { Sql } from "@/lib/db";
import { AUDITS_PER_DAY } from "../audit/findings.ts";
import { websiteVerificationOf } from "../audit/website-state.ts";
import { legalFormOf } from "../contactability/lead.ts";
import type { LeadWithFacts } from "../outreach/types.ts";
import type { HandlerLookup, JobHandler, StepContext } from "./runner.server.ts";
import type { JobType } from "./types.ts";

// ── Batches over businesses ──────────────────────────────────────────────────

export type BatchInput = { leadIds?: string[]; limit?: number };
export type BatchState = { planned: boolean; queue: string[]; cursor: number; stopped: string };
export type BatchProgress = { done: number; total: number; ok: number; failed: number; skipped: number; detail: string; stopped: string };

const BATCH_STEP = 3;

function batchHandler(spec: {
  label: string;
  /** Which of these businesses are due. */
  due: (sql: Sql, userId: string, leads: LeadWithFacts[]) => Promise<LeadWithFacts[]>;
  /** Do one; "stop" ends the batch (no key, budget used up). */
  run: (sql: Sql, userId: string, lead: LeadWithFacts) => Promise<{ outcome: "ok" | "failed" | "skipped" } | { outcome: "stop"; reason: string }>;
}): JobHandler<BatchInput, BatchState, BatchProgress, BatchProgress> {
  const progressOf = (state: BatchState, previous: BatchProgress, detail: string): BatchProgress => ({
    ...previous,
    done: state.cursor,
    total: state.queue.length,
    detail,
    stopped: state.stopped,
  });
  return {
    init: () => ({
      state: { planned: false, queue: [], cursor: 0, stopped: "" },
      progress: { done: 0, total: 0, ok: 0, failed: 0, skipped: 0, detail: `Finding businesses that need ${spec.label}…`, stopped: "" },
    }),
    needs: () => 70_000,
    cancel: async (_ctx, job) => ({ kind: "cancelled", state: job.state, progress: { ...job.progress, detail: "Stopped." }, result: job.progress }),
    step: async (ctx: StepContext, job) => {
      const store = await import("../outreach/store.server.ts");
      const limit = Math.max(1, Math.min(200, job.input.limit ?? 50));
      if (!job.state.planned) {
        const all = await store.loadLeads(ctx.sql, ctx.userId);
        const wanted = job.input.leadIds?.length ? new Set(job.input.leadIds) : null;
        const due = await spec.due(ctx.sql, ctx.userId, wanted ? all.filter((lead) => wanted.has(lead.id)) : all);
        const state: BatchState = { planned: true, queue: due.slice(0, limit).map((lead) => lead.id), cursor: 0, stopped: "" };
        const progress = progressOf(state, job.progress, state.queue.length ? `${spec.label}: 0 of ${state.queue.length}` : "Nothing is due.");
        if (state.queue.length === 0) return { kind: "done", state, progress, result: progress };
        return { kind: "continue", state, progress };
      }
      const ids = job.state.queue.slice(job.state.cursor, job.state.cursor + BATCH_STEP);
      const tally = { ok: job.progress.ok, failed: job.progress.failed, skipped: job.progress.skipped };
      let stopped = job.state.stopped;
      for (const id of ids) {
        if (stopped) break;
        const lead = await store.loadLead(ctx.sql, ctx.userId, id);
        if (!lead) {
          tally.skipped += 1;
          continue;
        }
        const out = await spec.run(ctx.sql, ctx.userId, lead).catch(() => ({ outcome: "failed" as const }));
        if (out.outcome === "stop") stopped = out.reason;
        else tally[out.outcome] += 1;
      }
      const state: BatchState = { ...job.state, cursor: stopped ? job.state.queue.length : Math.min(job.state.queue.length, job.state.cursor + BATCH_STEP), stopped };
      const finished = state.cursor >= state.queue.length;
      const progress = progressOf(state, { ...job.progress, ...tally }, stopped ? `Stopped: ${stopped}` : `${spec.label}: ${state.cursor} of ${state.queue.length}`);
      return finished ? { kind: "done", state, progress, result: progress } : { kind: "continue", state, progress };
    },
  };
}

const auditBatch = () =>
  batchHandler({
    label: "website audits",
    due: async (_sql, _userId, leads) => {
      const cutoff = Date.now() - 30 * 86_400_000;
      return leads.filter((lead) => {
        const state = websiteVerificationOf(lead).state;
        if (!lead.website.trim() || !(state === "WEBSITE_FOUND" || state === "WEBSITE_NOT_CONFIRMED" || state === "WEBSITE_UNREACHABLE")) return false;
        const last = lead.facts.audit;
        return !(last && last.status === "ok" && Date.parse(last.finishedAt) > cutoff);
      });
    },
    run: async (sql, userId, lead) => {
      const store = await import("../outreach/store.server.ts");
      const allowed = await store.consumeBudget(sql, userId, "audit", 1, AUDITS_PER_DAY).catch(() => 1);
      if (allowed === null) return { outcome: "stop", reason: `Today's ${AUDITS_PER_DAY} website audits are used up.` };
      const audits = await import("../audit/run.server.ts");
      const audit = await audits.runWebsiteAudit(sql, userId, lead, await audits.realNetwork());
      return { outcome: audit.status === "ok" ? "ok" : "failed" };
    },
  });

const companyBatch = () =>
  batchHandler({
    label: "Companies House checks",
    due: async (sql, userId, leads) => {
      const store = await import("../outreach/store.server.ts");
      const settings = await store.loadSettings(sql, userId);
      const cutoff = Date.now() - 90 * 86_400_000;
      return leads.filter((lead) => {
        const form = legalFormOf(lead, settings.contactRules).form;
        if (form !== "UNKNOWN" && form !== "REVIEW_REQUIRED") return false;
        if (lead.facts.legalFormOverride) return false;
        const checked = Date.parse(lead.facts.companyCheckedAt);
        return !(Number.isFinite(checked) && checked > cutoff);
      });
    },
    run: async (sql, userId, lead) => {
      const { checkCompanyForLead } = await import("../contactability/company-check.server.ts");
      const { sharedChLimiter } = await import("../sources/ch-limiter.server.ts");
      const outcome = await checkCompanyForLead(sql, userId, lead, { limiter: await sharedChLimiter() });
      if (outcome.status === "error") {
        if (outcome.kind === "no-key" || outcome.kind === "budget" || outcome.kind === "rate-limited") return { outcome: "stop", reason: outcome.error };
        return { outcome: "failed" };
      }
      return { outcome: outcome.status === "confirmed" ? "ok" : "skipped" };
    },
  });

// ── Reply polling ────────────────────────────────────────────────────────────

export type ReplyPollProgress = { passes: number; checked: number; replies: number; unsubscribes: number; bounces: number; autoReplies: number; detail: string };

/** Up to this many passes in one job, so a backlog clears without running for ever. */
const REPLY_PASSES = 8;

const replyPoll = (): JobHandler<Record<string, never>, { passes: number }, ReplyPollProgress, ReplyPollProgress> => ({
  init: () => ({
    state: { passes: 0 },
    progress: { passes: 0, checked: 0, replies: 0, unsubscribes: 0, bounces: 0, autoReplies: 0, detail: "Checking Gmail for replies…" },
  }),
  needs: () => 60_000,
  cancel: async (_ctx, job) => ({ kind: "cancelled", state: job.state, progress: job.progress, result: job.progress }),
  step: async (ctx, job) => {
    const { checkRepliesCore } = await import("../outreach/server.ts");
    const report = await checkRepliesCore(ctx.userId);
    if (!report.ok) {
      // Not connected, or Gmail needs attention: nothing to retry until a person fixes it.
      const progress = { ...job.progress, detail: report.error };
      return { kind: "done", state: job.state, progress, result: progress };
    }
    const state = { passes: job.state.passes + 1 };
    const progress: ReplyPollProgress = {
      passes: state.passes,
      checked: job.progress.checked + report.checked,
      replies: job.progress.replies + report.replies,
      unsubscribes: job.progress.unsubscribes + report.unsubscribes,
      bounces: job.progress.bounces + (report.bounces ?? 0),
      autoReplies: job.progress.autoReplies + (report.autoReplies ?? 0),
      detail: "",
    };
    progress.detail = `${progress.replies} new ${progress.replies === 1 ? "reply" : "replies"} from ${progress.checked} checked.`;
    if (report.more && state.passes < REPLY_PASSES) return { kind: "continue", state, progress };
    return { kind: "done", state, progress, result: progress };
  },
});

// ── Retention ────────────────────────────────────────────────────────────────

export type RetentionResult = { jobs: number; audits: number; evidence: number; rateWindows?: number };

/**
 * Tidies what is safe to tidy, and nothing else.
 *
 * Never touched: leads, emails sent, the suppression list, the do-not-call
 * list, screening records, activity — those are the record of what was done
 * and why, and some must be kept to honour an opt-out.
 */
export async function applyRetention(sql: Sql): Promise<RetentionResult> {
  const { pruneJobs } = await import("./store.server.ts");
  const jobs = await pruneJobs(sql, 30);
  // Audit history: keep the five newest per business, and anything from the
  // last 180 days.
  const audits = await sql
    .query(
      `delete from website_audits w
        using (
          select user_id, id, row_number() over (partition by user_id, lead_id order by finished_at desc) as n
            from website_audits
        ) ranked
        where w.user_id = ranked.user_id and w.id = ranked.id
          and ranked.n > 5 and w.finished_at < now() - interval '180 days'
        returning w.id`,
    )
    .then((rows) => rows.length)
    .catch(() => 0);
  // Evidence that was replaced by newer evidence more than a year ago.
  const evidence = await sql
    .query(`delete from evidence_items where superseded_at is not null and superseded_at < now() - interval '365 days' returning id`)
    .then((rows) => rows.length)
    .catch(() => 0);
  // Rate-limit windows (security/rate-limit.server.ts) older than a day.
  const rateWindows = await sql
    .query(`delete from usage_counters where kind like 'rl:%' and day < $1 returning kind`, [new Date(Date.now() - 86_400_000).toISOString().slice(0, 16)])
    .then((rows) => rows.length)
    .catch(() => 0);
  return { jobs, audits, evidence, rateWindows };
}

const retention = (): JobHandler<Record<string, never>, { ran: boolean }, { detail: string }, RetentionResult> => ({
  init: () => ({ state: { ran: false }, progress: { detail: "Tidying old records…" } }),
  cancel: async (_ctx, job) => ({ kind: "cancelled", state: job.state, progress: job.progress }),
  step: async (ctx) => {
    const result = await applyRetention(ctx.sql);
    return { kind: "done", state: { ran: true }, progress: { detail: `Removed ${result.jobs} old jobs, ${result.audits} old audits, ${result.evidence} superseded evidence rows.` }, result };
  },
});

// ── Lookup ───────────────────────────────────────────────────────────────────

export const defaultHandlers: HandlerLookup = async (type: JobType) => {
  switch (type) {
    case "find": {
      const { findHandler, realFindDeps } = await import("./find.server.ts");
      return findHandler(await realFindDeps()) as unknown as JobHandler;
    }
    case "audit_batch":
      return auditBatch() as unknown as JobHandler;
    case "company_batch":
      return companyBatch() as unknown as JobHandler;
    case "reply_poll":
      return replyPoll() as unknown as JobHandler;
    case "retention":
      return retention() as unknown as JobHandler;
    default:
      return null;
  }
};
