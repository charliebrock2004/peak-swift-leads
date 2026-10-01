/**
 * The contactability rules, applied to a lead as the app holds it.
 *
 * Shared by the send gate (eligibility.ts) and the prospect score, so the two
 * can never disagree about who the subscriber is. Client-safe and pure.
 */
import type { OutreachLead } from "../outreach/types.ts";
import { classifyLegalForm, DEFAULT_CONTACT_RULES, type ContactRules, type LegalFormInput, type LegalFormResult } from "./legal-form.ts";

/**
 * What the legal-form rules need from a lead: the server's facts when it has
 * them, otherwise what the discovery record itself says (a Companies House
 * lead carries its number in `placeId` and its type in the notes).
 */
export function legalInputOf(lead: OutreachLead): LegalFormInput {
  const facts = lead.facts;
  // Discovery merges a Companies House record into a map listing only when
  // the entity resolver says they are the same business, and keeps the
  // register's "Companies House <number> (<type>)" line in the notes.
  const noted = /Companies House ([A-Z]{0,2}\d{6,8})(?: \(([a-z-]+)\))?/i.exec(lead.notes ?? "");
  const placeNumber =
    /^ch:([A-Z0-9]+)$/i.exec(lead.placeId?.trim() ?? "")?.[1]?.toUpperCase() ?? noted?.[1]?.toUpperCase() ?? "";
  const notedType = noted && noted[1]!.toUpperCase() === placeNumber ? (noted[2] ?? "").toLowerCase() : "";
  return {
    businessName: lead.businessName,
    email: lead.email,
    companyNumber: facts?.companyNumber || placeNumber,
    companyType: facts?.companyType || (placeNumber ? notedType : ""),
    // A Companies House lead was active on the day discovery found it.
    companyStatus: facts?.companyStatus || (placeNumber ? "active" : ""),
    companyCheckedAt: facts?.companyCheckedAt || (placeNumber ? lead.foundAt : ""),
    override: facts?.legalFormOverride ?? "",
    overrideNote: facts?.legalFormNote ?? "",
    overrideAt: facts?.legalFormSetAt ?? "",
  };
}

export function legalFormOf(lead: OutreachLead, rules: ContactRules = DEFAULT_CONTACT_RULES, now: Date = new Date()): LegalFormResult {
  return classifyLegalForm(legalInputOf(lead), rules, now);
}

