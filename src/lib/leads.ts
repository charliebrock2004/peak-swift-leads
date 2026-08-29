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
] as const;

export const WEBSITE_STATUS_OPTIONS = [
  "Proper Website",
  "Social Only",
  "Directory Only",
  "No Website Found",
  "Unclear",
] as const;

export type CalledStatus = (typeof CALLED_OPTIONS)[number];
export type CallResult = (typeof CALL_RESULT_OPTIONS)[number] | "";
export type Priority = "HOT" | "WARM" | "COLD";
export type WebsiteStatus = (typeof WEBSITE_STATUS_OPTIONS)[number];

export type Lead = {
  id: string;
  businessName: string;
  trade: string;
  town: string;
  phone: string;
  rating: number | "";
  reviews: number | "";
  website: string;
  mapsLink: string;
  websiteStatus: WebsiteStatus | "";
  source: string;
  called: CalledStatus;
  callResult: CallResult;
  followUpDate: string;
  notes: string;
};

export const TRADE_SUGGESTIONS = [
  "Barber",
  "Beauty salon",
  "Builder",
  "Cafe",
  "Cleaning company",
  "Dog groomer",
  "Electrician",
  "Florist",
  "Garage",
  "Gardener",
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
  "Tree surgeon",
  "Tradesperson",
] as const;

export const TOWN_SUGGESTIONS = [
  "Aberfeldy",
  "Alloa",
  "Auchterarder",
  "Bridge of Allan",
  "Callander",
  "Comrie",
  "Crieff",
  "Dunblane",
  "Dunkeld",
  "Kinross",
  "Perth",
  "Pitlochry",
  "Stirling",
] as const;

export type SortKey =
  | "businessName"
  | "trade"
  | "town"
  | "phone"
  | "rating"
  | "reviews"
  | "website"
  | "websiteStatus"
  | "priority"
  | "called"
  | "callResult"
  | "followUpDate";

export type SortDir = "asc" | "desc";

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
  "justdial.com",
  "hotfrog.co.uk",
  "cylex.uk",
  "touchlocal.com",
  "nextdoor.com",
  "gumtree.com",
  "tripadvisor.com",
  "opentable.com",
];

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

export function resolveWebsiteStatus(lead: Pick<Lead, "website" | "websiteStatus">): WebsiteStatus {
  if (lead.websiteStatus) return lead.websiteStatus;
  return classifyWebsiteUrl(lead.website);
}

export function lacksProperWebsite(lead: Pick<Lead, "website" | "websiteStatus">): boolean {
  const status = resolveWebsiteStatus(lead);
  return status === "Social Only" || status === "Directory Only" || status === "No Website Found";
}

export function computePriority(
  lead: Pick<Lead, "website" | "reviews" | "rating" | "websiteStatus">,
): Priority {
  const reviews = typeof lead.reviews === "number" ? lead.reviews : 0;
  const rating = typeof lead.rating === "number" ? lead.rating : 0;
  const prospect = lacksProperWebsite(lead);

  if (prospect && reviews >= 20 && rating >= 4.5) return "HOT";
  if (prospect && reviews > 0) return "WARM";
  if (prospect && resolveWebsiteStatus(lead) === "Social Only") return "WARM";
  return "COLD";
}

export function priorityReason(
  lead: Pick<Lead, "website" | "reviews" | "rating" | "websiteStatus" | "phone">,
): string {
  const priority = computePriority(lead);
  const status = resolveWebsiteStatus(lead);
  const bits: string[] = [];
  if (typeof lead.reviews === "number") bits.push(`${lead.reviews} review${lead.reviews === 1 ? "" : "s"}`);
  if (typeof lead.rating === "number") bits.push(`${formatRating(lead.rating)} rating`);
  if (status === "No Website Found") bits.push("no proper website found");
  else if (status === "Social Only") bits.push("social profile only");
  else if (status === "Directory Only") bits.push("directory listing only");
  else if (status === "Proper Website") bits.push("already has a proper website");
  else bits.push("website presence unclear");
  if (!lead.phone?.trim() && priority !== "COLD") bits.push("no phone listed");
  return `${priority} — ${bits.join(", ")}.`;
}

export function websiteHref(website: string): string | null {
  const value = website.trim();
  if (!hasWebsite(value)) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
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

export function isFollowUpDue(lead: Lead): boolean {
  if (!lead.followUpDate) return false;
  const waiting =
    lead.called === "Callback" || lead.callResult === "Callback" || lead.called === "No Answer";
  return waiting && lead.followUpDate <= todayIso();
}

export function createLead(partial: Partial<Lead> = {}): Lead {
  return {
    id: crypto.randomUUID(),
    businessName: "",
    trade: "",
    town: "",
    phone: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "",
    source: "",
    called: "Not Called",
    callResult: "",
    followUpDate: "",
    notes: "",
    ...partial,
  };
}

export function migrateLead(raw: Partial<Lead> & { id?: string }): Lead {
  const lead = createLead({
    ...raw,
    id: raw.id || crypto.randomUUID(),
  });
  if (!lead.websiteStatus) {
    lead.websiteStatus = hasWebsite(lead.website) ? classifyWebsiteUrl(lead.website) : "No Website Found";
  }
  return lead;
}

function csvCell(value: string | number): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function leadsToCsv(leads: Lead[]): string {
  const header = [
    "Business Name",
    "Trade",
    "Town",
    "Phone Number",
    "Google Rating",
    "Number of Reviews",
    "Website",
    "Website Status",
    "Google Maps Link",
    "Priority",
    "Reason",
    "Called?",
    "Call Result",
    "Follow-Up Date",
    "Source",
    "Notes",
  ];
  const rows = leads.map((lead) =>
    [
      lead.businessName,
      lead.trade,
      lead.town,
      lead.phone,
      lead.rating,
      lead.reviews,
      lead.website,
      resolveWebsiteStatus(lead),
      lead.mapsLink,
      computePriority(lead),
      priorityReason(lead),
      lead.called,
      lead.callResult,
      lead.followUpDate,
      lead.source,
      lead.notes,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function downloadCsv(leads: Lead[]): void {
  const blob = new Blob([leadsToCsv(leads)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `peak-swift-leads-${stamp}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type LeadSummary = {
  total: number;
  hot: number;
  notCalled: number;
  interested: number;
  callbacks: number;
  booked: number;
};

export function summarise(leads: Lead[]): LeadSummary {
  let hot = 0;
  let notCalled = 0;
  let interested = 0;
  let callbacks = 0;
  let booked = 0;

  for (const lead of leads) {
    if (computePriority(lead) === "HOT") hot += 1;
    if (lead.called === "Not Called") notCalled += 1;
    if (lead.callResult === "Booked") booked += 1;
    if (lead.called === "Interested" || lead.callResult === "Interested") interested += 1;
    if (isFollowUpDue(lead)) callbacks += 1;
  }

  return { total: leads.length, hot, notCalled, interested, callbacks, booked };
}

const PRIORITY_RANK: Record<Priority, number> = { HOT: 0, WARM: 1, COLD: 2 };

function sortValue(lead: Lead, key: SortKey): string | number {
  if (key === "priority") return PRIORITY_RANK[computePriority(lead)];
  if (key === "rating") return typeof lead.rating === "number" ? lead.rating : -1;
  if (key === "reviews") return typeof lead.reviews === "number" ? lead.reviews : -1;
  if (key === "website") return hasWebsite(lead.website) ? lead.website.toLowerCase() : "";
  if (key === "websiteStatus") return resolveWebsiteStatus(lead);
  return String(lead[key] ?? "").toLowerCase();
}

export function compareLeads(a: Lead, b: Lead, key: SortKey, dir: SortDir): number {
  const mul = dir === "asc" ? 1 : -1;
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
  return String(av).localeCompare(String(bv), "en-GB", { sensitivity: "base" }) * mul;
}

export function parseNumberInput(value: string, decimals = 0): number | "" {
  if (value.trim() === "") return "";
  const next = Number(value);
  if (!Number.isFinite(next)) return "";
  const factor = 10 ** decimals;
  return Math.round(next * factor) / factor;
}

export function formatRating(value: number | ""): string {
  if (value === "") return "";
  return (Math.round(value * 10) / 10).toFixed(1);
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

export type DuplicateMatch = {
  lead: Lead;
  via: "phone" | "maps" | "name+town";
};

export function findDuplicate(
  candidate: Pick<Lead, "businessName" | "town" | "phone" | "mapsLink">,
  leads: Lead[],
): DuplicateMatch | null {
  const phone = normalizePhone(candidate.phone);
  const maps = candidate.mapsLink.trim() ? normalizeMaps(candidate.mapsLink) : "";
  const name = normalizeName(candidate.businessName);
  const town = candidate.town.trim().toLowerCase();

  for (const lead of leads) {
    const leadPhone = normalizePhone(lead.phone);
    if (phone.length >= 10 && leadPhone.length >= 10 && phone === leadPhone) {
      return { lead, via: "phone" };
    }
    const leadMaps = lead.mapsLink.trim() ? normalizeMaps(lead.mapsLink) : "";
    if (maps && leadMaps && maps === leadMaps) return { lead, via: "maps" };
    const sameName = name.length >= 3 && name === normalizeName(lead.businessName);
    const sameTown = town && lead.town.trim().toLowerCase() === town;
    if (sameName && sameTown) return { lead, via: "name+town" };
  }
  return null;
}

export const SAMPLE_LEADS: Lead[] = [
  createLead({
    id: "lead-01",
    businessName: "The Wee Bakehouse",
    trade: "Bakery",
    town: "Crieff",
    phone: "01764 652184",
    rating: 4.8,
    reviews: 47,
    website: "",
    websiteStatus: "No Website Found",
    mapsLink: "https://www.google.com/maps/search/?api=1&query=The+Wee+Bakehouse+Crieff",
    called: "Not Called",
    notes: "Busy Saturday queue. Maps listing only — no site.",
  }),
  createLead({
    id: "lead-02",
    businessName: "Strathearn Auto",
    trade: "Garage",
    town: "Auchterarder",
    phone: "01764 663901",
    rating: 4.6,
    reviews: 61,
    website: "https://www.facebook.com/strathearnauto",
    websiteStatus: "Social Only",
    called: "Not Called",
    notes: "Strong reviews, Facebook page only.",
  }),
  createLead({
    id: "lead-03",
    businessName: "Highland Handyman",
    trade: "Handyman",
    town: "Perth",
    phone: "01738 441276",
    rating: 4.9,
    reviews: 32,
    website: "",
    websiteStatus: "No Website Found",
    called: "Callback",
    callResult: "Callback",
    followUpDate: "2026-09-02",
    notes: "Asked to call back Tuesday after 4pm.",
  }),
  createLead({
    id: "lead-04",
    businessName: "Comrie Cut",
    trade: "Hairdresser",
    town: "Comrie",
    phone: "01764 670553",
    rating: 4.7,
    reviews: 28,
    website: "",
    websiteStatus: "No Website Found",
    called: "Interested",
    callResult: "Interested",
    notes: "Owner wants a simple booking page. Send a sample this week.",
  }),
  createLead({
    id: "lead-05",
    businessName: "Pitlochry Chippy",
    trade: "Takeaway",
    town: "Pitlochry",
    phone: "01796 472810",
    rating: 4.2,
    reviews: 34,
    website: "",
    websiteStatus: "No Website Found",
    called: "Not Called",
    notes: "No site. Rating just under the hot threshold.",
  }),
  createLead({
    id: "lead-06",
    businessName: "Glen Almond Plumbing",
    trade: "Plumber",
    town: "Aberfeldy",
    phone: "01887 820441",
    rating: 4.3,
    reviews: 15,
    website: "",
    websiteStatus: "No Website Found",
    called: "No Answer",
    callResult: "No Answer",
    followUpDate: "2026-09-01",
  }),
  createLead({
    id: "lead-07",
    businessName: "Dunkeld Flowers",
    trade: "Florist",
    town: "Dunkeld",
    phone: "01350 727604",
    rating: 5,
    reviews: 8,
    website: "",
    websiteStatus: "No Website Found",
    called: "Not Called",
  }),
  createLead({
    id: "lead-08",
    businessName: "Callander Joinery",
    trade: "Joiner",
    town: "Callander",
    phone: "01877 331092",
    rating: 4.8,
    reviews: 6,
    website: "",
    websiteStatus: "No Website Found",
    called: "Not Called",
    notes: "New-ish listing. Worth a warm call.",
  }),
  createLead({
    id: "lead-09",
    businessName: "Kinross Electrics",
    trade: "Electrician",
    town: "Kinross",
    phone: "01577 863220",
    rating: 4.1,
    reviews: 11,
    website: "",
    websiteStatus: "No Website Found",
    called: "Not Called",
  }),
  createLead({
    id: "lead-10",
    businessName: "Bridge of Allan Dental",
    trade: "Dentist",
    town: "Bridge of Allan",
    phone: "01786 832445",
    rating: 4.9,
    reviews: 120,
    website: "https://bridgeofallandental.co.uk",
    websiteStatus: "Proper Website",
    called: "Not Interested",
    callResult: "Not Interested",
    notes: "Already has a proper site.",
  }),
  createLead({
    id: "lead-11",
    businessName: "Alloa Roofing",
    trade: "Roofer",
    town: "Alloa",
    phone: "01259 214880",
    rating: 4.6,
    reviews: 22,
    website: "https://alloaroofing.com",
    websiteStatus: "Proper Website",
    called: "Called",
    callResult: "Not Interested",
  }),
  createLead({
    id: "lead-12",
    businessName: "The Strath Pub",
    trade: "Pub",
    town: "Crieff",
    phone: "01764 652900",
    rating: 4.4,
    reviews: 89,
    website: "https://thestrathpub.co.uk",
    websiteStatus: "Proper Website",
    called: "Not Called",
  }),
  createLead({
    id: "lead-13",
    businessName: "Stirling Tiles",
    trade: "Tiler",
    town: "Stirling",
    phone: "01786 451003",
    rating: "",
    reviews: "",
    website: "",
    websiteStatus: "Unclear",
    called: "Not Called",
    notes: "Bare Maps pin. No reviews yet.",
  }),
  createLead({
    id: "lead-14",
    businessName: "Dunblane Pets",
    trade: "Pet Shop",
    town: "Dunblane",
    phone: "01786 823611",
    rating: "",
    reviews: 0,
    website: "",
    websiteStatus: "No Website Found",
    called: "Called",
    callResult: "Booked",
    followUpDate: "2026-09-04",
    notes: "Booked a 30-min discovery call Thursday.",
  }),
];
