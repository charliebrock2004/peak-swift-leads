/**
 * Server functions for provenance and contactability: the Companies House
 * check, a person's legal-form ruling, TPS/CTPS screening records, the
 * do-not-call list, and "these two are / are not the same business".
 *
 * Owner-only (authMiddleware) and scoped to the signed-in account, like every
 * other server function. Server-only modules are imported inside handlers so
 * none of them reach the browser bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { LEGAL_FORMS, type LegalForm } from "./legal-form.ts";
import type { DoNotCall, PhoneScreening, ScreeningResult } from "./phone.ts";

type Fail = { success: false; error: string };

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new Error("Missing input");
  return input as Record<string, unknown>;
}

function leadIdOf(input: Record<string, unknown>): string {
  const id = str(input.leadId, 64);
  if (!id) throw new Error("Missing business");
  return id;
}

async function world(userId: string) {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const store = await import("@/lib/outreach/store.server");
  const contacts = await import("./store.server.ts");
  return { sql, store, contacts, userId };
}

async function chClient() {
  const { sharedChLimiter } = await import("@/lib/sources/ch-limiter.server");
  return { limiter: await sharedChLimiter() };
}

function failure(error: unknown): Fail {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export type ContactContext = {
  success: true;
  screenings: Record<string, PhoneScreening>;
  doNotCall: Record<string, DoNotCall>;
};

/** Screening results and the do-not-call list, keyed by E.164 number. */
export const getContactContext = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ContactContext | Fail> => {
    try {
      const { sql, contacts } = await world(context.userId);
      const [screenings, dnc] = await Promise.all([contacts.loadScreenings(sql, context.userId), contacts.loadDoNotCall(sql, context.userId)]);
      return { success: true, screenings: Object.fromEntries(screenings), doNotCall: Object.fromEntries(dnc) };
    } catch (error) {
      return failure(error);
    }
  });

/** Where every fact about one business came from. */
export const getBusinessProvenance = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ leadId: leadIdOf(record(input)) }))
  .handler(async ({ data, context }) => {
    try {
      const { sql, store, contacts } = await world(context.userId);
      const lead = await store.loadLead(sql, context.userId, data.leadId);
      if (!lead) return { success: false as const, error: "That business no longer exists." };
      const [sources, evidence, legacy] = await Promise.all([
        contacts.sourceRecordsForLead(sql, context.userId, lead),
        contacts.evidenceForLead(sql, context.userId, lead.id),
        store.loadLeadEvidence(sql, context.userId, [lead.id]),
      ]);
      // Free-form JSON travels as text: the server-function boundary only
      // carries values it can prove serialisable.
      return {
        success: true as const,
        sources: sources.map(({ fields, ...rest }) => ({ ...rest, fields: JSON.stringify(fields) })),
        evidence: evidence.map(({ detail, ...rest }) => ({ ...rest, detail: JSON.stringify(detail) })),
        legacy,
      };
    } catch (error) {
      return failure(error);
    }
  });

/** Look this business up on Companies House (one request against the shared budget). */
export const checkCompany = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ leadId: leadIdOf(record(input)) }))
  .handler(async ({ data, context }) => {
    try {
      const { sql, store } = await world(context.userId);
      const lead = await store.loadLead(sql, context.userId, data.leadId);
      if (!lead) return { success: false as const, error: "That business no longer exists." };
      const { checkCompanyForLead } = await import("./company-check.server.ts");
      const outcome = await checkCompanyForLead(sql, context.userId, lead, await chClient());
      const { log } = await import("@/lib/log.server");
      log.info("company_check", { userId: context.userId, leadId: lead.id, status: outcome.status });
      return { success: true as const, outcome };
    } catch (error) {
      return failure(error);
    }
  });

/**
 * Check the businesses whose legal form is not yet known, a few at a time.
 * Skips any searched in the last 90 days, so repeating it costs nothing.
 */
export const checkCompanies = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const limit = Number((input as { limit?: unknown } | undefined)?.limit);
    return { limit: Number.isFinite(limit) ? Math.min(25, Math.max(1, Math.round(limit))) : 10 };
  })
  .handler(async ({ data, context }) => {
    try {
      const { sql, store } = await world(context.userId);
      const { legalFormOf } = await import("@/lib/outreach/eligibility");
      const { checkCompanyForLead } = await import("./company-check.server.ts");
      const settings = await store.loadSettings(sql, context.userId);
      const leads = await store.loadLeads(sql, context.userId);
      const cutoff = Date.now() - 90 * 86_400_000;
      const due = leads.filter((lead) => {
        const form = legalFormOf(lead, settings.contactRules).form;
        if (form !== "UNKNOWN" && form !== "REVIEW_REQUIRED") return false;
        if (lead.facts.legalFormOverride) return false;
        const checked = Date.parse(lead.facts.companyCheckedAt);
        return !(Number.isFinite(checked) && checked > cutoff);
      });
      const client = await chClient();
      const tally = { confirmed: 0, noMatch: 0, ambiguous: 0, errors: 0, remaining: Math.max(0, due.length - data.limit) };
      let stopped = "";
      for (const lead of due.slice(0, data.limit)) {
        const outcome = await checkCompanyForLead(sql, context.userId, lead, client);
        if (outcome.status === "confirmed") tally.confirmed += 1;
        else if (outcome.status === "no-match") tally.noMatch += 1;
        else if (outcome.status === "ambiguous") tally.ambiguous += 1;
        else {
          tally.errors += 1;
          // No key, no budget, rate-limited: the rest would fail the same way.
          if (outcome.kind === "no-key" || outcome.kind === "budget" || outcome.kind === "rate-limited") {
            stopped = outcome.error;
            break;
          }
        }
      }
      return { success: true as const, tally, stopped };
    } catch (error) {
      return failure(error);
    }
  });

/** A person picked the right company from the candidates. */
export const confirmCompany = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = record(input);
    return { leadId: leadIdOf(source), companyNumber: str(source.companyNumber, 12) };
  })
  .handler(async ({ data, context }) => {
    try {
      const { sql, store } = await world(context.userId);
      const lead = await store.loadLead(sql, context.userId, data.leadId);
      if (!lead) return { success: false as const, error: "That business no longer exists." };
      const { confirmCompanyForLead } = await import("./company-check.server.ts");
      const outcome = await confirmCompanyForLead(sql, context.userId, lead, data.companyNumber, await chClient());
      return { success: true as const, outcome };
    } catch (error) {
      return failure(error);
    }
  });

/**
 * A person's ruling on the legal form. Wins over the rules, is recorded as
 * theirs with their reason, and can be cleared (form "").
 */
export const setLegalForm = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = record(input);
    const form = str(source.form, 20);
    if (form && !(LEGAL_FORMS as readonly string[]).includes(form)) throw new Error("Unknown legal form");
    const note = str(source.note, 300);
    if (form === "CORPORATE" && note.length < 3) throw new Error("Say how you know it is a company (e.g. its Companies House number).");
    return { leadId: leadIdOf(source), form: form as LegalForm | "", note };
  })
  .handler(async ({ data, context }) => {
    try {
      const { sql, contacts } = await world(context.userId);
      const at = new Date().toISOString();
      const saved = await contacts.setLegalFormOverride(sql, context.userId, data.leadId, { form: data.form, note: data.note, at });
      if (!saved) return { success: false as const, error: "That business no longer exists." };
      await contacts.addEvidence(sql, context.userId, data.leadId, [
        {
          kind: "legal_form_ruling",
          value: data.form,
          label: data.form ? `You set the legal form to ${data.form}${data.note ? `: ${data.note}` : ""}` : "You cleared your legal-form ruling",
          source: "manual",
          confidence: "high",
          observedAt: at,
        },
      ]);
      const { audit } = await import("@/lib/security/audit.server");
      await audit(sql, context.userId, "LEGAL_FORM_SET", { leadId: data.leadId, result: data.form || "cleared", reason: data.note });
      return { success: true as const };
    } catch (error) {
      return failure(error);
    }
  });

const SCREENING: readonly ScreeningResult[] = ["unchecked", "clear", "registered"];

/**
 * Record TPS/CTPS screening results from your screening service. Numbers are
 * stored in E.164; screening is valid for 28 days.
 */
export const recordPhoneScreening = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = record(input);
    const entries = Array.isArray(source.entries) ? source.entries.slice(0, 200) : [];
    const method = str(source.method, 80) || "Manual screening";
    const note = str(source.note, 300);
    const parsed = entries.map((entry) => {
      const item = record(entry);
      const tps = str(item.tps, 12) as ScreeningResult;
      const ctps = str(item.ctps, 12) as ScreeningResult;
      if (!SCREENING.includes(tps) || !SCREENING.includes(ctps)) throw new Error("Screening must be clear, registered or unchecked");
      return { phone: str(item.phone, 40), tps, ctps, leadId: str(item.leadId, 64) };
    });
    if (parsed.length === 0) throw new Error("No numbers to record");
    return { entries: parsed, method, note };
  })
  .handler(async ({ data, context }) => {
    try {
      const { sql, contacts } = await world(context.userId);
      const at = new Date().toISOString();
      const saved: string[] = [];
      const rejected: string[] = [];
      for (const entry of data.entries) {
        try {
          const number = await contacts.recordScreening(sql, context.userId, entry.phone, { tps: entry.tps, ctps: entry.ctps, checkedAt: at, method: data.method, note: data.note });
          saved.push(number);
          if (entry.leadId) {
            await contacts.addEvidence(sql, context.userId, entry.leadId, [
              {
                kind: "phone_screening",
                value: `tps:${entry.tps};ctps:${entry.ctps}`,
                label: `${number}: TPS ${entry.tps}, CTPS ${entry.ctps} (${data.method})`,
                source: "manual",
                sourceRef: number,
                confidence: "high",
                observedAt: at,
              },
            ]);
          }
        } catch {
          rejected.push(entry.phone);
        }
      }
      const { audit } = await import("@/lib/security/audit.server");
      await audit(sql, context.userId, "PHONES_SCREENED", { result: `${saved} saved, ${rejected.length} rejected`, reason: data.method });
      return { success: true as const, saved, rejected };
    } catch (error) {
      return failure(error);
    }
  });

/** Never ring this number again for marketing. */
export const setDoNotCall = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = record(input);
    const kind = str(source.source, 12);
    return {
      phone: str(source.phone, 40),
      reason: str(source.reason, 300),
      source: (kind === "objection" ? "objection" : "internal") as "objection" | "internal",
      leadId: str(source.leadId, 64),
    };
  })
  .handler(async ({ data, context }) => {
    try {
      const { sql, contacts } = await world(context.userId);
      const number = await contacts.addDoNotCall(sql, context.userId, data);
      if (data.leadId) {
        await contacts.addEvidence(sql, context.userId, data.leadId, [
          {
            kind: "do_not_call",
            value: number,
            label: data.source === "objection" ? `They objected to calls on ${number}${data.reason ? `: ${data.reason}` : ""}` : `You added ${number} to your do-not-call list${data.reason ? `: ${data.reason}` : ""}`,
            source: "manual",
            sourceRef: number,
            confidence: "high",
          },
        ]);
      }
      const { audit } = await import("@/lib/security/audit.server");
      await audit(sql, context.userId, "DO_NOT_CALL_ADDED", { leadId: data.leadId, result: number });
      return { success: true as const, phone: number };
    } catch (error) {
      return failure(error);
    }
  });

/** Take a number off your own do-not-call list. A recorded objection stays. */
export const clearDoNotCall = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ phone: str(record(input).phone, 40) }))
  .handler(async ({ data, context }) => {
    try {
      const { sql, contacts } = await world(context.userId);
      await contacts.removeDoNotCall(sql, context.userId, data.phone);
      const { audit } = await import("@/lib/security/audit.server");
      await audit(sql, context.userId, "DO_NOT_CALL_CLEARED", { result: data.phone });
      return { success: true as const };
    } catch (error) {
      return failure(error);
    }
  });

/** "These two are the same business" / "these are different businesses". */
export const ruleOnDuplicate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = record(input);
    const decision = str(source.decision, 12);
    if (decision !== "same" && decision !== "different") throw new Error("Say same or different");
    return { a: str(source.a, 64), b: str(source.b, 64), decision: decision as "same" | "different", note: str(source.note, 300) };
  })
  .handler(async ({ data, context }) => {
    try {
      const { sql, contacts } = await world(context.userId);
      await contacts.setEntityOverride(sql, context.userId, data);
      return { success: true as const };
    } catch (error) {
      return failure(error);
    }
  });
