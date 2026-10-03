export const CALLED_OPTIONS = [
  "Not Called",
  "Called",
  "No Answer",
  "Interested",
  "Not Interested",
  "Callback",
] as const;

export const CALL_RESULT_OPTIONS = [
  "No Answer",
  "Interested",
  "Callback",
  "Not Interested",
  "Wrong Number",
  "Booked",
  // The end of the funnel. Outreach must never email a customer you already
  // won, and the dashboard counts them.
  "Won",
] as const;

export const WEBSITE_STATUS_OPTIONS = [
  "Proper Website",
  "Basic Website",
  "Social Only",
  "Directory Only",
  "No Website Found",
  "Unclear",
] as const;

export type CalledStatus = (typeof CALLED_OPTIONS)[number];
export type CallResult = (typeof CALL_RESULT_OPTIONS)[number] | "";
export type Priority = "HOT" | "WARM" | "COLD";
export type WebsiteStatus = (typeof WEBSITE_STATUS_OPTIONS)[number];

export const WEBSITE_QUALITY_OPTIONS = ["good", "improve", "poor", "unable"] as const;
export type WebsiteQuality = (typeof WEBSITE_QUALITY_OPTIONS)[number] | "";

export const EMAIL_CONFIDENCE_OPTIONS = ["HIGH", "MEDIUM", "LOW"] as const;
export type EmailConfidence = (typeof EMAIL_CONFIDENCE_OPTIONS)[number] | "";

export type Lead = {
  id: string;
  businessName: string;
  trade: string;
  town: string;
  phone: string;
  /** Public email when a listing or website provided one. Never guessed. */
  email: string;
  /** Street address when the source provided one. */
  address: string;
  rating: number | "";
  reviews: number | "";
  website: string;
  mapsLink: string;
  websiteStatus: WebsiteStatus | "";
  /** Stable source id, e.g. ch:SC612222 or osm:node:123. Used for duplicates. */
  placeId: string;
  /** ISO timestamp when Find leads added this row. Empty for hand-added / old rows. */
  foundAt: string;
  /** Public listing status when the source provided one (Active, etc). */
  businessStatus: string;
  /** Phase 2: good / improve / poor / unable after Check Website. */
  websiteQuality: WebsiteQuality;
  websiteScore: number | "";
  websiteAnalysis: string;
  websiteCheckedAt: string;
  emailSource: string;
  emailConfidence: EmailConfidence;
  emailFoundAt: string;
  /** Snapshot of the prospect score's priority (scoring/prospect-score.ts). Display always recomputes. */
  opportunityScore: number | "";
  /** Where this lead came from: research, spreadsheet import, added by hand. */
  source: string;
  called: CalledStatus;
  callResult: CallResult;
  followUpDate: string;
  notes: string;
  /** Demo site built for this prospect (Netlify/preview URL). Empty until built. */
  demoUrl: string;
  /**
   * Phase 3 outreach hooks. Empty on purpose — this app does not send email.
   * Later: queue / sent / replied. unsubscribed is a suppression flag.
   */
  outreachStatus: string;
  unsubscribed: string;
  lastEmailedAt: string;
  /** ISO timestamp, client clock. Used to resolve two devices editing one lead. */
  updatedAt: string;
  /** Soft delete: ISO timestamp, or "" when live. Tombstones let deletes sync. */
  deletedAt: string;
};

export const TRADE_SUGGESTIONS = [
  "Barber",
  "Beautician",
  "Beauty salon",
  "Builder",
  "Cafe",
  "Cleaning company",
  "Dog groomer",
  "Electrician",
  "Flooring",
  "Florist",
  "Garage",
  "Gardener",
  "Gym",
  "Hairdresser",
  "Joiner",
  "Landscaper",
  "Mechanic",
  "Painter/decorator",
  "Plumber",
  "Pub",
  "Restaurant",
  "Roofer",
  "Takeaway",
  "Tiler",
  "Tree surgeon",
  "Tradesperson",
] as const;

export const RESULT_LIMITS = [6, 8, 12, 25, 50, 100] as const;
export type ResultLimit = (typeof RESULT_LIMITS)[number];

export const RADIUS_MILES = [10, 25, 50] as const;
export type RadiusMiles = (typeof RADIUS_MILES)[number];

const NO_SITE = new Set([
  "",
  "-",
  "n/a",
  "na",
  "none",
  "no",
  "no website",
  "no site",
  "none found",
  "facebook only",
]);

const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "youtube.com",
  "youtu.be",
  "whatsapp.com",
];

const DIRECTORY_HOSTS = [
  "yell.com",
  "thomsonlocal.com",
  "google.com",
  "google.co.uk",
  "maps.google.com",
  "bing.com",
  "apple.com",
  "trustpilot.com",
  "checkatrade.com",
  "mybuilder.com",
  "bookabuilderuk.com",
  "trustatrader.com",
  "ratedpeople.com",
  "bark.com",
  "houzz.com",
  "freeindex.co.uk",
  "scoot.co.uk",
  "cylex-uk.co.uk",
  "192.com",
  "chamberofcommerce.uk",
  "hamuch.com",
  "tradesmenup.co.uk",
  "buildscotland.co.uk",
  "fmb.org.uk",
  "carpenterscentral.co.uk",
  "crieff.scot",
  "locallife.co.uk",
  "justdial.com",
  "hotfrog.co.uk",
  "cylex.uk",
  "touchlocal.com",
  "nextdoor.com",
  "gumtree.com",
  "tripadvisor.com",
  "opentable.com",
  // Booking platforms and more directories: a profile page on one of these
  // is not the business's own website, and two businesses listed on the same
  // one are not the same business.
  "tripadvisor.co.uk",
  "yelp.com",
  "yelp.co.uk",
  "nextdoor.co.uk",
  "fresha.com",
  "booksy.com",
  "treatwell.co.uk",
  "setmore.com",
  "linktr.ee",
  "about.me",
  "find-open.co.uk",
  "opendi.co.uk",
  "thebestof.co.uk",
  "approvedtraders.co.uk",
  "whatclinic.com",
  "foursquare.com",
  "uk.trustpilot.com",
  "rated.people",
  "constructionline.co.uk",
  "companieshouse.gov.uk",
  "company-information.service.gov.uk",
  "endole.co.uk",
  "companycheck.co.uk",
  "bizdb.co.uk",
  "uk.kompass.com",
  "kompass.com",
  "yably.co.uk",
  "brownbook.net",
  "infobel.com",
  "streetmap.co.uk",
  "scottishbusinessdirectory.co.uk",
];

const HINT_TO_STATUS: Record<string, WebsiteStatus> = {
  proper: "Proper Website",
  "proper website": "Proper Website",
  basic: "Basic Website",
  "basic website": "Basic Website",
  social: "Social Only",
  "social only": "Social Only",
  directory: "Directory Only",
  "directory only": "Directory Only",
  none: "No Website Found",
  "no website": "No Website Found",
  "no website found": "No Website Found",
  unclear: "Unclear",
};

export function hasWebsite(website: string): boolean {
  return !NO_SITE.has(website.trim().toLowerCase());
}

export function hostnameOf(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  try {
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostMatches(host: string, list: string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function classifyWebsiteUrl(website: string): WebsiteStatus {
  if (!hasWebsite(website)) return "No Website Found";
  const host = hostnameOf(website);
  if (!host) return "Unclear";
  if (hostMatches(host, SOCIAL_HOSTS)) return "Social Only";
  if (hostMatches(host, DIRECTORY_HOSTS)) return "Directory Only";
  return "Proper Website";
}

/**
 * Pull a real independent site out of notes/evidence without treating ratings
 * ("4.9") or public suffixes (".co.uk") as URLs.
 */
export function extractIndependentUrl(text: string): string {
  const tokens =
    text.match(/https?:\/\/[^\s"'<>)]+|www\.[a-z0-9.-]+\.[a-z.]+|\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+/gi) ??
    [];
  for (const token of tokens) {
    const raw = token.replace(/[.,;:/]+$/, "");
    if (!raw) continue;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = hostnameOf(url);
    if (!host || !/[a-z]/i.test(host)) continue;
    if (/^\d/.test(host)) continue;
    if (!/\.(?:co\.uk|org\.uk|ac\.uk|com|scot|uk|net|org|io|co)$/i.test(host)) continue;
    if (/^(?:co\.uk|org\.uk|ac\.uk|com|scot|uk|net|org|io|co)$/i.test(host)) continue;
    if (classifyWebsiteUrl(url) === "Proper Website") return url;
  }
  return "";
}

/**
 * Conservative website status. An unverified independent URL is Unclear, not
 * Proper Website — a dead NXDOMAIN must not look like they already have a site.
 * An empty URL is not automatically "No Website Found".
 */
export function mergeWebsiteEvidence(
  hint: string,
  url: string,
  verified: WebsiteStatus | null,
): WebsiteStatus {
  const trimmed = url.trim();
  const fromUrl = trimmed ? classifyWebsiteUrl(trimmed) : "No Website Found";
  const fromHint = HINT_TO_STATUS[hint.trim().toLowerCase()];

  if (verified === "Social Only" || verified === "Directory Only" || verified === "Proper Website") {
    return verified;
  }
  if (fromUrl === "Social Only" || fromUrl === "Directory Only") return fromUrl;
  if (fromUrl === "Proper Website") return "Unclear";
  if (!trimmed) {
    if (fromHint === "Proper Website") return "Unclear";
    return fromHint ?? "Unclear";
  }
  if (fromHint) return fromHint;
  return "Unclear";
}

export function resolveWebsiteStatus(lead: Pick<Lead, "website" | "websiteStatus">): WebsiteStatus {
  if (lead.websiteStatus) return lead.websiteStatus;
  return classifyWebsiteUrl(lead.website);
}

export function websiteHref(website: string): string | null {
  const value = website.trim();
  if (!hasWebsite(value)) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function websiteActionLabel(
  website: string,
  status: WebsiteStatus | "" = "",
): string {
  const resolved = status || classifyWebsiteUrl(website);
  if (resolved === "Directory Only") return "Listing";
  if (resolved === "Social Only") {
    const host = hostnameOf(website);
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("facebook") || host === "fb.com" || host.endsWith(".fb.com")) return "Facebook";
    return "Social";
  }
  return "Website";
}

export function mapsHref(lead: Pick<Lead, "mapsLink" | "businessName" | "town">): string | null {
  const explicit = lead.mapsLink.trim();
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) return explicit;
    return `https://${explicit}`;
  }
  const query = [lead.businessName, lead.town].map((part) => part.trim()).filter(Boolean).join(" ");
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function phoneHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length >= 10 ? `tel:${digits}` : null;
}

export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Add days to a `YYYY-MM-DD` date without dragging a timezone into it. */
export function addDays(iso: string, days: number): string {
  const base = iso ? new Date(`${iso}T12:00:00Z`) : new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Outcomes that close a lead out — nothing left to chase. */
const FINISHED_RESULTS = new Set<CallResult>(["Booked", "Not Interested", "Wrong Number"]);

/**
 * Is this lead waiting on you today?
 *
 * Any lead with a follow-up date that has arrived and an outcome still open —
 * not just a callback. An "Interested, send the demo Thursday" lead is exactly
 * the one that must not slip.
 */
export function isFollowUpDue(lead: Lead): boolean {
  if (!lead.followUpDate) return false;
  if (FINISHED_RESULTS.has(lead.callResult)) return false;
  if (lead.called === "Not Interested") return false;
  return lead.followUpDate <= todayIso();
}

/**
 * The whole record of one call, in one tap.
 *
 * Recording an outcome should never be three dropdowns while you are stood in
 * the van. Each outcome sets the called status, the result, and — where the next
 * step is obvious — a follow-up date, without ever overwriting a date already
 * chosen by hand.
 */
export function callOutcomePatch(result: CallResult, lead: Pick<Lead, "followUpDate">): Partial<Lead> {
  const today = todayIso();
  // A date chosen by hand for later is kept. One that is today or already past
  // is the call just made, so it moves on — otherwise the lead never leaves
  // today's call list however many times it is rung.
  const keepOrSet = (days: number) => (lead.followUpDate > today ? lead.followUpDate : addDays(today, days));
  switch (result) {
    case "No Answer":
      return { called: "No Answer", callResult: "No Answer", followUpDate: keepOrSet(2) };
    case "Callback":
      return { called: "Callback", callResult: "Callback", followUpDate: keepOrSet(1) };
    case "Interested":
      return { called: "Interested", callResult: "Interested", followUpDate: keepOrSet(2) };
    case "Not Interested":
      return { called: "Not Interested", callResult: "Not Interested", followUpDate: "" };
    case "Wrong Number":
      return { called: "Called", callResult: "Wrong Number", followUpDate: "" };
    case "Booked":
      return { called: "Called", callResult: "Booked" };
    default:
      return { called: "Not Called", callResult: "" };
  }
}

/**
 * A stable id, preferring `crypto.randomUUID`. Safari only exposes it on secure
 * origins, and the CSV importer mints ids in bulk, so fall back rather than
 * throwing halfway through an import.
 */
export function newLeadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lead-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createLead(partial: Partial<Lead> = {}): Lead {
  return {
    id: newLeadId(),
    businessName: "",
    trade: "",
    town: "",
    phone: "",
    email: "",
    address: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "",
    placeId: "",
    foundAt: "",
    businessStatus: "",
    websiteQuality: "",
    websiteScore: "",
    websiteAnalysis: "",
    websiteCheckedAt: "",
    emailSource: "",
    emailConfidence: "",
    emailFoundAt: "",
    opportunityScore: "",
    source: "",
    called: "Not Called",
    callResult: "",
    followUpDate: "",
    notes: "",
    demoUrl: "",
    outreachStatus: "",
    unsubscribed: "",
    lastEmailedAt: "",
    updatedAt: new Date().toISOString(),
    deletedAt: "",
    ...partial,
  };
}

export function migrateLead(raw: Partial<Lead> & { id?: string }): Lead {
  const lead = createLead({
    ...raw,
    id: raw.id || newLeadId(),
  });
  if (!lead.websiteStatus) {
    lead.websiteStatus = hasWebsite(lead.website) ? classifyWebsiteUrl(lead.website) : "No Website Found";
  }
  return lead;
}

/** Live leads only — tombstones stay in the store so deletes can reach other devices. */
export function liveLeads(leads: Lead[]): Lead[] {
  return leads.filter((lead) => !lead.deletedAt);
}

export function parseNumberInput(value: string, decimals = 0): number | "" {
  if (value.trim() === "") return "";
  const next = Number(value);
  if (!Number.isFinite(next)) return "";
  const factor = 10 ** decimals;
  return Math.round(next * factor) / factor;
}

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd|llp|plc|inc|company|co)\b\.?/g, "")
    .replace(/\bthe\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b([a-z])\s+(?=[a-z]\b)/g, "$1");
}

export function normalizePhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("44") && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length > 10) digits = digits.slice(1);
  return digits.slice(-10);
}

export function normalizeMaps(value: string): string {
  const href = (websiteHref(value) ?? value.trim()).toLowerCase();
  return href.replace(/\/+$/, "");
}

export type LeadIdentity = Pick<Lead, "businessName" | "town" | "phone" | "mapsLink"> & {
  placeId?: string;
  website?: string;
  email?: string;
};

/** Independent business host, or "" for social/directory/empty. */
export function independentHost(url: string | undefined): string {
  const value = (url ?? "").trim();
  if (!value) return "";
  const status = classifyWebsiteUrl(value);
  if (status === "Social Only" || status === "Directory Only" || status === "No Website Found") return "";
  return hostnameOf(value);
}

/**
 * Fill empty fields on an existing lead from a newly discovered copy.
 *
 * Never overwrites a value that is already set. Never touches call history,
 * outreach status, notes, or unsubscribe flags — those outlive rediscovery.
 */
const FILL_FIELDS = [
  "phone",
  "email",
  "website",
  "address",
  "mapsLink",
  "placeId",
  "websiteStatus",
  "emailSource",
  "emailConfidence",
  "emailFoundAt",
  "rating",
  "reviews",
  "businessStatus",
  "trade",
] as const satisfies readonly (keyof Lead)[];

export function fillMissingLead(existing: Lead, incoming: Partial<Lead>): Partial<Lead> | null {
  const patch: Partial<Lead> = {};
  for (const field of FILL_FIELDS) {
    const next = incoming[field];
    if (next === undefined || next === "") continue;
    const current = existing[field];
    if (current === undefined || current === "") {
      Object.assign(patch, { [field]: next });
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
