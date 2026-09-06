/**
 * Free local-business discovery.
 *
 * Sources, all without an API key:
 *   1. Companies House — UK trades (joiners, plumbers, builders, electricians)
 *   2. Nominatim / Photon / BizData — mapped shops (restaurants, hair, garages)
 *   3. Overpass, last resort if maps fail and CH is empty
 *
 * Nothing here talks to Google Places or xAI.
 */

import { chSearchTowns } from "./scotland-places.ts";
import { searchCompaniesHouse, type CompanyHit } from "./companies-house.ts";

export type DiscoveredPlace = {
  businessName: string;
  trade: string;
  town: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  lat: number | "";
  lng: number | "";
  mapsLink: string;
  source: string;
  notes: string;
};

export type DiscoverResult =
  | { ok: true; places: DiscoveredPlace[]; warnings: string[]; locationLabel: string }
  | { ok: false; error: string; warnings: string[] };

export const RADIUS_MILES = [10, 25, 50] as const;
export type RadiusMiles = (typeof RADIUS_MILES)[number];

const USER_AGENT = "PeakSwiftLeads/1.0 (https://peak-swift-leads.vercel.app)";
const MILES_TO_KM = 1.60934;
const EARTH_MILES = 3958.8;

const CHAINS = [
  "howdens",
  "screwfix",
  "travis perkins",
  "wickes",
  "b&q",
  "b and q",
  "homebase",
  "toolstation",
  "jewson",
  "buildbase",
  "selco",
  "mkm",
  "wolseley",
  "plumbase",
  "plumb center",
  "plumbcentre",
  "city plumbing",
  "graham plumber",
  "edmundson",
  "yesss electrical",
  "city electrical factors",
  "rexel",
  "magnet kitchens",
  "kfc",
  "mcdonald",
  "burger king",
  "subway",
  "costa coffee",
  "starbucks",
  "greggs",
  "tesco",
  "sainsbury",
  "asda",
  "aldi",
  "lidl",
  "specsavers",
  "halfords",
  "harvester",
  "pizza hut",
  "domino's",
  "dominos",
  "wetherspoon",
];

const REJECT_KEYS = new Set([
  "highway",
  "place",
  "natural",
  "railway",
  "waterway",
  "boundary",
  "landuse",
  "leisure",
  "historic",
  "man_made",
]);

const REJECT_VALUES = new Set([
  "charging_station",
  "parking",
  "peak",
  "forest",
  "cemetery",
  "hamlet",
  "path",
  "residential",
  "house",
  "detached",
  "apartments",
  "farmyard",
  "industrial",
  "unclassified",
]);

type TradeProfile = {
  queries: string[];
  nominatim: string[];
  bizdata?: string;
  rejectName?: RegExp;
  /** false = bias to the area, then radius-filter (sparse UK crafts). */
  bounded?: boolean;
};

const TRADE_PROFILES: Array<{ match: RegExp; profile: TradeProfile }> = [
  {
    match: /join|carpent/,
    profile: { queries: ["joinery", "joiner", "carpenter"], nominatim: ["joinery", "carpenter"] },
  },
  {
    match: /plumb/,
    profile: {
      queries: ["plumber", "plumbing"],
      nominatim: ["plumbing", "plumber"],
      bounded: false,
    },
  },
  {
    match: /electric/,
    profile: {
      queries: ["electrician", "electrical"],
      nominatim: ["electrician"],
      rejectName: /charging|ev\b|bike|fleet|center|factors|yesss|cottage/i,
    },
  },
  {
    match: /build/,
    profile: { queries: ["builder", "builders"], nominatim: ["builders"], bounded: false },
  },
  { match: /roof/, profile: { queries: ["roofer", "roofing"], nominatim: ["roofer", "roofing"], bounded: false } },
  { match: /paint|decorat/, profile: { queries: ["painter", "decorator"], nominatim: ["painter", "decorator"] } },
  {
    match: /landscap|garden/,
    profile: { queries: ["landscaper", "gardener", "garden"], nominatim: ["gardener", "landscaper"] },
  },
  { match: /tree/, profile: { queries: ["tree surgeon", "arborist"], nominatim: ["tree surgeon"] } },
  {
    match: /mechan/,
    profile: { queries: ["mechanic", "garage"], nominatim: ["car repair", "garage"], bizdata: "car_repair" },
  },
  {
    match: /garage/,
    profile: { queries: ["garage", "car repair"], nominatim: ["garage"], bizdata: "car_repair" },
  },
  { match: /barber/, profile: { queries: ["barber"], nominatim: ["barber", "hairdresser"], bizdata: "hairdresser" } },
  {
    match: /hair/,
    profile: { queries: ["hairdresser", "salon"], nominatim: ["hairdresser"], bizdata: "hairdresser" },
  },
  { match: /beauty/, profile: { queries: ["beauty salon", "beauty"], nominatim: ["beauty"], bizdata: "beauty" } },
  { match: /florist|flower/, profile: { queries: ["florist"], nominatim: ["florist"], bizdata: "florist" } },
  {
    match: /restaurant/,
    profile: { queries: ["restaurant"], nominatim: ["restaurant"], bizdata: "restaurant" },
  },
  { match: /cafe|café/, profile: { queries: ["cafe"], nominatim: ["cafe"], bizdata: "cafe" } },
  { match: /\bpub\b/, profile: { queries: ["pub"], nominatim: ["pub"], bizdata: "bar" } },
  {
    match: /takeaway|take away/,
    profile: { queries: ["takeaway", "fast food"], nominatim: ["fast food", "takeaway"], bizdata: "restaurant" },
  },
  { match: /clean/, profile: { queries: ["cleaner", "cleaning"], nominatim: ["cleaning"] } },
  { match: /dog groom/, profile: { queries: ["dog groomer", "grooming"], nominatim: ["pet grooming"] } },
];

const DEFAULT_PROFILE: TradeProfile = { queries: [], nominatim: [] };

export function foldTrade(value: string): string {
  return value.trim().toLowerCase();
}

export function profileFor(trade: string): TradeProfile {
  const key = foldTrade(trade);
  const found = TRADE_PROFILES.find((entry) => entry.match.test(key));
  if (found) return found.profile;
  const word = key.replace(/[^a-z0-9]+/g, " ").trim();
  return word ? { queries: [word], nominatim: [word] } : DEFAULT_PROFILE;
}

export function isNationalChain(name: string): boolean {
  const key = name.trim().toLowerCase();
  return CHAINS.some((chain) => key === chain || key.startsWith(`${chain} `) || key.includes(` ${chain}`));
}

export function isMerchantName(name: string): boolean {
  const key = name.trim().toLowerCase();
  return (
    /\b(supplies|supply|merchant|depot|factors|wholesale|trade counter)\b/.test(key) ||
    /howdens/.test(key) ||
    /^city plumbing\b/.test(key)
  );
}

export function isRejectedOsm(osmKey: string, osmValue: string, name: string): boolean {
  const key = osmKey.trim().toLowerCase();
  const value = osmValue.trim().toLowerCase();
  if (REJECT_KEYS.has(key) && key !== "landuse") return true;
  if (key === "landuse" && value !== "commercial") return true;
  if (REJECT_VALUES.has(value)) return true;
  if (key === "amenity" && (value === "charging_station" || value === "parking")) return true;
  if (key === "building" && /cottage|house\b/i.test(name) && !/\b(ltd|services|joinery|plumbing|electrical)\b/i.test(name)) {
    return true;
  }
  if (/ (close|lane|gardens|terrace|hill|road|street|wynd)$/i.test(name) && key === "highway") return true;
  if (/^(the )?joinery$/i.test(name) && value === "cafe") return true;
  if (/^construction$/i.test(name)) return true;
  return false;
}

function isStreetLike(name: string, phone: string, website: string): boolean {
  if (phone.trim() || website.trim()) return false;
  return / (close|lane|gardens|terrace|hill|road|street|wynd|avenue|drive|place|crescent|way|cottage|yard)$/i.test(
    name.trim(),
  );
}

export function milesBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bboxFrom(center: { lat: number; lng: number }, radiusMiles: number): string {
  const latDelta = radiusMiles / 69.0;
  const lngDelta = radiusMiles / (Math.cos((center.lat * Math.PI) / 180) * 69.0);
  const minLat = center.lat - latDelta;
  const maxLat = center.lat + latDelta;
  const minLng = center.lng - lngDelta;
  const maxLng = center.lng + lngDelta;
  return `${minLng.toFixed(4)},${minLat.toFixed(4)},${maxLng.toFixed(4)},${maxLat.toFixed(4)}`;
}

/** Nominatim viewbox is left,top,right,bottom (minLon, maxLat, maxLon, minLat). */
export function nominatimViewbox(center: { lat: number; lng: number }, radiusMiles: number): string {
  const [minLon, minLat, maxLon, maxLat] = bboxFrom(center, radiusMiles).split(",");
  return `${minLon},${maxLat},${maxLon},${minLat}`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function asNum(value: unknown): number | "" {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : "";
}

export type GeoPoint = { lat: number; lng: number; label: string };

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: response.status, json: null, error: "Unexpected response" };
    }
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: 0,
      json: null,
      error: aborted ? "Timed out" : error instanceof Error ? error.message : "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function geocodePlace(location: string): Promise<GeoPoint | null> {
  const query = /scotland/i.test(location) ? location.trim() : `${location.trim()}, Scotland`;
  const photon = await fetchJson(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`,
  );
  if (photon.ok && photon.json && typeof photon.json === "object") {
    const features = (photon.json as { features?: unknown[] }).features ?? [];
    for (const feature of features) {
      if (!feature || typeof feature !== "object") continue;
      const row = feature as {
        geometry?: { coordinates?: number[] };
        properties?: { name?: string; city?: string; county?: string; countrycode?: string; country?: string };
      };
      const coords = row.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;
      const cc = (row.properties?.countrycode || "").toUpperCase();
      if (cc && cc !== "GB") continue;
      const lng = coords[0]!;
      const lat = coords[1]!;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const label =
        row.properties?.name ||
        row.properties?.city ||
        row.properties?.county ||
        location.trim();
      return { lat, lng, label };
    }
  }

  const meteo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.trim())}&count=5&countryCode=GB`,
  );
  if (meteo.ok && meteo.json && typeof meteo.json === "object") {
    const results = (meteo.json as { results?: Array<{ latitude?: number; longitude?: number; name?: string; admin1?: string }> }).results ?? [];
    const hit = results[0];
    if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
      return {
        lat: hit.latitude as number,
        lng: hit.longitude as number,
        label: [hit.name, hit.admin1].filter(Boolean).join(", ") || location.trim(),
      };
    }
  }
  return null;
}

type PhotonHit = {
  name: string;
  osmType: string;
  osmId: number;
  osmKey: string;
  osmValue: string;
  street: string;
  city: string;
  postcode: string;
  lat: number;
  lng: number;
};

function parsePhotonHits(json: unknown): PhotonHit[] {
  if (!json || typeof json !== "object") return [];
  const features = (json as { features?: unknown[] }).features ?? [];
  const hits: PhotonHit[] = [];
  for (const feature of features) {
    if (!feature || typeof feature !== "object") continue;
    const row = feature as {
      geometry?: { coordinates?: number[] };
      properties?: Record<string, unknown>;
    };
    const props = row.properties ?? {};
    const coords = row.geometry?.coordinates;
    const name = asText(props.name);
    const osmId = Number(props.osm_id);
    if (name.length < 2 || !Number.isFinite(osmId) || !coords || coords.length < 2) continue;
    const cc = asText(props.countrycode).toUpperCase();
    if (cc && cc !== "GB") continue;
    hits.push({
      name,
      osmType: asText(props.osm_type) || "N",
      osmId,
      osmKey: asText(props.osm_key),
      osmValue: asText(props.osm_value),
      street: [asText(props.housenumber), asText(props.street)].filter(Boolean).join(" "),
      city: asText(props.city) || asText(props.county),
      postcode: asText(props.postcode),
      lng: coords[0]!,
      lat: coords[1]!,
    });
  }
  return hits;
}

async function photonSearch(query: string, bbox: string, limit: number): Promise<PhotonHit[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&bbox=${encodeURIComponent(bbox)}&limit=${Math.min(50, Math.max(5, limit))}`;
  const result = await fetchJson(url, { timeoutMs: 8_000 });
  if (!result.ok) throw new Error(result.error || `Photon HTTP ${result.status}`);
  return parsePhotonHits(result.json);
}

type OsmTags = Record<string, string>;

async function fetchOsmTags(hits: Array<{ osmType: string; osmId: number }>): Promise<Map<string, OsmTags>> {
  const byType = new Map<string, number[]>();
  for (const hit of hits) {
    const kind = hit.osmType.toUpperCase().startsWith("W")
      ? "ways"
      : hit.osmType.toUpperCase().startsWith("R")
        ? "relations"
        : "nodes";
    const list = byType.get(kind) ?? [];
    list.push(hit.osmId);
    byType.set(kind, list);
  }
  const tags = new Map<string, OsmTags>();
  for (const [kind, ids] of byType) {
    const unique = [...new Set(ids)].slice(0, 80);
    if (unique.length === 0) continue;
    const path = kind === "nodes" ? "nodes" : kind === "ways" ? "ways" : "relations";
    const param = kind === "nodes" ? "nodes" : kind === "ways" ? "ways" : "relations";
    const url = `https://api.openstreetmap.org/api/0.6/${path}?${param}=${unique.join(",")}`;
    const result = await fetchJson(url, { timeoutMs: 8_000 });
    if (!result.ok || !result.json || typeof result.json !== "object") continue;
    const elements = (result.json as { elements?: Array<{ type?: string; id?: number; tags?: Record<string, string> }> }).elements ?? [];
    for (const el of elements) {
      if (!el.id || !el.tags) continue;
      const letter = el.type === "way" ? "W" : el.type === "relation" ? "R" : "N";
      tags.set(`${letter}:${el.id}`, el.tags);
    }
  }
  return tags;
}

function tag(tags: OsmTags | undefined, ...keys: string[]): string {
  if (!tags) return "";
  for (const key of keys) {
    const value = asText(tags[key]);
    if (value) return value;
  }
  return "";
}

function formatAddress(parts: string[]): string {
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join(", ");
}

function mapsUrl(lat: number | "", lng: number | "", name: string, town: string): string {
  if (typeof lat === "number" && typeof lng === "number") {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  const query = [name, town, "Scotland"].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function toPlace(
  name: string,
  trade: string,
  town: string,
  address: string,
  phone: string,
  email: string,
  website: string,
  lat: number | "",
  lng: number | "",
  source: string,
  extraNote = "",
): DiscoveredPlace {
  return {
    businessName: name.slice(0, 120),
    trade: trade.slice(0, 60),
    town: town.slice(0, 60),
    address: address.slice(0, 160),
    phone: phone.slice(0, 40),
    email: email.slice(0, 80),
    website: website.slice(0, 200),
    lat,
    lng,
    mapsLink: mapsUrl(lat, lng, name, town),
    source,
    notes: extraNote.slice(0, 400),
  };
}

function keepPlace(
  name: string,
  osmKey: string,
  osmValue: string,
  phone: string,
  website: string,
  profile: TradeProfile,
): boolean {
  if (name.length < 2) return false;
  if (isNationalChain(name) || isMerchantName(name)) return false;
  if (isRejectedOsm(osmKey, osmValue, name)) return false;
  if (profile.rejectName?.test(name)) return false;
  if (isStreetLike(name, phone, website)) return false;
  return true;
}

type BizDataBusiness = {
  name?: string;
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  email?: string;
  lat?: number;
  lon?: number;
};

async function searchBizData(
  location: string,
  category: string,
  radiusMiles: number,
  limit: number,
  trade: string,
  center: GeoPoint,
): Promise<{ places: DiscoveredPlace[]; error?: string }> {
  const radiusKm = Math.min(80, Math.max(1, Math.round(radiusMiles * MILES_TO_KM)));
  const url = `https://bizdata-web.vercel.app/api/businesses?location=${encodeURIComponent(location)}&category=${encodeURIComponent(category)}&radius_km=${radiusKm}&limit=${Math.min(200, Math.max(limit, 20))}`;
  const result = await fetchJson(url, { timeoutMs: 3_000 });
  if (!result.ok) {
    if (result.status === 400) return { places: [] };
    return { places: [], error: `BizData: ${result.error || `HTTP ${result.status}`}` };
  }
  const payload = result.json as { businesses?: BizDataBusiness[]; error?: string };
  if (payload?.error) return { places: [], error: `BizData: ${payload.error}` };
  const places: DiscoveredPlace[] = [];
  for (const row of payload.businesses ?? []) {
    const name = asText(row.name);
    if (name.length < 2 || isNationalChain(name) || isMerchantName(name)) continue;
    const lat = asNum(row.lat);
    const lng = asNum(row.lon);
    if (typeof lat === "number" && typeof lng === "number") {
      if (milesBetween(center, { lat, lng }) > radiusMiles + 2) continue;
    }
    const address = asText(row.address);
    const town =
      address
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !/^[A-Z]{1,2}\d/i.test(part))
        .slice(-2, -1)[0] || location;
    places.push(
      toPlace(
        name,
        trade,
        town,
        address,
        asText(row.phone),
        asText(row.email),
        asText(row.website),
        lat,
        lng,
        "OpenStreetMap via BizData",
      ),
    );
  }
  return { places };
}

async function searchPhoton(
  trade: string,
  profile: TradeProfile,
  center: GeoPoint,
  radiusMiles: number,
  limit: number,
  fallbackTown: string,
): Promise<{ places: DiscoveredPlace[]; error?: string }> {
  const bbox = bboxFrom(center, radiusMiles);
  const queryLimit = Math.min(50, Math.max(15, limit));
  const hits: PhotonHit[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const query of profile.queries) {
    try {
      const batch = await photonSearch(query, bbox, queryLimit);
      for (const hit of batch) {
        const key = `${hit.osmType}:${hit.osmId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(hit);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Photon failed");
    }
  }

  const nearby = hits.filter((hit) => {
    if (!keepPlace(hit.name, hit.osmKey, hit.osmValue, "", "", profile)) return false;
    if (milesBetween(center, { lat: hit.lat, lng: hit.lng }) > radiusMiles + 1) return false;
    return true;
  });

  let tags = new Map<string, OsmTags>();
  try {
    tags = await fetchOsmTags(nearby.slice(0, 80));
  } catch {
    // Contact fields stay empty; the name/place is still real.
  }

  const places: DiscoveredPlace[] = [];
  for (const hit of nearby) {
    const letter = hit.osmType.toUpperCase().startsWith("W")
      ? "W"
      : hit.osmType.toUpperCase().startsWith("R")
        ? "R"
        : "N";
    const osm = tags.get(`${letter}:${hit.osmId}`);
    const name = tag(osm, "name", "name:en") || hit.name;
    const phone = tag(osm, "phone", "contact:phone", "contact:mobile");
    const email = tag(osm, "email", "contact:email");
    const website = tag(osm, "website", "contact:website", "contact:facebook");
    if (!keepPlace(name, hit.osmKey, hit.osmValue, phone, website, profile)) continue;
    const town = tag(osm, "addr:city", "addr:town", "addr:village") || hit.city || fallbackTown;
    const address = formatAddress([
      tag(osm, "addr:housenumber"),
      tag(osm, "addr:street") || hit.street,
      town,
      tag(osm, "addr:postcode") || hit.postcode,
    ]);
    places.push(
      toPlace(
        name,
        trade,
        town,
        address,
        phone,
        email,
        website,
        hit.lat,
        hit.lng,
        "OpenStreetMap",
        tag(osm, "craft", "shop", "office", "amenity")
          ? `OSM ${tag(osm, "craft", "shop", "office", "amenity")}`
          : "",
      ),
    );
  }
  return { places, error: hits.length === 0 && errors.length ? errors[0] : undefined };
}

type NominatimHit = {
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  extratags?: Record<string, string> | null;
  address?: Record<string, string>;
};

async function nominatimOnce(
  term: string,
  center: GeoPoint,
  radiusMiles: number,
  limit: number,
  bounded: boolean,
): Promise<{ hits: NominatimHit[]; error?: string }> {
  const params = new URLSearchParams({
    q: term,
    countrycodes: "gb",
    viewbox: nominatimViewbox(center, radiusMiles),
    bounded: bounded ? "1" : "0",
    format: "jsonv2",
    addressdetails: "1",
    extratags: "1",
    limit: String(Math.min(50, Math.max(10, limit))),
  });
  const result = await fetchJson(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    timeoutMs: 10_000,
  });
  if (result.status === 429) {
    await sleep(2000);
    const retry = await fetchJson(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      timeoutMs: 10_000,
    });
    if (retry.status === 429) return { hits: [], error: "Nominatim rate limited — wait a few seconds and try again." };
    if (!retry.ok) return { hits: [], error: `Nominatim: ${retry.error || `HTTP ${retry.status}`}` };
    if (!Array.isArray(retry.json)) return { hits: [] };
    return { hits: retry.json as NominatimHit[] };
  }
  if (!result.ok) return { hits: [], error: `Nominatim: ${result.error || `HTTP ${result.status}`}` };
  if (!Array.isArray(result.json)) {
    const message = asText((result.json as { error?: unknown } | null)?.error);
    return { hits: [], error: message ? `Nominatim: ${message}` : "Nominatim returned no results." };
  }
  return { hits: result.json as NominatimHit[] };
}

async function searchNominatim(
  trade: string,
  profile: TradeProfile,
  center: GeoPoint,
  radiusMiles: number,
  limit: number,
  fallbackTown: string,
): Promise<{ places: DiscoveredPlace[]; error?: string }> {
  const terms = (profile.nominatim.length ? profile.nominatim : profile.queries).slice(0, 1);
  if (terms.length === 0) return { places: [] };
  const bounded = profile.bounded !== false;
  const places: DiscoveredPlace[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < terms.length; i += 1) {
    if (places.length >= limit) break;
    if (i > 0) await sleep(1100);
    const term = terms[i]!;
    const once = await nominatimOnce(term, center, radiusMiles, Math.max(limit, 30), bounded);
    if (once.error) errors.push(once.error);
    for (const hit of once.hits) {
      const extra = hit.extratags ?? {};
      const addr = hit.address ?? {};
      const name = asText(hit.name) || asText(hit.display_name).split(",")[0] || "";
      const osmKey = asText(hit.category);
      const osmValue = asText(hit.type);
      const phone = asText(extra.phone || extra["contact:phone"] || extra["contact:mobile"]);
      const email = asText(extra.email || extra["contact:email"]);
      const website = asText(extra.website || extra["contact:website"] || extra["contact:facebook"]);
      if (!keepPlace(name, osmKey, osmValue, phone, website, profile)) continue;
      const lat = asNum(hit.lat);
      const lng = asNum(hit.lon);
      if (typeof lat === "number" && typeof lng === "number") {
        if (milesBetween(center, { lat, lng }) > radiusMiles + 1.5) continue;
      }
      const key = `${hit.osm_type}:${hit.osm_id}:${name.toLowerCase()}`;
      if (seen.has(key) || seen.has(name.toLowerCase())) continue;
      seen.add(key);
      seen.add(name.toLowerCase());
      const town =
        asText(addr.city || addr.town || addr.village || addr.suburb) || fallbackTown;
      const address = formatAddress([
        asText(addr.house_number),
        asText(addr.road),
        town,
        asText(addr.postcode),
      ]);
      places.push(
        toPlace(
          name,
          trade,
          town,
          address || asText(hit.display_name),
          phone,
          email,
          website,
          lat,
          lng,
          "OpenStreetMap via Nominatim",
          osmValue ? `OSM ${osmKey}:${osmValue}` : "",
        ),
      );
    }
  }

  return {
    places,
    error: places.length === 0 && errors.length ? errors[0] : undefined,
  };
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function overpassQuery(profile: TradeProfile, center: GeoPoint, radiusMiles: number): string {
  const meters = Math.round(radiusMiles * MILES_TO_KM * 1000);
  const around = `(around:${meters},${center.lat.toFixed(5)},${center.lng.toFixed(5)})`;
  const clauses: string[] = [];
  for (const word of profile.queries.slice(0, 3)) {
    const safe = word.replace(/[^a-z0-9 ]+/gi, "").trim();
    if (safe.length < 3) continue;
    clauses.push(`nwr["name"~"${safe}",i]${around};`);
  }
  const joined = profile.queries.join(" ").toLowerCase();
  if (/join|carpent/.test(joined)) {
    clauses.push(`nwr["craft"="carpenter"]${around};`);
    clauses.push(`nwr["craft"="joiner"]${around};`);
  }
  if (/plumb/.test(joined)) clauses.push(`nwr["craft"="plumber"]${around};`);
  if (/electric/.test(joined)) clauses.push(`nwr["craft"="electrician"]${around};`);
  if (/hair|barber/.test(joined)) clauses.push(`nwr["shop"="hairdresser"]${around};`);
  if (/restaurant/.test(joined)) clauses.push(`nwr["amenity"="restaurant"]${around};`);
  if (clauses.length === 0) return "";
  return `[out:json][timeout:12];(${clauses.join("")});out center tags 80;`;
}

async function searchOverpass(
  trade: string,
  profile: TradeProfile,
  center: GeoPoint,
  radiusMiles: number,
  fallbackTown: string,
): Promise<{ places: DiscoveredPlace[]; error?: string }> {
  const query = overpassQuery(profile, center, radiusMiles);
  if (!query) return { places: [] };

  const attempts = await Promise.all(
    OVERPASS_ENDPOINTS.map((endpoint) =>
      fetchJson(endpoint, {
        method: "POST",
        timeoutMs: 7_000,
        headers: { "Content-Type": "text/plain" },
        body: query,
      }),
    ),
  );
  const result = attempts.find((item) => item.ok && item.json && typeof item.json === "object");
  if (!result) {
    const lastError = attempts.map((item) => item.error || `HTTP ${item.status}`).find(Boolean);
    return { places: [], error: lastError || undefined };
  }

  const elements =
    result.json && typeof result.json === "object"
      ? ((result.json as { elements?: Array<Record<string, unknown>> }).elements ?? [])
      : [];
  const places: DiscoveredPlace[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const tags = (el.tags ?? {}) as OsmTags;
    const name = tag(tags, "name");
    const osmKey = tags.craft
      ? "craft"
      : tags.shop
        ? "shop"
        : tags.amenity
          ? "amenity"
          : tags.office
            ? "office"
            : tags.highway
              ? "highway"
              : "";
    const osmValue = tag(tags, "craft", "shop", "amenity", "office");
    const phone = tag(tags, "phone", "contact:phone");
    const website = tag(tags, "website", "contact:website");
    if (!keepPlace(name, osmKey, osmValue, phone, website, profile)) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const lat =
      asNum(el.lat) ||
      asNum((el.center as { lat?: number } | undefined)?.lat);
    const lng =
      asNum(el.lon) ||
      asNum((el.center as { lon?: number } | undefined)?.lon);
    if (typeof lat === "number" && typeof lng === "number") {
      if (milesBetween(center, { lat, lng }) > radiusMiles + 2) continue;
    }
    const town = tag(tags, "addr:city", "addr:town", "addr:village") || fallbackTown;
    places.push(
      toPlace(
        name,
        trade,
        town,
        formatAddress([
          tag(tags, "addr:housenumber"),
          tag(tags, "addr:street"),
          town,
          tag(tags, "addr:postcode"),
        ]),
        phone,
        tag(tags, "email", "contact:email"),
        website,
        lat,
        lng,
        "OpenStreetMap via Overpass",
      ),
    );
  }
  return { places };
}

export function mergePlaces(existing: DiscoveredPlace[], incoming: DiscoveredPlace[]): DiscoveredPlace[] {
  const next = [...existing];
  const names = new Set(existing.map((item) => item.businessName.trim().toLowerCase()));
  const phones = new Set(
    existing.map((item) => item.phone.replace(/\D/g, "").slice(-10)).filter((item) => item.length >= 10),
  );
  for (const item of incoming) {
    const name = item.businessName.trim().toLowerCase();
    const phone = item.phone.replace(/\D/g, "").slice(-10);
    if (names.has(name)) continue;
    if (phone.length >= 10 && phones.has(phone)) continue;
    names.add(name);
    if (phone.length >= 10) phones.add(phone);
    next.push(item);
  }
  return next;
}

function fromCompanyHit(hit: CompanyHit, trade: string, fallbackTown: string): DiscoveredPlace {
  const town = hit.town || fallbackTown;
  return toPlace(
    hit.businessName,
    trade,
    town,
    hit.address,
    "",
    "",
    "",
    hit.lat,
    hit.lng,
    "Companies House",
    hit.notes,
  );
}

export async function discoverBusinesses(options: {
  location: string;
  businessType: string;
  limit: number;
  radiusMiles: number;
}): Promise<DiscoverResult> {
  const location = options.location.trim();
  const trade = options.businessType.trim();
  const limit = Math.min(100, Math.max(1, Math.round(options.limit) || 8));
  const radiusMiles = Math.min(80, Math.max(5, Math.round(options.radiusMiles) || 25));
  if (location.length < 2) return { ok: false, error: "Enter a location.", warnings: [] };
  if (trade.length < 2) return { ok: false, error: "Enter a business type.", warnings: [] };

  const center = await geocodePlace(location);
  if (!center) {
    return {
      ok: false,
      error: `Could not find “${location}”. Try a town or city in Scotland.`,
      warnings: [],
    };
  }

  const profile = profileFor(trade);
  const warnings: string[] = [];
  const towns = chSearchTowns(location, radiusMiles >= 40 ? 4 : 3);

  const [nominatim, photon, biz, companies] = await Promise.all([
    searchNominatim(trade, profile, center, radiusMiles, limit, center.label),
    searchPhoton(trade, profile, center, radiusMiles, limit, center.label),
    profile.bizdata
      ? searchBizData(location, profile.bizdata, radiusMiles, limit, trade, center)
      : Promise.resolve({ places: [] as DiscoveredPlace[], error: undefined as string | undefined }),
    searchCompaniesHouse({
      trade,
      location,
      towns,
      center,
      radiusMiles,
      limit,
    }),
  ]);
  const sourceErrors: string[] = [];
  if (nominatim.error && nominatim.places.length === 0) sourceErrors.push(nominatim.error);
  if (photon.error && photon.places.length === 0) sourceErrors.push(`OpenStreetMap search: ${photon.error}`);
  if (biz.error && biz.places.length === 0) sourceErrors.push(biz.error);
  if (companies.error && companies.hits.length === 0) sourceErrors.push(companies.error);

  let places = mergePlaces(nominatim.places, photon.places);
  places = mergePlaces(places, biz.places);
  places = mergePlaces(
    places,
    companies.hits.map((hit) => fromCompanyHit(hit, trade, center.label)),
  );

  if (
    places.length === 0 &&
    (nominatim.error || photon.error) &&
    !/rate limited/i.test(nominatim.error || "")
  ) {
    const extra = await searchOverpass(trade, profile, center, radiusMiles, center.label);
    if (extra.error) sourceErrors.push(`Overpass: ${extra.error}`);
    places = mergePlaces(places, extra.places);
  }

  if (places.length === 0) {
    warnings.push(...sourceErrors);
    const sourceDown =
      warnings.length > 0 && warnings.every((item) => /timed out|http|unavailable|failed|rate limited/i.test(item));
    if (sourceDown) {
      return {
        ok: false,
        error: `Lead search is temporarily unavailable (${warnings[0]}). Try again in a minute.`,
        warnings,
      };
    }
    return {
      ok: false,
      error: `No ${trade.toLowerCase()} businesses found within ${radiusMiles} miles of ${center.label}. Try 50 miles, or a nearby town.`,
      warnings,
    };
  }

  if (places.length < 3 && companies.hits.length === 0) {
    warnings.push(
      `Only ${places.length} mapped ${trade.toLowerCase()}${places.length === 1 ? "" : "s"} in this area. A larger radius may find more.`,
    );
  }

  places.sort((a, b) => {
    const dist = (place: DiscoveredPlace) =>
      typeof place.lat === "number" && typeof place.lng === "number"
        ? milesBetween(center, { lat: place.lat, lng: place.lng })
        : Number.POSITIVE_INFINITY;
    return dist(a) - dist(b);
  });

  return {
    ok: true,
    places: places.slice(0, limit),
    warnings,
    locationLabel: center.label,
  };
}
