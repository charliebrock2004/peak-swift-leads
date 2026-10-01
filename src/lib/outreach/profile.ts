/**
 * The studio sending the emails — who it is, what it offers, how it signs off.
 *
 * This used to be scattered as constants: "Charlie" and "PeakSwiftStudio" in
 * the templates, "around Perthshire" in the template bodies, the studio name in
 * the quality gate and in the From header. One profile now feeds all of them,
 * so changing the business name, the area or the call to action changes every
 * email consistently — and the quality gate checks for the name actually used.
 *
 * Pure and client-safe. Empty fields fall back to the defaults, which are the
 * values the app has always used, so an account that never opens this screen
 * sends exactly what it sent before.
 */
import { hasOptOut } from "./quality.ts";
import { OPT_OUT_LINE, SENDER_NAME, SENDER_STUDIO, SENDER_WEBSITE } from "./templates.ts";

export type BusinessProfile = {
  /** The studio's name as it should appear in emails. */
  businessName: string;
  /** The person writing. First name is enough. */
  senderName: string;
  /** The mailbox you expect to send from. The Gmail health check compares it. */
  senderEmail: string;
  website: string;
  /** What you offer, in your own words. Given to the AI as-is. */
  services: string;
  /** Where you are based. */
  location: string;
  /** Towns or regions you work in. */
  areasServed: string;
  /** How the emails should sound. */
  tone: string;
  /** The low-pressure next step every email ends on. */
  cta: string;
  portfolioUrl: string;
  /** Sign-off block. Empty means name + studio (+ website). */
  signature: string;
  /** The opt-out sentence. Must actually give a way out, or the default is used. */
  optOutLine: string;
  // ── Who you sell to (0016) ──────────────────────────────────────────────
  /** Towns or regions Find searches by default, comma-separated. */
  targetAreas: string;
  /** Trades Find searches by default, comma-separated. */
  targetTrades: string;
  /** Trades scored as high value whatever the general table says. */
  preferredTrades: string;
  /** Trades never worth contacting: scored out, never queued. */
  excludedTrades: string;
  /** Whole pounds: a typical job, and the smallest job you take. */
  typicalProject: string;
  minimumProject: string;
  /** "email", "phone" or "both" — how you are willing to make first contact. */
  contactMethods: string;
  /** Past work you are happy to mention, one per line. */
  examples: string;
  /** Your business postal address, for your signature and your records. */
  businessAddress: string;
};

export type ContactMethods = "email" | "phone" | "both";

export const DEFAULT_PROFILE: BusinessProfile = {
  businessName: SENDER_STUDIO,
  senderName: SENDER_NAME,
  senderEmail: "",
  website: SENDER_WEBSITE,
  services: "Simple, fast websites for trades and small local businesses",
  location: "Perthshire",
  areasServed: "Perthshire and central Scotland",
  tone: "Plain-spoken, friendly and direct — a Scottish web designer writing one-to-one, never a marketing department",
  cta: "Happy to mock something up so you can see it before deciding anything.",
  portfolioUrl: "",
  signature: "",
  optOutLine: OPT_OUT_LINE,
  targetAreas: "",
  targetTrades: "",
  preferredTrades: "",
  excludedTrades: "",
  typicalProject: "",
  minimumProject: "",
  contactMethods: "both",
  examples: "",
  businessAddress: "",
};

export const PROFILE_LIMITS: Record<keyof BusinessProfile, number> = {
  businessName: 60,
  senderName: 40,
  senderEmail: 120,
  website: 200,
  services: 400,
  location: 80,
  areasServed: 200,
  tone: 200,
  cta: 240,
  portfolioUrl: 200,
  signature: 400,
  optOutLine: 200,
  targetAreas: 200,
  targetTrades: 200,
  preferredTrades: 200,
  excludedTrades: 200,
  typicalProject: 12,
  minimumProject: 12,
  contactMethods: 10,
  examples: 600,
  businessAddress: 200,
};

function clean(value: unknown, max: number): string {
  if (value == null) return "";
  // No control characters: several of these end up in a mail header.
  // eslint-disable-next-line no-control-regex -- deliberate: stripping controls
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

function cleanUrl(value: unknown): string {
  const raw = clean(value, 200);
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (!url.hostname.includes(".")) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export type ProfileProblem = { field: keyof BusinessProfile; message: string };

/**
 * Bring anything claiming to be a profile into a safe shape, reporting what
 * was changed rather than silently dropping it.
 */
export function sanitizeProfile(input: Partial<Record<keyof BusinessProfile, unknown>>): {
  profile: BusinessProfile;
  problems: ProfileProblem[];
} {
  const problems: ProfileProblem[] = [];
  const text = (key: keyof BusinessProfile) => clean(input[key], PROFILE_LIMITS[key]);
  // Single-line fields: a newline in a display name is header injection.
  const line = (key: keyof BusinessProfile) => text(key).replace(/[\r\n]+/g, " ");

  const senderEmail = line("senderEmail").toLowerCase();
  const profile: BusinessProfile = {
    businessName: line("businessName"),
    senderName: line("senderName"),
    senderEmail: /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(senderEmail) ? senderEmail : "",
    website: cleanUrl(input.website),
    services: text("services"),
    location: line("location"),
    areasServed: line("areasServed"),
    tone: line("tone"),
    cta: line("cta"),
    portfolioUrl: cleanUrl(input.portfolioUrl),
    signature: text("signature").replace(/\r\n/g, "\n"),
    optOutLine: line("optOutLine"),
    targetAreas: listText(text("targetAreas")),
    targetTrades: listText(text("targetTrades")),
    preferredTrades: listText(text("preferredTrades")),
    excludedTrades: listText(text("excludedTrades")),
    typicalProject: poundsText(line("typicalProject")),
    minimumProject: poundsText(line("minimumProject")),
    contactMethods: (["email", "phone", "both"] as const).find((value) => value === line("contactMethods").toLowerCase()) ?? "",
    examples: text("examples").replace(/\r\n/g, "\n"),
    businessAddress: line("businessAddress"),
  };
  for (const key of ["typicalProject", "minimumProject"] as const) {
    if (clean(input[key], 12) && !profile[key]) problems.push({ field: key, message: "Give a price in whole pounds, like 2500." });
  }
  if (senderEmail && !profile.senderEmail) problems.push({ field: "senderEmail", message: "That is not an email address." });
  if (clean(input.website, 200) && !profile.website) problems.push({ field: "website", message: "That is not a web address." });
  if (clean(input.portfolioUrl, 200) && !profile.portfolioUrl) {
    problems.push({ field: "portfolioUrl", message: "That is not a web address." });
  }
  if (profile.optOutLine && !hasOptOut(profile.optOutLine)) {
    problems.push({
      field: "optOutLine",
      message: "That sentence does not give people a way to stop hearing from you, so the standard one is used instead.",
    });
    profile.optOutLine = "";
  }
  return { profile, problems };
}

/** "Perth, Crieff,, crieff" → "Perth, Crieff": trimmed, de-duplicated, at most 12. */
function listText(value: string): string {
  return profileList(value).join(", ");
}

/** "£2,500" or "2.5k" → "2500"; anything else → "". */
function poundsText(value: string): string {
  const clean = value.toLowerCase().replace(/[£,\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(clean);
  if (!match) return "";
  const pounds = Math.round(Number(match[1]) * (match[2] ? 1000 : 1));
  return pounds > 0 && pounds <= 1_000_000 ? String(pounds) : "";
}

/** A comma- or line-separated profile list as items. */
export function profileList(value: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of (value ?? "").split(/[,\n;]+/)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
    if (out.length >= 12) break;
  }
  return out;
}

/** Whole pounds from a profile price, or null. */
export function profilePounds(value: string | undefined): number | null {
  const pounds = Number(value ?? "");
  return Number.isFinite(pounds) && pounds > 0 ? pounds : null;
}

export function contactMethodsOf(profile: Pick<BusinessProfile, "contactMethods"> | null | undefined): ContactMethods {
  const value = profile?.contactMethods;
  return value === "email" || value === "phone" ? value : "both";
}

/** What scoring needs from the workspace: the trades you want, how you make contact, the smallest job you take. */
export function scoringProfile(profile: BusinessProfile | null | undefined) {
  return {
    preferredTrades: profileList(profile?.preferredTrades),
    excludedTrades: profileList(profile?.excludedTrades),
    contactMethods: contactMethodsOf(profile),
    minimumProjectPounds: profilePounds(profile?.minimumProject),
  };
}

/** The profile with every empty field filled from the defaults. */
export function effectiveProfile(stored: Partial<BusinessProfile> | null | undefined): BusinessProfile {
  const out = { ...DEFAULT_PROFILE };
  if (!stored) return out;
  for (const key of Object.keys(DEFAULT_PROFILE) as (keyof BusinessProfile)[]) {
    const value = stored[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  if (!hasOptOut(out.optOutLine)) out.optOutLine = OPT_OUT_LINE;
  return out;
}

/** The sign-off block. */
export function profileSignature(profile: BusinessProfile): string {
  if (profile.signature.trim()) return profile.signature.trim();
  return [profile.senderName, profile.businessName, profile.website.replace(/^https?:\/\//, "")]
    .filter((part) => part.trim())
    .join("\n");
}

/** The display name in the From header: "Charlie at Peak Swift Studio". */
export function fromName(profile: BusinessProfile): string {
  const name = profile.senderName.trim();
  const studio = profile.businessName.trim();
  if (name && studio) return `${name} at ${studio}`;
  return name || studio;
}

/** Has the owner actually filled the profile in, or is it all defaults? */
export function profileIsSetUp(stored: Partial<BusinessProfile> | null | undefined): boolean {
  if (!stored) return false;
  return Boolean(stored.businessName?.trim() && stored.senderName?.trim());
}
