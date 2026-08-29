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

export type CalledStatus = (typeof CALLED_OPTIONS)[number];
export type CallResult = (typeof CALL_RESULT_OPTIONS)[number] | "";
export type Priority = "HOT" | "WARM" | "COLD";

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
  called: CalledStatus;
  callResult: CallResult;
  followUpDate: string;
  notes: string;
};

export const TRADE_SUGGESTIONS = [
  "Bakery",
  "Butcher",
  "Cafe",
  "Dentist",
  "Electrician",
  "Florist",
  "Garage",
  "Hairdresser",
  "Handyman",
  "Joiner",
  "Landscaper",
  "Painter",
  "Pet Shop",
  "Plumber",
  "Pub",
  "Roofer",
  "Takeaway",
  "Tiler",
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

export function hasWebsite(website: string): boolean {
  return !NO_SITE.has(website.trim().toLowerCase());
}

export function computePriority(lead: Pick<Lead, "website" | "reviews" | "rating">): Priority {
  const reviews = typeof lead.reviews === "number" ? lead.reviews : 0;
  const rating = typeof lead.rating === "number" ? lead.rating : 0;
  const noSite = !hasWebsite(lead.website);

  if (noSite && reviews >= 20 && rating >= 4.5) return "HOT";
  if (noSite && reviews > 0) return "WARM";
  return "COLD";
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
  const waiting = lead.called === "Callback" || lead.callResult === "Callback" || lead.called === "No Answer";
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
    called: "Not Called",
    callResult: "",
    followUpDate: "",
    notes: "",
    ...partial,
  };
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
    "Google Maps Link",
    "Priority",
    "Called?",
    "Call Result",
    "Follow-Up Date",
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
      lead.mapsLink,
      computePriority(lead),
      lead.called,
      lead.callResult,
      lead.followUpDate,
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
    if (lead.called === "Callback" || lead.callResult === "Callback") callbacks += 1;
  }

  return { total: leads.length, hot, notCalled, interested, callbacks, booked };
}

const PRIORITY_RANK: Record<Priority, number> = { HOT: 0, WARM: 1, COLD: 2 };

function sortValue(lead: Lead, key: SortKey): string | number {
  if (key === "priority") return PRIORITY_RANK[computePriority(lead)];
  if (key === "rating") return typeof lead.rating === "number" ? lead.rating : -1;
  if (key === "reviews") return typeof lead.reviews === "number" ? lead.reviews : -1;
  if (key === "website") return hasWebsite(lead.website) ? lead.website.toLowerCase() : "";
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
    website: "",
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
    called: "Called",
    callResult: "Booked",
    followUpDate: "2026-09-04",
    notes: "Booked a 30-min discovery call Thursday.",
  }),
];
