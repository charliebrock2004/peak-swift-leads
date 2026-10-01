/**
 * Prospect-quality feedback: what you said about a business Find gave you,
 * and the deterministic rules that act on it.
 *
 * Nothing here learns. Every effect is a rule you can read:
 *   - a business you rejected is never queued, emailed or re-added by Find;
 *   - a website you marked wrong is set aside, along with any email address on
 *     its domain, and never attached to that business again;
 *   - a site you said is already good leaves nothing to offer them;
 *   - contact details you marked wrong are not used until you change them;
 *   - a good prospect gets a small, labelled lift;
 *   - a discovery source (or a trade search) whose results you mark bad more
 *     often than not is ranked lower — once enough marks say so (quality.ts).
 *
 * Client-safe and pure, with no imports: scoring reads it.
 */
export const VERDICTS = ["good", "useful", "bad", "irrelevant", "not_in_trade", "wrong_business", "duplicate", "wrong_website", "good_website", "wrong_contact"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABEL: Record<Verdict, string> = {
  good: "Good prospect",
  useful: "Useful prospect",
  bad: "Bad prospect",
  irrelevant: "Irrelevant",
  not_in_trade: "Not actually in this trade",
  wrong_business: "Wrong business",
  duplicate: "Duplicate",
  wrong_website: "Wrong website",
  good_website: "Already has a good website",
  wrong_contact: "Contact details wrong",
};

/** Marks that say the business is worth working. */
export const POSITIVE: readonly Verdict[] = ["good", "useful"];
/** Marks that say this is not a prospect at all. */
export const REJECTING: readonly Verdict[] = ["bad", "irrelevant", "not_in_trade", "wrong_business", "duplicate"];
/** Marks that correct the data but say nothing about the business's worth. */
export const CORRECTING: readonly Verdict[] = ["wrong_website", "good_website", "wrong_contact"];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Marks that cannot stand together: saying a business is good withdraws "bad", and the reverse. */
export function conflictsWith(verdict: Verdict): Verdict[] {
  if (POSITIVE.includes(verdict)) return [...REJECTING];
  if (REJECTING.includes(verdict)) return [...POSITIVE];
  return [];
}

/** "good,wrong_website" (as stored with a lead's facts) → verdicts, unknown ones dropped. */
export function parseVerdicts(text: string | null | undefined): Verdict[] {
  if (!text) return [];
  return [...new Set(String(text).split(",").map((item) => item.trim()))].filter(isVerdict);
}

/** The first rejecting mark, if any — the reason a business is out. */
export function rejection(verdicts: readonly Verdict[] | undefined): Verdict | null {
  return verdicts?.find((verdict) => REJECTING.includes(verdict)) ?? null;
}

export function domainOf(url: string): string {
  const raw = url.trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** An address on a domain you said is not theirs. */
export function emailOnDomain(email: string, domain: string): boolean {
  const at = email.trim().toLowerCase().split("@")[1] ?? "";
  return Boolean(domain && at && (at === domain || at.endsWith(`.${domain}`)));
}
