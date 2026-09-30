/**
 * Check one business against Companies House and record what was found.
 *
 * - A business with a company number is refreshed from its profile (status,
 *   type) — one request.
 * - One without is searched by name, dissolved companies included, and linked
 *   only when `matchCompany` finds exactly one strong match — one request.
 * - Several plausible matches are recorded as candidates for a person to pick;
 *   nothing is linked. No match is recorded as "searched, none found", which
 *   is evidence (not proof) of a sole trader.
 *
 * Every outcome is written as evidence with its source and date, and the raw
 * register record is kept as a source record linked to the business.
 */
import type { Sql } from "@/lib/db";
import {
  getCompanyProfile,
  searchCompanyByName,
  type ChClientOptions,
  type CompanyHit,
  type CompanyProfile,
} from "../companies-house.ts";
import { legalInputOf } from "../outreach/eligibility.ts";
import type { LeadWithFacts } from "../outreach/types.ts";
import { matchCompany, type CandidateSummary } from "./company-match.ts";
import * as contacts from "./store.server.ts";

export type CompanyCheckOutcome =
  | { status: "confirmed"; companyNumber: string; legalName: string; companyType: string; companyStatus: string; reasons: string[] }
  | { status: "no-match" }
  | { status: "ambiguous"; candidates: CandidateSummary[] }
  | { status: "error"; error: string; kind?: string };

const REGISTER_URL = (number: string) => `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number)}`;

function sourceRecordOf(
  lead: LeadWithFacts,
  company: { companyNumber: string; legalName: string; companyType: string; companyStatus: string; address: string; postcode: string; sicCodes: string[]; incorporatedOn: string; dissolvedOn?: string },
  at: string,
): contacts.SourceRecordInput {
  return {
    id: `ch:${company.companyNumber}`,
    source: "companies_house",
    sourceId: company.companyNumber,
    leadId: lead.id,
    name: company.legalName,
    url: REGISTER_URL(company.companyNumber),
    fetchedAt: at,
    fields: {
      companyNumber: company.companyNumber,
      legalName: company.legalName,
      companyType: company.companyType,
      companyStatus: company.companyStatus,
      registeredAddress: company.address,
      postcode: company.postcode,
      sicCodes: company.sicCodes,
      incorporatedOn: company.incorporatedOn,
      ...(company.dissolvedOn ? { dissolvedOn: company.dissolvedOn } : {}),
    },
  };
}

async function recordCompany(
  sql: Sql,
  userId: string,
  lead: LeadWithFacts,
  company: { companyNumber: string; legalName: string; companyType: string; companyStatus: string; address: string; postcode: string; sicCodes: string[]; incorporatedOn: string; dissolvedOn?: string },
  how: { reasons: string[]; confidence: contacts.Confidence; by: "register" | "person" },
  at: string,
): Promise<void> {
  await contacts.saveCompanyFacts(sql, userId, lead.id, {
    companyNumber: company.companyNumber,
    companyType: company.companyType,
    companyStatus: company.companyStatus,
    checkedAt: at,
  });
  await contacts.upsertSourceRecords(sql, userId, [sourceRecordOf(lead, company, at)]);
  await contacts.addEvidence(sql, userId, lead.id, [
    {
      kind: "company_record",
      value: company.companyNumber,
      label: `${company.legalName} (${company.companyNumber}) — ${company.companyType || "type unknown"}, ${company.companyStatus || "status unknown"}${how.by === "person" ? " — confirmed by you" : ""}`,
      source: "companies_house",
      sourceRef: company.companyNumber,
      sourceUrl: REGISTER_URL(company.companyNumber),
      confidence: how.confidence,
      observedAt: at,
      detail: { reasons: how.reasons, by: how.by, incorporatedOn: company.incorporatedOn, sicCodes: company.sicCodes },
    },
  ]);
}

function fromProfile(profile: CompanyProfile) {
  return {
    companyNumber: profile.companyNumber,
    legalName: profile.legalName,
    companyType: profile.companyType,
    companyStatus: profile.companyStatus,
    address: profile.address,
    postcode: profile.postcode,
    sicCodes: profile.sicCodes,
    incorporatedOn: profile.incorporatedOn,
    dissolvedOn: profile.dissolvedOn,
  };
}

function fromHit(hit: CompanyHit) {
  return {
    companyNumber: hit.companyNumber,
    legalName: hit.legalName,
    companyType: hit.companyType,
    companyStatus: hit.companyStatus,
    address: hit.address,
    postcode: hit.postcode,
    sicCodes: hit.sicCodes,
    incorporatedOn: hit.incorporatedOn,
  };
}

/** The company number already tied to this business: stored, or from its discovery record. */
export function knownCompanyNumber(lead: LeadWithFacts): string {
  return (legalInputOf(lead).companyNumber ?? "").trim().toUpperCase();
}

export async function checkCompanyForLead(
  sql: Sql,
  userId: string,
  lead: LeadWithFacts,
  client: ChClientOptions,
  now: Date = new Date(),
): Promise<CompanyCheckOutcome> {
  const at = now.toISOString();
  const number = knownCompanyNumber(lead);

  if (number) {
    const { profile, error, kind } = await getCompanyProfile(number, client);
    if (!profile) return { status: "error", error: error ?? "Companies House did not return that company.", kind };
    const company = fromProfile(profile);
    await recordCompany(sql, userId, lead, company, { reasons: [`Refreshed from the register (${number})`], confidence: "high", by: "register" }, at);
    return { status: "confirmed", ...company, reasons: [`Refreshed from the register (${number})`] };
  }

  const { hits, error, kind } = await searchCompanyByName(lead.businessName, client, { includeInactive: true });
  if (error) return { status: "error", error, kind };
  const match = matchCompany({ businessName: lead.businessName, town: lead.town, address: lead.address }, hits);

  if (match.kind === "match") {
    const company = fromHit(match.hit);
    const confidence: contacts.Confidence = match.reasons.some((reason) => /same postcode \(/.test(reason)) ? "high" : "medium";
    await recordCompany(sql, userId, lead, company, { reasons: match.reasons, confidence, by: "register" }, at);
    return { status: "confirmed", ...company, reasons: match.reasons };
  }

  if (match.kind === "none") {
    await contacts.saveCompanyFacts(sql, userId, lead.id, { companyNumber: "", companyType: "", companyStatus: "", checkedAt: at });
    await contacts.addEvidence(sql, userId, lead.id, [
      {
        kind: "company_record",
        value: "",
        label: `Searched Companies House for “${lead.businessName}”: no matching company`,
        source: "companies_house",
        sourceRef: `search:${lead.businessName}`,
        confidence: "medium",
        observedAt: at,
        detail: { resultsReturned: hits.length },
      },
    ]);
    return { status: "no-match" };
  }

  const candidates = match.candidates.map((candidate) => ({
    companyNumber: candidate.hit.companyNumber,
    legalName: candidate.hit.legalName,
    companyType: candidate.hit.companyType,
    companyStatus: candidate.hit.companyStatus,
    address: candidate.hit.address,
    reasons: candidate.reasons,
  }));
  await contacts.addEvidence(sql, userId, lead.id, [
    {
      kind: "company_candidates",
      value: String(candidates.length),
      label: `${candidates.length} possible Companies House match${candidates.length === 1 ? "" : "es"} — confirm which, if any, is this business`,
      source: "companies_house",
      sourceRef: `search:${lead.businessName}`,
      confidence: "low",
      observedAt: at,
      detail: { candidates },
    },
  ]);
  return { status: "ambiguous", candidates };
}

/** A person picked the right company from the candidates (or typed its number). */
export async function confirmCompanyForLead(
  sql: Sql,
  userId: string,
  lead: LeadWithFacts,
  companyNumber: string,
  client: ChClientOptions,
  now: Date = new Date(),
): Promise<CompanyCheckOutcome> {
  const number = companyNumber.trim().toUpperCase();
  if (!/^[A-Z]{0,2}\d{6,8}$/.test(number)) return { status: "error", error: "That is not a Companies House number." };
  const { profile, error, kind } = await getCompanyProfile(number, client);
  if (!profile) return { status: "error", error: error ?? "Companies House has no company with that number.", kind };
  const company = fromProfile(profile);
  const reasons = ["Confirmed by you from the register"];
  await recordCompany(sql, userId, lead, company, { reasons, confidence: "high", by: "person" }, now.toISOString());
  return { status: "confirmed", ...company, reasons };
}
