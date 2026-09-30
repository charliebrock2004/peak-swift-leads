/**
 * Is this business a corporate subscriber or an individual one?
 *
 * UK PECR treats the two differently for electronic marketing: companies, LLPs
 * and Scottish partnerships are corporate subscribers; sole traders and some
 * other partnerships are individual subscribers, who may be emailed only with
 * consent. The ICO's advice when unsure is to treat the subscriber as an
 * individual. This module turns that into product rules — it is not legal
 * advice, and the rules a business chooses to apply are configurable
 * (`ContactRules`).
 *
 * Reference (product-design authority, check for updates):
 * https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/
 *
 * The output is conservative by construction:
 * - CORPORATE needs positive evidence — a Companies House record of a
 *   corporate type, or (if the rules allow it) "Ltd"/"LLP" in the trading name.
 * - Not being found on Companies House is evidence, never proof, of a sole
 *   trader: on its own it gives UNKNOWN, and UNKNOWN is never email-eligible.
 * - A person's override always wins, and says so.
 *
 * Client-safe and pure: the same verdict is shown in the UI and enforced by
 * the server's send gate.
 */

export const LEGAL_FORMS = ["CORPORATE", "INDIVIDUAL", "UNKNOWN", "REVIEW_REQUIRED"] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

export const LEGAL_FORM_LABEL: Record<LegalForm, string> = {
  CORPORATE: "Company",
  INDIVIDUAL: "Sole trader / partnership",
  UNKNOWN: "Legal form unknown",
  REVIEW_REQUIRED: "Needs review",
};

export type ContactRules = {
  /**
   * Treat "Ltd", "Limited", "PLC" or "LLP" in the trading name as a company
   * when Companies House has not confirmed it. Using those words when not
   * registered is itself an offence (Companies Act 2006, ss.1197–1198), so it
   * is reasonable evidence — but it is weaker than the register, so it only
   * ever gives medium confidence and can be switched off.
   */
  trustCompanySuffix: boolean;
  /** A Companies House status older than this still counts, at lower confidence. */
  companyStatusMaxAgeDays: number;
};

export const DEFAULT_CONTACT_RULES: ContactRules = {
  trustCompanySuffix: true,
  companyStatusMaxAgeDays: 180,
};

export function sanitizeContactRules(value: unknown): ContactRules {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const days = Number(source.companyStatusMaxAgeDays);
  return {
    trustCompanySuffix: typeof source.trustCompanySuffix === "boolean" ? source.trustCompanySuffix : DEFAULT_CONTACT_RULES.trustCompanySuffix,
    companyStatusMaxAgeDays: Number.isFinite(days) && days >= 7 && days <= 730 ? Math.round(days) : DEFAULT_CONTACT_RULES.companyStatusMaxAgeDays,
  };
}

export type LegalFormInput = {
  businessName: string;
  email?: string;
  /** Companies House number, when one is linked. */
  companyNumber?: string;
  /** Companies House `company_type`, e.g. "ltd", "llp", "scottish-partnership". */
  companyType?: string;
  /** Companies House `company_status`, e.g. "active", "dissolved". */
  companyStatus?: string;
  /**
   * When Companies House was last checked. With no company number, a date here
   * means "searched, and no matching company was found".
   */
  companyCheckedAt?: string;
  override?: LegalForm | "";
  overrideNote?: string;
  overrideAt?: string;
};

export type LegalReason = {
  text: string;
  source: "companies_house" | "name" | "email" | "manual" | "rules";
};

export type LegalFormResult = {
  form: LegalForm;
  confidence: "high" | "medium" | "low";
  /** What decided it, in order of weight. Always at least one. */
  reasons: LegalReason[];
  /** One line for a card. */
  summary: string;
  basis: "override" | "companies_house" | "name" | "email" | "none";
};

/** Companies House `company_type` values that are corporate bodies. */
const CORPORATE_TYPES = new Set([
  "ltd",
  "plc",
  "llp",
  "private-unlimited",
  "private-unlimited-nsc",
  "private-limited-guarant-nsc",
  "private-limited-guarant-nsc-limited-exemption",
  "private-limited-shares-section-30-exemption",
  "old-public-company",
  "scottish-partnership",
  "royal-charter",
  "industrial-and-provident-society",
  "registered-society-non-jurisdictional",
  "charitable-incorporated-organisation",
  "scottish-charitable-incorporated-organisation",
  "community-interest-company",
  "uk-establishment",
  "oversea-company",
  "european-public-limited-liability-company-se",
  "unregistered-company",
  "investment-company-with-variable-capital",
  "assurance-company",
  "further-education-or-sixth-form-college-corporation",
  "eeig",
]);

const TYPE_LABEL: Record<string, string> = {
  ltd: "private limited company",
  plc: "public limited company",
  llp: "limited liability partnership",
  "scottish-partnership": "Scottish partnership",
  "limited-partnership": "limited partnership",
  "private-unlimited": "unlimited company",
  "private-limited-guarant-nsc": "company limited by guarantee",
  "charitable-incorporated-organisation": "charitable incorporated organisation",
  "community-interest-company": "community interest company",
};

type RegisteredKind = { kind: "corporate" | "review"; label: string };

/**
 * What a company number's prefix says about the entity, for records that
 * predate storing `company_type`. From Companies House's published prefixes.
 */
export function kindFromCompanyNumber(number: string): RegisteredKind | null {
  const value = number.trim().toUpperCase();
  if (!value) return null;
  if (/^\d{6,8}$/.test(value) || /^(SC|NI|R0)\d+$/.test(value)) return { kind: "corporate", label: "registered company" };
  if (/^(OC|SO|NC)\d+$/.test(value)) return { kind: "corporate", label: "limited liability partnership" };
  // Scottish limited and qualifying partnerships have legal personality.
  if (/^(SL|SG)\d+$/.test(value)) return { kind: "corporate", label: "Scottish partnership" };
  if (/^(IP|SP|NP|RS|SR|RC|CE|CS|FC|SF|NF|BR|SE|GE)\d+$/.test(value)) return { kind: "corporate", label: "registered body" };
  // Limited partnerships in England, Wales and Northern Ireland do not.
  if (/^(LP|NL)\d+$/.test(value)) return { kind: "review", label: "limited partnership (England, Wales or NI)" };
  return { kind: "review", label: "unrecognised registration" };
}

export function kindFromCompanyType(type: string, number = ""): RegisteredKind | null {
  const value = type.trim().toLowerCase();
  if (!value) return null;
  if (value === "limited-partnership") {
    // A Scottish LP (SL…) is a Scottish partnership; one elsewhere is not a corporate body.
    return /^SL/i.test(number.trim())
      ? { kind: "corporate", label: "Scottish limited partnership" }
      : { kind: "review", label: "limited partnership (England, Wales or NI)" };
  }
  if (CORPORATE_TYPES.has(value)) return { kind: "corporate", label: TYPE_LABEL[value] ?? value.replace(/-/g, " ") };
  return { kind: "review", label: value.replace(/-/g, " ") };
}

const COMPANY_SUFFIX = /\b(ltd|limited|plc|llp|l\.l\.p|cic|c\.i\.c)\b\.?/i;
const PERSONAL_MAILBOX = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "btinternet.com",
  "btopenworld.com",
  "aol.com",
  "aol.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "sky.com",
  "talktalk.net",
  "tiscali.co.uk",
  "virginmedia.com",
  "ntlworld.com",
  "blueyonder.co.uk",
  "protonmail.com",
  "proton.me",
]);

export function isPersonalMailboxDomain(domain: string): boolean {
  return PERSONAL_MAILBOX.has(domain.trim().toLowerCase());
}

function mailboxDomain(email: string | undefined): string {
  return (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
}

/** "J Smith Joinery", "Mr G Brock", "John Smith Plumbing" — a person's name as the business. */
export function looksLikePersonalName(name: string): boolean {
  const value = name.trim().toLowerCase();
  if (/^(mr|mrs|ms|miss|dr)\.?\s/.test(value)) return true;
  if (/^[a-z]\.?\s+[a-z]{2,}\s/.test(value)) return true;
  return /\b(and|&)\s+sons?\b/.test(value);
}

function ageDays(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

function dateLabel(iso: string | undefined): string {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "";
}

const INACTIVE_REASON: Record<string, string> = {
  dissolved: "the company is dissolved — the business may now trade as a sole trader",
  "converted-closed": "the company was converted or closed",
  removed: "the company was removed from the register",
  closed: "the company is closed",
  liquidation: "the company is in liquidation",
  receivership: "the company is in receivership",
  administration: "the company is in administration",
  "insolvency-proceedings": "the company is in insolvency proceedings",
  "voluntary-arrangement": "the company is in a voluntary arrangement",
};

export function classifyLegalForm(
  input: LegalFormInput,
  rules: ContactRules = DEFAULT_CONTACT_RULES,
  now: Date = new Date(),
): LegalFormResult {
  // 1. A person's decision wins, and is labelled as theirs.
  if (input.override && (LEGAL_FORMS as readonly string[]).includes(input.override)) {
    const when = dateLabel(input.overrideAt);
    const note = (input.overrideNote ?? "").trim();
    return {
      form: input.override,
      confidence: "high",
      basis: "override",
      summary: `${LEGAL_FORM_LABEL[input.override]} — set by you${when ? ` on ${when}` : ""}`,
      reasons: [{ source: "manual", text: `Set by you${when ? ` on ${when}` : ""}${note ? `: ${note}` : ""}` }],
    };
  }

  const reasons: LegalReason[] = [];
  const number = (input.companyNumber ?? "").trim().toUpperCase();
  const domain = mailboxDomain(input.email);
  const personalMailbox = domain !== "" && isPersonalMailboxDomain(domain);

  // 2. The register.
  if (number) {
    const registered = kindFromCompanyType(input.companyType ?? "", number) ?? kindFromCompanyNumber(number)!;
    const status = (input.companyStatus ?? "").trim().toLowerCase();
    const checked = dateLabel(input.companyCheckedAt);
    const age = ageDays(input.companyCheckedAt, now);
    const statusText = status ? `status ${status}${checked ? ` on ${checked}` : ""}` : "status not checked";
    reasons.push({ source: "companies_house", text: `Companies House ${number}: ${registered.label}, ${statusText}` });

    if (status && status !== "active") {
      return {
        form: "REVIEW_REQUIRED",
        confidence: "high",
        basis: "companies_house",
        summary: `Needs review — ${INACTIVE_REASON[status] ?? `company status is ${status}`}`,
        reasons: [{ source: "companies_house", text: `Companies House ${number}: ${INACTIVE_REASON[status] ?? `status ${status}`}` }, ...reasons.slice(1)],
      };
    }
    if (registered.kind === "review") {
      return {
        form: "REVIEW_REQUIRED",
        confidence: "medium",
        basis: "companies_house",
        summary: `Needs review — ${registered.label}; some partnerships are individual subscribers`,
        reasons,
      };
    }
    const fresh = status === "active" && age !== null && age <= rules.companyStatusMaxAgeDays;
    if (!fresh) reasons.push({ source: "rules", text: status ? `Status last checked ${age ?? "?"} days ago — re-check to confirm` : "Company status has not been checked" });
    return {
      form: "CORPORATE",
      confidence: fresh ? "high" : "medium",
      basis: "companies_house",
      summary: `Company — ${registered.label} (${number})`,
      reasons,
    };
  }

  // 3. No register entry. Everything from here is weaker evidence.
  const searchedAt = dateLabel(input.companyCheckedAt);
  if (searchedAt) reasons.push({ source: "companies_house", text: `Searched Companies House on ${searchedAt}: no matching company` });
  const suffix = COMPANY_SUFFIX.exec(input.businessName);

  if (suffix) {
    const found = suffix[1]!.replace(/\./g, "").toLowerCase();
    const word = found === "ltd" ? "Ltd" : found === "limited" ? "Limited" : found.toUpperCase();
    reasons.unshift({ source: "name", text: `The name includes “${word}”, which only a registered company may use` });
    if (rules.trustCompanySuffix && !searchedAt) {
      reasons.push({ source: "rules", text: "Not yet confirmed on Companies House" });
      return { form: "CORPORATE", confidence: "medium", basis: "name", summary: `Company — “${word}” in the name, not yet confirmed`, reasons };
    }
    return {
      form: "REVIEW_REQUIRED",
      confidence: "medium",
      basis: "name",
      summary: searchedAt ? `Needs review — says “${word}” but no matching company on Companies House` : `Needs review — “${word}” in the name, not confirmed`,
      reasons,
    };
  }

  if (personalMailbox) {
    reasons.unshift({ source: "email", text: `Uses a personal mailbox (${domain}) and no company registration is linked` });
    return { form: "INDIVIDUAL", confidence: "medium", basis: "email", summary: "Sole trader or partnership — personal mailbox, no company", reasons };
  }

  if (looksLikePersonalName(input.businessName)) {
    reasons.unshift({ source: "name", text: "The name looks like a person's name, as sole traders' often do" });
    if (searchedAt) {
      return { form: "INDIVIDUAL", confidence: "medium", basis: "name", summary: "Sole trader or partnership — personal name, no company found", reasons };
    }
  }

  if (reasons.length === 0) reasons.push({ source: "rules", text: "No company registration is linked to this business yet" });
  reasons.push({ source: "rules", text: "Treated as an individual subscriber until confirmed (ICO: if unsure, assume individual)" });
  return {
    form: "UNKNOWN",
    confidence: "low",
    basis: "none",
    summary: searchedAt ? "Unknown — no company found; may be a sole trader" : "Unknown — check Companies House",
    reasons,
  };
}
