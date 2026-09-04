import { createServerFn } from "@tanstack/react-start";
import {
  classifyWebsiteUrl,
  computePriority,
  mapsHref,
  normalizeName,
  parseNumberInput,
  priorityReason,
  type WebsiteStatus,
} from "@/lib/leads";
import { MAX_PER_BATCH } from "@/lib/regions";
import type { Prospect, ResearchResult } from "@/lib/research-types";

export type { Prospect, ResearchResult };

const HINT_TO_STATUS: Record<string, WebsiteStatus> = {
  proper: "Proper Website",
  "proper website": "Proper Website",
  social: "Social Only",
  "social only": "Social Only",
  directory: "Directory Only",
  "directory only": "Directory Only",
  none: "No Website Found",
  "no website": "No Website Found",
  "no website found": "No Website Found",
  unclear: "Unclear",
};

function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Research did not return a usable list");
  return JSON.parse(raw.slice(start, end + 1)) as unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function asNumber(value: unknown, decimals = 0): number | "" {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  return parseNumberInput(String(value), decimals);
}

function outputText(payload: {
  output_text?: unknown;
  output?: Array<{ type?: string; content?: Array<{ text?: string; type?: string }> }>;
}): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

async function verifyWebsite(url: string): Promise<WebsiteStatus | null> {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "PeakSwiftLeads/1.0 (prospect research)" },
    });
    const finalUrl = response.url || href;
    return classifyWebsiteUrl(finalUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mergeStatus(hint: string, url: string, verified: WebsiteStatus | null): WebsiteStatus {
  const fromUrl = url ? classifyWebsiteUrl(url) : "No Website Found";
  const fromHint = HINT_TO_STATUS[hint.trim().toLowerCase()];
  if (verified === "Social Only" || verified === "Directory Only") return verified;
  if (verified === "Proper Website") return "Proper Website";
  if (fromUrl === "Social Only" || fromUrl === "Directory Only") return fromUrl;
  if (fromUrl === "Proper Website") return "Proper Website";
  if (fromHint) return fromHint;
  if (!url) return "No Website Found";
  return "Unclear";
}

function uniqueProspects(list: Prospect[]): Prospect[] {
  const seen = new Set<string>();
  const next: Prospect[] = [];
  for (const item of list) {
    const key = `${normalizeName(item.businessName)}|${item.town.trim().toLowerCase()}|${item.phone.replace(/\D/g, "").slice(-10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

/**
 * The xAI endpoint. Overridable ONLY so an end-to-end test can point the search
 * at a local stand-in; production never sets it, so there is no path by which
 * invented data reaches the app.
 */
function apiBase(): string {
  const override = process.env.XAI_API_BASE?.trim();
  return (override || "https://api.x.ai/v1").replace(/\/+$/, "");
}

/** Retry once on the failures that are worth retrying: rate limits and 5xx. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type XaiPayload = {
  output_text?: unknown;
  output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  error?: { message?: string };
};

type CallOutcome =
  | { ok: true; payload: XaiPayload }
  | { ok: false; error: string };

async function callXai(apiKey: string, prompt: string, attempt = 0): Promise<CallOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(`${apiBase()}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "grok-4.20-0309-non-reasoning",
        input: [
          {
            role: "system",
            content:
              "You research real local Scottish businesses using web search. Never invent details. Return JSON only.",
          },
          { role: "user", content: prompt },
        ],
        tools: [{ type: "web_search" }],
        max_output_tokens: 3600,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as XaiPayload;
    if (response.ok) return { ok: true, payload };
    if (RETRY_STATUSES.has(response.status) && attempt === 0) {
      clearTimeout(timer);
      await sleep(RETRY_DELAY_MS);
      return callXai(apiKey, prompt, attempt + 1);
    }
    if (response.status === 429) {
      return { ok: false, error: "xAI rate limit reached. Wait a moment and search again." };
    }
    return { ok: false, error: payload.error?.message || `Research failed (${response.status})` };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    if (!aborted && attempt === 0) {
      clearTimeout(timer);
      await sleep(RETRY_DELAY_MS);
      return callXai(apiKey, prompt, attempt + 1);
    }
    return {
      ok: false,
      error: aborted
        ? "That search took too long. Try a smaller area or fewer prospects."
        : "Could not reach Grok research just now. Try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Research one batch of businesses in one place.
 *
 * A large search calls this many times — see `@/lib/prospect-search`, which owns
 * the sweep, the deduplication and the stopping. This function's only job is:
 * find up to `limit` real businesses in `location`, skipping the ones already
 * found, and never make any of them up.
 */
export const researchProspects = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Enter a location and business type");
    const source = input as {
      location?: unknown;
      businessType?: unknown;
      limit?: unknown;
      exclude?: unknown;
      context?: unknown;
    };
    const location = asString(source.location).slice(0, 80);
    const businessType = asString(source.businessType).slice(0, 80);
    if (location.length < 2) throw new Error("Enter a location");
    if (businessType.length < 2) throw new Error("Enter a business type");
    const rawLimit = Number(source.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_PER_BATCH, Math.round(rawLimit)))
      : 8;
    // Bounded: the exclude list rides in the prompt, and an unbounded one would
    // blow the context window (and the bill) on a long sweep.
    const exclude = Array.isArray(source.exclude)
      ? source.exclude.map((name) => asString(name).slice(0, 80)).filter(Boolean).slice(0, 40)
      : [];
    const context = asString(source.context).slice(0, 80);
    return { location, businessType, limit, exclude, context };
  })
  .handler(async ({ data }): Promise<ResearchResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: "Research is not available in this environment. Grok web search needs an xAI API key.",
      };
    }

    const where = data.context && data.context !== data.location
      ? `${data.location} (in ${data.context}), Scotland`
      : `${data.location}, Scotland`;
    const skip =
      data.exclude.length > 0
        ? `\n\nAlready found — do NOT return any of these again:\n${data.exclude.map((n) => `- ${n}`).join("\n")}`
        : "";

    const prompt = `Find up to ${data.limit} real ${data.businessType} businesses in or serving ${where}.

Rules:
- Only include businesses you actually found on the public web (Google, Maps, Yell, Thomson Local, Facebook, company sites).
- NEVER invent a name, phone, rating, review count, or website. It is far better to return 3 real businesses than ${data.limit} with any made up.
- Return fewer than ${data.limit} if that is all that genuinely exists there.
- If a field is unknown, use an empty string or null. Do not guess a phone number.
- Prefer independent local businesses over national chains.
- For each business, check whether they have a proper independent website, only a social page, only a directory listing, or no meaningful web presence.
- Do not assume a missing website field means they have no website — search for one.
- Set "town" to the actual town the business is in, which may differ from the search area.${skip}

Return JSON only:
{"prospects":[{
  "businessName":"",
  "trade":"",
  "town":"",
  "phone":"",
  "rating": null,
  "reviews": null,
  "website":"",
  "mapsLink":"",
  "websiteHint":"proper|social|directory|none|unclear",
  "notes":"",
  "evidence":""
}]}`;

    const call = await callXai(apiKey, prompt);
    if (!call.ok) return { ok: false, error: call.error };
    const payload = call.payload;

    let parsed: { prospects?: unknown };
    try {
      parsed = extractJsonObject(outputText(payload)) as { prospects?: unknown };
    } catch {
      return { ok: false, error: "Research came back in an unexpected format. Try again." };
    }

    const rawList = Array.isArray(parsed.prospects) ? parsed.prospects : [];
    const draft: Array<Prospect & { websiteHint?: string }> = [];
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const businessName = asString(row.businessName || row.name);
      if (businessName.length < 2) continue;
      const town = asString(row.town) || data.location;
      const website = asString(row.website);
      const mapsLink =
        asString(row.mapsLink) ||
        mapsHref({ mapsLink: "", businessName, town }) ||
        "";
      draft.push({
        businessName: businessName.slice(0, 120),
        trade: (asString(row.trade) || data.businessType).slice(0, 60),
        town: town.slice(0, 60),
        phone: asString(row.phone).slice(0, 40),
        rating: asNumber(row.rating, 1),
        reviews: asNumber(row.reviews, 0),
        website,
        mapsLink,
        websiteStatus: "Unclear",
        notes: asString(row.notes).slice(0, 400),
        source: asString(row.evidence || row.source).slice(0, 400),
        websiteHint: asString(row.websiteHint),
        priority: "COLD",
        reason: "",
      });
    }

    const toVerify = draft.filter((item) => item.website).slice(0, MAX_PER_BATCH);
    const verified = await Promise.all(toVerify.map((item) => verifyWebsite(item.website)));
    const verifiedByName = new Map(toVerify.map((item, index) => [item.businessName, verified[index] ?? null]));

    const prospects = uniqueProspects(
      draft.map((item) => {
        const websiteStatus = mergeStatus(
          item.websiteHint ?? "",
          item.website,
          verifiedByName.get(item.businessName) ?? null,
        );
        const scored = {
          ...item,
          websiteStatus,
        };
        const priority = computePriority(scored);
        return {
          businessName: scored.businessName,
          trade: scored.trade,
          town: scored.town,
          phone: scored.phone,
          rating: scored.rating,
          reviews: scored.reviews,
          website: scored.website,
          mapsLink: scored.mapsLink,
          websiteStatus,
          notes: scored.notes,
          source: scored.source,
          priority,
          reason: priorityReason(scored),
        };
      }),
    ).sort((a, b) => {
      const rank = { HOT: 0, WARM: 1, COLD: 2 };
      if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      const aReviews = typeof a.reviews === "number" ? a.reviews : -1;
      const bReviews = typeof b.reviews === "number" ? b.reviews : -1;
      return bReviews - aReviews;
    });

    // An empty batch is a fact about the place, not a failure: a village with no
    // joiners is exactly the answer, and a sweep must not count it as a broken
    // call and give up. The caller decides what to say about a whole empty sweep.
    return { ok: true, prospects, location: data.location, businessType: data.businessType };
  });
