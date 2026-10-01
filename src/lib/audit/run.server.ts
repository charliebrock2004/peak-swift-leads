/**
 * Run one website opportunity audit and store it. **Server-only.**
 *
 * Homepage (with redirects and timing), robots.txt, sitemap, a handful of
 * internal links, and Google PageSpeed on mobile — PageSpeed in parallel,
 * because it takes 20–40 seconds on Google's side. Each part that fails is
 * recorded as such; nothing is filled in by guesswork. The audit is kept as a
 * row of its own (history), and one evidence item points at it.
 *
 * Network access is injected so the whole pipeline runs against fixtures in
 * tests.
 */
import type { Sql } from "@/lib/db";
import { classifyWebsiteUrl, websiteHref } from "../leads.ts";
import type { LeadWithFacts } from "../outreach/types.ts";
import { addEvidence } from "../contactability/store.server.ts";
import { keyOpportunities, opportunityLevel, OPPORTUNITY_LABEL, type Finding, type OpportunityLevel } from "./findings.ts";
import { auditHomepage, type HomepageFacts } from "./homepage.ts";
import { pageSpeedFindings, type PageSpeedOutcome, type PageSpeedResult } from "./pagespeed.ts";
import type { PageFetch } from "./fetch.server.ts";

export type AuditNetwork = {
  fetchPage: (url: string) => Promise<PageFetch>;
  robots: (origin: string) => Promise<{ found: boolean; disallowAll: boolean; sitemaps: string[] }>;
  sitemap: (origin: string, declared: string[]) => Promise<boolean>;
  links: (urls: readonly string[]) => Promise<{ checked: number; broken: { url: string; status: number }[] }>;
  pagespeed: (url: string) => Promise<PageSpeedOutcome>;
};

export async function realNetwork(): Promise<AuditNetwork> {
  const net = await import("./fetch.server.ts");
  const { runPageSpeed } = await import("./pagespeed.ts");
  return {
    fetchPage: (url) => net.fetchForAudit(url),
    robots: net.fetchRobots,
    sitemap: net.fetchSitemapExists,
    links: net.checkLinks,
    pagespeed: (url) => runPageSpeed(url),
  };
}

export type WebsiteAudit = {
  id: string;
  leadId: string;
  url: string;
  finalUrl: string;
  status: "ok" | "unreachable" | "error";
  httpStatus: number;
  responseMs: number | null;
  pageBytes: number | null;
  redirects: string[];
  facts: Partial<HomepageFacts>;
  findings: Finding[];
  pagespeed: PageSpeedResult | null;
  pagespeedError: string;
  opportunity: OpportunityLevel | "unmeasured";
  points: number;
  keyFindings: Finding[];
  error: string;
  startedAt: string;
  finishedAt: string;
};

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Up to eight same-site pages linked from the homepage, for the broken-link check. */
export function internalLinks(html: string, base: string, max = 8): string[] {
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    const href = match[1]!.trim();
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const url = new URL(href, origin);
      if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, "") !== origin.hostname.replace(/^www\./, "")) continue;
      if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|docx?)$/i.test(url.pathname)) continue;
      url.hash = "";
      const key = url.toString();
      if (key === origin.toString() || seen.has(key)) continue;
      seen.add(key);
      if (seen.size >= max) break;
    } catch {
      /* not a URL */
    }
  }
  return [...seen];
}

export async function runWebsiteAudit(
  sql: Sql,
  userId: string,
  lead: LeadWithFacts,
  network: AuditNetwork,
  now: () => Date = () => new Date(),
): Promise<WebsiteAudit> {
  const startedAt = now().toISOString();
  const url = websiteHref(lead.website) ?? "";
  const kind = url ? classifyWebsiteUrl(url) : "No Website Found";
  if (!url || kind === "Social Only" || kind === "Directory Only" || kind === "No Website Found") {
    throw new Error("There is no independent website on record to audit.");
  }

  const [page, psi] = await Promise.all([network.fetchPage(url), network.pagespeed(url)]);
  const findings: Finding[] = [];
  let facts: Partial<HomepageFacts> = {};
  let status: WebsiteAudit["status"] = "ok";
  let error = "";

  if (!page.ok) {
    status = "unreachable";
    error = page.error;
    findings.push({
      kind: "unreachable",
      category: "technical",
      status: "opportunity",
      impact: 9,
      title: "Website could not be reached",
      evidence: `${url} could not be loaded on ${new Date(startedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}: ${page.error}`,
      why: "If it is down for us it may be down for customers — worth checking before saying so.",
      value: page.error,
      source: "http",
      url,
      observedAt: startedAt,
      confidence: "medium",
    });
  } else {
    const origin = new URL(page.finalUrl).origin;
    const [robots, links] = await Promise.all([
      network.robots(origin).catch(() => null),
      network.links(internalLinks(page.html, page.finalUrl)).catch(() => null),
    ]);
    const sitemapFound = robots ? await network.sitemap(origin, robots.sitemaps).catch(() => null) : null;
    const audited = auditHomepage({
      url,
      finalUrl: page.finalUrl,
      status: page.status,
      html: page.html,
      responseMs: page.responseMs,
      bytes: page.bytes,
      redirects: page.redirects,
      business: { name: lead.businessName, town: lead.town, trade: lead.trade },
      observedAt: startedAt,
      robots: robots ? { found: robots.found, disallowAll: robots.disallowAll } : null,
      sitemap: sitemapFound === null ? null : { found: sitemapFound },
      links,
    });
    facts = audited.facts;
    findings.push(...audited.findings);
    if (page.status >= 400) status = "error";
  }

  let pagespeed: PageSpeedResult | null = null;
  let pagespeedError = "";
  if (psi.ok) {
    pagespeed = psi.result;
    findings.push(...pageSpeedFindings(psi.result, url));
  } else {
    pagespeedError = psi.error;
  }

  const measured = status === "ok" || pagespeed !== null;
  const { level, points } = opportunityLevel(findings);
  const opportunity: WebsiteAudit["opportunity"] = status === "unreachable" && !pagespeed ? "unmeasured" : measured ? level : "unmeasured";
  const keyFindings = keyOpportunities(findings);
  const finishedAt = now().toISOString();
  const audit: WebsiteAudit = {
    id: newId(),
    leadId: lead.id,
    url,
    finalUrl: page.finalUrl,
    status,
    httpStatus: page.status,
    responseMs: page.responseMs,
    pageBytes: page.ok ? page.bytes : null,
    redirects: page.redirects,
    facts,
    findings,
    pagespeed,
    pagespeedError,
    opportunity,
    points,
    keyFindings,
    error,
    startedAt,
    finishedAt,
  };

  await sql.query(
    `insert into website_audits (user_id, id, lead_id, url, final_url, status, http_status, response_ms, page_bytes, redirects,
       facts, findings, pagespeed, pagespeed_error, opportunity, points, key_findings, error, started_at, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17::jsonb,$18,$19::timestamptz,$20::timestamptz)`,
    [
      userId,
      audit.id,
      lead.id,
      url.slice(0, 500),
      audit.finalUrl.slice(0, 500),
      status,
      audit.httpStatus,
      audit.responseMs,
      audit.pageBytes,
      JSON.stringify(audit.redirects.slice(0, 10)),
      JSON.stringify(facts),
      JSON.stringify(findings),
      pagespeed ? JSON.stringify(pagespeed) : null,
      pagespeedError.slice(0, 300),
      opportunity,
      points,
      JSON.stringify(keyFindings),
      error.slice(0, 300),
      startedAt,
      finishedAt,
    ],
  );

  const opportunities = findings.filter((finding) => finding.status === "opportunity").length;
  await addEvidence(sql, userId, lead.id, [
    {
      kind: "website_audit",
      value: opportunity,
      label:
        opportunity === "unmeasured"
          ? `Website audit could not measure ${url}${error ? `: ${error}` : ""}`
          : `${OPPORTUNITY_LABEL[opportunity]} — ${opportunities} measured finding${opportunities === 1 ? "" : "s"}${pagespeed?.performance != null ? `, mobile PageSpeed ${pagespeed.performance}/100` : ""}`,
      source: "website_audit",
      sourceRef: audit.id,
      sourceUrl: url,
      confidence: status === "ok" && pagespeed ? "high" : "medium",
      observedAt: finishedAt,
      detail: { keyFindings: keyFindings.map((finding) => finding.kind) },
    },
  ]);
  return audit;
}

type AuditRow = Record<string, unknown>;

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = value == null ? "" : String(value);
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : "";
}

export function auditFromRow(row: AuditRow): WebsiteAudit {
  const status = String(row.status ?? "ok");
  return {
    id: String(row.id ?? ""),
    leadId: String(row.lead_id ?? ""),
    url: String(row.url ?? ""),
    finalUrl: String(row.final_url ?? ""),
    status: status === "unreachable" || status === "error" ? status : "ok",
    httpStatus: Number(row.http_status ?? 0),
    responseMs: row.response_ms == null ? null : Number(row.response_ms),
    pageBytes: row.page_bytes == null ? null : Number(row.page_bytes),
    redirects: jsonOf<string[]>(row.redirects, []),
    facts: jsonOf<Partial<HomepageFacts>>(row.facts, {}),
    findings: jsonOf<Finding[]>(row.findings, []),
    pagespeed: jsonOf<PageSpeedResult | null>(row.pagespeed, null),
    pagespeedError: String(row.pagespeed_error ?? ""),
    opportunity: String(row.opportunity ?? "unmeasured") as WebsiteAudit["opportunity"],
    points: Number(row.points ?? 0),
    keyFindings: jsonOf<Finding[]>(row.key_findings, []),
    error: String(row.error ?? ""),
    startedAt: isoOf(row.started_at),
    finishedAt: isoOf(row.finished_at),
  };
}

export async function loadAudit(sql: Sql, userId: string, leadId: string, auditId?: string): Promise<WebsiteAudit | null> {
  const rows = await sql.query<AuditRow>(
    auditId
      ? `select * from website_audits where user_id = $1 and lead_id = $2 and id = $3`
      : `select * from website_audits where user_id = $1 and lead_id = $2 order by finished_at desc limit 1`,
    auditId ? [userId, leadId, auditId] : [userId, leadId],
  );
  return rows[0] ? auditFromRow(rows[0]) : null;
}

export async function auditHistory(sql: Sql, userId: string, leadId: string): Promise<{ id: string; finishedAt: string; opportunity: string; points: number; performance: number | null }[]> {
  const rows = await sql.query<AuditRow>(
    `select id, finished_at, opportunity, points, pagespeed from website_audits where user_id = $1 and lead_id = $2 order by finished_at desc limit 10`,
    [userId, leadId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    finishedAt: isoOf(row.finished_at),
    opportunity: String(row.opportunity),
    points: Number(row.points ?? 0),
    performance: jsonOf<PageSpeedResult | null>(row.pagespeed, null)?.performance ?? null,
  }));
}
