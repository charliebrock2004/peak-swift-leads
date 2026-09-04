import { createServerFn } from "@tanstack/react-start";
import {
  classifyWebsiteUrl,
  computePriority,
  extractIndependentUrl,
  findDuplicate,
  mapsHref,
  mergeWebsiteEvidence,
  parseNumberInput,
  priorityReason,
  type Priority,
  type WebsiteStatus,
} from "@/lib/leads";
import { RESEARCH_BATCH_MAX } from "@/lib/scotland-places";

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

const RESEARCH_MODEL = "grok-4.5";
/** Leave headroom under Vercel's function limit for website verification. */
const RESEARCH_TIMEOUT_MS = 110_000;

function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("Research did not return a usable list");
  const end = raw.lastIndexOf("}");
  const slice = end > start ? raw.slice(start, end + 1) : raw.slice(start);
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    return JSON.parse(repairJson(slice)) as unknown;
  }
}

function repairJson(raw: string): string {
  let text = raw.trim().replace(/,\s*$/, "");
  const openArr = (text.match(/\[/g) || []).length;
  const closeArr = (text.match(/\]/g) || []).length;
  const opens = (text.match(/\{/g) || []).length;
  const closes = (text.match(/\}/g) || []).length;
  if (openArr > closeArr) text += "]".repeat(openArr - closeArr);
  if (opens > closes) text += "}".repeat(opens - closes);
  return text;
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

function asPhone(value: unknown): string {
  const text = asString(value);
  if (!text || /^(n\/a|na|none|unknown|not found|unlisted|-)$/i.test(text)) return "";
  return text.slice(0, 40);
}

function collectText(payload: {
  output_text?: unknown;
  output?: Array<{ type?: string; content?: Array<{ text?: string; type?: string }> }>;
}): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const messages: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    const chunks: string[] = [];
    for (const part of item.content ?? []) {
      if (part.text) chunks.push(part.text);
    }
    const text = chunks.join("\n").trim();
    if (text) messages.push(text);
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].includes("{")) return messages[i];
  }
  return messages.join("\n");
}

function firstSocialUrl(...texts: string[]): string {
  for (const text of texts) {
    const match = text.match(
      /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|instagram\.com)\/[^\s"'<>)]+/i,
    );
    if (match) return match[0].replace(/[.,;]+$/, "");
  }
  return "";
}

function describeXaiFailure(status: number, payload: { error?: { message?: string; code?: string } }): string {
  const message = payload.error?.message?.trim() || "";
  const code = payload.error?.code?.trim() || "";
  if (status === 401 || status === 403) {
    return "Lead search failed because the server xAI API key was rejected. XAI_API_KEY must be a valid server-side key.";
  }
  if (status === 429) {
    return "Lead search hit the xAI rate limit. Wait a minute and try again.";
  }
  if (/model/i.test(message) && /not found|invalid|unavailable/i.test(message)) {
    return `Lead search failed because the xAI model is unavailable (${RESEARCH_MODEL}). ${message}`;
  }
  if (message) return `Lead search failed (${status}): ${message}`;
  if (code) return `Lead search failed (${status} ${code}).`;
  return `Lead search failed because xAI returned HTTP ${status}.`;
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

function uniqueProspects(list: Prospect[]): Prospect[] {
  const next: Prospect[] = [];
  for (const item of list) {
    if (findDuplicate(item, next)) continue;
    next.push(item);
  }
  return next;
}

function appendNote(notes: string, extra: string): string {
  if (!extra) return notes;
  if (!notes) return extra;
  if (notes.toLowerCase().includes(extra.toLowerCase())) return notes;
  return `${notes} ${extra}`.trim();
}

export const researchProspects = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Enter a location and business type");
    const location = asString((input as { location?: unknown }).location).slice(0, 80);
    const businessType = asString((input as { businessType?: unknown }).businessType).slice(0, 80);
    const rawLimit = Number((input as { limit?: unknown }).limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(RESEARCH_BATCH_MAX, Math.max(1, Math.round(rawLimit)))
      : 8;
    const excludeRaw = (input as { excludeNames?: unknown }).excludeNames;
    const excludeNames = Array.isArray(excludeRaw)
      ? excludeRaw
          .map((value) => asString(value).slice(0, 80))
          .filter((name) => name.length >= 2)
          .slice(0, 40)
      : [];
    if (location.length < 2) throw new Error("Enter a location");
    if (businessType.length < 2) throw new Error("Enter a business type");
    return { location, businessType, limit, excludeNames };
  })
  .handler(async ({ data }): Promise<ResearchResult> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Lead search failed because XAI_API_KEY is missing from the production server. In Vercel open peak-swift-leads → Settings → Environment Variables. Add XAI_API_KEY (server only — do not prefix with VITE_), tick Production, then Redeploy. Create a key at console.x.ai if you do not have one.",
      };
    }

    const skip =
      data.excludeNames.length > 0
        ? `\n- Do not include these businesses, they are already found: ${data.excludeNames.join("; ")}.`
        : "";

    const prompt = `Find up to ${data.limit} real ${data.businessType} businesses in or serving ${data.location}, Scotland.

Use web search, then return JSON only. Do not write progress messages.

Keep the search short — about 6 to 10 searches:
1. "${data.businessType} ${data.location} Scotland"
2. Yell, Thomson Local, Checkatrade, MyBuilder and Facebook for the same query
3. For the strongest candidates, confirm phone, rating/reviews, and whether they have an independent website

Rules:
- Only include businesses you actually found on the public web.
- Never invent a name, phone, rating, review count, or website.
- If a field is unknown, use an empty string or null. Do not guess.
- Prefer independent local businesses over national chains.
- Include real local businesses even if they already have a website — we will rank them.
- Put the actual URL you found in "website":
  - independent site → that URL, websiteHint=proper
  - Facebook/Instagram only → that profile URL, websiteHint=social
  - directory listing only (Yell, Thomson Local, Checkatrade, Google Maps, MyBuilder) → that listing URL, websiteHint=directory
  - nothing found → website="", websiteHint=none
  - mixed or thin evidence → websiteHint=unclear
- A Facebook page, Instagram page or directory listing is NOT a proper website.
- Phone numbers from Yell, Thomson Local or the business site are valid.
- Prefer Google Maps rating and review count. If you only have Checkatrade or MyBuilder figures, still include them and say so in notes.${skip}

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
    const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);

    type XaiPayload = {
      output_text?: unknown;
      output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
      error?: { message?: string; code?: string };
      status?: string;
      incomplete_details?: { reason?: string };
    };

    let payload: XaiPayload;
    try {
      const response = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: RESEARCH_MODEL,
          input: [
            {
              role: "system",
              content:
                "You research real local Scottish businesses using web search. Never invent details. After searching, output JSON only — no commentary.",
            },
            { role: "user", content: prompt },
          ],
          tools: [{ type: "web_search" }],
          max_output_tokens: 5000,
          max_tool_calls: 10,
          store: false,
        }),
      });
      payload = (await response.json()) as XaiPayload;
      if (!response.ok) {
        console.error("[research] xAI HTTP", response.status, payload.error);
        return { ok: false, error: describeXaiFailure(response.status, payload) };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      console.error("[research] xAI request failed:", error);
      return {
        ok: false,
        error: aborted
          ? "That search took too long. Try a more specific town or fewer results."
          : "Could not reach the xAI research API just now. Try again.",
      };
    } finally {
      clearTimeout(timer);
    }

    const rawText = collectText(payload);
    let parsed: { prospects?: unknown };
    try {
      parsed = extractJsonObject(rawText) as { prospects?: unknown };
    } catch {
      const reason = payload.incomplete_details?.reason;
      const status = payload.status;
      console.error("[research] unusable xAI output", { status, reason, preview: rawText.slice(0, 400) });
      if (status === "incomplete") {
        return {
          ok: false,
          error: reason
            ? `Lead search stopped early (${reason}). Try fewer results or a more specific town.`
            : "Lead search stopped before it finished. Try fewer results or a more specific town.",
        };
      }
      if (!rawText.trim()) {
        return {
          ok: false,
          error: "Lead search returned an empty response from xAI. Try again.",
        };
      }
      return {
        ok: false,
        error: "Research came back in an unexpected format. Try again.",
      };
    }

    const rawList = Array.isArray(parsed.prospects) ? parsed.prospects : [];
    const draft: Array<Prospect & { websiteHint?: string; candidateSite?: string }> = [];
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const businessName = asString(row.businessName || row.name);
      if (businessName.length < 2) continue;
      const town = asString(row.town) || data.location;
      const notes = asString(row.notes).slice(0, 400);
      const source = asString(row.evidence || row.source).slice(0, 400);
      let website = asString(row.website);
      if (!website) website = firstSocialUrl(notes, source);
      const candidateSite =
        classifyWebsiteUrl(website) === "Proper Website"
          ? ""
          : extractIndependentUrl([website, notes, source].join(" "));
      const mapsLink =
        asString(row.mapsLink) ||
        mapsHref({ mapsLink: "", businessName, town }) ||
        "";
      draft.push({
        businessName: businessName.slice(0, 120),
        trade: (asString(row.trade) || data.businessType).slice(0, 60),
        town: town.slice(0, 60),
        phone: asPhone(row.phone),
        rating: asNumber(row.rating, 1),
        reviews: asNumber(row.reviews, 0),
        website,
        mapsLink,
        websiteStatus: "Unclear",
        notes,
        source,
        websiteHint: asString(row.websiteHint),
        candidateSite,
        priority: "COLD",
        reason: "",
      });
    }

    const toVerify = draft
      .flatMap((item) =>
        [item.website, item.candidateSite].filter((url): url is string => Boolean(url)),
      )
      .slice(0, data.limit * 2);
    const verified = await Promise.all(toVerify.map((url) => verifyWebsite(url)));
    const verifiedByUrl = new Map(toVerify.map((url, index) => [url, verified[index] ?? null]));

    const prospects = uniqueProspects(
      draft.map((item) => {
        let website = item.website;
        let live = website ? (verifiedByUrl.get(website) ?? null) : null;
        if (item.candidateSite && verifiedByUrl.get(item.candidateSite) === "Proper Website") {
          website = item.candidateSite;
          live = "Proper Website";
        }
        const websiteStatus = mergeWebsiteEvidence(item.websiteHint ?? "", website, live);
        let notes = item.notes;
        if (website && classifyWebsiteUrl(website) === "Proper Website" && live === null) {
          notes = appendNote(notes, "Listed website did not load.");
        }
        const scored = {
          ...item,
          website,
          notes,
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
    )
      .sort((a, b) => {
        const rank = { HOT: 0, WARM: 1, COLD: 2 };
        if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
        const aReviews = typeof a.reviews === "number" ? a.reviews : -1;
        const bReviews = typeof b.reviews === "number" ? b.reviews : -1;
        return bReviews - aReviews;
      })
      .slice(0, data.limit);

    if (prospects.length === 0) {
      return { ok: true, prospects: [], location: data.location, businessType: data.businessType };
    }

    console.info(
      `[research] ${data.location} ${data.businessType} → ${prospects.length}`,
      prospects.map((item) => `${item.priority}:${item.businessName} (${item.town})`).join(" | "),
    );

    return { ok: true, prospects, location: data.location, businessType: data.businessType };
  });
