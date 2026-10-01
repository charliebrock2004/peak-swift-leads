import { useCallback, useEffect, useRef, useState } from "react";
import { advanceJob, cancelJob, getJob, startJob } from "@/lib/jobs/server";
import {
  emptyEnrichment,
  type FindEnrichment,
  type FindEvent,
  type FindInput,
  type FindProgress,
  type FindResult,
  type FindStage,
  type JobView,
} from "@/lib/jobs/types";
import { emptyFunnel, type RunFunnel } from "@/lib/outreach/run-funnel";
import { friendlyServerError } from "@/lib/server-errors";
import { useLeadsStore } from "@/store/leads-store";

/**
 * Find & reach — one run, on the server.
 *
 * The run is a background job (src/lib/jobs/find.server.ts): search → save →
 * check websites and emails → Companies House and audits → score → write
 * drafts. It carries on when this tab closes or the phone locks; this hook
 * only starts it, follows it, and nudges it along while the app is open. It
 * stops at READY: drafts wait on the Send screen for a person to read and send.
 */

export type RunConfig = FindInput;
export type RunStatus = "idle" | "starting" | "running" | "done" | "stopped" | "failed";

export type ProspectRunState = {
  status: RunStatus;
  jobId: string;
  stage: FindStage | null;
  completed: FindStage[];
  detail: string;
  progress: { done: number; total: number };
  funnel: RunFunnel;
  enrichment: FindEnrichment;
  config: RunConfig | null;
  log: FindEvent[];
  startedAt: string;
  finishedAt: string;
  result: FindResult | null;
  reconcileProblems: string[];
  /** A problem talking to the server, shown without ending the run. */
  error: string;
};

const DISMISSED_KEY = "peak-swift-find-dismissed";
/** A finished run is shown again on return for this long, until dismissed. */
const SHOW_FINISHED_MS = 12 * 60 * 60 * 1000;
const POLL_MS = 1500;

function initial(): ProspectRunState {
  return {
    status: "idle",
    jobId: "",
    stage: null,
    completed: [],
    detail: "",
    progress: { done: 0, total: 0 },
    funnel: emptyFunnel(),
    enrichment: emptyEnrichment(),
    config: null,
    log: [],
    startedAt: "",
    finishedAt: "",
    result: null,
    reconcileProblems: [],
    error: "",
  };
}

function fromJob(view: JobView<FindProgress, FindResult | null>): ProspectRunState {
  const progress = (view.progress ?? {}) as Partial<FindProgress>;
  const active = view.status === "queued" || view.status === "running";
  const status: RunStatus = active
    ? "running"
    : view.status === "done"
      ? progress.status === "stopped" ? "stopped" : "done"
      : view.status === "cancelled"
        ? "stopped"
        : "failed";
  return {
    status,
    jobId: view.id,
    stage: progress.stage ?? "discovering",
    completed: progress.completed ?? [],
    detail: progress.detail || (view.status === "failed" ? view.error || "The run could not finish." : active ? "Starting…" : ""),
    progress: progress.progress ?? { done: 0, total: 0 },
    funnel: { ...emptyFunnel(), ...(progress.funnel ?? {}) },
    enrichment: { ...emptyEnrichment(), ...(progress.enrichment ?? {}) },
    config: progress.config ?? null,
    log: progress.log ?? [],
    startedAt: progress.startedAt ?? view.createdAt,
    finishedAt: progress.finishedAt || view.finishedAt,
    result: progress.result ?? view.result ?? null,
    reconcileProblems: progress.reconcileProblems ?? [],
    error: "",
  };
}

function parse(reply: { ok: true; job: string | null } | { ok: false; error: string }): JobView<FindProgress, FindResult | null> | null {
  if (!reply.ok || !reply.job) return null;
  try {
    return JSON.parse(reply.job) as JobView<FindProgress, FindResult | null>;
  } catch {
    return null;
  }
}

function dismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? "";
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useProspectRun(onFinished?: () => void) {
  const [run, setRun] = useState<ProspectRunState>(initial);
  const following = useRef("");
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  /** Follow one job until it finishes or another replaces it. */
  const follow = useCallback(async (jobId: string) => {
    following.current = jobId;
    let lastStage = "";
    let failures = 0;
    while (following.current === jobId) {
      const reply = await advanceJob({ data: { id: jobId } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
      if (following.current !== jobId) return;
      const view = parse(reply);
      if (!view) {
        failures += 1;
        const message = reply.ok ? "Lost track of the run." : reply.error;
        setRun((current) => ({ ...current, error: `${message} Still running on the server — retrying…` }));
        await sleep(Math.min(30_000, POLL_MS * 2 ** failures));
        continue;
      }
      failures = 0;
      const next = fromJob(view);
      setRun(next);
      // New leads are written on the server; pull them onto this device as
      // each stage lands, so the Prospects tab fills in while the run goes on.
      if (next.stage && next.stage !== lastStage && lastStage) void useLeadsStore.getState().sync();
      lastStage = next.stage ?? "";
      if (next.status !== "running") {
        following.current = "";
        void useLeadsStore.getState().sync();
        finishedRef.current?.();
        return;
      }
      await sleep(view.running ? POLL_MS : 250);
    }
  }, []);

  // Pick up a run started earlier — in another tab, before a reload, or
  // before the phone locked.
  useEffect(() => {
    let live = true;
    getJob({ data: { type: "find" } })
      .then((reply) => {
        const view = parse(reply);
        if (!live || !view || following.current) return;
        const active = view.status === "queued" || view.status === "running";
        const recent = Date.now() - Date.parse(view.finishedAt || view.updatedAt) < SHOW_FINISHED_MS;
        if (active) {
          setRun(fromJob(view));
          void follow(view.id);
        } else if (recent && dismissed() !== view.id) {
          setRun(fromJob(view));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
      following.current = "";
    };
  }, [follow]);

  const start = useCallback(
    async (config: RunConfig) => {
      if (following.current) return;
      setRun({ ...initial(), status: "starting", config, detail: "Starting…", stage: "discovering", startedAt: new Date().toISOString() });
      // The run de-duplicates against the server's copy of the sheet, so
      // anything added on this device goes up first.
      await useLeadsStore.getState().sync().catch(() => undefined);
      const reply = await startJob({ data: { type: "find", input: config } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
      const view = parse(reply);
      if (!view) {
        setRun({ ...initial(), status: "failed", config, detail: reply.ok ? "Could not start the run." : reply.error });
        return;
      }
      setRun(fromJob(view));
      void follow(view.id);
    },
    [follow],
  );

  const stop = useCallback(() => {
    const jobId = run.jobId;
    if (!jobId || run.status !== "running") return;
    setRun((current) => ({ ...current, detail: "Stopping after the current step…" }));
    void cancelJob({ data: { id: jobId } }).catch(() => undefined);
  }, [run.jobId, run.status]);

  const reset = useCallback(() => {
    if (run.status === "running" || run.status === "starting") return;
    try {
      if (run.jobId) localStorage.setItem(DISMISSED_KEY, run.jobId);
    } catch {
      // Private mode: the run simply shows again next time.
    }
    setRun(initial());
  }, [run.jobId, run.status]);

  const running = run.status === "running" || run.status === "starting";
  return { run, start, stop, reset, running };
}
