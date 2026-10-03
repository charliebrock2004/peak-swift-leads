/**
 * Local-business discovery from sources with a known owner and licence.
 *
 *   1. Companies House official API (`COMPANIES_HOUSE_API_KEY`) — registered
 *      companies by SIC code near the target towns (see companies-house.ts)
 *   2. OpenStreetMap via Nominatim / Photon — mapped premises (ODbL)
 *   3. Overpass (OpenStreetMap), last resort if the others return nothing
 *
 * Nothing here talks to Google Places or xAI. Later phases can add a paid
 * Places adapter behind the same DiscoveredPlace shape.
 */

import { addRejects, emptyRejectTally, rejectTotal, type RejectReason, type RejectTally } from "./discovery-reasons.ts";
import { compareBusinesses, type BusinessRecord } from "./entity/resolve.ts";
import { normalizeName } from "./leads.ts";
import { chSearchTowns } from "./scotland-places.ts";
import {
  companiesHouseKey,
  extractUkPostcode,
  searchCompaniesHouse,
  type ChClientOptions,
  type CompanyHit,
} from "./companies-house.ts";

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
  placeId: string;
  businessStatus: string;
  /** True when we inspected an OSM listing for contact tags. */
  osmChecked: boolean;
  /**
   * Every source record merged into this place ("osm:node:1", "ch:SC612222"),
   * so provenance survives the merge. `placeId` is the first of them.
   */
  sourceIds?: string[];
};

/**
 * One record exactly as a source returned it, before merging — kept so every
 * fact about a business can say where it came from (`source_records`).
 */
export type SourceRecordDraft = {
  /** Same shape as `placeId`: "ch:SC612222", "osm:node:123". */
  id: string;
  source: "companies_house" | "openstreetmap";
  sourceId: string;
  name: string;
  url: string;
  fields: Record<string, unknown>;
  /** The place this record ended up merged into (its `placeId`). */
  primaryId: string;
};

/**
 * What a discovery run actually did, counted at every stage.
 *
 * A run that returns sixteen businesses could mean the area holds sixteen, or
 * that four queries were sent where forty were needed, or that the caller's own
 * target truncated a longer list. Those need opposite responses, and without
 * these numbers there is no way to tell them apart.
 */
export type DiscoveryFunnel = {
  /** Queries actually sent across every source. */
  queriesSent: number;
  /** The towns Companies House was asked about. */
  towns: string[];
  /** The search words used on the map sources this time. */
  terms: string[];
  /**
   * Every row the sources returned, each map or register record counted once:
   * the ones refused (`rejected`) plus the ones kept (`rawTotal`).
   */
  listings: number;
  /** Rows refused, by the one reason each was refused. */
  rejected: RejectTally;
  rawBySource: { nominatim: number; photon: number; companiesHouse: number; overpass: number };
  /** Rows kept, before records of the same business were merged. */
  rawTotal: number;
  /** Distinct businesses after merging. All of them are returned. */
  unique: number;
  /** Rows that were another source's record of a business already found here. */
  duplicatesMerged: number;
  withWebsite: number;
  withoutWebsite: number;
  /** Businesses whose listing already carried an address. */
  withListedEmail: number;
  returned: number;
};

export type DiscoverResult =
  | {
      ok: true;
      places: DiscoveredPlace[];
      warnings: string[];
      locationLabel: string;
      funnel?: DiscoveryFunnel;
      /** The raw records behind `places`, for provenance. */
      records?: SourceRecordDraft[];
    }
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

export type TradeProfile = {
  queries: string[];
  nominatim: string[];
  rejectName?: RegExp;
  /** false = bias to the area, then radius-filter (sparse UK crafts). */
  bounded?: boolean;
};

/**
 * The words each trade is searched under.
 *
 * Businesses name themselves in many ways — a "heating engineer" is a plumber
 * to a customer, a "slater" is a roofer — and a search that only ever asks for
 * one or two words finds the same handful of firms every time. Every map query
 * word is sent on every search; Nominatim (one request a second) takes three
 * at a time and rotates through the rest across repeat searches of the same
 * town, so a second search of an area asks different questions than the first.
 */
const TRADE_PROFILES: Array<{ match: RegExp; profile: TradeProfile }> = [
  {
    match: /join|carpent/,
    profile: {
      queries: ["joiner", "joinery", "carpenter", "carpentry", "kitchen fitter", "shopfitter"],
      nominatim: ["joiner", "joinery", "carpenter", "carpentry", "kitchen fitter", "shopfitter"],
    },
  },
  {
    match: /plumb|heating|gas engineer|boiler/,
    profile: {
      queries: ["plumber", "plumbing", "heating engineer", "gas engineer", "plumbing and heating"],
      nominatim: ["plumber", "plumbing", "heating engineer", "gas engineer", "plumbing and heating"],
      bounded: false,
    },
  },
  {
    match: /electric/,
    profile: {
      queries: ["electrician", "electrical contractor", "electrical services", "electrical"],
      nominatim: ["electrician", "electrical contractor", "electrical services", "electrical"],
      rejectName: /charging|ev\b|bike|fleet|center|factors|yesss|cottage/i,
    },
  },
  {
    match: /build/,
    profile: {
      queries: ["builder", "builders", "building contractor", "building services", "stonemason", "construction"],
      nominatim: ["builders", "building contractor", "building services", "stonemason", "builder", "construction"],
      bounded: false,
    },
  },
  {
    match: /roof/,
    profile: {
      queries: ["roofer", "roofing", "roofing contractor", "slater", "roughcaster"],
      nominatim: ["roofer", "roofing", "slater", "roofing contractor", "roughcaster"],
      bounded: false,
    },
  },
  {
    match: /paint|decorat/,
    profile: {
      queries: ["painter", "decorator", "painter and decorator", "painting"],
      nominatim: ["painter", "decorator", "painter and decorator", "painting"],
    },
  },
  {
    match: /landscap|garden/,
    profile: {
      queries: ["landscaper", "landscaping", "gardener", "garden services", "groundworks"],
      nominatim: ["gardener", "landscaper", "landscaping", "garden services", "groundworks"],
    },
  },
  { match: /tree/, profile: { queries: ["tree surgeon", "arborist", "tree services"], nominatim: ["tree surgeon", "arborist", "tree services"] } },
  {
    match: /mechan/,
    profile: { queries: ["mechanic", "garage", "car repair", "auto repairs", "mot"], nominatim: ["car repair", "garage", "mechanic", "auto repairs"] },
  },
  {
    match: /garage/,
    profile: { queries: ["garage", "car repair", "auto repairs", "mot"], nominatim: ["garage", "car repair", "auto repairs"] },
  },
  { match: /barber/, profile: { queries: ["barber", "barbers", "barber shop"], nominatim: ["barber", "hairdresser", "barbers"] } },
  {
    match: /hair/,
    profile: { queries: ["hairdresser", "salon", "hair salon", "hair studio"], nominatim: ["hairdresser", "hair salon", "hair studio"] },
  },
  {
    match: /beauty|beautician|nail/,
    profile: { queries: ["beauty salon", "beauty", "nail salon", "beautician", "aesthetics"], nominatim: ["beauty", "beauty salon", "nail salon", "beautician"] },
  },
  { match: /florist|flower/, profile: { queries: ["florist", "flowers"], nominatim: ["florist", "flowers"] } },
  {
    match: /restaurant/,
    profile: { queries: ["restaurant", "bistro", "grill"], nominatim: ["restaurant", "bistro"] },
  },
  { match: /cafe|café|coffee/, profile: { queries: ["cafe", "coffee shop", "tearoom"], nominatim: ["cafe", "coffee shop", "tearoom"] } },
  { match: /\bpub\b|\bbar\b|inn\b/, profile: { queries: ["pub", "bar", "inn"], nominatim: ["pub", "bar", "inn"] } },
  {
    match: /takeaway|take away/,
    profile: { queries: ["takeaway", "fast food", "fish and chips", "pizza"], nominatim: ["fast food", "takeaway", "fish and chips"] },
  },
  {
    match: /clean/,
    profile: {
      queries: ["cleaner", "cleaning", "cleaning services", "window cleaner", "carpet cleaning"],
      nominatim: ["cleaning", "cleaning services", "window cleaner", "carpet cleaning"],
    },
  },
  { match: /dog groom|groomer/, profile: { queries: ["dog groomer", "grooming", "pet grooming"], nominatim: ["pet grooming", "dog groomer"] } },
  { match: /tile|tiler/, profile: { queries: ["tiler", "tiling", "wall and floor tiling"], nominatim: ["tiler", "tiling"], bounded: false } },
  {
    match: /floor|carpet fit/,
    profile: { queries: ["flooring", "floorer", "carpet fitter", "floor sanding"], nominatim: ["flooring", "carpet fitter", "floor sanding"], bounded: false },
  },
  { match: /plaster|render/, profile: { queries: ["plasterer", "plastering", "rendering"], nominatim: ["plasterer", "plastering", "rendering"], bounded: false } },
  { match: /glaz|window/, profile: { queries: ["glazier", "double glazing", "windows and doors"], nominatim: ["glazier", "double glazing", "windows"], bounded: false } },
  { match: /locksmith/, profile: { queries: ["locksmith"], nominatim: ["locksmith"], bounded: false } },
  { match: /kitchen/, profile: { queries: ["kitchen fitter", "kitchens", "kitchen installer"], nominatim: ["kitchen fitter", "kitchens"], bounded: false } },
  { match: /bathroom/, profile: { queries: ["bathroom fitter", "bathrooms", "bathroom installer"], nominatim: ["bathroom fitter", "bathrooms"], bounded: false } },
  { match: /scaffold/, profile: { queries: ["scaffolding", "scaffolder"], nominatim: ["scaffolding", "scaffolder"], bounded: false } },
  { match: /handyman|odd job/, profile: { queries: ["handyman", "property maintenance", "odd jobs"], nominatim: ["handyman", "property maintenance"], bounded: false } },
  { match: /\bgym\b|fitness/, profile: { queries: ["gym", "fitness", "personal trainer"], nominatim: ["gym", "fitness centre", "personal trainer"] } },
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

/** How many words one Nominatim search sends (it asks for one request a second). */
export const NOMINATIM_TERMS_PER_SEARCH = 3;

/**
 * The Nominatim words for one search, rotated by how many times this town and
 * trade have been searched before: the first search asks the first three, the
 * next asks the following three, and so on round the list.
 */
export function nominatimTerms(profile: TradeProfile, variant = 0): string[] {
  const all = profile.nominatim.length ? profile.nominatim : profile.queries;
  if (all.length <= NOMINATIM_TERMS_PER_SEARCH) return [...all];
  const offset = (Math.max(0, Math.floor(variant)) * NOMINATIM_TERMS_PER_SEARCH) % all.length;
  return Array.from({ length: NOMINATIM_TERMS_PER_SEARCH }, (_, i) => all[(offset + i) % all.length]!);
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
  return (await geocodeWithStatus(location)).point;
}

/**
 * Geocode, and say whether either lookup service answered at all — so "that
 * place does not exist" is never reported when the truth is "the lookup was
 * unreachable", which sends people off retyping a town that was fine.
 */
export async function geocodeWithStatus(location: string): Promise<{ point: GeoPoint | null; reached: boolean; error: string }> {
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
      return { point: { lat, lng, label }, reached: true, error: "" };
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
        point: {
          lat: hit.latitude as number,
          lng: hit.longitude as number,
          label: [hit.name, hit.admin1].filter(Boolean).join(", ") || location.trim(),
        },
        reached: true,
        error: "",
      };
    }
  }
  // Only a proper answer means the place is unknown. A 403, a 5xx or a page
  // that is not JSON is the service failing, not the town being wrong.
  const failed = [photon, meteo].find((attempt) => !attempt.ok);
  return {
    point: null,
    reached: photon.ok || meteo.ok,
    error: failed ? (failed.status ? `HTTP ${failed.status}` : failed.error || "network error") : "",
  };
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
  placeId = "",
  businessStatus = "",
  osmChecked = false,
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
    placeId: placeId.slice(0, 80),
    businessStatus: businessStatus.slice(0, 40),
    osmChecked,
    sourceIds: placeId ? [placeId.slice(0, 80)] : [],
  };
}

/** Null when the row is a business in the trade; otherwise the one reason it is not. */
export function rejectReason(
  name: string,
  osmKey: string,
  osmValue: string,
  phone: string,
  website: string,
  profile: TradeProfile,
): RejectReason | null {
  if (name.length < 2) return "not_a_business";
  if (isNationalChain(name) || isMerchantName(name)) return "chain";
  if (isRejectedOsm(osmKey, osmValue, name)) return "not_a_business";
  if (profile.rejectName?.test(name)) return "wrong_trade";
  if (isStreetLike(name, phone, website)) return "not_a_business";
  return null;
}

async function searchPhoton(
  trade: string,
  profile: TradeProfile,
  center: GeoPoint,
  radiusMiles: number,
  limit: number,
  fallbackTown: string,
): Promise<{ places: DiscoveredPlace[]; rejected: RejectTally; error?: string }> {
  const bbox = bboxFrom(center, radiusMiles);
  const rejected = emptyRejectTally();
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
    const reason = rejectReason(hit.name, hit.osmKey, hit.osmValue, "", "", profile);
    if (reason) {
      rejected[reason] += 1;
      return false;
    }
    if (milesBetween(center, { lat: hit.lat, lng: hit.lng }) > radiusMiles + 1) {
      rejected.outside_area += 1;
      return false;
    }
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
    const reason = rejectReason(name, hit.osmKey, hit.osmValue, phone, website, profile);
    if (reason) {
      rejected[reason] += 1;
      continue;
    }
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
        `osm:${letter}:${hit.osmId}`,
        "",
        true,
      ),
    );
  }
  return { places, rejected, error: hits.length === 0 && errors.length ? errors[0] : undefined };
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
  variant = 0,
): Promise<{ places: DiscoveredPlace[]; rejected: RejectTally; error?: string }> {
  // Every term the profile lists, not just the first. Slicing to one meant a
  // joinery search never looked for "carpenter" on the map at all, and the
  // second term costs one more request against a source with no key and no
  // quota. Still bounded, so an over-long profile cannot run away.
  const terms = nominatimTerms(profile, variant);
  const rejected = emptyRejectTally();
  if (terms.length === 0) return { places: [], rejected };
  const bounded = profile.bounded !== false;
  const places: DiscoveredPlace[] = [];
  const errors: string[] = [];
  // The same map record returned by two search words is one listing. Two
  // records with the same name are NOT collapsed here: whether they are one
  // business is the entity resolver's call (mergePlaces), and it is counted.
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
      const key = hit.osm_type && hit.osm_id ? `${hit.osm_type}:${hit.osm_id}` : `name:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = rejectReason(name, osmKey, osmValue, phone, website, profile);
      if (reason) {
        rejected[reason] += 1;
        continue;
      }
      const lat = asNum(hit.lat);
      const lng = asNum(hit.lon);
      if (typeof lat === "number" && typeof lng === "number") {
        if (milesBetween(center, { lat, lng }) > radiusMiles + 1.5) {
          rejected.outside_area += 1;
          continue;
        }
      }
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
          hit.osm_type && hit.osm_id ? `osm:${hit.osm_type}:${hit.osm_id}` : "",
          "",
          true,
        ),
      );
    }
  }

  return {
    places,
    rejected,
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
  if (/mechan|garage/.test(joined)) clauses.push(`nwr["shop"="car_repair"]${around};`);
  if (clauses.length === 0) return "";
  return `[out:json][timeout:12];(${clauses.join("")});out center tags 80;`;
}

async function searchOverpass(
  trade: string,
  profile: TradeProfile,
  center: GeoPoint,
  radiusMiles: number,
  fallbackTown: string,
): Promise<{ places: DiscoveredPlace[]; rejected: RejectTally; error?: string }> {
  const query = overpassQuery(profile, center, radiusMiles);
  const rejected = emptyRejectTally();
  if (!query) return { places: [], rejected };

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
    return { places: [], rejected, error: lastError || undefined };
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
    const key = el.id ? `${asText(el.type)}:${el.id}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = rejectReason(name, osmKey, osmValue, phone, website, profile);
    if (reason) {
      rejected[reason] += 1;
      continue;
    }
    const lat =
      asNum(el.lat) ||
      asNum((el.center as { lat?: number } | undefined)?.lat);
    const lng =
      asNum(el.lon) ||
      asNum((el.center as { lon?: number } | undefined)?.lon);
    if (typeof lat === "number" && typeof lng === "number") {
      if (milesBetween(center, { lat, lng }) > radiusMiles + 2) {
        rejected.outside_area += 1;
        continue;
      }
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
        "",
        el.id ? `osm:${asText(el.type) || "node"}:${el.id}` : "",
        "",
        true,
      ),
    );
  }
  return { places, rejected };
}

function fillMissing(target: DiscoveredPlace, extra: DiscoveredPlace): DiscoveredPlace {
  return {
    ...target,
    phone: target.phone || extra.phone,
    email: target.email || extra.email,
    website: target.website || extra.website,
    address: target.address || extra.address,
    lat: target.lat === "" ? extra.lat : target.lat,
    lng: target.lng === "" ? extra.lng : target.lng,
    mapsLink: target.mapsLink || extra.mapsLink,
    businessStatus: target.businessStatus || extra.businessStatus,
    osmChecked: target.osmChecked || extra.osmChecked,
    notes: [target.notes, extra.notes].filter(Boolean).join(" ").slice(0, 400),
    sourceIds: [...new Set([...(target.sourceIds ?? [target.placeId]), ...(extra.sourceIds ?? [extra.placeId])].filter(Boolean))],
    source:
      extra.osmChecked && !target.osmChecked
        ? extra.source
        : target.website || extra.website
          ? target.source || extra.source
          : target.source,
  };
}

/** A place as the entity resolver sees it. */
function recordOf(place: DiscoveredPlace, index: number): BusinessRecord {
  const ids = place.sourceIds ?? (place.placeId ? [place.placeId] : []);
  const chId = ids.find((id) => id.startsWith("ch:"));
  return {
    id: place.placeId || `place-${index}`,
    name: place.businessName,
    phone: place.phone,
    email: place.email,
    website: place.website,
    postcode: extractUkPostcode(place.address),
    town: place.town,
    companyNumber: chId ? chId.slice(3) : "",
    sourceIds: ids,
  };
}

/**
 * Merge records that describe the same business.
 *
 * Only a `same` verdict from the entity resolver merges: a shared identifier
 * nothing contradicts, or the same name at the same premises or in the same
 * town. A similar name alone never does — merging a sole trader with a
 * like-named company would hand the sole trader the company's legal form.
 */
export function mergePlaces(existing: DiscoveredPlace[], incoming: DiscoveredPlace[]): DiscoveredPlace[] {
  const next = [...existing];

  for (const item of incoming) {
    const placeId = item.placeId.trim();
    const candidate = recordOf(item, -1);

    const matchIndex = next.findIndex((row, index) => {
      const rowId = row.placeId.trim();
      if (placeId && rowId && placeId === rowId) return true;
      return compareBusinesses(recordOf(row, index), candidate).verdict === "same";
    });

    if (matchIndex >= 0) {
      next[matchIndex] = fillMissing(next[matchIndex]!, item);
      continue;
    }

    next.push(item);
  }
  return next;
}

/**
 * Companies House has no website field. Empty is not proof they have no site
 * unless we also found the same business on OSM and inspected its tags.
 */
export function listingWebsiteHint(
  place: Pick<DiscoveredPlace, "website" | "source" | "osmChecked">,
): "url" | "osm-none" | "unconfirmed" {
  if (place.website.trim()) return "url";
  if (place.osmChecked) return "osm-none";
  if (/companies house/i.test(place.source)) return "unconfirmed";
  return "osm-none";
}

function fromCompanyHit(hit: CompanyHit, trade: string, fallbackTown: string): DiscoveredPlace {
  const town = hit.town || fallbackTown;
  const place = toPlace(
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
    hit.companyNumber ? `ch:${hit.companyNumber}` : "",
    "Active",
    false,
  );
  // The coordinates are the postcode's centre (postcodes.io), often an
  // accountant's registered office: a map pin there is not the business. The
  // link searches for the company by name and address instead.
  const query = [hit.businessName, hit.address].filter(Boolean).join(", ");
  return { ...place, mapsLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` };
}

async function enrichCompanyContacts(
  places: DiscoveredPlace[],
  center: GeoPoint,
  radiusMiles: number,
): Promise<DiscoveredPlace[]> {
  const pending = places
    .map((place, index) => ({ place, index }))
    .filter(({ place }) => !place.website && !place.osmChecked && /companies house/i.test(place.source))
    .slice(0, 6);
  if (pending.length === 0) return places;

  const lookups = await Promise.all(
    pending.map(async ({ place, index }) => {
      const query = `${place.businessName} ${place.town}`.trim();
      const result = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`, {
        timeoutMs: 2500,
      });
      if (!result.ok) return { index, hit: null as PhotonHit | null };
      const name = normalizeName(place.businessName);
      const match = parsePhotonHits(result.json).find((hit) => {
        if (name.length < 4) return false;
        if (normalizeName(hit.name) !== name) return false;
        return milesBetween(center, { lat: hit.lat, lng: hit.lng }) <= radiusMiles + 2;
      });
      return { index, hit: match ?? null };
    }),
  );

  const matched = lookups.filter((row): row is { index: number; hit: PhotonHit } => Boolean(row.hit));
  if (matched.length === 0) return places;

  let tags = new Map<string, OsmTags>();
  try {
    tags = await fetchOsmTags(matched.map((row) => row.hit));
  } catch {
    tags = new Map();
  }

  const next = [...places];
  for (const row of matched) {
    const hit = row.hit;
    const letter = hit.osmType.toUpperCase().startsWith("W")
      ? "W"
      : hit.osmType.toUpperCase().startsWith("R")
        ? "R"
        : "N";
    const osm = tags.get(`${letter}:${hit.osmId}`);
    const website = tag(osm, "website", "contact:website", "contact:facebook");
    const phone = tag(osm, "phone", "contact:phone", "contact:mobile");
    const email = tag(osm, "email", "contact:email");
    const current = next[row.index]!;
    next[row.index] = {
      ...current,
      website: current.website || website,
      phone: current.phone || phone,
      email: current.email || email,
      osmChecked: true,
      source: website || phone ? "Companies House + OpenStreetMap" : current.source,
      notes: [current.notes, website ? "" : "Mapped on OpenStreetMap with no website tag."]
        .filter(Boolean)
        .join(" ")
        .slice(0, 400),
    };
  }
  return next;
}

export async function discoverBusinesses(options: {
  location: string;
  businessType: string;
  /** Rows asked of each source query. Not a cap on what is returned. */
  limit: number;
  radiusMiles: number;
  /**
   * The towns Companies House is asked about. Defaults to a ring around the
   * location; a town searched as one area of a wider plan passes just itself,
   * so neighbouring areas do not each re-fetch the same registered companies.
   */
  chTowns?: string[];
  /** How many times this town and trade were searched before: rotates the search words. */
  variant?: number;
  /** Key, shared rate limiter and transport for Companies House. */
  companiesHouse?: ChClientOptions;
}): Promise<DiscoverResult> {
  const location = options.location.trim();
  const trade = options.businessType.trim();
  const limit = Math.min(100, Math.max(1, Math.round(options.limit) || 25));
  const radiusMiles = Math.min(80, Math.max(2, Math.round(options.radiusMiles) || 25));
  if (location.length < 2) return { ok: false, error: "Enter a location.", warnings: [] };
  if (trade.length < 2) return { ok: false, error: "Enter a business type.", warnings: [] };

  const geo = await geocodeWithStatus(location);
  const center = geo.point;
  if (!center) {
    return {
      ok: false,
      error: geo.reached
        ? `Could not find “${location}”. Try a town or city in the UK.`
        : `The map lookup service could not be reached${geo.error ? ` (${geo.error})` : ""}, so nothing was searched. Try again in a minute.`,
      warnings: [],
    };
  }

  const profile = profileFor(trade);
  const variant = Math.max(0, Math.floor(options.variant ?? 0));
  const warnings: string[] = [];
  const towns = options.chTowns?.length ? options.chTowns : chSearchTowns(location, radiusMiles >= 40 ? 12 : 8);

  const chQueryCount = companiesHouseKey() ? Math.min(14, towns.length + 1) : 0;
  const terms = nominatimTerms(profile, variant);

  const [nominatim, photon, companies] = await Promise.all([
    searchNominatim(trade, profile, center, radiusMiles, limit, center.label, variant),
    searchPhoton(trade, profile, center, radiusMiles, limit, center.label),
    searchCompaniesHouse(
      {
        trade,
        location,
        towns,
        center,
        radiusMiles,
        limit,
      },
      options.companiesHouse ?? {},
    ),
  ]);
  const sourceErrors: string[] = [];
  if (nominatim.error && nominatim.places.length === 0) sourceErrors.push(nominatim.error);
  if (photon.error && photon.places.length === 0) sourceErrors.push(`OpenStreetMap search: ${photon.error}`);
  // "Off" is a configuration state, not an outage: it is reported as a warning
  // on a successful run, never as the reason a run failed.
  if (companies.disabled) warnings.push(companies.error ?? "Companies House is off.");
  else if (companies.error && companies.hits.length === 0) sourceErrors.push(companies.error);

  // The funnel, counted rather than guessed at. Every row a source returned is
  // either refused for a named reason or kept; every kept row is either a new
  // business here or another source's record of one already found.
  const companyPlaces = companies.hits.map((hit) => fromCompanyHit(hit, trade, center.label));
  const rejected = addRejects(addRejects(addRejects(emptyRejectTally(), nominatim.rejected), photon.rejected), companies.rejected);
  const rawBySource = {
    nominatim: nominatim.places.length,
    photon: photon.places.length,
    companiesHouse: companyPlaces.length,
    overpass: 0,
  };

  let places = mergePlaces(nominatim.places, photon.places);
  places = mergePlaces(places, companyPlaces);
  let overpassPlaces: DiscoveredPlace[] = [];

  if (
    places.length === 0 &&
    (nominatim.error || photon.error) &&
    !/rate limited/i.test(nominatim.error || "")
  ) {
    const extra = await searchOverpass(trade, profile, center, radiusMiles, center.label);
    if (extra.error) sourceErrors.push(`Overpass: ${extra.error}`);
    overpassPlaces = extra.places;
    rawBySource.overpass = extra.places.length;
    addRejects(rejected, extra.rejected);
    places = mergePlaces(places, extra.places);
  }
  const rawTotal = rawBySource.nominatim + rawBySource.photon + rawBySource.companiesHouse + rawBySource.overpass;

  if (places.length === 0) {
    warnings.push(...sourceErrors);
    // Every source failed: nothing was searched, and that is an error. A
    // search that worked and found nothing (or only rows it had to refuse) is
    // an answer, and it is returned as one so the run can count it.
    const sourceDown =
      rawTotal + rejectTotal(rejected) === 0 &&
      sourceErrors.length > 0 &&
      sourceErrors.every((item) => /timed out|http|unavailable|failed|rate limited|network|fetch/i.test(item));
    if (sourceDown) {
      return {
        ok: false,
        error: `Lead search is temporarily unavailable (${sourceErrors[0]}). Try again in a minute.`,
        warnings,
      };
    }
  }

  places = await enrichCompanyContacts(places, center, radiusMiles);

  places.sort((a, b) => {
    const dist = (place: DiscoveredPlace) =>
      typeof place.lat === "number" && typeof place.lng === "number"
        ? milesBetween(center, { lat: place.lat, lng: place.lng })
        : Number.POSITIVE_INFINITY;
    return dist(a) - dist(b);
  });

  const funnel: DiscoveryFunnel = {
    queriesSent: chQueryCount + terms.length + profile.queries.length,
    towns,
    terms: [...new Set([...terms, ...profile.queries])],
    listings: rawTotal + rejectTotal(rejected),
    rejected,
    rawBySource,
    rawTotal,
    unique: places.length,
    duplicatesMerged: Math.max(0, rawTotal - places.length),
    withWebsite: places.filter((place) => place.website).length,
    withoutWebsite: places.filter((place) => !place.website).length,
    withListedEmail: places.filter((place) => place.email).length,
    returned: places.length,
  };

  return {
    ok: true,
    funnel,
    places,
    warnings,
    locationLabel: center.label,
    records: sourceRecordsFor(places, [...nominatim.places, ...photon.places, ...overpassPlaces], companies.hits),
  };
}

/**
 * The raw records behind the places kept, each tagged with the place it was
 * merged into. Companies House records keep their register fields; map
 * records keep what the map said.
 */
export function sourceRecordsFor(kept: DiscoveredPlace[], mapped: DiscoveredPlace[], companies: CompanyHit[]): SourceRecordDraft[] {
  const primaryOf = new Map<string, string>();
  for (const place of kept) {
    for (const id of place.sourceIds ?? [place.placeId]) if (id && place.placeId) primaryOf.set(id, place.placeId);
  }
  const records = new Map<string, SourceRecordDraft>();
  for (const hit of companies) {
    const id = `ch:${hit.companyNumber}`;
    const primaryId = primaryOf.get(id);
    if (!hit.companyNumber || !primaryId) continue;
    records.set(id, {
      id,
      source: "companies_house",
      sourceId: hit.companyNumber,
      name: hit.legalName,
      url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(hit.companyNumber)}`,
      fields: {
        companyNumber: hit.companyNumber,
        legalName: hit.legalName,
        companyType: hit.companyType,
        companyStatus: hit.companyStatus,
        sicCodes: hit.sicCodes,
        incorporatedOn: hit.incorporatedOn,
        registeredAddress: hit.address,
        postcode: hit.postcode,
      },
      primaryId,
    });
  }
  for (const place of mapped) {
    const id = place.placeId;
    const primaryId = id ? primaryOf.get(id) : undefined;
    if (!id || !primaryId || records.has(id) || !id.startsWith("osm:")) continue;
    const [, type = "node", osmId = ""] = id.split(":");
    records.set(id, {
      id,
      source: "openstreetmap",
      sourceId: `${type}/${osmId}`,
      name: place.businessName,
      url: `https://www.openstreetmap.org/${type}/${osmId}`,
      fields: {
        name: place.businessName,
        address: place.address,
        phone: place.phone,
        email: place.email,
        website: place.website,
        lat: place.lat,
        lng: place.lng,
        via: place.source,
      },
      primaryId,
    });
  }
  return [...records.values()];
}
