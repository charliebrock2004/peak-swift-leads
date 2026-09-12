/**
 * Campaigns.
 *
 * A campaign is a named piece of work — "Glasgow Joiners", 100 prospects, 10 a
 * day — not a second outreach pipeline. It chooses what to look for and keeps
 * the score. Discovery, qualification, eligibility, duplicate protection,
 * Gmail and the daily limit are all exactly the code that already runs; a
 * campaign never gets its own path through any of them, and never its own
 * permission to send.
 *
 * Progress is derived from the prospects and emails that exist, never stored as
 * counters. Stored counters are a second copy of the truth, and the day the
 * copy drifts is the day the dashboard reports sends that never happened. The
 * numbers here can only be wrong if the underlying rows are.
 */
import type { Lead } from "../leads.ts";
import { lifecycleOf, type LifecycleStage } from "./lifecycle.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";

export const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

/**
 * Which status changes are allowed.
 *
 * A campaign can be archived from anywhere — tidying up is always permitted —
 * but archived is the end: reopening one is a new campaign, not a resurrected
 * old one, so the history of what was sent under a name stays true.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "COMPLETED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canCampaignTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  if (from === to) return true;
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function campaignTransitionProblem(from: CampaignStatus, to: CampaignStatus): string {
  if (canCampaignTransition(from, to)) return "";
  if (from === "ARCHIVED") return "This campaign is archived. Start a new one instead of reopening it.";
  if (from === "COMPLETED" && to === "ACTIVE") {
    return "This campaign is finished. Start a new one to keep going.";
  }
  return `A ${CAMPAIGN_STATUS_LABELS[from].toLowerCase()} campaign cannot become ${CAMPAIGN_STATUS_LABELS[to].toLowerCase()}.`;
}

/** Only an active campaign may have a run started against it. */
export function campaignCanRun(status: CampaignStatus): boolean {
  return status === "ACTIVE";
}

export type Campaign = {
  id: string;
  name: string;
  status: CampaignStatus;
  /** Comma-separated, exactly as the existing search input takes them. */
  locations: string;
  trades: string;
  targetProspects: number;
  dailyTarget: number;
  batchSize: number;
  /** `prepare` writes drafts and stops. Sending is always the explicit choice. */
  sendMode: "prepare" | "send";
  createdAt: string;
  updatedAt: string;
};

export const CAMPAIGN_TARGET_MAX = 500;
export const CAMPAIGN_NAME_MAX = 60;

/**
 * A new campaign, before anyone has typed anything.
 *
 * `prepare` and DRAFT on purpose: creating a campaign must never be a thing
 * that starts sending, and nothing here is a shortcut past choosing to send.
 */
export function newCampaign(id: string, now: string): Campaign {
  return {
    id,
    name: "",
    status: "DRAFT",
    locations: "",
    trades: "",
    targetProspects: 50,
    dailyTarget: 10,
    batchSize: 5,
    sendMode: "prepare",
    createdAt: now,
    updatedAt: now,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.round(next)));
}

/**
 * Bring anything claiming to be a campaign into range.
 *
 * The daily target and batch size are clamped to the product ceiling here as
 * well as server-side. A campaign is not allowed to be the thing that raises
 * a sending limit: the server clamps again on the way in, and this only stops
 * the UI from offering a number that would be silently reduced.
 */
export function clampCampaign(
  input: Partial<Campaign> & { id: string },
  limits: { dailyMax: number; batchMax: number },
  now: string,
): Campaign {
  const status = CAMPAIGN_STATUSES.includes(input.status as CampaignStatus)
    ? (input.status as CampaignStatus)
    : "DRAFT";
  return {
    id: input.id,
    name: String(input.name ?? "").trim().slice(0, CAMPAIGN_NAME_MAX),
    status,
    locations: String(input.locations ?? "").trim().slice(0, 200),
    trades: String(input.trades ?? "").trim().slice(0, 200),
    targetProspects: clampInt(input.targetProspects, 50, 1, CAMPAIGN_TARGET_MAX),
    dailyTarget: clampInt(input.dailyTarget, 10, 0, limits.dailyMax),
    batchSize: clampInt(input.batchSize, 5, 1, limits.batchMax),
    sendMode: input.sendMode === "send" ? "send" : "prepare",
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

/** Why a campaign cannot be saved, or "" when it can. */
export function campaignProblem(campaign: Campaign): string {
  if (campaign.name.trim().length < 2) return "Give the campaign a name.";
  if (campaign.locations.trim().length < 2) return "Choose at least one location.";
  if (campaign.trades.trim().length < 2) return "Choose at least one trade.";
  return "";
}

/** Why a campaign cannot be started yet, or "" when it can. */
export function campaignStartProblem(campaign: Campaign): string {
  const problem = campaignProblem(campaign);
  if (problem) return problem;
  if (campaign.sendMode === "send" && campaign.dailyTarget === 0) {
    return "The daily target is 0, so nothing could be sent. Raise it, or keep the campaign on drafts only.";
  }
  return "";
}

/** Split a comma list the same way everywhere: trimmed, de-duplicated, in order. */
export function splitList(value: string, max = 8): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of value.split(",")) {
    const item = part.trim();
    if (item.length < 2) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length === max) break;
  }
  return items;
}

export type CampaignProgress = {
  target: number;
  found: number;
  qualified: number;
  emailsFound: number;
  prepared: number;
  sent: number;
  replies: number;
  interested: number;
  booked: number;
  won: number;
  skipped: number;
  call: number;
  /** Prospects found as a share of the target, 0–100, capped at 100. */
  percent: number;
};

const COUNTED_AS_QUALIFIED: readonly LifecycleStage[] = [
  "QUALIFIED",
  "REVIEW",
  "APPROVED",
  "PREPARED",
  "QUEUED",
  "SENT",
  "REPLIED",
  "INTERESTED",
  "BOOKED",
  "WON",
  "NOT_INTERESTED",
];

/**
 * What a campaign has actually achieved.
 *
 * Every number counts rows that exist. Nothing is estimated, projected, or
 * carried over from a stored counter — pass in the campaign's prospects and
 * the emails written for them and the answer is whatever is true right now.
 *
 * The stages are cumulative where it makes sense: a prospect that has been
 * sent an email was necessarily qualified, so it counts in both, and a funnel
 * where a later stage exceeded an earlier one would be nonsense.
 */
export function campaignProgress(
  campaign: Pick<Campaign, "targetProspects">,
  leads: readonly (Lead | OutreachLead)[],
  emails: readonly OutreachEmail[],
  decisions?: ReadonlyMap<string, { level: string; reviewRequired?: boolean }>,
): CampaignProgress {
  const byLead = new Map<string, OutreachEmail[]>();
  for (const email of emails) {
    const list = byLead.get(email.leadId);
    if (list) list.push(email);
    else byLead.set(email.leadId, [email]);
  }

  let qualified = 0;
  let emailsFound = 0;
  let prepared = 0;
  let sent = 0;
  let replies = 0;
  let interested = 0;
  let booked = 0;
  let won = 0;
  let skipped = 0;
  let call = 0;

  for (const lead of leads) {
    const mine = byLead.get(lead.id) ?? [];
    const stage = lifecycleOf(lead, mine, decisions?.get(lead.id));
    if (lead.email.trim()) emailsFound += 1;
    if (COUNTED_AS_QUALIFIED.includes(stage)) qualified += 1;
    if (mine.length > 0) prepared += 1;
    for (const email of mine) {
      if (email.status === "sent" || email.status === "replied" || email.sentAt) {
        sent += 1;
        break;
      }
    }
    if (stage === "REPLIED" || stage === "INTERESTED" || stage === "BOOKED" || stage === "WON") {
      replies += 1;
    }
    if (stage === "INTERESTED") interested += 1;
    if (stage === "BOOKED") booked += 1;
    if (stage === "WON") won += 1;
    if (stage === "SKIPPED") skipped += 1;
    if (stage === "CALL") call += 1;
  }

  const target = Math.max(1, campaign.targetProspects);
  return {
    target: campaign.targetProspects,
    found: leads.length,
    qualified,
    emailsFound,
    prepared,
    sent,
    replies,
    interested,
    booked,
    won,
    skipped,
    call,
    percent: Math.min(100, Math.round((leads.length / target) * 100)),
  };
}

/**
 * Has this campaign done what it set out to do?
 *
 * Reaching the prospect target is not completion — finding 100 businesses and
 * emailing none of them is a campaign that has not started. It is complete when
 * every prospect it holds has reached a stage outreach cannot move on from.
 */
export function campaignLooksComplete(progress: CampaignProgress): boolean {
  if (progress.found === 0) return false;
  if (progress.found < progress.target) return false;
  return progress.sent + progress.skipped + progress.call >= progress.found;
}

/** The one-line summary shown in the campaign list. */
export function campaignSummary(progress: CampaignProgress): string {
  return (
    `${progress.found} / ${progress.target} prospects · ${progress.sent} sent · ` +
    `${progress.replies} ${progress.replies === 1 ? "reply" : "replies"}`
  );
}
