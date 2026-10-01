/**
 * Tasks, opportunities and interactions (migration 0013). Every query is
 * scoped to one account; nothing here trusts an id without its user.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { STAGES, TASK_TYPES, type Interaction, type InteractionType, type Opportunity, type Stage, type Task, type TaskPriority, type TaskStatus, type TaskType } from "./types.ts";

function iso(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

function day(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

const text = (value: unknown): string => (value == null ? "" : String(value));

function json(value: unknown): Record<string, string> {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return {}; } })() : value;
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) if (item != null) out[key] = String(item);
  return out;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

function taskFromRow(row: Record<string, unknown>): Task {
  return {
    id: text(row.id),
    leadId: text(row.lead_id),
    type: text(row.type) as TaskType,
    title: text(row.title),
    contact: text(row.contact),
    dueAt: iso(row.due_at),
    priority: text(row.priority) as TaskPriority,
    status: text(row.status) as TaskStatus,
    notes: text(row.notes),
    source: text(row.source),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
  };
}

const TASK_COLUMNS = "id, lead_id, type, title, contact, due_at, priority, status, notes, source, created_at, updated_at, completed_at";

export type TaskInput = {
  id?: string;
  leadId: string;
  type: TaskType;
  title: string;
  contact?: string;
  dueAt?: string;
  priority?: TaskPriority;
  notes?: string;
  source?: string;
  /** Automatic tasks name what made them, so the same event never makes two. */
  sourceKey?: string;
};

export function sanitizeTask(input: TaskInput): TaskInput {
  if (!(TASK_TYPES as readonly string[]).includes(input.type)) throw new Error("Unknown task type.");
  const due = input.dueAt ? Date.parse(input.dueAt) : NaN;
  return {
    ...input,
    title: input.title.trim().slice(0, 200) || "Task",
    contact: (input.contact ?? "").trim().slice(0, 160),
    notes: (input.notes ?? "").trim().slice(0, 2000),
    dueAt: Number.isNaN(due) ? "" : new Date(due).toISOString(),
    priority: input.priority === "high" || input.priority === "low" ? input.priority : "normal",
    source: (input.source ?? "user").slice(0, 40),
    leadId: input.leadId.slice(0, 64),
  };
}

/** Create a task, or — for an automatic one already made — return that. */
export async function createTask(sql: Sql, userId: string, raw: TaskInput): Promise<Task> {
  const input = sanitizeTask(raw);
  const rows = await sql.query<Record<string, unknown>>(
    `insert into tasks (user_id, id, lead_id, type, title, contact, due_at, priority, notes, source, source_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict do nothing
     returning ${TASK_COLUMNS}`,
    [userId, input.id || randomUUID(), input.leadId, input.type, input.title, input.contact, input.dueAt || null, input.priority, input.notes, input.source, input.sourceKey ?? null],
  );
  if (rows[0]) return taskFromRow(rows[0]);
  const existing = await sql.query<Record<string, unknown>>(
    `select ${TASK_COLUMNS} from tasks where user_id = $1 and (source_key = $2 or id = $3) limit 1`,
    [userId, input.sourceKey ?? null, input.id ?? ""],
  );
  if (!existing[0]) throw new Error("Could not save the task.");
  return taskFromRow(existing[0]);
}

export async function updateTask(
  sql: Sql,
  userId: string,
  id: string,
  patch: { title?: string; dueAt?: string; priority?: TaskPriority; notes?: string; status?: TaskStatus; type?: TaskType },
): Promise<Task | null> {
  const rows = await sql.query<Record<string, unknown>>(
    `update tasks set
        title = coalesce($3, title),
        due_at = case when $4::text is null then due_at when $4 = '' then null else $4::timestamptz end,
        priority = coalesce($5, priority),
        notes = coalesce($6, notes),
        status = coalesce($7, status),
        type = coalesce($8, type),
        completed_at = case when $7 = 'done' then coalesce(completed_at, now()) when $7 is not null then null else completed_at end,
        updated_at = now()
      where user_id = $1 and id = $2
      returning ${TASK_COLUMNS}`,
    [
      userId,
      id,
      patch.title?.trim().slice(0, 200) ?? null,
      patch.dueAt === undefined ? null : patch.dueAt && !Number.isNaN(Date.parse(patch.dueAt)) ? new Date(patch.dueAt).toISOString() : "",
      patch.priority ?? null,
      patch.notes?.trim().slice(0, 2000) ?? null,
      patch.status ?? null,
      patch.type ?? null,
    ],
  );
  return rows[0] ? taskFromRow(rows[0]) : null;
}

export async function openTasks(sql: Sql, userId: string): Promise<Task[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${TASK_COLUMNS} from tasks where user_id = $1 and status = 'open' order by due_at nulls last, created_at limit 500`,
    [userId],
  );
  return rows.map(taskFromRow);
}

export async function tasksForLead(sql: Sql, userId: string, leadId: string): Promise<Task[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select ${TASK_COLUMNS} from tasks where user_id = $1 and lead_id = $2 order by (status = 'open') desc, due_at nulls last, created_at desc limit 100`,
    [userId, leadId],
  );
  return rows.map(taskFromRow);
}

/** Close the open tasks of these types for a business — the thing they were for has happened. */
export async function completeOpenTasks(sql: Sql, userId: string, leadId: string, types: readonly TaskType[]): Promise<number> {
  const rows = await sql.query(
    `update tasks set status = 'done', completed_at = now(), updated_at = now()
      where user_id = $1 and lead_id = $2 and status = 'open' and type = any($3::text[])
      returning id`,
    [userId, leadId, [...types]],
  );
  return rows.length;
}

// ── Opportunities ────────────────────────────────────────────────────────────

function opportunityFromRow(row: Record<string, unknown>): Opportunity {
  return {
    leadId: text(row.lead_id),
    stage: text(row.stage) as Stage,
    valuePence: row.value_pence == null ? null : Number(row.value_pence),
    expectedClose: day(row.expected_close),
    quoteDate: day(row.quote_date),
    wonDate: day(row.won_date),
    lostReason: text(row.lost_reason),
    nurtureDate: day(row.nurture_date),
    notes: text(row.notes),
    stageChangedAt: iso(row.stage_changed_at),
    updatedAt: iso(row.updated_at),
  };
}

const OPP_COLUMNS = "lead_id, stage, value_pence, expected_close, quote_date, won_date, lost_reason, nurture_date, notes, stage_changed_at, updated_at";

export async function loadOpportunities(sql: Sql, userId: string): Promise<Map<string, Opportunity>> {
  const rows = await sql.query<Record<string, unknown>>(`select ${OPP_COLUMNS} from opportunities where user_id = $1`, [userId]);
  return new Map(rows.map((row) => { const opportunity = opportunityFromRow(row); return [opportunity.leadId, opportunity]; }));
}

export async function loadOpportunity(sql: Sql, userId: string, leadId: string): Promise<Opportunity | null> {
  const rows = await sql.query<Record<string, unknown>>(`select ${OPP_COLUMNS} from opportunities where user_id = $1 and lead_id = $2`, [userId, leadId]);
  return rows[0] ? opportunityFromRow(rows[0]) : null;
}

const dateOrNull = (value: string | undefined) => (value === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

export type OpportunityPatch = {
  stage?: Stage;
  valuePence?: number | null;
  expectedClose?: string;
  quoteDate?: string;
  wonDate?: string;
  lostReason?: string;
  nurtureDate?: string;
  notes?: string;
};

/**
 * Create or change a business's opportunity. Returns the row and the stage it
 * had before (null when it is new), so the caller can record a stage change.
 */
export async function saveOpportunity(sql: Sql, userId: string, leadId: string, patch: OpportunityPatch): Promise<{ opportunity: Opportunity; previousStage: Stage | null }> {
  if (patch.stage && !(STAGES as readonly string[]).includes(patch.stage)) throw new Error("Unknown stage.");
  const value = patch.valuePence === undefined ? undefined : patch.valuePence === null ? null : Math.max(0, Math.min(2_000_000_000, Math.round(patch.valuePence)));
  const before = await loadOpportunity(sql, userId, leadId);
  const params = [
    userId,
    leadId,
    patch.stage ?? null,
    value === undefined ? null : value,
    value === undefined,
    dateOrNull(patch.expectedClose) ?? null,
    patch.expectedClose === undefined,
    dateOrNull(patch.quoteDate) ?? null,
    patch.quoteDate === undefined,
    dateOrNull(patch.wonDate) ?? null,
    patch.wonDate === undefined,
    patch.lostReason?.trim().slice(0, 300) ?? null,
    dateOrNull(patch.nurtureDate) ?? null,
    patch.nurtureDate === undefined,
    patch.notes?.trim().slice(0, 4000) ?? null,
  ];
  const rows = await sql.query<Record<string, unknown>>(
    `insert into opportunities (user_id, lead_id, stage, value_pence, expected_close, quote_date, won_date, lost_reason, nurture_date, notes)
     values ($1, $2, coalesce($3, 'PROSPECT'), $4, $6::date, $8::date, $10::date, coalesce($12, ''), $13::date, coalesce($15, ''))
     on conflict (user_id, lead_id) do update set
       stage = coalesce($3, opportunities.stage),
       stage_changed_at = case when $3 is not null and $3 <> opportunities.stage then now() else opportunities.stage_changed_at end,
       value_pence = case when $5 then opportunities.value_pence else $4 end,
       expected_close = case when $7 then opportunities.expected_close else $6::date end,
       quote_date = case when $9 then opportunities.quote_date else $8::date end,
       won_date = case when $11 then opportunities.won_date else $10::date end,
       lost_reason = coalesce($12, opportunities.lost_reason),
       nurture_date = case when $14 then opportunities.nurture_date else $13::date end,
       notes = coalesce($15, opportunities.notes),
       updated_at = now()
     returning ${OPP_COLUMNS}`,
    params,
  );
  return { opportunity: opportunityFromRow(rows[0]!), previousStage: before?.stage ?? null };
}

// ── Interactions ─────────────────────────────────────────────────────────────

function interactionFromRow(row: Record<string, unknown>): Interaction {
  return {
    id: text(row.id),
    leadId: text(row.lead_id),
    type: text(row.type) as InteractionType,
    outcome: text(row.outcome),
    summary: text(row.summary),
    detail: json(row.detail),
    occurredAt: iso(row.occurred_at),
  };
}

export async function addInteraction(
  sql: Sql,
  userId: string,
  input: { leadId: string; type: InteractionType; outcome?: string; summary?: string; detail?: Record<string, string>; occurredAt?: string; id?: string },
): Promise<Interaction> {
  const at = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString();
  const rows = await sql.query<Record<string, unknown>>(
    `insert into interactions (user_id, id, lead_id, type, outcome, summary, detail, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     on conflict (user_id, id) do update set summary = excluded.summary
     returning id, lead_id, type, outcome, summary, detail, occurred_at`,
    [userId, input.id || randomUUID(), input.leadId.slice(0, 64), input.type, (input.outcome ?? "").slice(0, 60), (input.summary ?? "").slice(0, 4000), JSON.stringify(input.detail ?? {}), at],
  );
  return interactionFromRow(rows[0]!);
}

export async function interactionsForLead(sql: Sql, userId: string, leadId: string): Promise<Interaction[]> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, lead_id, type, outcome, summary, detail, occurred_at from interactions
      where user_id = $1 and lead_id = $2 order by occurred_at desc limit 300`,
    [userId, leadId],
  );
  return rows.map(interactionFromRow);
}

/** The latest interaction per business, for lists that show "last contact". */
export async function lastInteractions(sql: Sql, userId: string): Promise<Map<string, Interaction>> {
  const rows = await sql.query<Record<string, unknown>>(
    `select distinct on (lead_id) id, lead_id, type, outcome, summary, detail, occurred_at from interactions
      where user_id = $1 order by lead_id, occurred_at desc`,
    [userId],
  );
  return new Map(rows.map((row) => { const item = interactionFromRow(row); return [item.leadId, item]; }));
}
