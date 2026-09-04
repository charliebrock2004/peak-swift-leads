/**
 * Spreadsheet import.
 *
 * Built for one job: getting a real research spreadsheet (146 Perthshire trades
 * across 13 towns, some already verified) into the sheet **without** losing what
 * is already there. The rules that matter:
 *
 * - A row that matches an existing lead is a **merge**, never a replace. Merging
 *   only ever fills fields that are currently empty, and appends notes it does
 *   not already have.
 * - Call history — called / call result / follow-up date — is never touched by
 *   an import. That is your work, not the spreadsheet's.
 * - Nothing is written until the plan has been reviewed, and every row's verdict
 *   (new / merge / skip) is visible before that.
 */
import {
  CALLED_OPTIONS,
  CALL_RESULT_OPTIONS,
  WEBSITE_STATUS_OPTIONS,
  classifyWebsiteUrl,
  findDuplicate,
  hasWebsite,
  parseNumberInput,
  type CallResult,
  type CalledStatus,
  type Lead,
  type WebsiteStatus,
} from "./leads.ts";

/** Lead fields a spreadsheet column can feed. */
export const IMPORT_FIELDS = [
  "businessName",
  "trade",
  "town",
  "phone",
  "email",
  "rating",
  "reviews",
  "website",
  "websiteStatus",
  "mapsLink",
  "demoUrl",
  "called",
  "callResult",
  "followUpDate",
  "notes",
  "source",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  businessName: "Business name",
  trade: "Trade",
  town: "Town",
  phone: "Phone",
  email: "Email",
  rating: "Rating",
  reviews: "Reviews",
  website: "Website",
  websiteStatus: "Website status",
  mapsLink: "Maps link",
  demoUrl: "Demo URL",
  called: "Called",
  callResult: "Call result",
  followUpDate: "Follow-up date",
  notes: "Notes",
  source: "Source",
};

/**
 * Header spellings seen in the wild, matched loosely (case, spaces and
 * punctuation are ignored). Order matters: the first field whose aliases match
 * a header claims it.
 */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  businessName: ["businessname", "business", "name", "company", "companyname", "tradingname"],
  trade: ["trade", "businesstype", "type", "category", "industry", "service", "sector"],
  town: ["town", "city", "location", "area", "village", "place"],
  phone: ["phone", "phonenumber", "telephone", "tel", "mobile", "contactnumber", "contact", "contactinformation", "contactinfo", "contactdetails"],
  email: ["email", "emailaddress", "mail", "contactemail"],
  rating: ["rating", "ratings", "googlerating", "stars", "score", "avgrating", "averagerating"],
  reviews: ["reviews", "reviewcount", "numberofreviews", "noofreviews", "numreviews", "googlereviews", "totalreviews"],
  website: ["website", "url", "weburl", "site", "webaddress", "websiteurl", "domain"],
  websiteStatus: ["websitestatus", "webstatus", "sitestatus", "status", "websitepresence", "webpresence"],
  mapsLink: ["mapslink", "googlemaps", "maps", "map", "maplink", "googlemapslink"],
  demoUrl: ["demourl", "demo", "demolink", "demosite", "demowebsite", "mockup"],
  called: ["called", "calledstatus", "contacted", "callstatus"],
  callResult: ["callresult", "result", "outcome", "calloutcome"],
  followUpDate: ["followupdate", "followup", "callback", "callbackdate", "nextaction", "duedate"],
  notes: ["notes", "note", "verificationnotes", "comments", "comment", "remarks", "detail", "details"],
  source: ["source", "evidence", "foundvia", "researchsource", "reference", "verified", "verification"],
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Split on the delimiter that produces the most columns on the header line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [
    { delimiter: "\t", count: (firstLine.match(/\t/g) ?? []).length },
    { delimiter: ",", count: (firstLine.match(/,/g) ?? []).length },
    { delimiter: ";", count: (firstLine.match(/;/g) ?? []).length },
  ].sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ",";
}

/**
 * Parse delimited text into rows.
 *
 * Hand-rolled rather than pulled from npm because the format is small and the
 * awkward parts are the ones a dependency would not know about anyway: quoted
 * fields holding the delimiter or a newline, doubled quotes, and the stray
 * BOM Excel puts at the front of a "Save as CSV".
 */
export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, ""); // Excel writes a BOM on "Save as CSV"

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Drop the trailing blank line a file usually ends with.
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n") {
      endRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Best guess at which column feeds which field. Unmatched columns stay unmapped. */
export function guessColumnMap(headers: string[]): (ImportField | null)[] {
  const taken = new Set<ImportField>();
  const normalized = headers.map(normalizeHeader);
  const map: (ImportField | null)[] = headers.map(() => null);

  // Exact alias hits first, so a sheet with both "Contact" and "Phone" columns
  // gives "Phone" the phone field rather than whichever came first.
  for (const pass of ["exact", "partial"] as const) {
    for (let column = 0; column < normalized.length; column += 1) {
      if (map[column]) continue;
      const header = normalized[column];
      if (!header) continue;
      for (const field of IMPORT_FIELDS) {
        if (taken.has(field)) continue;
        const aliases = HEADER_ALIASES[field];
        const hit =
          pass === "exact"
            ? aliases.includes(header)
            : aliases.some((alias) => alias.length >= 4 && header.includes(alias));
        if (hit) {
          map[column] = field;
          taken.add(field);
          break;
        }
      }
    }
  }
  return map;
}

const STATUS_HINTS: [RegExp, WebsiteStatus][] = [
  [/^(proper|real|own|independent|full)|has\s*(a\s*)?(website|site)|^yes\b/i, "Proper Website"],
  [/facebook|instagram|social|fb\b/i, "Social Only"],
  [/yell|checkatrade|directory|listing|mybuilder|ratedpeople|thomson/i, "Directory Only"],
  [/^(no|none|nil|n\/a)\b|no\s*(website|site|web)|missing|not\s*found/i, "No Website Found"],
  [/unclear|unknown|unsure|maybe|tbc|\?/i, "Unclear"],
];

/** Read a free-text website-status cell into one of the app's five statuses. */
export function normalizeWebsiteStatus(value: string): WebsiteStatus | "" {
  const raw = value.trim();
  if (!raw) return "";
  const exact = WEBSITE_STATUS_OPTIONS.find(
    (option) => option.toLowerCase() === raw.toLowerCase(),
  );
  if (exact) return exact;
  for (const [pattern, status] of STATUS_HINTS) {
    if (pattern.test(raw)) return status;
  }
  return "";
}

function matchOption<T extends string>(options: readonly T[], value: string): T | "" {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  return options.find((option) => option.toLowerCase() === raw) ?? "";
}

/** Accept `2026-09-02`, `02/09/2026` and `2/9/26` — UK order, since that is what the sheet uses. */
export function normalizeDate(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const uk = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!uk) return "";
  const [, d, m, y] = uk;
  const year = y.length === 2 ? `20${y}` : y;
  const month = m.padStart(2, "0");
  const day = d.padStart(2, "0");
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return "";
  return `${year}-${month}-${day}`;
}

export type ImportDraft = Partial<Lead> & { businessName: string };

/** Turn one spreadsheet row into a lead draft, cell by mapped cell. */
export function rowToDraft(row: string[], map: (ImportField | null)[]): ImportDraft | null {
  const draft: ImportDraft = { businessName: "" };
  for (let column = 0; column < map.length; column += 1) {
    const field = map[column];
    if (!field) continue;
    const cell = (row[column] ?? "").trim();
    if (!cell) continue;
    switch (field) {
      case "rating":
        draft.rating = parseNumberInput(cell.replace(/[^\d.]/g, ""), 1);
        break;
      case "reviews":
        draft.reviews = parseNumberInput(cell.replace(/[^\d]/g, ""), 0);
        break;
      case "websiteStatus":
        draft.websiteStatus = normalizeWebsiteStatus(cell);
        break;
      case "called":
        draft.called = (matchOption(CALLED_OPTIONS, cell) || "Not Called") as CalledStatus;
        break;
      case "callResult":
        draft.callResult = matchOption(CALL_RESULT_OPTIONS, cell) as CallResult;
        break;
      case "followUpDate":
        draft.followUpDate = normalizeDate(cell);
        break;
      default:
        draft[field] = cell;
    }
  }
  if (draft.businessName.trim().length < 2) return null;

  // A "website" cell reading "none" is a fact about the business, not a URL.
  if (draft.website) {
    if (hasWebsite(draft.website)) {
      draft.websiteStatus ||= classifyWebsiteUrl(draft.website);
    } else {
      draft.websiteStatus ||= "No Website Found";
      draft.website = "";
    }
  }
  // A status is only claimed when the sheet actually said something. Guessing
  // "No Website Found" from a sheet with no website column would look like new
  // information at merge time and overwrite a blank the app fills better itself
  // (`resolveWebsiteStatus`).
  return draft;
}

export type ImportAction = "add" | "merge" | "skip";

export type ImportEntry = {
  /** Row number as shown to the user (1-based, header excluded). */
  rowNumber: number;
  draft: ImportDraft;
  /** The lead this row already exists as, if any. */
  existing: Lead | null;
  matchedVia: "phone" | "maps" | "name" | "name+town" | null;
  /** Fields a merge would fill in on the existing lead. Empty means nothing to do. */
  fills: ImportField[];
  action: ImportAction;
};

export type ImportPlan = {
  entries: ImportEntry[];
  /** Rows that had no usable business name. */
  skippedRows: number;
};

const MERGE_FIELDS: ImportField[] = [
  "trade",
  "town",
  "phone",
  "email",
  "rating",
  "reviews",
  "website",
  "websiteStatus",
  "mapsLink",
  "demoUrl",
  "source",
];

function isEmpty(value: unknown): boolean {
  return value === "" || value === undefined || value === null;
}

/**
 * The patch an import would apply to a lead it already has.
 *
 * Only empty fields are filled, and notes are appended rather than replaced, so
 * re-importing the same spreadsheet twice is safe and changes nothing the second
 * time. Call history is deliberately absent from `MERGE_FIELDS`.
 */
export function mergePatch(existing: Lead, draft: ImportDraft): Partial<Lead> {
  const patch: Partial<Lead> = {};
  for (const field of MERGE_FIELDS) {
    const incoming = draft[field as keyof ImportDraft];
    if (isEmpty(incoming)) continue;
    if (!isEmpty(existing[field as keyof Lead])) continue;
    Object.assign(patch, { [field]: incoming });
  }
  const note = (draft.notes ?? "").trim();
  if (note && !(existing.notes ?? "").includes(note)) {
    patch.notes = existing.notes ? `${existing.notes}\n${note}` : note;
  }
  return patch;
}

/** Which fields of `patch` actually change something (for the review screen). */
function fillsOf(patch: Partial<Lead>): ImportField[] {
  return Object.keys(patch).filter((key): key is ImportField =>
    (IMPORT_FIELDS as readonly string[]).includes(key),
  );
}

/**
 * Work out, row by row, what an import would do — before doing any of it.
 *
 * Rows are also checked against each other, so a spreadsheet listing the same
 * business twice does not create two leads.
 */
export function planImport(rows: string[][], map: (ImportField | null)[], existing: Lead[]): ImportPlan {
  const entries: ImportEntry[] = [];
  let skippedRows = 0;
  // Grows as rows are planned, so duplicates *within* the file are caught too.
  const known = [...existing];

  rows.forEach((row, index) => {
    const draft = rowToDraft(row, map);
    if (!draft) {
      if (row.some((cell) => cell.trim())) skippedRows += 1;
      return;
    }
    const duplicate = findDuplicate(
      {
        businessName: draft.businessName,
        town: draft.town ?? "",
        phone: draft.phone ?? "",
        mapsLink: draft.mapsLink ?? "",
      },
      known,
    );
    if (!duplicate) {
      // Provisional lead so later rows can match against this one.
      known.push({ ...(draft as Lead), id: `pending-${index}` });
      entries.push({
        rowNumber: index + 1,
        draft,
        existing: null,
        matchedVia: null,
        fills: [],
        action: "add",
      });
      return;
    }
    const patch = mergePatch(duplicate.lead, draft);
    const fills = fillsOf(patch);
    const hasNoteChange = patch.notes !== undefined;
    entries.push({
      rowNumber: index + 1,
      draft,
      existing: duplicate.lead,
      matchedVia: duplicate.via,
      fills,
      // Nothing to add to a lead we already hold in full — default to leaving it be.
      action: fills.length > 0 || hasNoteChange ? "merge" : "skip",
    });
  });

  return { entries, skippedRows };
}

export type ImportSummary = { added: number; merged: number; skipped: number };

export function summarizePlan(entries: ImportEntry[]): ImportSummary {
  let added = 0;
  let merged = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (entry.action === "add") added += 1;
    else if (entry.action === "merge") merged += 1;
    else skipped += 1;
  }
  return { added, merged, skipped };
}
