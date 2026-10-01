/**
 * How much money PeakSwift helped create, and what it cost in your time.
 *
 * Every number is counted from rows that exist: businesses found, emails
 * Gmail accepted, calls you logged, stages a sale reached, values you put on
 * them, and minutes measured while you used the app or were on a call. Nothing
 * is estimated, weighted, projected or annualised.
 *
 * The same honesty rule as the rest of Insights: a rate or an average from a
 * handful of cases is noise dressed as a number, so below its minimum a figure
 * is withheld (null) and the counts are shown instead.
 *
 * Pure: the server function loads the rows and hands them here.
 */
import type { Lead } from "../leads.ts";
import { RATE_MIN_SENT, rateOf, type Rate } from "../outreach/analytics.ts";
import type { OutreachEmail } from "../outreach/types.ts";
import { derivedStage, effectiveStage, pipelineTotals } from "./pipeline.ts";
import { OPEN_STAGES, type Opportunity, type Stage } from "./types.ts";

export const FUNNEL = ["FOUND", "CONTACTABLE", "CONTACTED", "CONVERSATION", "MEETING", "QUOTE", "WON"] as const;
export type FunnelStep = (typeof FUNNEL)[number];
export const FUNNEL_LABEL: Record<FunnelStep, string> = {
  FOUND: "Found",
  CONTACTABLE: "Contactable",
  CONTACTED: "Contacted",
  CONVERSATION: "Conversation",
  MEETING: "Meeting",
  QUOTE: "Quote",
  WON: "Won",
};

/** A typical gap between two steps needs this many businesses that made it. */
export const TIMING_MIN = 5;
/** Per-conversation costs need this many conversations. */
export const PER_CONVERSATION_MIN = 3;
/** Per-customer costs, and £ per hour, need this many customers. */
export const PER_CUSTOMER_MIN = 2;
/** £ per hour needs at least this much measured time. */
export const HOURLY_MIN_HOURS = 2;

export type RevenueInteraction = { leadId: string; type: string; outcome: string; occurredAt: string };
export type TimeEntry = { day: string; kind: "app" | "call"; seconds: number };

export type RevenueInput = {
  now: Date;
  leads: readonly Lead[];
  /** Whether each business can be reached at all (the unified score's reach). */
  reachable: (lead: Lead) => boolean;
  emails: readonly OutreachEmail[];
  opportunities: ReadonlyMap<string, Opportunity>;
  /** Calls, stage changes, quotes and meetings — the sale's own history. */
  interactions: readonly RevenueInteraction[];
  time: readonly TimeEntry[];
};

type Channel = "email" | "call" | "";

/** How far one business got, and when it first reached each step ("" when the time is not known). */
export type Journey = {
  leadId: string;
  reached: number;
  at: Partial<Record<FunnelStep, string>>;
  /** How the first conversation started. */
  channel: Channel;
  emailed: boolean;
  called: boolean;
  stage: Stage;
  valuePence: number | null;
};

const SENT = new Set(["sent", "replied", "bounced"]);
const NOT_A_PERSON = new Set(["unsubscribe", "ooo", "bounce"]);

function isReal(email: OutreachEmail): boolean {
  return email.kind !== ("test" as OutreachEmail["kind"]) && email.status !== "test_sent";
}

/** A person wrote back — the pipeline's own definition of a conversation by email. */
export function personReplied(email: OutreachEmail): boolean {
  if (email.status !== "replied" && !email.repliedAt) return false;
  if (email.replyKind === "auto_reply" || email.replyKind === "bounce" || email.replyKind === "unsubscribe") return false;
  return !NOT_A_PERSON.has(email.replyIntent ?? "");
}

function earliest(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => Boolean(value && !Number.isNaN(Date.parse(value)))).sort()[0] ?? "";
}

const STAGE_STEP: Partial<Record<Stage, FunnelStep>> = {
  CONTACTED: "CONTACTED",
  CONVERSATION: "CONVERSATION",
  MEETING: "MEETING",
  QUOTE_SENT: "QUOTE",
  WON: "WON",
};

/**
 * One business's way through the funnel, from its evidence: emails sent and
 * replied to, calls logged, and the stages a person moved it through. Reaching
 * a step means reaching every step before it — a won customer was contacted.
 */
export function journeyOf(
  lead: Lead,
  emails: readonly OutreachEmail[],
  opportunity: Opportunity | null,
  history: readonly RevenueInteraction[],
  reachable: boolean,
): Journey {
  const sent = emails.filter((email) => SENT.has(email.status));
  const calls = history.filter((item) => item.type === "call");
  const stageAt = (step: FunnelStep) =>
    earliest(...history.filter((item) => (item.type === "stage_change" || item.type === "quote") && STAGE_STEP[item.outcome as Stage] === step).map((item) => item.occurredAt));

  const emailed = sent.length > 0 || Boolean(lead.lastEmailedAt.trim());
  const called = calls.length > 0 || (lead.called.trim() !== "" && lead.called !== "Not Called");
  const firstEmail = earliest(...sent.map((email) => email.sentAt), lead.lastEmailedAt);
  const firstCall = earliest(...calls.map((item) => item.occurredAt));

  const replyAt = earliest(...emails.filter(personReplied).map((email) => email.repliedAt));
  const spokeAt = earliest(...calls.filter((item) => item.outcome === "interested" || item.outcome === "meeting_booked").map((item) => item.occurredAt));
  const talked = Boolean(replyAt || spokeAt) || ["Interested", "Booked", "Won"].includes(lead.callResult) || lead.called === "Interested";
  const channel: Channel = replyAt && (!spokeAt || replyAt <= spokeAt) ? "email" : spokeAt ? "call" : lead.callResult === "Interested" || lead.callResult === "Booked" ? "call" : "";

  const bookedAt = earliest(
    ...calls.filter((item) => item.outcome === "meeting_booked").map((item) => item.occurredAt),
    ...emails.filter((email) => email.replyStage === "booked").map((email) => email.repliedAt),
    stageAt("MEETING"),
  );
  const booked = Boolean(bookedAt) || lead.callResult === "Booked" || emails.some((email) => email.replyStage === "booked");
  const quotedAt = earliest(stageAt("QUOTE"), opportunity?.quoteDate);
  const derived = derivedStage(lead, emails);
  const stage = effectiveStage(opportunity, derived.stage);
  const wonAt = earliest(opportunity?.wonDate, stageAt("WON"));
  const won = stage === "WON";

  const at: Journey["at"] = {
    FOUND: lead.foundAt || "",
    CONTACTED: earliest(firstEmail, firstCall, stageAt("CONTACTED")),
    CONVERSATION: earliest(replyAt, spokeAt, stageAt("CONVERSATION")),
    MEETING: bookedAt,
    QUOTE: quotedAt,
    WON: won ? wonAt : "",
  };

  // The furthest step the evidence shows, including the stage the pipeline holds.
  const evidence: Record<FunnelStep, boolean> = {
    FOUND: true,
    CONTACTABLE: reachable,
    CONTACTED: emailed || called || Boolean(at.CONTACTED),
    CONVERSATION: talked || Boolean(at.CONVERSATION),
    MEETING: booked,
    QUOTE: Boolean(quotedAt),
    WON: won,
  };
  const fromStage = STAGE_STEP[stage];
  let reached = fromStage ? FUNNEL.indexOf(fromStage) : 0;
  FUNNEL.forEach((step, index) => {
    if (evidence[step]) reached = Math.max(reached, index);
  });
  for (const step of FUNNEL.slice(reached + 1)) delete at[step];
  return { leadId: lead.id, reached, at, channel: reached >= FUNNEL.indexOf("CONVERSATION") ? channel : "", emailed, called, stage, valuePence: opportunity?.valuePence ?? null };
}

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type Timing = { from: FunnelStep; to: FunnelStep; label: string; medianDays: number | null; sample: number };

const TIMINGS: [FunnelStep, FunnelStep, string][] = [
  ["FOUND", "CONTACTED", "Found → first contact"],
  ["CONTACTED", "CONVERSATION", "First contact → conversation"],
  ["CONVERSATION", "QUOTE", "Conversation → quote"],
  ["QUOTE", "WON", "Quote → won"],
  ["CONTACTED", "WON", "First contact → won"],
];

function timings(journeys: readonly Journey[]): Timing[] {
  return TIMINGS.map(([from, to, label]) => {
    const gaps = journeys.flatMap((journey) => {
      const start = journey.at[from];
      const end = journey.at[to];
      if (!start || !end) return [];
      return [Math.max(0, (Date.parse(end) - Date.parse(start)) / DAY_MS)];
    });
    return { from, to, label, medianDays: gaps.length >= TIMING_MIN ? median(gaps) : null, sample: gaps.length };
  });
}

export type Segment = {
  name: string;
  found: number;
  contacted: number;
  conversations: number;
  won: number;
  wonPence: number;
  /** Conversations ÷ contacted, withheld below the minimum. */
  conversationRate: Rate;
};

function segments(leads: readonly Lead[], journeys: ReadonlyMap<string, Journey>, field: (lead: Lead) => string): Segment[] {
  const byName = new Map<string, Omit<Segment, "conversationRate">>();
  for (const lead of leads) {
    const name = field(lead).trim();
    const journey = journeys.get(lead.id);
    if (!name || !journey) continue;
    const segment = byName.get(name) ?? { name, found: 0, contacted: 0, conversations: 0, won: 0, wonPence: 0 };
    segment.found += 1;
    if (journey.reached >= FUNNEL.indexOf("CONTACTED")) segment.contacted += 1;
    if (journey.reached >= FUNNEL.indexOf("CONVERSATION")) segment.conversations += 1;
    if (journey.stage === "WON") {
      segment.won += 1;
      segment.wonPence += journey.valuePence ?? 0;
    }
    byName.set(name, segment);
  }
  return [...byName.values()]
    .map((segment) => ({ ...segment, conversationRate: rateOf(segment.conversations, segment.contacted, RATE_MIN_SENT) }))
    .sort((a, b) => b.wonPence - a.wonPence || b.won - a.won || b.conversations - a.conversations || b.contacted - a.contacted || a.name.localeCompare(b.name));
}

export type AngleRow = { angle: string; sent: number; replies: number; positive: number; replyRate: Rate };

function byAngle(emails: readonly OutreachEmail[]): AngleRow[] {
  const rows = new Map<string, Omit<AngleRow, "replyRate">>();
  for (const email of emails) {
    if (email.kind !== "initial" || !SENT.has(email.status) || !email.angle) continue;
    const row = rows.get(email.angle) ?? { angle: email.angle, sent: 0, replies: 0, positive: 0 };
    row.sent += 1;
    if (personReplied(email)) row.replies += 1;
    if (email.replyIntent === "positive" || email.replyStage === "interested" || email.replyStage === "booked" || email.replyStage === "won") row.positive += 1;
    rows.set(email.angle, row);
  }
  return [...rows.values()].map((row) => ({ ...row, replyRate: rateOf(row.replies, row.sent, RATE_MIN_SENT) })).sort((a, b) => b.replies - a.replies || b.sent - a.sent);
}

export type ChannelRow = {
  channel: "email" | "call";
  /** Businesses contacted this way. */
  contacted: number;
  /** Emails sent, or calls logged. */
  touches: number;
  conversations: number;
  won: number;
  conversationRate: Rate;
  /** Emails (or calls) per conversation, withheld below the minimum. */
  touchesPerConversation: number | null;
};

export type North = {
  /** First day time was measured, YYYY-MM-DD; "" before any. */
  since: string;
  appSeconds: number;
  callSeconds: number;
  /** Conversations, customers and £ won since measuring began — the same window as the minutes. */
  conversations: number;
  customers: number;
  wonPence: number;
  minutesPerConversation: number | null;
  minutesPerCustomer: number | null;
  poundsPerHour: number | null;
};

export type Revenue = {
  funnel: { step: FunnelStep; label: string; count: number; fromPrevious: Rate | null }[];
  money: {
    openPence: number;
    openCount: number;
    /** Open deals past first contact with no value on them yet. */
    unvalued: number;
    quotedPence: number;
    wonPence: number;
    wonCount: number;
    wonThisMonthPence: number;
    /** Average won deal, withheld below PER_CUSTOMER_MIN. */
    averageWonPence: number | null;
  };
  timings: Timing[];
  effort: { emailsSent: number; callsMade: number };
  north: North;
  channels: ChannelRow[];
  trades: Segment[];
  towns: Segment[];
  angles: AngleRow[];
};

export function revenueAnalytics(input: RevenueInput): Revenue {
  const live = input.leads.filter((lead) => !lead.deletedAt);
  const emailsByLead = new Map<string, OutreachEmail[]>();
  for (const email of input.emails) if (isReal(email)) emailsByLead.set(email.leadId, [...(emailsByLead.get(email.leadId) ?? []), email]);
  const historyByLead = new Map<string, RevenueInteraction[]>();
  for (const item of input.interactions) historyByLead.set(item.leadId, [...(historyByLead.get(item.leadId) ?? []), item]);

  const journeys = new Map<string, Journey>();
  for (const lead of live) {
    journeys.set(lead.id, journeyOf(lead, emailsByLead.get(lead.id) ?? [], input.opportunities.get(lead.id) ?? null, historyByLead.get(lead.id) ?? [], input.reachable(lead)));
  }
  const all = [...journeys.values()];

  const counts = FUNNEL.map((_, index) => all.filter((journey) => journey.reached >= index).length);
  const funnel = FUNNEL.map((step, index) => ({
    step,
    label: FUNNEL_LABEL[step],
    count: counts[index]!,
    fromPrevious: index === 0 ? null : rateOf(counts[index]!, counts[index - 1]!, RATE_MIN_SENT),
  }));

  const totals = pipelineTotals(
    all.filter((journey) => journey.stage !== "PROSPECT" || input.opportunities.has(journey.leadId)).map((journey) => {
      const opportunity = input.opportunities.get(journey.leadId);
      return { stage: journey.stage, valuePence: journey.valuePence, wonDate: opportunity?.wonDate, stageChangedAt: opportunity?.stageChangedAt };
    }),
    input.now,
  );
  const won = all.filter((journey) => journey.stage === "WON");
  const valuedWins = won.filter((journey) => journey.valuePence !== null);
  const pastContact = new Set<Stage>(OPEN_STAGES.filter((stage) => stage !== "PROSPECT" && stage !== "CONTACTED"));

  const real = input.emails.filter(isReal);
  const emailsSent = real.filter((email) => SENT.has(email.status)).length;
  const callsMade = input.interactions.filter((item) => item.type === "call").length;

  // ── Minutes ─────────────────────────────────────────────────────────────
  const since = input.time.filter((entry) => entry.seconds > 0).map((entry) => entry.day).sort()[0] ?? "";
  const appSeconds = input.time.filter((entry) => entry.kind === "app").reduce((sum, entry) => sum + entry.seconds, 0);
  const callSeconds = input.time.filter((entry) => entry.kind === "call").reduce((sum, entry) => sum + entry.seconds, 0);
  const minutes = (appSeconds + callSeconds) / 60;
  const inWindow = (at: string | undefined) => Boolean(since && at && at.slice(0, 10) >= since);
  const conversationsSince = all.filter((journey) => inWindow(journey.at.CONVERSATION)).length;
  const customersSince = won.filter((journey) => inWindow(journey.at.WON));
  const wonSincePence = customersSince.reduce((sum, journey) => sum + (journey.valuePence ?? 0), 0);
  const north: North = {
    since,
    appSeconds,
    callSeconds,
    conversations: conversationsSince,
    customers: customersSince.length,
    wonPence: wonSincePence,
    minutesPerConversation: conversationsSince >= PER_CONVERSATION_MIN ? minutes / conversationsSince : null,
    minutesPerCustomer: customersSince.length >= PER_CUSTOMER_MIN ? minutes / customersSince.length : null,
    poundsPerHour: customersSince.length >= PER_CUSTOMER_MIN && minutes / 60 >= HOURLY_MIN_HOURS ? wonSincePence / 100 / (minutes / 60) : null,
  };

  // ── Channels ────────────────────────────────────────────────────────────
  const channel = (which: "email" | "call"): ChannelRow => {
    const contacted = all.filter((journey) => (which === "email" ? journey.emailed : journey.called)).length;
    const conversations = all.filter((journey) => journey.channel === which).length;
    const touches = which === "email" ? emailsSent : callsMade;
    return {
      channel: which,
      contacted,
      touches,
      conversations,
      won: won.filter((journey) => journey.channel === which).length,
      conversationRate: rateOf(conversations, contacted, RATE_MIN_SENT),
      touchesPerConversation: conversations >= PER_CONVERSATION_MIN ? touches / conversations : null,
    };
  };

  return {
    funnel,
    money: {
      openPence: totals.openPence,
      openCount: totals.openCount,
      unvalued: all.filter((journey) => pastContact.has(journey.stage) && journey.valuePence === null).length,
      quotedPence: totals.quotedPence,
      wonPence: totals.wonPence,
      wonCount: won.length,
      wonThisMonthPence: totals.wonThisMonthPence,
      averageWonPence: valuedWins.length >= PER_CUSTOMER_MIN ? Math.round(valuedWins.reduce((sum, journey) => sum + (journey.valuePence ?? 0), 0) / valuedWins.length) : null,
    },
    timings: timings(all),
    effort: { emailsSent, callsMade },
    north,
    channels: [channel("email"), channel("call")],
    trades: segments(live, journeys, (lead) => lead.trade),
    towns: segments(live, journeys, (lead) => lead.town),
    angles: byAngle(real),
  };
}

/**
 * One plain sentence about which trade and town are working, or "" when no
 * segment has enough contacted businesses for its rate to mean anything.
 * Judged on conversations and money, not replies alone.
 */
export function whatWorksLine(trades: readonly Segment[], towns: readonly Segment[]): string {
  const best = (rows: readonly Segment[]) =>
    rows
      .filter((row) => row.conversationRate.value !== null && row.conversations > 0)
      .sort((a, b) => b.wonPence - a.wonPence || b.conversationRate.value! - a.conversationRate.value! || b.conversations - a.conversations)[0];
  const describe = (row: Segment) =>
    `${row.name} — ${row.conversations} ${row.conversations === 1 ? "conversation" : "conversations"} from ${row.contacted} contacted${row.wonPence ? `, ${formatPounds(row.wonPence)} won` : ""}`;
  const trade = best(trades);
  const town = best(towns);
  return [trade ? `Best trade so far: ${describe(trade)}.` : "", town ? `Best town: ${describe(town)}.` : ""].filter(Boolean).join(" ");
}

function formatPounds(pence: number): string {
  return `£${Math.round(pence / 100).toLocaleString("en-GB")}`;
}

/** "1h 25m", "12m", "45s" — measured time, plainly. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const mins = Math.round((total % 3600) / 60);
  if (!hours) return `${mins}m`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/** "3 days", "under a day" — a median gap in words. */
export function formatDays(days: number): string {
  if (days < 1) return "under a day";
  const whole = Math.round(days);
  return `${whole} ${whole === 1 ? "day" : "days"}`;
}
