/**
 * Server functions for the sales loop: Today, one business's workspace, the
 * pipeline, and the actions that move a sale (log a call, change a stage, add
 * a note or a task). Owner-only; every query is scoped to the signed-in
 * account. Server-only modules are imported inside the handlers.
 *
 * Payloads travel as JSON text: they carry the lead with its server-held
 * facts, and the server-function boundary only carries values it can prove
 * serialisable.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { CALL_OUTCOMES, STAGES, TASK_TYPES, type CallOutcome, type Stage, type TaskPriority, type TaskStatus, type TaskType } from "./types.ts";

type Fail = { ok: false; error: string };
type Reply = { ok: true; json: string } | Fail;

function failure(error: unknown, fallback: string): Fail {
  const message = error instanceof Error ? error.message : "";
  if (/relation "(tasks|opportunities|interactions)" does not exist/i.test(message)) {
    return { ok: false, error: "The pipeline needs the latest database migration. Redeploy to apply it." };
  }
  return { ok: false, error: message || fallback };
}

const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Everything Today, the pipeline and a business page are computed from — loaded once. */
async function world(userId: string) {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const store = await import("@/lib/outreach/store.server");
  const contacts = await import("@/lib/contactability/store.server");
  const sales = await import("./store.server.ts");
  const [leads, emails, settings, suppression, profile, screenings, doNotCall, tasks, opportunities] = await Promise.all([
    store.loadLeads(sql, userId),
    store.loadEmails(sql, userId),
    store.loadSettings(sql, userId),
    store.suppressedSet(sql, userId),
    store.loadProfile(sql, userId).catch(() => null),
    contacts.loadScreenings(sql, userId).catch(() => new Map()),
    contacts.loadDoNotCall(sql, userId).catch(() => new Map()),
    sales.openTasks(sql, userId),
    sales.loadOpportunities(sql, userId),
  ]);
  const { scoreAll } = await import("@/lib/scoring/records");
  const { effectiveProfile, scoringProfile } = await import("@/lib/outreach/profile");
  const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
  const scores = scoreAll(leads, {
    screenings,
    doNotCall,
    suppressed: suppression,
    contacted: new Set(emails.filter((email) => email.kind === "initial" && live.has(email.status)).map((email) => email.leadId)),
    rules: settings.contactRules,
    profile: scoringProfile(effectiveProfile(profile)),
  });
  return { sql, store, sales, leads, emails, settings, suppression, profile, screenings, doNotCall, tasks, opportunities, scores };
}

export const getToday = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Reply> => {
    try {
      const w = await world(context.userId);
      const { sendQueue } = await import("@/components/app/send-queue");
      const { allowance } = await import("@/lib/outreach/limits");
      const { autoContext } = await import("@/lib/outreach/auto-run");
      const { followUpsDue } = await import("@/lib/outreach/follow-ups");
      const { callQueue } = await import("@/lib/outreach/call-queue");
      const { callContactability, normalizeUkPhone } = await import("@/lib/contactability/phone");
      const { contactMethodsOf, effectiveProfile, profileList } = await import("@/lib/outreach/profile");
      const { buildToday } = await import("./today.ts");
      const profile = effectiveProfile(w.profile);
      // Email-only: a cold call is never on the day's list (callbacks they asked for still are).
      const phones = contactMethodsOf(profile) !== "email";
      const trades = profileList(profile.targetTrades);
      const areas = profileList(profile.targetAreas);
      const searchHint = trades.length && areas.length ? `${trades.slice(0, 3).join(", ")} around ${areas.slice(0, 2).join(" and ")}` : "";

      const state = {
        leads: w.leads,
        emails: w.emails,
        suppression: [...w.suppression].map((email) => ({ email })),
        settings: w.settings,
        profile: effectiveProfile(w.profile),
      } as unknown as Parameters<typeof sendQueue>[0];
      const queue = sendQueue(state);
      const approved = queue.ready.filter((entry) => entry.email.status === "approved" || entry.email.status === "queued").length;
      const drafts = queue.ready.filter((entry) => entry.email.status === "draft").length;
      const room = allowance(w.emails, w.settings).remaining;
      const eligibility = autoContext(w.emails, [...w.suppression], w.settings);
      const followUps = w.settings.followUpsOn ? followUpsDue(w.leads, w.emails, w.settings, eligibility).length : 0;
      const calls = callQueue(w.leads)
        .today.filter((item) => {
          const number = normalizeUkPhone(item.lead.phone)?.e164 ?? "";
          const verdict = callContactability({
            phone: item.lead.phone,
            screening: number ? w.screenings.get(number) : null,
            doNotCall: number ? w.doNotCall.get(number) : null,
            callResult: item.lead.callResult,
            called: item.lead.called,
            unsubscribed: item.lead.unsubscribed,
            outreachStatus: item.lead.outreachStatus,
          });
          return verdict.status !== "BLOCKED" && (phones || item.kind === "follow-up");
        })
        .map((item) => ({ leadId: item.lead.id, reason: item.reason }));

      const plan = buildToday({
        now: new Date(),
        leads: w.leads,
        scores: w.scores,
        emails: w.emails,
        tasks: w.tasks,
        opportunities: w.opportunities,
        sendReady: Math.min(approved, room),
        draftsToReview: drafts,
        followUpEmailsDue: followUps,
        calls,
        searchHint,
      });
      return { ok: true, json: JSON.stringify(plan) };
    } catch (error) {
      return failure(error, "Could not load today.");
    }
  });

export const getBusiness = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ leadId: str((input as { leadId?: unknown } | null)?.leadId, 64) }))
  .handler(async ({ data, context }): Promise<Reply> => {
    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();
      const store = await import("@/lib/outreach/store.server");
      const lead = await store.loadLead(sql, context.userId, data.leadId);
      if (!lead) return { ok: false, error: "That business no longer exists." };
      const w = await world(context.userId);
      const sales = w.sales;
      const audits = await import("@/lib/audit/run.server");
      const { derivedStage, effectiveStage } = await import("./pipeline.ts");
      const { buildTimeline } = await import("./timeline.ts");
      const { buildCallBrief } = await import("./call-brief.ts");
      const { effectiveProfile } = await import("@/lib/outreach/profile");
      const { normalizeUkPhone } = await import("@/lib/contactability/phone");

      const emails = w.emails.filter((email) => email.leadId === lead.id);
      const [tasks, interactions, history, opportunity] = await Promise.all([
        sales.tasksForLead(sql, context.userId, lead.id),
        sales.interactionsForLead(sql, context.userId, lead.id),
        audits.auditHistory(sql, context.userId, lead.id).catch(() => []),
        sales.loadOpportunity(sql, context.userId, lead.id),
      ]);
      const derived = derivedStage(lead, emails);
      const stage = effectiveStage(opportunity, derived.stage);
      const timeline = buildTimeline({
        lead,
        emails,
        audits: history.map((audit) => ({ id: audit.id, finishedAt: audit.finishedAt, status: "ok", opportunity: audit.opportunity })),
        interactions,
        tasks,
      });
      const score = w.scores.get(lead.id);
      const previous = timeline.find((event) => event.kind !== "discovered" && event.kind !== "company" && event.kind !== "audit");
      const brief = buildCallBrief(lead, score, effectiveProfile(w.profile), { previous: previous ? `${previous.title}${previous.detail ? ` — ${previous.detail}` : ""}` : "" });
      const number = normalizeUkPhone(lead.phone)?.e164 ?? "";
      return {
        ok: true,
        json: JSON.stringify({
          lead,
          score: score ?? null,
          stage,
          stageReason: derived.reason,
          opportunity,
          emails,
          tasks,
          timeline,
          brief,
          screening: number ? (w.screenings.get(number) ?? null) : null,
          doNotCall: number ? (w.doNotCall.get(number) ?? null) : null,
          rules: w.settings.contactRules,
          suppressed: Boolean(lead.email.trim() && w.suppression.has(lead.email.trim().toLowerCase())),
        }),
      };
    } catch (error) {
      return failure(error, "Could not load that business.");
    }
  });

export const getPipeline = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Reply> => {
    try {
      const w = await world(context.userId);
      const { derivedStage, effectiveStage, pipelineTotals } = await import("./pipeline.ts");
      const last = await w.sales.lastInteractions(w.sql, context.userId);
      const emailsByLead = new Map<string, typeof w.emails>();
      for (const email of w.emails) emailsByLead.set(email.leadId, [...(emailsByLead.get(email.leadId) ?? []), email]);
      const nextTask = new Map<string, (typeof w.tasks)[number]>();
      for (const task of w.tasks) if (task.leadId && !nextTask.has(task.leadId)) nextTask.set(task.leadId, task);
      const rows = w.leads.flatMap((lead) => {
        const opportunity = w.opportunities.get(lead.id) ?? null;
        const stage = effectiveStage(opportunity, derivedStage(lead, emailsByLead.get(lead.id) ?? []).stage);
        if (stage === "PROSPECT" && !opportunity) return [];
        const score = w.scores.get(lead.id);
        const lastEmail = (emailsByLead.get(lead.id) ?? []).map((email) => email.repliedAt || email.sentAt).filter(Boolean).sort().at(-1) ?? "";
        const lastTouch = [last.get(lead.id)?.occurredAt ?? "", lastEmail].sort().at(-1) ?? "";
        return [{
          leadId: lead.id,
          businessName: lead.businessName,
          trade: lead.trade,
          town: lead.town,
          phone: lead.phone,
          stage,
          valuePence: opportunity?.valuePence ?? null,
          stageChangedAt: opportunity?.stageChangedAt ?? "",
          wonDate: opportunity?.wonDate ?? "",
          band: score?.band ?? "NONE",
          lastTouch,
          lastSummary: last.get(lead.id)?.summary ?? "",
          nextTask: nextTask.get(lead.id) ?? null,
        }];
      });
      const totals = pipelineTotals(rows, new Date());
      return { ok: true, json: JSON.stringify({ rows, totals }) };
    } catch (error) {
      return failure(error, "Could not load the pipeline.");
    }
  });

/** Revenue analytics and the north-star minutes (revenue.ts), from the account's own rows. */
export const getRevenue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Reply> => {
    try {
      const w = await world(context.userId);
      const [history, time] = await Promise.all([
        w.sales.saleHistory(w.sql, context.userId),
        // Before migration 0015 there is no measured time — the rest still stands.
        w.sales.loadTime(w.sql, context.userId).catch(() => []),
      ]);
      const { revenueAnalytics } = await import("./revenue.ts");
      const revenue = revenueAnalytics({
        now: new Date(),
        leads: w.leads,
        reachable: (lead) => (w.scores.get(lead.id)?.reach.channel ?? "none") !== "none",
        emails: w.emails,
        opportunities: w.opportunities,
        interactions: history,
        time,
      });
      return { ok: true, json: JSON.stringify(revenue) };
    } catch (error) {
      return failure(error, "Could not load revenue.");
    }
  });

/**
 * Every sales write behind one function — log a call, change a stage, save a
 * value, add a note, add or close a task. They are one shape of operation and
 * share a function for the same reason `saveCampaign` does: the server bundle
 * has split before under the weight of server-function exports.
 */
export const salesAction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as Record<string, unknown>;
    const action = str(source.action, 20);
    if (!["log_call", "set_stage", "save_value", "add_note", "save_task", "task_status", "log_time"].includes(action)) throw new Error("Unknown action.");
    const outcome = str(source.outcome, 30);
    const stage = str(source.stage, 20);
    const type = str(source.type, 20);
    const status = str(source.status, 20);
    const priority = str(source.priority, 10);
    const value = source.valuePence === null || source.valuePence === "" ? null : Number(source.valuePence);
    const seconds = Number(source.seconds);
    return {
      action,
      leadId: str(source.leadId, 64),
      outcome: ((CALL_OUTCOMES as readonly string[]).includes(outcome) ? outcome : "") as CallOutcome | "",
      stage: ((STAGES as readonly string[]).includes(stage) ? stage : "") as Stage | "",
      note: str(source.note, 4000),
      at: str(source.at, 40),
      valuePence: source.valuePence === undefined ? undefined : value !== null && Number.isFinite(value) ? value : null,
      lostReason: str(source.lostReason, 300),
      nurtureDate: str(source.nurtureDate, 10),
      taskId: str(source.taskId, 64),
      type: ((TASK_TYPES as readonly string[]).includes(type) ? type : "OTHER") as TaskType,
      title: str(source.title, 200),
      dueAt: str(source.dueAt, 40),
      priority: (priority === "high" || priority === "low" ? priority : "normal") as TaskPriority,
      status: (status === "done" || status === "cancelled" || status === "open" ? status : "done") as TaskStatus,
      seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0,
    };
  })
  .handler(async ({ data, context }): Promise<Reply> => {
    try {
      const { getSql } = await import("@/lib/db");
      const sql = await getSql();
      const actions = await import("./actions.server.ts");
      const sales = await import("./store.server.ts");
      const { log } = await import("@/lib/log.server");
      let out: unknown;
      switch (data.action) {
        case "log_call":
          if (!data.outcome) return { ok: false, error: "Choose what happened on the call." };
          out = await actions.logCall(sql, context.userId, { leadId: data.leadId, outcome: data.outcome, note: data.note, at: data.at, durationSeconds: data.seconds });
          break;
        case "set_stage":
          if (!data.stage) return { ok: false, error: "Choose a stage." };
          out = await actions.setStage(sql, context.userId, { leadId: data.leadId, stage: data.stage, valuePence: data.valuePence, lostReason: data.lostReason, nurtureDate: data.nurtureDate });
          break;
        case "save_value":
          out = await sales.saveOpportunity(sql, context.userId, data.leadId, { valuePence: data.valuePence ?? null, notes: data.note || undefined });
          break;
        case "add_note":
          out = await actions.addNote(sql, context.userId, { leadId: data.leadId, text: data.note });
          break;
        case "save_task":
          out = await sales.createTask(sql, context.userId, { leadId: data.leadId, type: data.type, title: data.title, dueAt: data.dueAt, priority: data.priority, notes: data.note });
          break;
        case "log_time":
          // App time only: call time is recorded with the call it belongs to.
          return { ok: true, json: JSON.stringify({ added: await sales.addTime(sql, context.userId, "app", data.seconds) }) };
        case "task_status": {
          const task = await sales.updateTask(sql, context.userId, data.taskId, { status: data.status });
          if (!task) return { ok: false, error: "That task no longer exists." };
          out = task;
          break;
        }
      }
      log.info("sales_action", { userId: context.userId, action: data.action, leadId: data.leadId, outcome: data.outcome || undefined, stage: data.stage || undefined });
      return { ok: true, json: JSON.stringify(out ?? null) };
    } catch (error) {
      return failure(error, "Could not save that.");
    }
  });
