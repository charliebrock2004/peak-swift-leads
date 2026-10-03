/**
 * Job types shared by the server runner and the screens that watch jobs.
 * Client-safe: no server imports.
 */
import type { DiscoveryLedger } from "../discovery-ledger.ts";
import type { RunFunnel } from "../outreach/run-funnel.ts";
import type { RunDiagnosis } from "../run-diagnosis.ts";
import type { Action, Band } from "../scoring/prospect-score.ts";

export const JOB_TYPES = ["find", "audit_batch", "company_batch", "reply_poll", "retention"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** A job as a browser sees it. */
export type JobView<P = unknown, R = unknown> = {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: P;
  result: R | null;
  error: string;
  attempts: number;
  cancelRequested: boolean;
  /** A runner holds a live lease right now. */
  running: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string;
};

// ── Find ─────────────────────────────────────────────────────────────────────

export const FIND_STAGES = ["discovering", "deduplicating", "verifying", "enriching", "qualifying", "personalising", "ready"] as const;
export type FindStage = (typeof FIND_STAGES)[number];

export const FIND_STAGE_TITLES: Record<FindStage, string> = {
  discovering: "Discovering businesses",
  deduplicating: "Removing ones you already know",
  verifying: "Checking websites and public emails",
  enriching: "Companies House and website audits",
  qualifying: "Scoring and choosing a channel",
  personalising: "Writing drafts for you to review",
  ready: "Ready",
};

export type FindInput = {
  location: string;
  trades: string[];
  target: number;
  dailyLimit: number;
  radiusMiles: number;
  /** An existing campaign, or empty to create (or reuse) one called `campaignName`. */
  campaignId: string;
  campaignName: string;
  /**
   * When the places asked for run out of new businesses, search the rest of
   * their region and the regions next door (never across a border you did not
   * name or configure). On unless switched off.
   */
  widen?: boolean;
  /** "enrich": check, audit and score these existing businesses — no search, no drafts. */
  mode?: "find" | "enrich";
  leadIds?: string[];
};

export type FindEvent = { at: string; text: string; tone: "info" | "good" | "warn" | "bad" };

/**
 * "empty": the run finished, but left nothing to act on — no new prospects, or
 * new ones none of which can be contacted or are worth it. Never shown as
 * Ready: the run says which stage lost everything (`diagnosis`).
 */
export type FindRunStatus = "running" | "done" | "empty" | "stopped" | "failed";

/** One business worth looking at first, with the reason in a line. */
export type FindTopProspect = {
  id: string;
  businessName: string;
  trade: string;
  town: string;
  band: Band;
  action: Action;
  priority: number;
  reason: string;
};

export type FindSummary = {
  /** New businesses this run added (or re-found) and checked. */
  found: number;
  strong: number;
  good: number;
  weak: number;
  /** Not a prospect: no measured need, closed, opted out or excluded. */
  rejected: number;
  /** Drafts written and waiting for review. */
  emailReady: number;
  /** Best reached by phone (screening permitting). */
  callReady: number;
  /** Need one check from you before they can be contacted. */
  review: number;
};

export type FindEnrichment = {
  companiesChecked: number;
  companiesConfirmed: number;
  companiesAmbiguous: number;
  audited: number;
  auditFailed: number;
  /** Why enrichment stopped early (no key, budget used up), if it did. */
  stopped: string[];
};

export type FindResult = {
  runId: string;
  campaignId: string;
  leadIds: string[];
  readyEmailIds: string[];
  callLeadIds: string[];
  summary: FindSummary;
  top: FindTopProspect[];
};

/** Everything the Find screen draws, checkpointed after every unit of work. */
export type FindProgress = {
  status: FindRunStatus;
  stage: FindStage;
  completed: FindStage[];
  detail: string;
  progress: { done: number; total: number };
  funnel: RunFunnel;
  /** Every discovered listing's one outcome, per search. The discovery funnel is read from this. */
  ledger: DiscoveryLedger;
  /** Why the run left nothing to act on, when it did. */
  diagnosis: RunDiagnosis | null;
  enrichment: FindEnrichment;
  config: FindInput;
  log: FindEvent[];
  startedAt: string;
  finishedAt: string;
  runId: string;
  result: FindResult | null;
  reconcileProblems: string[];
};

export function emptyEnrichment(): FindEnrichment {
  return { companiesChecked: 0, companiesConfirmed: 0, companiesAmbiguous: 0, audited: 0, auditFailed: 0, stopped: [] };
}
