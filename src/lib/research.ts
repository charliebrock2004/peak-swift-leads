import { createServerFn } from "@tanstack/react-start";
import {
  classifyWebsiteUrl,
  computePriority,
  mergeWebsiteEvidence,
  priorityReason,
  type Priority,
  type WebsiteStatus,
} from "@/lib/leads";
import { discoverBusinesses, listingWebsiteHint, type DiscoveredPlace } from "@/lib/osm-discover";

export type Prospect = {
  businessName: string;
  trade: string;
  town: string;
  address: string;
  phone: string;
  email: string;
  rating: number | "";
  reviews: number | "";
  website: string;
  mapsLink: string;
  websiteStatus: WebsiteStatus;
  notes: string;
  source: string;
  priority: Priority;
  reason: string;
  lat: number | "";
  lng: number | "";
  placeId: string;
  foundAt: string;
  businessStatus: string;
};

export type ResearchResult =
  | { ok: true; prospects: Prospect[]; location: string; businessType: string; warnings?: string[] }
  | { ok: false; error: string };

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function isThinHtml(html: string): boolean {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 400) return true;
  if (/coming soon|under construction|domain for sale|buy this domain|parked free|this domain is parked/i.test(html)) {
    return true;
  }
  if (/generator" content="(?:Wix|Squarespace|Weebly|GoDaddy)/i.test(html) && stripped.length < 1500) {
    return true;
  }
  return false;
}

async function inspectWebsite(url: string): Promise<{ status: WebsiteStatus | null; thin: boolean }> {
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
    const classified = classifyWebsiteUrl(finalUrl);
    if (classified !== "Proper Website") return { status: classified, thin: false };
    const html = (await response.text()).slice(0, 40_000);
    return { status: "Proper Website", thin: isThinHtml(html) };
  } catch {
    return { status: null, thin: false };
  } finally {
    clearTimeout(timer);
  }
}

function scorePlace(place: DiscoveredPlace, websiteStatus: WebsiteStatus, extraNote: string): Prospect {
  const notes = [place.notes, extraNote].filter(Boolean).join(" ").trim();
  const scored = {
    ...place,
    websiteStatus,
    notes,
    rating: "" as const,
    reviews: "" as const,
  };
  const priority = computePriority(scored);
  return {
    businessName: place.businessName,
    trade: place.trade,
    town: place.town,
    address: place.address,
    phone: place.phone,
    email: place.email,
    rating: "",
    reviews: "",
    website: place.website,
    mapsLink: place.mapsLink,
    websiteStatus,
    notes,
    source: place.source,
    priority,
    reason: priorityReason(scored),
    lat: place.lat,
    lng: place.lng,
    placeId: place.placeId,
    foundAt: new Date().toISOString(),
    businessStatus: place.businessStatus,
  };
}

function websiteStatusForPlace(
  place: DiscoveredPlace,
  live: { status: WebsiteStatus | null; thin: boolean } | null,
): { status: WebsiteStatus; extra: string } {
  if (place.website) {
    if (live?.status === "Social Only" || live?.status === "Directory Only") {
      return { status: live.status, extra: "" };
    }
    if (live?.status === "Proper Website" && live.thin) {
      return { status: "Basic Website", extra: "Website looks basic or template-built." };
    }
    return { status: mergeWebsiteEvidence("", place.website, live?.status ?? null), extra: "" };
  }
  // Companies House never publishes websites. Empty is not proof they have none
  // unless the same business was also found on OpenStreetMap.
  if (listingWebsiteHint(place) === "unconfirmed") {
    return {
      status: "Unclear",
      extra: "Companies House listing has no website field — not confirmed missing.",
    };
  }
  return { status: "No Website Found", extra: "" };
}

export const researchProspects = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Enter a location and business type");
    const location = asString((input as { location?: unknown }).location).slice(0, 80);
    const businessType = asString((input as { businessType?: unknown }).businessType).slice(0, 80);
    const rawLimit = Number((input as { limit?: unknown }).limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.round(rawLimit))) : 25;
    const rawRadius = Number((input as { radiusMiles?: unknown }).radiusMiles);
    const radiusMiles = Number.isFinite(rawRadius) ? Math.min(80, Math.max(5, Math.round(rawRadius))) : 25;
    if (location.length < 2) throw new Error("Enter a location");
    if (businessType.length < 2) throw new Error("Enter a business type");
    return { location, businessType, limit, radiusMiles };
  })
  .handler(async ({ data }): Promise<ResearchResult> => {
    const found = await discoverBusinesses(data);
    if (!found.ok) return { ok: false, error: found.error };

    const toInspect = found.places
      .map((place) => place.website)
      .filter((url) => Boolean(url))
      .slice(0, Math.min(30, data.limit * 2));
    const inspected = await Promise.all(toInspect.map((url) => inspectWebsite(url)));
    const byUrl = new Map(toInspect.map((url, index) => [url, inspected[index]!]));

    const rank: Record<Priority, number> = { HOT: 0, WARM: 1, COLD: 2 };
    const prospects = found.places
      .map((place) => {
        const live = place.website ? (byUrl.get(place.website) ?? null) : null;
        const { status, extra } = websiteStatusForPlace(place, live);
        return scorePlace(place, status, extra);
      })
      .sort((a, b) => {
        if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
        return a.businessName.localeCompare(b.businessName, "en-GB");
      })
      .slice(0, data.limit);

    if (prospects.length === 0) {
      return {
        ok: false,
        error: `No ${data.businessType.toLowerCase()} businesses found in ${data.location}. Try a larger radius.`,
      };
    }

    return {
      ok: true,
      prospects,
      location: found.locationLabel || data.location,
      businessType: data.businessType,
      warnings: found.warnings,
    };
  });
