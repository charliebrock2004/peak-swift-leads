/**
 * What discovery recorded about a lead's website and email, as the screens
 * read it. Written server-side by `findLeadEmail`; stored as JSON text and
 * parsed defensively here, so an older or damaged row renders as "not
 * recorded" rather than breaking a card. Client-safe.
 */

export type WebsiteEvidenceRecord = {
  url: string;
  verified: boolean;
  via: string;
  score: number | null;
  confidence: string;
  signals: string[];
  candidatesChecked: number;
  candidatesRejected: number;
  searchProvider: string | null;
  searchesRun: number;
  checkedAt: string;
  /** The search queries actually sent (recorded from Phase C on; empty before). */
  queries: string[];
  /** Candidate sites rejected, and why (recorded from Phase C on). */
  rejections: { url: string; why: string }[];
  /** Set when the search itself failed (no key, quota, outage) — absence then proves nothing. */
  searchFailure: string;
};

export type EmailEvidenceRecord = {
  email: string | null;
  status: string;
  confidence: string | null;
  source: string | null;
  sourceUrl: string;
  evidence: string;
  reason: string | null;
  pagesChecked: number;
  alternatives: { email: string; confidence: string; sourceUrl: string }[];
  rejected: { email: string; why: string; sourceUrl: string }[];
  checkedAt: string;
};

export type LeadEvidence = { website?: WebsiteEvidenceRecord; email?: EmailEvidenceRecord };

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = <T>(value: unknown, map: (item: Record<string, unknown>) => T): T[] =>
  Array.isArray(value) ? value.filter((item) => item && typeof item === "object").map((item) => map(item as Record<string, unknown>)) : [];

export function parseEvidenceRows(rows: readonly { leadId: string; kind: string; json: string }[]): Map<string, LeadEvidence> {
  const out = new Map<string, LeadEvidence>();
  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.json || "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const entry = out.get(row.leadId) ?? {};
    if (row.kind === "website") {
      entry.website = {
        url: str(data.url),
        verified: data.verified === true,
        via: str(data.via),
        score: typeof data.score === "number" ? data.score : null,
        confidence: str(data.confidence),
        signals: Array.isArray(data.signals) ? data.signals.map(String) : [],
        candidatesChecked: num(data.candidatesChecked),
        candidatesRejected: num(data.candidatesRejected),
        searchProvider: typeof data.searchProvider === "string" ? data.searchProvider : null,
        searchesRun: num(data.searchesRun),
        checkedAt: str(data.checkedAt),
        queries: Array.isArray(data.queries) ? data.queries.map(String).slice(0, 12) : [],
        rejections: list(data.rejections, (item) => ({ url: str(item.url), why: str(item.why) })).slice(0, 10),
        searchFailure: str(data.searchFailure),
      };
    } else if (row.kind === "email") {
      entry.email = {
        email: typeof data.email === "string" ? data.email : null,
        status: str(data.status),
        confidence: typeof data.confidence === "string" ? data.confidence : null,
        source: typeof data.source === "string" ? data.source : null,
        sourceUrl: str(data.sourceUrl),
        evidence: str(data.evidence),
        reason: typeof data.reason === "string" ? data.reason : null,
        pagesChecked: num(data.pagesChecked),
        alternatives: list(data.alternatives, (item) => ({
          email: str(item.email),
          confidence: str(item.confidence),
          sourceUrl: str(item.sourceUrl),
        })),
        rejected: list(data.rejected, (item) => ({ email: str(item.email), why: str(item.why), sourceUrl: str(item.sourceUrl) })),
        checkedAt: str(data.checkedAt),
      };
    }
    out.set(row.leadId, entry);
  }
  return out;
}

/** Plain-English ticks for the website signals the identity check recorded. */
export function websiteTicks(record: WebsiteEvidenceRecord | undefined): string[] {
  if (!record) return [];
  const ticks: string[] = [];
  const text = record.signals.join(" ").toLowerCase();
  if (/name/.test(text)) ticks.push("business name");
  if (/town|locality|place/.test(text)) ticks.push("town");
  if (/phone/.test(text)) ticks.push("phone");
  if (/postcode|address/.test(text)) ticks.push("address");
  if (/trade|service/.test(text)) ticks.push("service match");
  if (/domain/.test(text)) ticks.push("domain");
  return ticks;
}
