/**
 * May this business be cold-emailed at this address?
 *
 * Two questions, both conservative:
 *
 * 1. Who is the subscriber? For a company, the company is — so a corporate
 *    address may be emailed without prior consent (with an opt-out). For a
 *    personal mailbox (gmail.com, btinternet.com…) the subscriber is the
 *    person who holds it, whatever business they run, so it is treated as an
 *    individual subscriber. UNKNOWN and REVIEW_REQUIRED legal forms are held.
 * 2. Is the address real? Only a verifier (optional, run at send-ready) can
 *    say, and "catch-all" or "unknown" is never treated as proof.
 *
 * Client-safe and pure. Not legal advice — see legal-form.ts.
 */
import { isPersonalMailboxDomain, type LegalFormResult } from "./legal-form.ts";

export type EmailAddressKind = "role" | "named" | "personal_mailbox" | "unknown";

export const EMAIL_KIND_LABEL: Record<EmailAddressKind, string> = {
  role: "Business role address",
  named: "Named person's address",
  personal_mailbox: "Personal mailbox",
  unknown: "Unknown",
};

const ROLE_LOCAL_PARTS = new Set([
  "info",
  "hello",
  "hi",
  "enquiries",
  "enquiry",
  "enquire",
  "contact",
  "contactus",
  "office",
  "admin",
  "sales",
  "bookings",
  "booking",
  "book",
  "appointments",
  "mail",
  "email",
  "team",
  "studio",
  "support",
  "accounts",
  "reception",
  "general",
  "quotes",
  "quote",
  "estimates",
  "service",
  "services",
  "jobs",
  "help",
  "shop",
  "orders",
  "welcome",
  "workshop",
  "salon",
  "garage",
  "post",
  "business",
]);

export type EmailAddressInfo = {
  email: string;
  domain: string;
  kind: EmailAddressKind;
  /** The address is on the business's own website domain. Null when there is no website to compare. */
  onBusinessDomain: boolean | null;
};

function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tail = parts.slice(-2).join(".");
  // co.uk, org.uk, ltd.uk, plc.uk, me.uk, net.uk, com.au…
  if (/^(co|org|ltd|plc|me|net|ac|gov|sch|com)\.[a-z]{2}$/.test(tail)) return parts.slice(-3).join(".");
  return tail;
}

function hostOf(website: string): string {
  const value = (website ?? "").trim();
  if (!value) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function classifyEmailAddress(email: string, context: { website?: string } = {}): EmailAddressInfo {
  const value = (email ?? "").trim().toLowerCase();
  const [local = "", domain = ""] = value.split("@");
  if (!local || !domain) return { email: value, domain: "", kind: "unknown", onBusinessDomain: null };
  const siteHost = hostOf(context.website ?? "");
  const onBusinessDomain = siteHost ? registrable(siteHost) === registrable(domain) : null;
  if (isPersonalMailboxDomain(domain)) return { email: value, domain, kind: "personal_mailbox", onBusinessDomain };
  const base = local.replace(/[._-]?\d+$/, "").replace(/[._-]/g, "");
  if (ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(base)) return { email: value, domain, kind: "role", onBusinessDomain };
  // Anything else on a business domain may be a person: "john", "j.smith".
  return { email: value, domain, kind: "named", onBusinessDomain };
}

export type VerificationResult = "valid" | "invalid" | "risky" | "catch_all" | "unknown";

export const VERIFICATION_LABEL: Record<VerificationResult, string> = {
  valid: "Verified deliverable",
  invalid: "Undeliverable",
  risky: "Risky",
  catch_all: "Catch-all domain — not guaranteed",
  unknown: "Could not be verified",
};

export type EmailStatus = "ELIGIBLE" | "HOLD" | "BLOCKED";

export type EmailContactability = {
  status: EmailStatus;
  /** Why it is held or blocked. Empty when eligible. */
  reasons: string[];
  /** Things to know even when eligible. */
  notes: string[];
  address: EmailAddressInfo | null;
};

export function emailContactability(input: {
  email: string;
  website?: string;
  legal: LegalFormResult;
  verification?: { result: VerificationResult; checkedAt?: string } | null;
}): EmailContactability {
  const email = (input.email ?? "").trim();
  if (!email) return { status: "BLOCKED", reasons: ["No published email address"], notes: [], address: null };
  const address = classifyEmailAddress(email, { website: input.website });
  const notes: string[] = [];

  if (address.kind === "personal_mailbox") {
    return {
      status: "BLOCKED",
      reasons: [`Personal mailbox (${address.domain}): the subscriber is an individual, so it needs their consent — call instead`],
      notes,
      address,
    };
  }
  if (input.verification?.result === "invalid") {
    return { status: "BLOCKED", reasons: ["The email verifier says this address does not exist"], notes, address };
  }

  const legal = input.legal;
  if (legal.form === "INDIVIDUAL") {
    return { status: "BLOCKED", reasons: [`${legal.summary} — individual subscribers need consent for email; call instead`], notes, address };
  }
  if (legal.form === "UNKNOWN") {
    return { status: "HOLD", reasons: ["Not confirmed as a company — check Companies House, or call instead"], notes, address };
  }
  if (legal.form === "REVIEW_REQUIRED") {
    return { status: "HOLD", reasons: [legal.summary], notes, address };
  }

  if (address.kind === "named") notes.push("A named person's address: UK GDPR applies — keep it relevant and honour any objection at once");
  if (address.onBusinessDomain === false) notes.push(`Not on the business's own website domain (${address.domain})`);
  const verification = input.verification?.result;
  if (verification === "catch_all") notes.push("Catch-all domain: the verifier cannot confirm this mailbox exists");
  else if (verification === "risky") notes.push("The verifier rates this address risky");
  else if (verification === "unknown") notes.push("The verifier could not confirm this address");
  if (legal.confidence !== "high") notes.push(`Legal form: ${legal.summary}`);
  return { status: "ELIGIBLE", reasons: [], notes, address };
}
