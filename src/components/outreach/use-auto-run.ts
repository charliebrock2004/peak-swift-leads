import { useCallback, useRef, useState } from "react";
import { findDuplicate, fillMissingLead, liveLeads, newLeadId, type Lead } from "@/lib/leads";
import { emailPatch, websitePatch } from "@/lib/qualify";
import { checkLeadWebsite, findLeadEmail } from "@/lib/qualify-server";
import { researchProspects, type Prospect } from "@/lib/research";
import { runPlannedSearch } from "@/lib/run-search";
import {
  checkReplies,
  generateEmails,
  getOutreachState,
  saveOutreachRun,
  saveOutreachSettings,
  sendQueued,
  setEmailDecision,
} from "@/lib/outreach/server";
import {
  discoveryIsFresh,
  emptyTally,
  tallyDiscovery,
  type DiscoveryTally,
} from "@/lib/email-discovery";
import {
  appendLog,
  appendSkips,
  autoContext,
  batchDelayMs,
  clampAutoConfig,
  configProblem,
  parseTrades,
  tradeBreadth,
  DEFAULT_AUTO_CONFIG,
  emptyCounters,
  initialRunState,
  isRunning,
  mergePatches,
  planTargets,
  searchBreadth,
  summarise,
  type AutoCounters,
  type AutoPhase,
  type AutoRunConfig,
  type AutoRunState,
  type AutoSkip,
  type AutoTone,
  type RingingLead,
} from "@/lib/outreach/auto-run";
import type { OutreachLead } from "@/lib/outreach/types";
import { useLeadsStore } from "@/store/leads-store";
import { decideProspect, describeBottleneck, tallyDecisions } from "@/lib/decision";

/**
 * AI Outreach — the run, driven.
 *
 * This hook is an *orchestrator and nothing else*. It calls the server
 * functions the manual workflow already calls, in the order you would click
 * them, and reports what came back:
 *
 *   researchProspects  →  checkLeadWebsite / findLeadEmail  →  generateEmails
 *                      →  setEmailDecision("queue")  →  sendQueued  →  checkReplies
 *
 * It contains no eligibility rule, no send, no SQL and no credential. Every
 * decision that matters is still taken on the server, from the row the server
 * holds — twice for sending, once at approval and again immediately before
 * Gmail is handed anything. If this file were wrong, the worst it could do is
 * ask for something the server then refuses.
 *
 * The run is deliberately in the foreground. There is no scheduler: it lives
 * for as long as this screen does, stops the moment you say so, and cannot send
 * anything while the app is closed.
 */

/** Website checks and email lookups, two at a time — same as the sheet's bulk actions. */
const QUALIFY_CONCURRENCY = 2;
/**
 * Leads per `generateEmails` call. The server writes each one with an AI request
 * inside, so small batches keep every request well short of a serverless
 * timeout — and make the counter move while you watch.
 */
const GENERATE_CHUNK = 4;
/** A send loop cannot run forever; each pass sends at most `batchSize`. */
const MAX_SEND_PASSES = 40;

function sleep(ms: number, signal: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let waited = 0;
    const timer = setInterval(() => {
      waited += step;
      if (waited >= ms || signal()) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
}

/** The lead fields a prospect maps onto — identical to the Find leads import. */
function leadFromProspect(prospect: Prospect): Partial<Lead> {
  return {
    id: newLeadId(),
    businessName: prospect.businessName,
    trade: prospect.trade,
    town: prospect.town,
    phone: prospect.phone,
    email: prospect.email,
    address: prospect.address,
    rating: prospect.rating,
    reviews: prospect.reviews,
    website: prospect.website,
    mapsLink: prospect.mapsLink,
    websiteStatus: prospect.websiteStatus,
    placeId: prospect.placeId,
    foundAt: prospect.foundAt || new Date().toISOString(),
    businessStatus: prospect.businessStatus,
    source: prospect.source,
    notes: [prospect.reason, prospect.notes, prospect.address].filter(Boolean).join(" "),
    called: "Not Called",
    emailSource: prospect.email ? "Public listing" : "",
    emailConfidence: prospect.email ? "MEDIUM" : "",
    emailFoundAt: prospect.email ? new Date().toISOString() : "",
  };
}

export function useAutoRun(onFinished?: () => void) {
  const [run, setRun] = useState<AutoRunState>(() => initialRunState(clampAutoConfig(DEFAULT_AUTO_CONFIG)));
  const stopping = useRef(false);
  const active = useRef(false);

  const shouldStop = useCallback(() => stopping.current, []);

  const log = useCallback((text: string, tone: AutoTone = "info") => {
    setRun((current) => ({ ...current, log: appendLog(current.log, text, tone) }));
  }, []);

  const phase = useCallback((next: AutoPhase, detail = "") => {
    setRun((current) => ({ ...current, phase: next, detail }));
  }, []);

  const detail = useCallback((text: string) => {
    setRun((current) => ({ ...current, detail: text }));
  }, []);

  const count = useCallback((patch: Partial<AutoCounters>) => {
    setRun((current) => {
      const counters = { ...current.counters };
      for (const [key, value] of Object.entries(patch)) {
        counters[key as keyof AutoCounters] += value ?? 0;
      }
      return { ...current, counters };
    });
  }, []);

  /** The call list from this run's plan. Replaced wholesale, never appended. */
  const setRinging = useCallback((ringing: readonly RingingLead[]) => {
    setRun((current) => ({ ...current, ringing: [...ringing] }));
  }, []);

  const skip = useCallback((added: readonly AutoSkip[]) => {
    if (added.length === 0) return;
    setRun((current) => ({
      ...current,
      skips: appendSkips(current.skips, added),
      counters: { ...current.counters, skipped: current.counters.skipped + added.length },
    }));
  }, []);

  const stop = useCallback(() => {
    if (!active.current) return;
    stopping.current = true;
    setRun((current) => ({ ...current, detail: "Stopping after the current step…" }));
  }, []);

  /**
   * Push the sheet and confirm it landed.
   *
   * Outreach reads leads from the database, never from the browser, so a run
   * that generated before the push would be told "lead not found". A sync that
   * did not reach the server is a hard stop, not a warning.
   */
  const pushSheet = useCallback(async (): Promise<string | null> => {
    await useLeadsStore.getState().sync();
    const state = useLeadsStore.getState();
    if (state.syncState === "synced") return null;
    return (
      state.syncMessage ||
      "The lead sheet could not reach your account, so outreach cannot see these leads yet."
    );
  }, []);

  const start = useCallback(
    async (input: AutoRunConfig) => {
      if (active.current) return;
      const config = clampAutoConfig(input);
      const problem = configProblem(config);
      if (problem) {
        setRun((current) => ({
          ...current,
          config,
          phase: "failed",
          detail: problem,
          log: appendLog(current.log, problem, "bad"),
        }));
        return;
      }

      active.current = true;
      stopping.current = false;
      setRun({
        ...initialRunState(config),
        phase: "searching",
        startedAt: new Date().toISOString(),
        detail: `${config.businessType} within ${config.radiusMiles} miles of ${config.location}`,
        log: appendLog([], `Run started — ${config.businessType} in ${config.location}.`),
      });

      let trackedIds = new Set<string>();

      const finish = (next: AutoPhase, text: string, tone: AutoTone) => {
        setRun((current) => {
          const finishedAt = new Date().toISOString();
          const runLeads = liveLeads(useLeadsStore.getState().leads).filter((lead) => trackedIds.has(lead.id));
          void saveOutreachRun({
            data: {
              startedAt: current.startedAt,
              finishedAt,
              location: config.location,
              businessType: config.businessType,
              mode: config.mode,
              found: current.counters.found,
              qualified: current.counters.qualified,
              hot: current.counters.hot,
              warm: current.counters.warm,
              callCount: current.counters.call,
              lowCount: current.counters.low,
              skipped: current.counters.skipped,
              emailsFound: current.counters.emailsFound,
              prepared: current.counters.prepared,
              sent: current.counters.sent,
              replies: current.counters.replies,
              errors: current.counters.errors,
              bottleneck: describeBottleneck(runLeads.map((lead) => decideProspect(lead))),
              summary: summarise(current.counters, config.mode),
            },
          }).catch(() => undefined);
          return {
            ...current,
            phase: next,
            detail: text,
            finishedAt,
            log: appendLog(current.log, `${text} ${summarise(current.counters, config.mode)}`, tone),
          };
        });
      };

      try {
        // ── 0. The daily limit, through the existing settings path ───────────
        // `sanitizeSettings` clamps it server-side to the product ceiling, so a
        // run can lower the limit but never raise it past 30.
        const saved = await saveOutreachSettings({ data: { dailyLimit: config.dailyLimit } });
        if (!saved.ok) {
          finish("failed", saved.error, "bad");
          return;
        }

        // ── 1. SEARCH ────────────────────────────────────────────────────────
        //
        // Through `runPlannedSearch`, which fans the area into town batches and
        // keeps going until it has enough. Most businesses found will have no
        // public email — that is the whole reason they are worth writing to —
        // so the run looks at several times the number it expects to contact.
        //
        // One search per trade, sharing the run's breadth rather than
        // multiplying it, so covering four trades costs about what covering one
        // costs. Prospects are merged across trades and de-duplicated on the
        // same place id the single-trade path uses, because one business can
        // be listed under two trades and must not become two leads.
        const trades = parseTrades(config.businessType);
        const searchFor = searchBreadth(config.target);
        const perTrade = tradeBreadth(searchFor, trades.length);

        const prospects: Prospect[] = [];
        const seenProspect = new Set<string>();
        const searchErrors: string[] = [];
        let areaCount = 0;
        let planLabel = config.location;

        for (const [tradeIndex, trade] of trades.entries()) {
          if (shouldStop()) break;
          const search = await runPlannedSearch({
            location: config.location,
            businessType: trade,
            limit: perTrade,
            shouldCancel: shouldStop,
            concurrency: 2,
            onProgress: (progress) => {
              if (progress.phase === "done") return;
              const which = trades.length > 1 ? `${trade} — ` : "";
              detail(
                `${which}Searching ${progress.area} (${progress.index} of ${progress.total}) — ` +
                  `${progress.found} of ${progress.target} found`,
              );
            },
            research: async (input) => {
              const result = await researchProspects({
                data: {
                  location: input.location,
                  businessType: input.businessType,
                  limit: input.limit,
                  radiusMiles: config.radiusMiles,
                },
              });
              return result;
            },
          });
          searchErrors.push(...search.errors);
          areaCount += search.plan.areas.length;
          planLabel = search.plan.label;
          for (const prospect of search.prospects) {
            const key = (prospect.placeId || `${prospect.businessName}|${prospect.town}`).toLowerCase();
            if (seenProspect.has(key)) continue;
            seenProspect.add(key);
            prospects.push(prospect);
          }
          if (trades.length > 1) {
            log(
              `${trade}: ${search.prospects.length} found (${tradeIndex + 1} of ${trades.length}).`,
            );
          }
        }

        if (shouldStop()) return finish("stopped", "Stopped before anything was written.", "warn");
        for (const problem of searchErrors.slice(0, 4)) log(problem, "warn");
        if (prospects.length === 0) {
          finish(
            "failed",
            searchErrors[0] ??
              `No ${config.businessType.toLowerCase()} businesses found near ${config.location}.`,
            "bad",
          );
          return;
        }
        const found = { prospects, location: planLabel };
        count({ found: found.prospects.length });
        log(
          `Found ${found.prospects.length} businesses across ${areaCount} ` +
            `area${areaCount === 1 ? "" : "s"} near ${found.location}.`,
          "good",
        );

        // ── 2. Into the sheet, de-duplicated against what is already there ───
        const sheet = liveLeads(useLeadsStore.getState().leads);
        const fresh: Partial<Lead>[] = [];
        const merges: { id: string; patch: Partial<Lead> }[] = [];
        const runLeadIds = new Set<string>();
        for (const prospect of found.prospects) {
          const duplicate = findDuplicate(prospect, sheet);
          if (duplicate) {
            // Already on the sheet. Fill any empty fields, keep outreach history.
            runLeadIds.add(duplicate.lead.id);
            const incoming = leadFromProspect(prospect);
            const patch = fillMissingLead(duplicate.lead, incoming);
            if (patch) merges.push({ id: duplicate.lead.id, patch });
            continue;
          }
          const lead = leadFromProspect(prospect);
          fresh.push(lead);
          runLeadIds.add(lead.id as string);
        }
        trackedIds = runLeadIds;
        if (fresh.length > 0) useLeadsStore.getState().addLeads(fresh);
        if (merges.length > 0) useLeadsStore.getState().updateLeads(merges);
        log(
          `${fresh.length} new to your sheet` +
            (merges.length > 0 ? ` · ${merges.length} updated` : "") +
            (found.prospects.length - fresh.length - merges.length > 0
              ? ` · ${found.prospects.length - fresh.length} already there`
              : ""),
        );

        const pushed = await pushSheet();
        if (pushed) {
          finish("failed", pushed, "bad");
          return;
        }
        if (shouldStop()) return finish("stopped", "Stopped after saving the new leads.", "warn");

        // ── 3. QUALIFY — the sheet's own website check and email lookup ──────
        phase("qualifying", "Checking websites and looking for public emails…");
        const toQualify = liveLeads(useLeadsStore.getState().leads).filter((lead) =>
          runLeadIds.has(lead.id),
        );
        let index = 0;
        let done = 0;
        const patches: { id: string; patch: Partial<Lead> }[] = [];
        const discovery: DiscoveryTally & { cached: number } = emptyTally();

        const worker = async () => {
          while (true) {
            if (shouldStop()) return;
            const at = index;
            index += 1;
            if (at >= toQualify.length) return;
            const lead = toQualify[at]!;
            let working: Lead = lead;
            // Recently searched and already answered: do not crawl them again.
            if (discoveryIsFresh(lead)) {
              discovery.cached += 1;
              done += 1;
              detail(`Checked ${done} of ${toQualify.length}`);
              continue;
            }
            try {
              if (lead.website.trim()) {
                const site = await checkLeadWebsite({
                  data: { website: lead.website, businessName: lead.businessName },
                });
                if (site.ok) {
                  const patch = websitePatch(working, site.check, site.checkedAt);
                  working = { ...working, ...patch };
                  patches.push({ id: lead.id, patch });
                }
              }
              const mail = await findLeadEmail({
                data: {
                  website: working.website,
                  existingEmail: working.email,
                  existingSource: working.emailSource,
                  // The scorer needs the name to tell a business's own Gmail
                  // from an unrelated one.
                  businessName: working.businessName,
                  town: working.town,
                  trade: working.trade,
                  phone: working.phone,
                  address: working.address,
                },
              });
                if (mail.ok) {
                const patch = emailPatch(working, mail.found, mail.foundAt);
                patches.push({ id: lead.id, patch });
                tallyDiscovery(discovery, mail.discovery);
              }
            } catch (error) {
              count({ errors: 1 });
              log(
                `${lead.businessName}: ${error instanceof Error ? error.message : "check failed"}`,
                "warn",
              );
            } finally {
              done += 1;
              detail(`Checked ${done} of ${toQualify.length}`);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.max(1, Math.min(QUALIFY_CONCURRENCY, toQualify.length)) }, worker),
        );
        // `updateLeads` keys its patches by lead id, so two entries for one lead
        // means the second silently replaces the first — and the website check
        // always runs before the email lookup. Merge them per lead, or every
        // website quality, score and analysis this step just fetched is thrown
        // away before it reaches the sheet or the eligibility gate.
        // Say what email discovery actually achieved, and where it got stuck.
        // "No public email found" on its own tells nobody what to fix.
        {
          const { bestSource, biggestBottleneck, REASON_LABELS } = await import("@/lib/email-discovery");
          const top = bestSource(discovery);
          const stuck = biggestBottleneck(discovery);
          log(
            `Email discovery: ${discovery.found} found of ${discovery.searched} searched` +
              (discovery.cached > 0 ? ` (${discovery.cached} already known)` : "") +
              ` · ${discovery.high} high, ${discovery.medium} medium confidence`,
            discovery.found > 0 ? "good" : "warn",
          );
          if (top) log(`Best source: ${top.source.toLowerCase().replace(/_/g, " ")} (${top.count}).`);
          if (stuck) {
            log(
              `Biggest blocker: ${REASON_LABELS[stuck.reason as keyof typeof REASON_LABELS] ?? stuck.reason} (${stuck.count}).`,
              "warn",
            );
          }
        }

        if (patches.length > 0) useLeadsStore.getState().updateLeads(mergePatches(patches));
        const pushedAgain = await pushSheet();
        if (pushedAgain) {
          finish("failed", pushedAgain, "bad");
          return;
        }
        if (shouldStop()) return finish("stopped", "Stopped after qualifying.", "warn");

        // ── 4. Decide who may be written to — the shared gate, server data ───
        const state = await getOutreachState();
        if (!state.ok) {
          finish("failed", state.error, "bad");
          return;
        }
        const context = autoContext(
          state.emails,
          state.suppression.map((entry) => entry.email),
          state.settings,
        );
        const room =
          config.mode === "send"
            ? Math.min(state.allowance.remaining, config.target)
            : config.target;
        const plan = planTargets(state.leads as OutreachLead[], context, room, runLeadIds);
        skip(plan.skipped);
        setRinging(plan.ringing);
        const runLeads = liveLeads(useLeadsStore.getState().leads).filter((lead) => runLeadIds.has(lead.id));
        const tally = tallyDecisions(runLeads);
        if (plan.ringing.length > 0) {
          log(
            `${plan.ringing.length} worth ringing — good prospects with no public email.`,
            "warn",
          );
        }
        count({
          qualified: plan.leadIds.length + plan.heldForTomorrow,
          hot: tally.hot,
          warm: tally.warm,
          call: plan.ringing.length,
          low: tally.low,
          emailsFound: tally.emailsFound,
        });
        log(
          `${plan.leadIds.length + plan.heldForTomorrow} qualified · ${plan.ringing.length} CALL · ${plan.skipped.length} skipped` +
            (plan.heldForTomorrow > 0 ? ` · ${plan.heldForTomorrow} held for another day` : ""),
          plan.leadIds.length > 0 ? "good" : "warn",
        );
        if (plan.leadIds.length === 0) {
          finish(
            "done",
            plan.ringing.length > 0
              ? `Nothing left to email — but ${plan.ringing.length} are worth ringing.`
              : "Nothing left that can be contacted.",
            "warn",
          );
          return;
        }

        // ── 5. PERSONALISE — the existing AI generator, in small batches ─────
        phase("personalising", `Writing ${plan.leadIds.length} emails…`);
        // A refusal names a lead id; show the business instead.
        const nameOf = new Map(state.leads.map((lead) => [lead.id, lead.businessName]));
        const emailIds: string[] = [];
        for (let at = 0; at < plan.leadIds.length; at += GENERATE_CHUNK) {
          if (shouldStop()) break;
          const chunk = plan.leadIds.slice(at, at + GENERATE_CHUNK);
          const written = await generateEmails({
            data: { leadIds: chunk, mode: state.settings.defaultMode || "ai", kind: "initial" },
          });
          if (!written.ok) {
            count({ errors: 1 });
            log(written.error, "bad");
            break;
          }
          for (const row of written.rows) {
            if (row.ok && row.emailId) {
              emailIds.push(row.emailId);
              count({ prepared: 1 });
              if (row.note) log(`${row.subject}: ${row.note}`, "warn");
            } else if (!row.ok) {
              skip([
                {
                  businessName: nameOf.get(row.leadId) ?? "",
                  reasons: [row.error ?? "Could not write an email"],
                },
              ]);
            }
          }
          detail(`Prepared ${emailIds.length} of ${plan.leadIds.length}`);
        }

        if (config.mode === "prepare") {
          finish(
            "done",
            `${emailIds.length} draft${emailIds.length === 1 ? "" : "s"} waiting in Review. Nothing was sent.`,
            "good",
          );
          return;
        }
        if (shouldStop()) return finish("stopped", "Stopped with drafts left in Review.", "warn");
        if (emailIds.length === 0) {
          finish("done", "No emails could be written.", "warn");
          return;
        }

        // ── 6. QUEUE, then SEND under the existing limits ────────────────────
        phase("sending", `Queueing ${emailIds.length}…`);
        const queued = await setEmailDecision({ data: { ids: emailIds, decision: "queue" } });
        if (!queued.ok) {
          finish("failed", queued.error, "bad");
          return;
        }
        if (queued.refused.length > 0) {
          skip(queued.refused.map((reason) => ({ businessName: "", reasons: [reason] })));
        }
        if (queued.changed === 0) {
          finish("done", "Nothing could be queued. The drafts are in Review.", "warn");
          return;
        }

        const delay = batchDelayMs(state.settings);
        for (let pass = 0; pass < MAX_SEND_PASSES; pass += 1) {
          if (shouldStop()) return finish("stopped", "Stopped between batches.", "warn");
          const report = await sendQueued();
          if (!report.ok) {
            count({ errors: 1 });
            finish("failed", report.error, "bad");
            return;
          }
          count({ sent: report.sent, errors: report.failed });
          skip(
            report.details
              .filter((line) => line.status === "skipped")
              .map((line) => ({
                businessName: line.businessName,
                reasons: [line.error || "Refused at send time"],
              })),
          );
          for (const line of report.details) {
            if (line.status === "sent") log(`Sent to ${line.businessName}.`, "good");
            else if (line.status === "failed") log(`${line.businessName}: ${line.error}`, "bad");
          }
          if (report.stopped) {
            finish("failed", report.stopped, "bad");
            return;
          }
          if (report.sent + report.failed + report.skipped === 0) break;
          if (report.remaining === 0) {
            log("Daily limit reached. The rest stays queued for tomorrow.", "warn");
            break;
          }
          detail(`Waiting ${Math.round(delay / 1000)}s before the next batch…`);
          await sleep(delay, shouldStop);
        }

        // ── 7. Replies, read-only ────────────────────────────────────────────
        if (!shouldStop()) {
          phase("replies", "Checking for replies…");
          const replies = await checkReplies();
          if (replies.ok) {
            count({ replies: replies.replies });
            if (replies.replies > 0) {
              log(`${replies.replies} replied — follow-ups stop for them.`, "good");
            }
            // The poll is bounded so it always returns; say when it did not get
            // through everything, rather than implying nobody replied.
            if (replies.more) {
              log(
                `Checked ${replies.checked} conversations — more are still waiting. ` +
                  `Run “Check for replies” on the Overview tab to continue.`,
                "warn",
              );
            }
          }
        }

        finish("done", "Run finished.", "good");
      } catch (error) {
        setRun((current) => ({
          ...current,
          phase: "failed",
          detail: error instanceof Error ? error.message : "The run stopped unexpectedly.",
          finishedAt: new Date().toISOString(),
          counters: { ...current.counters, errors: current.counters.errors + 1 },
        }));
      } finally {
        active.current = false;
        stopping.current = false;
        onFinished?.();
      }
    },
    [count, detail, log, onFinished, phase, pushSheet, setRinging, shouldStop, skip],
  );

  const reset = useCallback(() => {
    if (active.current) return;
    setRun((current) => ({
      ...initialRunState(current.config),
      counters: emptyCounters(),
    }));
  }, []);

  return { run, start, stop, reset, running: isRunning(run.phase) };
}
