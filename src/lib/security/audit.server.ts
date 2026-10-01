/**
 * Audit events: who changed what on the account, in the same activity log
 * (`activity_events`, migration 0006) that already records sends, bounces,
 * replies and unsubscribes — one trail, not two.
 *
 * For actions that change who may be contacted or how the account sends:
 * Gmail connected or disconnected, sending settings, the business profile,
 * suppression, legal-form decisions, phone screening and the do-not-call
 * list, and businesses removed or imported. Never throws, and never records
 * a secret: the detail is the setting names or counts, not values.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { log } from "../log.server.ts";
import { recordActivity } from "../outreach/store.server.ts";

export type AuditType =
  | "GMAIL_CONNECTED"
  | "GMAIL_DISCONNECTED"
  | "SETTINGS_CHANGED"
  | "PROFILE_SAVED"
  | "SUPPRESSED_BY_YOU"
  | "LEGAL_FORM_SET"
  | "PHONES_SCREENED"
  | "DO_NOT_CALL_ADDED"
  | "DO_NOT_CALL_CLEARED"
  | "BUSINESS_REMOVED"
  | "BUSINESSES_IMPORTED"
  | "TEST_EMAIL_SENT";

export async function audit(
  sql: Sql,
  userId: string,
  type: AuditType,
  fields: { leadId?: string; leadName?: string; result?: string; reason?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await recordActivity(sql, userId, {
      id: randomUUID(),
      type,
      leadId: fields.leadId,
      leadName: fields.leadName,
      result: fields.result,
      reason: fields.reason,
      metadata: fields.metadata ? JSON.stringify(fields.metadata).slice(0, 2000) : undefined,
    });
    log.info("audit", { userId, type, leadId: fields.leadId, result: fields.result });
  } catch {
    // An audit write must never undo the action it records.
  }
}
