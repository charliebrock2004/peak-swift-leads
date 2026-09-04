import { findDuplicate, type Priority } from "./leads.ts";
import { planSearch, RESEARCH_BATCH_MAX, type ResearchPlan } from "./scotland-places.ts";
import type { Prospect, ResearchResult } from "./research.ts";

export type SearchInput = {
  location: string;
  businessType: string;
  limit: number;
  excludeNames: string[];
};

export type SearchProgress = {
  phase: "searching" | "done";
  area: string;
  index: number;
  total: number;
  found: number;
  target: number;
  errors: string[];
  active: string[];
};

export type PlannedSearchResult = {
  prospects: Prospect[];
  errors: string[];
  plan: ResearchPlan;
  cancelled: boolean;
};

export type ResearchFn = (input: SearchInput) => Promise<ResearchResult>;

const RANK: Record<Priority, number> = { HOT: 0, WARM: 1, COLD: 2 };

export function sortProspects(list: Prospect[]): Prospect[] {
  return [...list].sort((a, b) => {
    if (RANK[a.priority] !== RANK[b.priority]) return RANK[a.priority] - RANK[b.priority];
    const aReviews = typeof a.reviews === "number" ? a.reviews : -1;
    const bReviews = typeof b.reviews === "number" ? b.reviews : -1;
    return bReviews - aReviews;
  });
}

export function mergeProspects(existing: Prospect[], incoming: Prospect[], limit: number): Prospect[] {
  const next = [...existing];
  for (const item of incoming) {
    if (next.length >= limit) break;
    if (findDuplicate(item, next)) continue;
    next.push(item);
  }
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fan a location+limit into town batches, research each, merge and stop at
 * `limit` unique genuine businesses. Partial failures keep successful towns.
 */
export async function runPlannedSearch(options: {
  location: string;
  businessType: string;
  limit: number;
  research: ResearchFn;
  shouldCancel?: () => boolean;
  onProgress?: (progress: SearchProgress) => void;
  concurrency?: number;
  rateLimitPauseMs?: number;
}): Promise<PlannedSearchResult> {
  const target = Math.min(100, Math.max(1, Math.round(options.limit) || 8));
  const plan = planSearch(options.location, target);
  let found: Prospect[] = [];
  const errors: string[] = [];
  let cancelled = false;
  let nextIndex = 0;
  let pauseUntil = 0;
  const active = new Set<string>();
  const total = plan.areas.length;
  const workers = Math.max(1, Math.min(options.concurrency ?? 1, total));
  const rateLimitPauseMs = options.rateLimitPauseMs ?? 8000;

  const emit = (area: string, index: number) => {
    options.onProgress?.({
      phase: "searching",
      area,
      index,
      total,
      found: found.length,
      target,
      errors: [...errors],
      active: [...active],
    });
  };

  async function worker() {
    while (true) {
      if (options.shouldCancel?.()) {
        cancelled = true;
        return;
      }
      if (found.length >= target) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= plan.areas.length) return;
      const area = plan.areas[index]!;
      const remaining = target - found.length;
      if (remaining <= 0) return;
      const quota = Math.min(RESEARCH_BATCH_MAX, Math.max(6, Math.min(area.quota, remaining + 4)));
      const wait = pauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      if (options.shouldCancel?.()) {
        cancelled = true;
        return;
      }
      if (found.length >= target) return;
      active.add(area.name);
      emit(area.name, index + 1);
      try {
        const result = await options.research({
          location: area.name,
          businessType: options.businessType,
          limit: quota,
          excludeNames: found.map((item) => item.businessName).slice(0, 40),
        });
        if (options.shouldCancel?.()) {
          cancelled = true;
          if (result.ok) found = mergeProspects(found, result.prospects, target);
          return;
        }
        if (!result.ok) {
          errors.push(`${area.name}: ${result.error}`);
          if (/rate limit|429/i.test(result.error)) pauseUntil = Date.now() + rateLimitPauseMs;
        } else {
          found = mergeProspects(found, result.prospects, target);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search failed";
        errors.push(`${area.name}: ${message}`);
        if (/rate limit|429|too many/i.test(message)) pauseUntil = Date.now() + rateLimitPauseMs;
      } finally {
        active.delete(area.name);
        emit(area.name, index + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  const prospects = sortProspects(found).slice(0, target);
  options.onProgress?.({
    phase: "done",
    area: "",
    index: total,
    total,
    found: prospects.length,
    target,
    errors: [...errors],
    active: [],
  });
  return { prospects, errors, plan, cancelled };
}
