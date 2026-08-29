import { createServerFn } from "@tanstack/react-start";
import {
  classifyWebsiteUrl,
  computePriority,
  mapsHref,
  normalizeName,
  parseNumberInput,
  priorityReason,
  type Priority,
  type WebsiteStatus,
} from "@/lib/leads";

export type Prospect = {
  businessName: string;
  trade: string;
  town: string;
  phone: string;
  rating: number | "";
  reviews: number | "";
  website: string;
  mapsLink: string;
  websiteStatus: WebsiteStatus;
  notes: string;
  source: string;
  priority: Priority;
  reason: string;
};

export type ResearchResult =
  | { ok: true; prospects: Prospect[]; location: string; businessType: string }
  | { ok: false; error: string };

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

export const researchProspects = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Enter a location and business type");
    const location = asString((input as { location?: unknown }).location).slice(0, 80);
    const businessType = asString((input as { businessType?: unknown }).businessType).slice(0, 80);
    if (location.length < 2) throw new Error("Enter a location");
    if (businessType.length < 2) throw new Error("Enter a business type");
    return { location, businessType };
  })
  .handler(async ({ data }): Promise<ResearchResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: "Research is not available in this environment. Grok web search needs an xAI API key.",
      };
    }

    const prompt = `Find up to 8 real ${data.businessType} businesses in or serving ${data.location}, Scotland.

Rules:
- Only include businesses you actually found on the public web (Google, Maps, Yell, Thomson Local, Facebook, company sites).
- Never invent a name, phone, rating, review count, or website.
- If a field is unknown, use an empty string or null.
- Prefer independent local businesses over national chains.
- For each business, check whether they have a proper independent website, only a social page, only a directory listing, or no meaningful web presence.
- Do not assume a missing website field means they have no website — search for one.

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);

    let payload: { output_text?: unknown; output?: Array<{ type?: string; content?: Array<{ text?: string }> }>; error?: { message?: string } };
    try {
      const response = await fetch("https://api.x.ai/v1/responses", {
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
          max_output_tokens: 3200,
        }),
      });
      payload = (await response.json()) as typeof payload;
      if (!response.ok) {
        return { ok: false, error: payload.error?.message || `Research failed (${response.status})` };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        error: aborted
          ? "That search took too long. Try a more specific town or trade."
          : "Could not reach Grok research just now. Try again.",
      };
    } finally {
      clearTimeout(timer);
    }

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

    const toVerify = draft.filter((item) => item.website).slice(0, 8);
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

    if (prospects.length === 0) {
      return {
        ok: false,
        error: `No verified ${data.businessType.toLowerCase()} businesses found in ${data.location}. Try a nearby town.`,
      };
    }

    return { ok: true, prospects, location: data.location, businessType: data.businessType };
  });
