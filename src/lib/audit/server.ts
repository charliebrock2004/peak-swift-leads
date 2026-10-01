/**
 * Server functions for website audits. Owner-only; scoped to the signed-in
 * account. Server-only modules are imported inside handlers.
 *
 * An audit fetches the prospect's site and asks Google PageSpeed to load it,
 * so it is budgeted (AUDITS_PER_DAY) and a business is not re-audited within
 * ten minutes unless its last audit failed.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { AUDITS_PER_DAY } from "./findings.ts";

const REAUDIT_AFTER_MS = 10 * 60 * 1000;

type Fail = { success: false; error: string };

function leadIdOf(input: unknown): string {
  const id = typeof (input as { leadId?: unknown } | null)?.leadId === "string" ? (input as { leadId: string }).leadId.trim().slice(0, 64) : "";
  if (!id) throw new Error("Missing business");
  return id;
}

function failure(error: unknown): Fail {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

/** Audit one business's website now (up to about a minute: PageSpeed is slow). */
export const auditWebsite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ leadId: leadIdOf(input) }))
  .handler(async ({ data, context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("@/lib/outreach/store.server");
      const audits = await import("./run.server.ts");
      const { log } = await import("@/lib/log.server");
      const sql = await getSql();
      const lead = await store.loadLead(sql, context.userId, data.leadId);
      if (!lead) return { success: false as const, error: "That business no longer exists." };
      const last = lead.facts.audit;
      if (last && last.status === "ok" && Date.now() - Date.parse(last.finishedAt) < REAUDIT_AFTER_MS) {
        return { success: true as const, auditId: last.id, reused: true };
      }
      const allowed = await store.consumeBudget(sql, context.userId, "audit", 1, AUDITS_PER_DAY).catch(() => 1);
      if (allowed === null) return { success: false as const, error: `Today's ${AUDITS_PER_DAY} website audits are used up. More tomorrow.` };
      const audit = await audits.runWebsiteAudit(sql, context.userId, lead, await audits.realNetwork());
      log.info("website_audit", {
        userId: context.userId,
        leadId: lead.id,
        auditId: audit.id,
        status: audit.status,
        opportunity: audit.opportunity,
        pagespeed: audit.pagespeed ? "ok" : audit.pagespeedError || "none",
      });
      return { success: true as const, auditId: audit.id, reused: false };
    } catch (error) {
      const { log } = await import("@/lib/log.server");
      log.warn("website_audit_failed", { userId: context.userId, leadId: data.leadId, error });
      return failure(error);
    }
  });

/**
 * One audit (the latest unless `auditId` names another), with the business,
 * what is known about its website, and the audit history. The audit travels as
 * JSON text: the server-function boundary only carries values it can prove
 * serialisable.
 */
export const getWebsiteAudit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({
    leadId: leadIdOf(input),
    auditId: typeof (input as { auditId?: unknown }).auditId === "string" ? String((input as { auditId: string }).auditId).slice(0, 64) : "",
  }))
  .handler(async ({ data, context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("@/lib/outreach/store.server");
      const audits = await import("./run.server.ts");
      const sql = await getSql();
      const lead = await store.loadLead(sql, context.userId, data.leadId);
      if (!lead) return { success: false as const, error: "That business no longer exists." };
      const [audit, history] = await Promise.all([
        audits.loadAudit(sql, context.userId, lead.id, data.auditId || undefined),
        audits.auditHistory(sql, context.userId, lead.id),
      ]);
      return {
        success: true as const,
        lead: {
          id: lead.id,
          businessName: lead.businessName,
          trade: lead.trade,
          town: lead.town,
          website: lead.website,
          websiteStatus: lead.websiteStatus,
          rating: lead.rating,
          reviews: lead.reviews,
          phone: lead.phone,
          email: lead.email,
          source: lead.source,
          foundAt: lead.foundAt,
        },
        websiteEvidence: lead.facts.websiteEvidence ? JSON.stringify(lead.facts.websiteEvidence) : "",
        audit: audit ? JSON.stringify(audit) : "",
        history,
      };
    } catch (error) {
      return failure(error);
    }
  });
