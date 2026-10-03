/**
 * Adding, editing, removing and importing businesses — on the server, the one
 * place the business list lives. Owner-only; every write is scoped to the
 * signed-in account and goes through the same sanitising as sync.
 *
 * What a person types is theirs to vouch for; nothing here guesses. An email
 * entered by hand is recorded as "Entered by you", so its provenance is never
 * mistaken for something the app found.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

type Reply = { ok: true; json: string } | { ok: false; error: string };

const EDITABLE = ["businessName", "trade", "town", "phone", "email", "address", "website", "notes"] as const;
type Editable = (typeof EDITABLE)[number];

function pick(raw: unknown): Partial<Record<Editable, string>> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<Record<Editable, string>> = {};
  const limits: Record<Editable, number> = { businessName: 160, trade: 80, town: 80, phone: 40, email: 160, address: 200, website: 500, notes: 4000 };
  for (const key of EDITABLE) {
    if (typeof source[key] === "string") out[key] = (source[key] as string).trim().slice(0, limits[key]);
  }
  return out;
}

export const businessAction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as Record<string, unknown>;
    const action = typeof source.action === "string" ? source.action : "";
    if (!["create", "update", "remove", "import", "feedback"].includes(action)) throw new Error("Unknown action.");
    return {
      action: action as "create" | "update" | "remove" | "import" | "feedback",
      id: typeof source.id === "string" ? source.id.slice(0, 64) : "",
      fields: pick(source.fields),
      adds: Array.isArray(source.adds) ? source.adds.slice(0, 2000) : [],
      merges: Array.isArray(source.merges) ? source.merges.slice(0, 2000) : [],
      verdict: typeof source.verdict === "string" ? source.verdict.slice(0, 30) : "",
      on: source.on !== false,
      note: typeof source.note === "string" ? source.note.trim().slice(0, 500) : "",
    };
  })
  .handler(async ({ data, context }): Promise<Reply> => {
    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();
      const writes = await import("@/lib/jobs/lead-writes.server");
      const { classifyWebsiteUrl, newLeadId } = await import("@/lib/leads");
      const { findDuplicate } = await import("@/lib/identity-index");
      const { sanitizeLead } = await import("@/lib/leads-server");
      const { mergePatch } = await import("@/lib/csv-import");
      const { log } = await import("@/lib/log.server");
      const { RATE, RATE_LIMITED, withinRate } = await import("@/lib/security/rate-limit.server");
      if (!(await withinRate(sql, context.userId, data.action === "import" ? RATE.import : RATE.business))) return { ok: false, error: RATE_LIMITED };
      const now = new Date().toISOString();

      /** The extra fields a hand-entered email or website implies. */
      const implied = (fields: Partial<Record<Editable, string>>, current?: { email: string; website: string }) => {
        const extra: Record<string, string> = {};
        if (fields.email !== undefined && fields.email !== (current?.email ?? "")) {
          if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) throw new Error("That email address doesn't look right.");
          Object.assign(extra, fields.email ? { emailSource: "Entered by you", emailConfidence: "HIGH", emailFoundAt: now } : { emailSource: "", emailConfidence: "", emailFoundAt: "" });
        }
        if (fields.website !== undefined && fields.website !== (current?.website ?? "")) extra.websiteStatus = fields.website ? classifyWebsiteUrl(fields.website) : "";
        return extra;
      };

      if (data.action === "create") {
        if (!data.fields.businessName || data.fields.businessName.length < 2) return { ok: false, error: "Give the business a name." };
        const sheet = await writes.loadSheet(sql, context.userId);
        const duplicate = findDuplicate({ businessName: data.fields.businessName, town: data.fields.town ?? "", phone: data.fields.phone ?? "", mapsLink: "", website: data.fields.website ?? "", email: data.fields.email ?? "" }, sheet);
        if (duplicate) return { ok: true, json: JSON.stringify({ id: duplicate.lead.id, duplicate: true }) };
        const id = newLeadId();
        await writes.insertLeads(sql, context.userId, [{ id, ...data.fields, ...implied(data.fields), source: "Added by you", foundAt: now, called: "Not Called" }]);
        log.info("business_created", { userId: context.userId, leadId: id });
        return { ok: true, json: JSON.stringify({ id, duplicate: false }) };
      }

      if (data.action === "update") {
        const [current] = await writes.loadSheetLeads(sql, context.userId, [data.id]);
        if (!current) return { ok: false, error: "That business no longer exists." };
        if (data.fields.businessName !== undefined && data.fields.businessName.length < 2) return { ok: false, error: "Give the business a name." };
        await writes.patchLead(sql, context.userId, data.id, { ...data.fields, ...implied(data.fields, current) });
        // Correcting the record answers the mark that said it was wrong.
        const feedback = await import("@/lib/feedback/store.server");
        await feedback
          .clearCorrected(sql, context.userId, data.id, {
            website: data.fields.website !== undefined && data.fields.website !== current.website,
            contact: (data.fields.email !== undefined && data.fields.email !== current.email) || (data.fields.phone !== undefined && data.fields.phone !== current.phone),
          })
          .catch(() => undefined);
        return { ok: true, json: JSON.stringify({ id: data.id }) };
      }

      if (data.action === "feedback") {
        const { isVerdict } = await import("@/lib/feedback/verdicts");
        if (!isVerdict(data.verdict)) return { ok: false, error: "Unknown mark." };
        const feedback = await import("@/lib/feedback/store.server");
        const [current] = await writes.loadSheetLeads(sql, context.userId, [data.id]);
        if (!current) return { ok: false, error: "That business no longer exists." };
        const result = await feedback.setFeedback(sql, context.userId, { leadId: data.id, verdict: data.verdict, on: data.on, note: data.note });
        // "Not their website": the site comes off the record (the mark keeps
        // it, so it is never attached again) and the next check looks afresh.
        if (data.verdict === "wrong_website" && data.on && current.website.trim()) {
          await writes.patchLead(sql, context.userId, data.id, { website: "", websiteStatus: "", websiteQuality: "", websiteScore: "", websiteAnalysis: "", websiteCheckedAt: "" } as never);
        }
        log.info("prospect_feedback", { userId: context.userId, leadId: data.id, verdict: data.verdict, on: data.on });
        return { ok: true, json: JSON.stringify(result) };
      }

      if (data.action === "remove") {
        // A soft delete: the row stays, so suppression and send history keep
        // their meaning; it just leaves every list.
        const rows = await sql.query<{ business_name: string }>(`update leads set deleted_at = now(), updated_at = now() where user_id = $1 and id = $2 and deleted_at is null returning business_name`, [context.userId, data.id]);
        if (!rows.length) return { ok: false, error: "That business no longer exists." };
        const { audit } = await import("@/lib/security/audit.server");
        await audit(sql, context.userId, "BUSINESS_REMOVED", { leadId: data.id, leadName: String(rows[0]!.business_name ?? "") });
        return { ok: true, json: JSON.stringify({ id: data.id }) };
      }

      // Import: re-checked here against the account's own list, so a stale
      // browser copy cannot add a duplicate or overwrite anything — a match
      // only ever fills blanks.
      const sheet = await writes.loadSheet(sql, context.userId);
      const fresh: Record<string, unknown>[] = [];
      const merged = new Map<string, Record<string, unknown>>();
      for (const raw of data.adds) {
        const lead = sanitizeLead({ ...(raw as object), id: newLeadId(), updatedAt: now });
        if (!lead || lead.businessName.trim().length < 2) continue;
        const duplicate = findDuplicate(lead, [...sheet]);
        if (duplicate) {
          merged.set(duplicate.lead.id, { ...(merged.get(duplicate.lead.id) ?? {}), ...mergePatch(duplicate.lead, { ...lead }) });
          continue;
        }
        sheet.push(lead);
        fresh.push({ ...lead, source: lead.source || "Spreadsheet", foundAt: lead.foundAt || now, emailSource: lead.email ? lead.emailSource || "Spreadsheet" : "", emailConfidence: lead.email ? lead.emailConfidence || "MEDIUM" : "" });
      }
      for (const raw of data.merges as { id?: unknown; patch?: unknown }[]) {
        const id = typeof raw?.id === "string" ? raw.id : "";
        const existing = sheet.find((lead) => lead.id === id);
        const patch = sanitizeLead({ ...existing, ...(raw?.patch as object), id: id || "x", updatedAt: now });
        if (!existing || !patch) continue;
        merged.set(id, { ...(merged.get(id) ?? {}), ...mergePatch(existing, { ...patch, businessName: existing.businessName }) });
      }
      await writes.insertLeads(sql, context.userId, fresh as never[]);
      for (const [id, patch] of merged) await writes.patchLead(sql, context.userId, id, patch as never);
      log.info("businesses_imported", { userId: context.userId, added: fresh.length, merged: merged.size });
      const { audit } = await import("@/lib/security/audit.server");
      await audit(sql, context.userId, "BUSINESSES_IMPORTED", { result: `${fresh.length} added, ${merged.size} topped up` });
      return { ok: true, json: JSON.stringify({ added: fresh.length, merged: merged.size, ids: [...fresh.map((lead) => String(lead.id)), ...merged.keys()] }) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not save that." };
    }
  });
