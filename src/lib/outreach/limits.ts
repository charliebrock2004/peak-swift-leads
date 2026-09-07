/**
 * Sending controls.
 *
 * The daily count is *derived* from what was actually sent, never stored as a
 * counter. A counter can drift — a crash mid-batch, two tabs, a retry — and a
 * drifted counter either blocks a day's work or quietly sends double. Counting
 * rows with a `sent_at` in today cannot be wrong.
 *
 * The day boundary is UTC. Britain is within an hour of that all year, and a
 * fixed boundary is far easier to reason about than one that moves with the
 * clocks halfway through a send.
 */
import type { OutreachEmail, OutreachSettings } from "./types.ts";
import { DELIVERED_STATUSES } from "./types.ts";

/** `YYYY-MM-DD` in UTC. The key a day's sending is counted against. */
export function dayKey(when: Date | string): string {
  const date = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

const delivered = new Set<string>(DELIVERED_STATUSES);

/** How many actually went out today. */
export function sentToday(emails: readonly OutreachEmail[], now: Date = new Date()): number {
  const today = dayKey(now);
  return emails.filter((email) => delivered.has(email.status) && email.sentAt && dayKey(email.sentAt) === today)
    .length;
}

export type Allowance = {
  sent: number;
  limit: number;
  /** How many more may go out today. Never negative. */
  remaining: number;
  /** How many of those may go out in this batch. */
  batch: number;
  atLimit: boolean;
};

export function allowance(
  emails: readonly OutreachEmail[],
  settings: OutreachSettings,
  now: Date = new Date(),
): Allowance {
  const sent = sentToday(emails, now);
  const limit = Math.max(0, Math.floor(settings.dailyLimit));
  const remaining = Math.max(0, limit - sent);
  const batch = Math.min(remaining, Math.max(1, Math.floor(settings.batchSize)));
  return { sent, limit, remaining, batch: remaining === 0 ? 0 : batch, atLimit: remaining === 0 };
}

/**
 * The emails to hand to Gmail on this pass, oldest approval first.
 *
 * Bounded twice — by the batch size and by what is left of the daily limit — so
 * the limit holds even if a batch is triggered repeatedly.
 */
export function nextBatch(
  emails: readonly OutreachEmail[],
  settings: OutreachSettings,
  now: Date = new Date(),
): OutreachEmail[] {
  const room = allowance(emails, settings, now);
  if (room.batch === 0) return [];
  return emails
    .filter((email) => email.status === "queued")
    .sort((a, b) => (a.approvedAt || a.createdAt).localeCompare(b.approvedAt || b.createdAt))
    .slice(0, room.batch);
}

/** "12 / 30" — the counter the dashboard shows. */
export function describeAllowance(room: Allowance): string {
  return `${room.sent} / ${room.limit}`;
}

/** Settings a person typed, clamped to something that cannot do harm. */
export function sanitizeSettings(input: Partial<OutreachSettings>, current: OutreachSettings): OutreachSettings {
  const int = (value: unknown, fallback: number, min: number, max: number) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, Math.round(next)));
  };
  return {
    // 30/day and 5/batch are the product ceiling, not just the default. A
    // typo in the settings form must not become a hundred cold emails.
    dailyLimit: int(input.dailyLimit, current.dailyLimit, 0, 30),
    batchSize: int(input.batchSize, current.batchSize, 1, 5),
    delaySeconds: int(input.delaySeconds, current.delaySeconds, 5, 600),
    followUpsOn: typeof input.followUpsOn === "boolean" ? input.followUpsOn : current.followUpsOn,
    followUp1Days: int(input.followUp1Days, current.followUp1Days, 1, 60),
    followUp2Days: int(input.followUp2Days, current.followUp2Days, 1, 90),
    maxFollowUps: int(input.maxFollowUps, current.maxFollowUps, 0, 2),
    // Nothing in the app actually auto-sends. Forcing this off means a stored
    // true, or a client that posts true, cannot become a scheduler later.
    autoSend: false,
    includeLow: typeof input.includeLow === "boolean" ? input.includeLow : current.includeLow,
    defaultMode: typeof input.defaultMode === "string" && input.defaultMode.trim() ? input.defaultMode.trim().slice(0, 60) : current.defaultMode,
  };
}
