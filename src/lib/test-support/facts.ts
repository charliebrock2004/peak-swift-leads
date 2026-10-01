/**
 * Server-held facts for test leads. Test-only; nothing in the app imports it.
 */
import { EMPTY_FACTS, type BusinessFacts } from "../outreach/types.ts";
import type { WebsiteEvidenceRecord } from "../outreach/evidence-record.ts";

/** A recent web search that looked for the business's website and found none. */
export function searchedNoWebsite(overrides: Partial<WebsiteEvidenceRecord> = {}): WebsiteEvidenceRecord {
  return {
    url: "",
    verified: false,
    via: "SEARCH",
    score: null,
    confidence: "NONE",
    signals: [],
    candidatesChecked: 3,
    candidatesRejected: 3,
    searchProvider: "tavily",
    searchesRun: 2,
    checkedAt: new Date().toISOString(),
    queries: ["Strathearn Joinery Crieff", "Strathearn Joinery Crieff website"],
    rejections: [{ url: "https://www.yell.com/biz/strathearn", why: "directory listing" }],
    searchFailure: "",
    ...overrides,
  };
}

export function factsWith(overrides: Partial<BusinessFacts> = {}): BusinessFacts {
  return { ...EMPTY_FACTS, ...overrides };
}
