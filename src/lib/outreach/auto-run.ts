/**
 * AI Outreach — the run, as data.
 *
 * A run is SEARCH → QUALIFY → PERSONALISE → SEND → RECORD, and every one of
 * those steps is an existing server function. Nothing new sends an email,
 * decides who may be emailed, or writes to the database: this module only
 * decides *what to attempt next* and *what to show*, so the orchestration can be
 * unit-tested without a network, a database or a Gmail account.
 *
 * The important function here is `planTargets`. It is the one place the
 * automation chooses leads, and it chooses them by asking `checkEligibility` —
 * the same gate the manual workflow uses — and then taking only the leads that
 * came back `eligible: true`. A lead held for manual review is `eligible:
 * false`, so automation can never pick one up; it stays in the Prospects tab
 * for you to look at, which is the whole point of the hold.
 *
 * The server checks all of this again anyway, twice. This is the client being
 * honest, not the client being trusted.
 */
import type { Lead } from "../leads.ts";
import {
  checkEligibility,
  isWorthRinging,
  REASON_LABELS,
  type EligibilityContext,
} from "./eligibility.ts";
import type { OutreachEmail, OutreachLead, OutreachSettings } from "./types.ts";

/** Where a run has got to. `stopped` is you pressing Stop; `failed` is a fault. */
export const AUTO_PHASES = [
  "idle",
  "searching",
  "qualifying",
  "personalising",
  "sending",
  "replies",
  "done",
  "stopped",
  "failed",
] as const;
export type AutoPhase = (typeof AUTO_PHASES)[number];

export const PHASE_LABELS: Record<AutoPhase, string> = {
  idle: "Ready",
  searching: "Searching for businesses",
  qualifying: "Checking websites and finding emails",
  personalising: "Writing personalised emails",
  sending: "Sending",
  replies: "Checking for replies",
  done: "Finished",
  stopped: "Stopped",
  failed: "Stopped — something went wrong",
};

/** The four things you choose, plus the two the search already understood. */
export type AutoRunConfig = {
  location: string;
  businessType: string;
  /** How many businesses to look for. */
  target: number;
  /** Emails per day. Clamped to the product ceiling, same as Settings. */
  dailyLimit: number;
  radiusMiles: number;
  /**
   * `prepare` runs everything except the send, leaving drafts in Review. It is
   * the dry run — the same pipeline, with the last step withheld.
   */
  mode: "send" | "prepare";
};

/**
 * The product ceiling, repeated from `limits.ts` because this module must not
 * offer a number the server would clamp anyway. 30/day and 5/batch are the
 * ceiling, not the default.
 */
export const AUTO_DAILY_MAX = 30;
/** More than this in one run is a research session, not outreach. */
export const AUTO_TARGET_MAX = 50;

export const DEFAULT_AUTO_CONFIG: AutoRunConfig = {
  location: "Crieff",
  businessType: "Joiner",
  target: 20,
  dailyLimit: 10,
  radiusMiles: 25,
  mode: "send",
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.round(next)));
}

/** What a person typed, reduced to something that cannot ask for harm. */
export function clampAutoConfig(input: Partial<AutoRunConfig>): AutoRunConfig {
  return {
    location: String(input.location ?? "").trim().slice(0, 80),
    businessType: String(input.businessType ?? "").trim().slice(0, 80),
    target: clampInt(input.target, DEFAULT_AUTO_CONFIG.target, 1, AUTO_TARGET_MAX),
    dailyLimit: clampInt(input.dailyLimit, DEFAULT_AUTO_CONFIG.dailyLimit, 0, AUTO_DAILY_MAX),
    radiusMiles: clampInt(input.radiusMiles, DEFAULT_AUTO_CONFIG.radiusMiles, 5, 80),
    mode: input.mode === "prepare" ? "prepare" : "send",
  };
}

/** Why a run cannot start. Null means it can. */
export function configProblem(config: AutoRunConfig): string | null {
  if (config.location.length < 2) return "Choose a town or area.";
  if (config.businessType.length < 2) return "Choose a business type.";
  if (config.mode === "send" && config.dailyLimit === 0) {
    return "The daily limit is 0, so nothing could be sent. Raise it, or choose Prepare only.";
  }
  return null;
}

/** The status view: seven numbers, each one a thing that actually happened. */
export type AutoCounters = {
  found: number;
  qualified: number;
  prepared: number;
  sent: number;
  replies: number;
  skipped: number;
  errors: number;
};

export function emptyCounters(): AutoCounters {
  return { found: 0, qualified: 0, prepared: 0, sent: 0, replies: 0, skipped: 0, errors: 0 };
}

/**
 * One lead the run declined to contact, and every reason why.
 *
 * All of them, not just the first: a business with no website usually fails
 * two rules at once ("No public email found" and "Low opportunity"), and
 * showing one of those sends you looking in the wrong place.
 */
export type AutoSkip = { businessName: string; reasons: string[] };

export type AutoTone = "info" | "good" | "warn" | "bad";
export type AutoEvent = { at: string; text: string; tone: AutoTone };

export type AutoRunState = {
  phase: AutoPhase;
  config: AutoRunConfig;
  counters: AutoCounters;
  skips: AutoSkip[];
  /** Good prospects with no public address — the call list, not a failure list. */
  ringing: RingingLead[];
  log: AutoEvent[];
  /** What is happening right now, for the line under the phase. */
  detail: string;
  startedAt: string;
  finishedAt: string;
};

export function initialRunState(config: AutoRunConfig): AutoRunState {
  return {
    phase: "idle",
    config,
    counters: emptyCounters(),
    skips: [],
    ringing: [],
    log: [],
    detail: "",
    startedAt: "",
    finishedAt: "",
  };
}

/** Newest last, bounded — a long run must not grow the page without limit. */
export const LOG_LIMIT = 200;

export function appendLog(log: readonly AutoEvent[], text: string, tone: AutoTone = "info"): AutoEvent[] {
  const next = [...log, { at: new Date().toISOString(), text, tone }];
  return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
}

/** Skips are shown as a list, so the same bound applies. */
export const SKIP_LIMIT = 200;

export function appendSkips(current: readonly AutoSkip[], added: readonly AutoSkip[]): AutoSkip[] {
  const next = [...current, ...added];
  return next.length > SKIP_LIMIT ? next.slice(next.length - SKIP_LIMIT) : next;
}

export function isFinished(phase: AutoPhase): boolean {
  return phase === "done" || phase === "stopped" || phase === "failed";
}

export function isRunning(phase: AutoPhase): boolean {
  return phase !== "idle" && !isFinished(phase);
}

/**
 * Build the eligibility context from what the server sent.
 *
 * Same construction the manual Prospects tab uses: a lead counts as contacted
 * once a live email of this kind exists for it, by lead id *or* by address, so
 * two rows for the same business cannot both be written to.
 */
export function autoContext(
  emails: readonly OutreachEmail[],
  suppressed: readonly string[],
  settings: Pick<OutreachSettings, "includeLow">,
): EligibilityContext {
  const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
  const alreadyContacted = new Set<string>();
  const contactedAddresses = new Set<string>();
  for (const email of emails) {
    if (email.kind !== "initial" || !live.has(email.status)) continue;
    alreadyContacted.add(email.leadId);
    if (email.recipient) contactedAddresses.add(email.recipient.toLowerCase());
  }
  return {
    settings: { includeLow: settings.includeLow },
    suppressed: new Set(suppressed.map((entry) => entry.trim().toLowerCase())),
    alreadyContacted,
    contactedAddresses,
  };
}

/**
 * A business worth ringing: a real opportunity that simply cannot be emailed.
 *
 * Everything a phone call needs, carried over from the lead as it stands. The
 * lead itself is untouched and still in the sheet — this is a view of it, not a
 * copy, so it can never drift from the row it came from.
 */
export type RingingLead = {
  id: string;
  businessName: string;
  phone: string;
  town: string;
  websiteStatus: string;
  score: number;
  band: "High" | "Medium" | "Low";
  /** Why it could not be emailed, in the words the screen shows. */
  reason: string;
};

/** The sentence shown against every worth-ringing business. */
export const RINGING_REASON = "Good prospect, but no public email found — call this business instead.";

export type TargetPlan = {
  /** Lead ids to write to, best opportunity first, never more than `room`. */
  leadIds: string[];
  /** Everything considered and declined, with the reason. */
  skipped: AutoSkip[];
  /** Leads that were eligible but did not fit in today's remaining allowance. */
  heldForTomorrow: number;
  /** Good prospects that cannot be emailed, best opportunity first. */
  ringing: RingingLead[];
};

/**
 * Choose who this run writes to.
 *
 * Only leads the shared gate returned `eligible: true` for, ranked highest
 * opportunity first, capped at what is left of the daily limit. A lead held for
 * manual review appears in `skipped` with its reason, never in `leadIds`.
 */
export function planTargets(
  leads: readonly OutreachLead[],
  context: EligibilityContext,
  room: number,
  /** Only consider these leads, when a run wants to stay within what it found. */
  onlyIds?: ReadonlySet<string>,
): TargetPlan {
  const rank = { High: 0, Medium: 1, Low: 2 };
  const eligible: { lead: OutreachLead; band: "High" | "Medium" | "Low"; score: number }[] = [];
  const skipped: AutoSkip[] = [];
  const ringing: RingingLead[] = [];

  for (const lead of leads) {
    if (onlyIds && !onlyIds.has(lead.id)) continue;
    const verdict = checkEligibility(lead, context, "initial");
    if (verdict.eligible) {
      eligible.push({ lead, band: verdict.band, score: verdict.score });
      continue;
    }
    const reasons = verdict.reasons.map((reason) => REASON_LABELS[reason] ?? reason);
    // `checkEligibility` stops at the first set of reasons, so a sole trader who
    // also has no address reports only the missing address — and then does not
    // appear on the call list either, with nothing on screen saying why. The
    // hold is a fact about the lead, so report it alongside. The rule itself is
    // unchanged: this is what is shown, not what is decided.
    if (verdict.manualReview && !verdict.reasons.includes("manual-review")) {
      reasons.push(REASON_LABELS["manual-review"]);
    }
    skipped.push({
      businessName: lead.businessName || "Unnamed business",
      reasons: reasons.length > 0 ? reasons : ["Not eligible"],
    });
    // Refused, but only because there is nowhere to write to. Still a prospect.
    if (isWorthRinging(lead, verdict)) {
      ringing.push({
        id: lead.id,
        businessName: lead.businessName || "Unnamed business",
        phone: lead.phone,
        town: lead.town,
        websiteStatus: lead.websiteStatus || "Website unknown",
        score: verdict.score,
        band: verdict.band,
        reason: RINGING_REASON,
      });
    }
  }

  ringing.sort((a, b) => (rank[a.band] - rank[b.band]) || (b.score - a.score));

  eligible.sort((a, b) => {
    const byBand = rank[a.band] - rank[b.band];
    return byBand !== 0 ? byBand : b.score - a.score;
  });

  const allowed = Math.max(0, Math.floor(room));
  return {
    leadIds: eligible.slice(0, allowed).map((entry) => entry.lead.id),
    skipped,
    heldForTomorrow: Math.max(0, eligible.length - allowed),
    ringing,
  };
}

/**
 * How long to wait between send batches.
 *
 * The stored `delaySeconds` is the throttle the manual queue already respects;
 * automation must not be gentler with someone else's inbox than a person is.
 */
export function batchDelayMs(settings: Pick<OutreachSettings, "delaySeconds">): number {
  const seconds = Number(settings.delaySeconds);
  if (!Number.isFinite(seconds)) return 45_000;
  return Math.min(600, Math.max(5, Math.round(seconds))) * 1000;
}

/**
 * The skip list, folded into "6 × No public email found".
 *
 * A run that skips everything skips it for two or three shared reasons, and a
 * flat list of forty business names hides that completely. Counted and ordered,
 * the cause of a disappointing run is the first line you read.
 */
export function groupSkips(skips: readonly AutoSkip[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const skip of skips) {
    for (const reason of skip.reasons.length > 0 ? skip.reasons : ["Not eligible"]) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
}

/** The reason that explains most of a run's skips, or "" if there were none. */
export function dominantSkip(skips: readonly AutoSkip[]): string {
  return groupSkips(skips)[0]?.reason ?? "";
}

/**
 * What a skip reason actually means for what to do next.
 *
 * Written for the case that prompted them. "No public email found" is not a
 * fault to fix — it is what happens when a business has no website to publish
 * an address on, which is the very thing that made them a good prospect.
 */
export const SKIP_ADVICE: Record<string, string> = {
  "No public email found":
    "These businesses have no website with a contact address on it. Peak Swift never guesses an address, so they cannot be emailed — but they are on your sheet, with phone numbers, to ring instead.",
  "Low opportunity":
    "Their listing did not show enough of a website problem to be worth writing about. Turn on “Include low opportunity” in Settings if you want them offered anyway.",
  "Email confidence too low":
    "An address was seen but not on a page that clearly belongs to the business, so it was not trusted.",
  "Their website is already good":
    "Nothing honest to offer them — their site is fine as it is.",
  "Already emailed": "They already have an email from you. Nobody is written to twice.",
  "Manual review required":
    "They look like a sole trader or use a personal mailbox. UK rules treat those like individuals, so they are held for you to send by hand from the Prospects tab.",
  "On the suppression list": "They asked not to be contacted, permanently.",
  "Asked not to be contacted": "They opted out.",
};

/**
 * Merge every patch for one lead into a single entry.
 *
 * The qualify step produces up to two patches per lead — one from the website
 * check, one from the email lookup — and the store keys patches by lead id, so
 * handing it both means the second wins and the first is lost.
 */
export function mergePatches(
  patches: readonly { id: string; patch: Partial<Lead> }[],
): { id: string; patch: Partial<Lead> }[] {
  const byId = new Map<string, Partial<Lead>>();
  for (const entry of patches) {
    byId.set(entry.id, { ...(byId.get(entry.id) ?? {}), ...entry.patch });
  }
  return [...byId.entries()].map(([id, patch]) => ({ id, patch }));
}

/**
 * How many businesses to look at, to end up with `target` worth contacting.
 *
 * Most businesses a search finds cannot be emailed at all: the ones with the
 * highest opportunity are exactly the ones with no website, and a business with
 * no website has nowhere to publish a contact address. Looking at only `target`
 * of them is how a run ends with nothing to send.
 */
export function searchBreadth(target: number): number {
  return Math.min(100, Math.max(12, Math.round(target) * 4));
}

/** "20 found · 12 qualified · 8 sent" — the one-line summary of a finished run. */
export function summarise(counters: AutoCounters, mode: AutoRunConfig["mode"]): string {
  const parts = [
    `${counters.found} found`,
    `${counters.qualified} qualified`,
    `${counters.prepared} prepared`,
  ];
  if (mode === "send") parts.push(`${counters.sent} sent`);
  if (counters.skipped > 0) parts.push(`${counters.skipped} skipped`);
  if (counters.errors > 0) parts.push(`${counters.errors} error${counters.errors === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
