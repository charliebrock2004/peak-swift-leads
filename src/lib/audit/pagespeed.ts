/**
 * Google PageSpeed Insights (Lighthouse, mobile) — the one measurement of how a
 * site behaves on a phone that is independent of us.
 *
 * Official API: https://developers.google.com/speed/docs/insights/v5/get-started
 * Key: PAGESPEED_API_KEY (Google Cloud, "PageSpeed Insights API" enabled). It
 * also answers without a key at a small shared quota, which is fine for trying
 * it and unreliable for daily use.
 *
 * Results are reported as measurements with a date — "PageSpeed measured
 * mobile performance at 42 on 30 Sep 2026" — never as a verdict on the site.
 * Lab scores vary run to run by a few points; field data (real Chrome users)
 * is shown only when Google has enough of it.
 *
 * Parsing is pure; `runPageSpeed` is the only network call.
 */
import { dateLabel, type Finding } from "./findings.ts";

export const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export type PageSpeedResult = {
  strategy: "mobile";
  fetchedAt: string;
  finalUrl: string;
  /** 0–100 Lighthouse category scores. */
  performance: number | null;
  accessibility: number | null;
  seo: number | null;
  bestPractices: number | null;
  /** Lab metrics (one simulated mobile load). */
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null; speedIndexMs: number | null; pageBytes: number | null };
  /** Field data from real Chrome users (75th percentile), when Google has enough. */
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null; category: string } | null;
  /** Lighthouse audits that failed and matter on a phone. */
  failedMobileAudits: string[];
};

function score(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function numeric(audits: Record<string, { numericValue?: unknown; score?: unknown }>, id: string): number | null {
  const value = audits[id]?.numericValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parsePageSpeed(payload: unknown): PageSpeedResult | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const lighthouse = data.lighthouseResult as Record<string, unknown> | undefined;
  if (!lighthouse) return null;
  const categories = (lighthouse.categories ?? {}) as Record<string, { score?: unknown }>;
  const audits = (lighthouse.audits ?? {}) as Record<string, { numericValue?: unknown; score?: unknown; title?: unknown }>;
  const metrics = ((data.loadingExperience as Record<string, unknown> | undefined)?.metrics ?? {}) as Record<string, { percentile?: unknown }>;
  const percentile = (id: string) => {
    const value = metrics[id]?.percentile;
    return typeof value === "number" ? value : null;
  };
  const fieldCategory = String((data.loadingExperience as Record<string, unknown> | undefined)?.overall_category ?? "");
  const fieldLcp = percentile("LARGEST_CONTENTFUL_PAINT_MS");
  const fieldInp = percentile("INTERACTION_TO_NEXT_PAINT");
  const fieldCls = percentile("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const failed = ["viewport", "font-size", "tap-targets", "image-size-responsive", "content-width"].filter((id) => audits[id] && audits[id]!.score === 0);
  return {
    strategy: "mobile",
    fetchedAt: String(lighthouse.fetchTime ?? data.analysisUTCTimestamp ?? new Date().toISOString()),
    finalUrl: String(lighthouse.finalDisplayedUrl ?? lighthouse.finalUrl ?? data.id ?? ""),
    performance: score(categories.performance?.score),
    accessibility: score(categories.accessibility?.score),
    seo: score(categories.seo?.score),
    bestPractices: score(categories["best-practices"]?.score),
    lab: {
      lcpMs: numeric(audits, "largest-contentful-paint"),
      cls: numeric(audits, "cumulative-layout-shift"),
      tbtMs: numeric(audits, "total-blocking-time"),
      fcpMs: numeric(audits, "first-contentful-paint"),
      speedIndexMs: numeric(audits, "speed-index"),
      pageBytes: numeric(audits, "total-byte-weight"),
    },
    field:
      fieldLcp !== null || fieldInp !== null || fieldCls !== null
        ? { lcpMs: fieldLcp, inpMs: fieldInp, cls: fieldCls !== null ? fieldCls / 100 : null, category: fieldCategory }
        : null,
    failedMobileAudits: failed,
  };
}

const MOBILE_AUDIT_TEXT: Record<string, string> = {
  viewport: "the page is not sized for phones",
  "font-size": "text is too small to read on a phone",
  "tap-targets": "buttons and links are too close together to tap",
  "image-size-responsive": "images are not sized for phone screens",
  "content-width": "content is wider than a phone screen",
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** PageSpeed's measurements as findings, each dated and attributed. */
export function pageSpeedFindings(result: PageSpeedResult, url: string): Finding[] {
  const when = dateLabel(result.fetchedAt);
  const base = { source: "pagespeed" as const, url, observedAt: result.fetchedAt, category: "performance" as const };
  const findings: Finding[] = [];

  if (result.performance !== null) {
    const value = result.performance;
    findings.push({
      ...base,
      kind: "psi_performance",
      status: value < 90 ? "opportunity" : "ok",
      impact: value < 30 ? 8 : value < 50 ? 6 : value < 70 ? 4 : value < 90 ? 2 : 0,
      title: "Mobile performance",
      evidence: `PageSpeed measured mobile performance at ${value}/100 on ${when}.`,
      why: value < 50 ? "Slow pages on a phone lose visitors before the page even appears." : value < 90 ? "There is room to make the site faster on phones." : "",
      value: String(value),
      confidence: "high",
    });
  }
  const lcp = result.field?.lcpMs ?? result.lab.lcpMs;
  if (lcp !== null && lcp > 2500) {
    const field = result.field?.lcpMs != null;
    findings.push({
      ...base,
      kind: "slow_lcp",
      status: "opportunity",
      impact: lcp > 4000 ? 5 : 3,
      title: "Main content slow to appear",
      evidence: field
        ? `Real Chrome users on phones wait ${seconds(lcp)} for the main content to appear (PageSpeed field data, ${when}).`
        : `In PageSpeed's mobile test on ${when}, the main content took ${seconds(lcp)} to appear (Google's target is 2.5 s).`,
      why: "People leave if nothing useful shows within a few seconds.",
      value: String(Math.round(lcp)),
      confidence: field ? "high" : "medium",
    });
  }
  const cls = result.field?.cls ?? result.lab.cls;
  if (cls !== null && cls > 0.25) {
    findings.push({
      ...base,
      kind: "layout_shift",
      status: "opportunity",
      impact: 2,
      title: "Page jumps while loading",
      evidence: `PageSpeed measured a layout shift score of ${cls.toFixed(2)} on ${when} (Google's target is under 0.1).`,
      why: "Content that jumps makes people tap the wrong thing.",
      value: cls.toFixed(2),
      confidence: result.field?.cls != null ? "high" : "medium",
    });
  }
  if (result.field?.inpMs != null && result.field.inpMs > 500) {
    findings.push({
      ...base,
      kind: "slow_interaction",
      status: "opportunity",
      impact: 3,
      title: "Slow to respond to taps",
      evidence: `Real Chrome users wait ${Math.round(result.field.inpMs)} ms for the page to respond to a tap (PageSpeed field data, ${when}).`,
      why: "A page that lags when tapped feels broken.",
      value: String(Math.round(result.field.inpMs)),
      confidence: "high",
    });
  }
  if (result.lab.pageBytes !== null && result.lab.pageBytes > 4_000_000) {
    findings.push({
      ...base,
      kind: "heavy_page",
      status: "opportunity",
      impact: 3,
      title: "Heavy page",
      evidence: `The homepage downloads ${(result.lab.pageBytes / 1_000_000).toFixed(1)} MB on a phone (PageSpeed, ${when}).`,
      why: "Large pages are slow and costly on mobile data.",
      value: String(Math.round(result.lab.pageBytes)),
      confidence: "high",
    });
  }
  for (const id of result.failedMobileAudits) {
    findings.push({
      ...base,
      kind: `psi_${id}`,
      status: "opportunity",
      impact: id === "viewport" || id === "content-width" ? 6 : 3,
      title: "Hard to use on a phone",
      evidence: `PageSpeed's mobile test on ${when} found ${MOBILE_AUDIT_TEXT[id] ?? id}.`,
      why: "Most local searches are on phones.",
      value: id,
      confidence: "high",
    });
  }
  if (result.accessibility !== null && result.accessibility < 70) {
    findings.push({
      ...base,
      kind: "psi_accessibility",
      category: "technical",
      status: "opportunity",
      impact: 2,
      title: "Accessibility issues",
      evidence: `PageSpeed measured accessibility at ${result.accessibility}/100 on ${when}.`,
      why: "Accessibility problems (contrast, labels) also make a site harder for everyone.",
      value: String(result.accessibility),
      confidence: "high",
    });
  }
  if (result.seo !== null && result.seo < 80) {
    findings.push({
      ...base,
      kind: "psi_seo",
      category: "seo",
      status: "opportunity",
      impact: 3,
      title: "Search basics missing",
      evidence: `PageSpeed measured SEO basics at ${result.seo}/100 on ${when}.`,
      why: "The basics Google checks for are missing.",
      value: String(result.seo),
      confidence: "high",
    });
  }
  return findings;
}

export type PageSpeedOutcome = { ok: true; result: PageSpeedResult } | { ok: false; error: string; quota: boolean };

export async function runPageSpeed(
  url: string,
  options: { key?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PageSpeedOutcome> {
  const key = options.key ?? process.env.PAGESPEED_API_KEY?.trim() ?? "";
  const params = new URLSearchParams({ url, strategy: "mobile" });
  for (const category of ["performance", "accessibility", "seo", "best-practices"]) params.append("category", category);
  if (key) params.set("key", key);
  const controller = new AbortController();
  // Lighthouse runs a real page load on Google's side: 20–40 s is normal.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${PAGESPEED_ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 429) {
      return { ok: false, quota: true, error: key ? "PageSpeed quota reached for today." : "PageSpeed's shared quota is used up — set PAGESPEED_API_KEY for a quota of your own." };
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      // Google's messages can echo the request URL; never pass the key along.
      const message = (body?.error?.message ?? `HTTP ${response.status}`).replace(/key=[^&\s]+/g, "key=…").slice(0, 200);
      return { ok: false, quota: false, error: `PageSpeed could not test this site: ${message}` };
    }
    const result = parsePageSpeed(await response.json());
    return result ? { ok: true, result } : { ok: false, quota: false, error: "PageSpeed returned no measurements." };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, quota: false, error: aborted ? "PageSpeed timed out." : "PageSpeed could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}
