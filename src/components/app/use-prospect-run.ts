import { useCallback, useRef, useState } from "react";
import { fillMissingLead, findDuplicate, liveLeads, newLeadId, type Lead } from "@/lib/leads";
import { discoveredWebsitePatch, emailPatch, websitePatch } from "@/lib/qualify";
import { checkLeadWebsite, findLeadEmail } from "@/lib/qualify-server";
import { researchProspects, type Prospect } from "@/lib/research";
import { runPlannedSearch } from "@/lib/run-search";
import { discoveryIsFresh, REASON_LABELS as DISCOVERY_REASON_LABELS } from "@/lib/email-discovery";
import { SEARCH_FAILURE_LABELS } from "@/lib/search-provider";
import { autoContext, mergePatches, planTargets, searchBreadth, tradeBreadth } from "@/lib/outreach/auto-run";
import { generateEmails, getOutreachState, recordRun, saveCampaign } from "@/lib/outreach/server";
import { emptyFunnel, reconcileFunnel, tallyOutcomes, websiteOutcome, type RunFunnel } from "@/lib/outreach/run-funnel";
import type { OutreachLead } from "@/lib/outreach/types";
import { friendlyServerError } from "@/lib/server-errors";
import { useLeadsStore } from "@/store/leads-store";

/**
 * Find & reach — one run, driven from the browser.
 *
 * Serverless has no long-running workers, so the run is a sequence of short
 * server calls orchestrated here, each one of the existing, owner-only server
 * functions: search → save → check websites and emails → qualify → write
 * drafts. It stops at READY: drafts wait on the Send screen, where a person
 * reads them and presses Send. Nothing in a run sends an email.
 *
 * Every step is counted into a funnel that must reconcile, and the run is
 * recorded on the server as it goes — so a tab closed half-way still leaves an
 * honest record of how far it got.
 */

export const RUN_STAGES = [
  "discovering",
  "deduplicating",
  "verifying",
  "websites",
  "emails",
  "qualifying",
  "personalising",
  "ready",
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const STAGE_TITLES: Record<RunStage, string> = {
  discovering: "Discovering",
  deduplicating: "Deduplicating",
  verifying: "Verifying businesses",
  websites: "Checking websites",
  emails: "Finding emails",
  qualifying: "Qualifying",
  personalising: "Personalising",
  ready: "Ready to send",
};

export type RunStatus = "idle" | "running" | "done" | "stopped" | "failed";

export type RunConfig = {
  location: string;
  trades: string[];
  target: number;
  dailyLimit: number;
  radiusMiles: number;
  /** An existing campaign, or empty to create one called `campaignName`. */
  campaignId: string;
  campaignName: string;
};

export type RunEvent = { at: string; text: string; tone: "info" | "good" | "warn" | "bad" };

export type RunResult = {
  runId: string;
  campaignId: string;
  leadIds: string[];
  readyEmailIds: string[];
  callLeadIds: string[];
};

export type ProspectRunState = {
  status: RunStatus;
  stage: RunStage | null;
  /** Stages finished, for the stepper. */
  completed: RunStage[];
  detail: string;
  /** Progress within the current stage. */
  progress: { done: number; total: number };
  funnel: RunFunnel;
  config: RunConfig | null;
  log: RunEvent[];
  startedAt: string;
  finishedAt: string;
  result: RunResult | null;
  /** Broken funnel equations, if any. Shown instead of hiding a mystery loss. */
  reconcileProblems: string[];
};

const LOG_LIMIT = 150;
/** Website and email checks at once. Each is one short server call. */
const CHECK_CONCURRENCY = 3;
/** Drafts per server call, so each call stays well inside a function timeout. */
const GENERATE_CHUNK = 4;

function initial(): ProspectRunState {
  return {
    status: "idle",
    stage: null,
    completed: [],
    detail: "",
    progress: { done: 0, total: 0 },
    funnel: emptyFunnel(),
    config: null,
    log: [],
    startedAt: "",
    finishedAt: "",
    result: null,
    reconcileProblems: [],
  };
}

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
    notes: [prospect.reason, prospect.notes].filter(Boolean).join(" "),
    called: "Not Called",
    emailSource: prospect.email ? "Public listing" : "",
    emailConfidence: prospect.email ? "MEDIUM" : "",
    emailFoundAt: prospect.email ? new Date().toISOString() : "",
  };
}

export function useProspectRun(onFinished?: () => void) {
  const [run, setRun] = useState<ProspectRunState>(initial);
  const stopping = useRef(false);
  const active = useRef(false);

  const log = useCallback((text: string, tone: RunEvent["tone"] = "info") => {
    setRun((current) => {
      const next = [...current.log, { at: new Date().toISOString(), text, tone }];
      return { ...current, log: next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next };
    });
  }, []);

  const enter = useCallback((stage: RunStage, detail = "") => {
    setRun((current) => {
      const index = RUN_STAGES.indexOf(stage);
      const completed = RUN_STAGES.slice(0, index);
      return { ...current, stage, completed, detail, progress: { done: 0, total: 0 } };
    });
  }, []);

  const stop = useCallback(() => {
    if (!active.current) return;
    stopping.current = true;
    setRun((current) => ({ ...current, detail: "Stopping after the current step…" }));
  }, []);

  const reset = useCallback(() => {
    if (active.current) return;
    setRun(initial());
  }, []);

  const start = useCallback(
    async (config: RunConfig) => {
      if (active.current) return;
      active.current = true;
      stopping.current = false;
      const runId = newLeadId();
      const startedAt = new Date().toISOString();
      const funnel = emptyFunnel();
      let campaignId = config.campaignId;
      let runLeadIds: string[] = [];
      let stage: RunStage = "discovering";

      setRun({ ...initial(), status: "running", config, startedAt, stage: "discovering" });

      /** Write the run record. Never allowed to stop the run itself. */
      const persist = async (status: RunStatus | "running", extra: { summary?: string; finishedAt?: string } = {}) => {
        await recordRun({
          data: {
            id: runId,
            startedAt,
            finishedAt: extra.finishedAt ?? "",
            location: config.location,
            businessType: config.trades.join(", "),
            mode: "prepare",
            status: status === "idle" ? "running" : status,
            phase: stage,
            campaignId,
            target: config.target,
            dailyLimit: config.dailyLimit,
            found: funnel.selected,
            qualified: funnel.eligible,
            callCount: funnel.call,
            lowCount: funnel.lowOpportunity,
            skipped: funnel.checked - funnel.eligible - funnel.call,
            emailsFound: funnel.emailsFound,
            prepared: funnel.prepared,
            errors: funnel.checkErrors + funnel.prepareFailed,
            summary: extra.summary ?? "",
            funnel: JSON.stringify(funnel),
            leadIds: runLeadIds,
          },
        }).catch(() => undefined);
      };

      const publish = () => setRun((current) => ({ ...current, funnel: { ...funnel } }));

      const finish = async (status: Exclude<RunStatus, "idle" | "running">, text: string, result: RunResult | null) => {
        const finishedAt = new Date().toISOString();
        const problems = reconcileFunnel(funnel);
        if (problems.length > 0) log(`The run's numbers do not add up: ${problems.join("; ")}`, "bad");
        await persist(status, { summary: text, finishedAt });
        setRun((current) => ({
          ...current,
          status,
          stage: status === "done" ? "ready" : current.stage,
          completed: status === "done" ? [...RUN_STAGES] : current.completed,
          detail: text,
          finishedAt,
          funnel: { ...funnel },
          result,
          reconcileProblems: problems,
          log: [
            ...current.log,
            { at: finishedAt, text, tone: (status === "done" ? "good" : status === "failed" ? "bad" : "warn") as RunEvent["tone"] },
          ].slice(-LOG_LIMIT),
        }));
      };

      const pushSheet = async (): Promise<string | null> => {
        await useLeadsStore.getState().sync();
        const state = useLeadsStore.getState();
        if (state.syncState === "synced") return null;
        return state.syncMessage || "Your leads could not reach your account, so the rest of the run cannot see them.";
      };

      try {
        // ── Campaign ───────────────────────────────────────────────────────
        // A campaign is only switched on once this run has actually put
        // prospects into it — a run that finds nothing must not leave an
        // empty "Active" campaign behind — and a retry with the same name
        // reuses the campaign instead of creating a duplicate.
        let activateWhenFilled = false;
        const campaignName = (config.campaignName || `${config.location} ${config.trades.join(", ")}`).trim().slice(0, 60);
        if (!campaignId) {
          const current = await getOutreachState().catch(() => null);
          const sameName =
            current && current.ok
              ? current.campaigns.find(
                  (campaign) =>
                    campaign.name.trim().toLowerCase() === campaignName.toLowerCase() &&
                    (campaign.status === "DRAFT" || campaign.status === "ACTIVE" || campaign.status === "PAUSED"),
                )
              : undefined;
          if (sameName) {
            campaignId = sameName.id;
            activateWhenFilled = sameName.status === "DRAFT";
            log(`Adding to the existing campaign "${sameName.name}".`);
          }
        }
        if (!campaignId) {
          const created = await saveCampaign({
            data: {
              action: "save",
              name: campaignName,
              locations: config.location,
              trades: config.trades.join(", "),
              targetProspects: config.target,
              dailyTarget: config.dailyLimit,
              batchSize: 5,
              sendMode: "prepare",
            },
          });
          if (!created.success) return void (await finish("failed", created.error, null));
          campaignId = created.id;
          activateWhenFilled = true;
          log(`Campaign "${campaignName}" created.`);
        }
        await persist("running");

        // ── 1. DISCOVERING ─────────────────────────────────────────────────
        enter("discovering", `Searching ${config.location} for ${config.trades.join(", ")}…`);
        const before = useLeadsStore.getState().leads;
        const known = liveLeads(before);
        const suppressedLeads = before.filter((lead) => lead.unsubscribed.trim());
        const contactedLeads = known.filter((lead) => lead.lastEmailedAt.trim());
        const prospects: Prospect[] = [];
        const rediscovered: Prospect[] = [];
        const errors: string[] = [];
        const seen = new Set<string>();
        const perTrade = tradeBreadth(searchBreadth(config.target), config.trades.length);

        for (const trade of config.trades) {
          if (stopping.current) break;
          const search = await runPlannedSearch({
            location: config.location,
            businessType: trade,
            limit: perTrade,
            known: [...known, ...prospects],
            suppressed: suppressedLeads,
            contacted: contactedLeads,
            shouldCancel: () => stopping.current,
            concurrency: 2,
            onProgress: (progress) => {
              if (progress.phase === "done") return;
              setRun((current) => ({
                ...current,
                detail: `${config.trades.length > 1 ? `${trade} — ` : ""}searching ${progress.area} (${progress.index} of ${progress.total})`,
                progress: { done: progress.found, total: progress.target },
              }));
            },
            research: async (input) =>
              researchProspects({
                data: { location: input.location, businessType: input.businessType, limit: input.limit, radiusMiles: config.radiusMiles },
              }),
          });
          errors.push(...search.errors);
          funnel.rawFound += search.funnel.rawTotal;
          funnel.unique += search.funnel.unique;
          funnel.beyondFetchBudget += search.funnel.droppedToFetchBudget;
          funnel.offered += search.pool.collected;
          funnel.duplicatesAcrossAreas += search.pool.duplicatesAcrossAreas;
          funnel.alreadyKnown += search.pool.alreadyKnown;
          funnel.alreadyContacted += search.pool.alreadyContacted;
          funnel.suppressed += search.pool.suppressed;
          funnel.beyondSafetyCeiling += search.pool.droppedToSafetyCeiling;
          funnel.newCandidates += search.pool.newCandidates;
          funnel.notNeeded += search.pool.remainingAfterTarget;
          funnel.selected += search.pool.targetAchieved;
          rediscovered.push(...search.knownMatches);
          for (const prospect of search.prospects) {
            const key = (prospect.placeId || `${prospect.businessName}|${prospect.town}`).toLowerCase();
            if (seen.has(key)) {
              // The same listing under two trades: one business, one slot.
              funnel.selected -= 1;
              funnel.newCandidates -= 1;
              funnel.duplicatesAcrossAreas += 1;
              continue;
            }
            seen.add(key);
            prospects.push(prospect);
          }
          log(`${trade}: ${search.funnel.rawTotal} listings, ${search.pool.targetAchieved} new.`, "info");
          publish();
        }

        for (const problem of [...new Set(errors)].slice(0, 3)) log(friendlyServerError(new Error(problem)), "warn");
        if (stopping.current) return void (await finish("stopped", "Stopped before anything was saved.", null));
        if (prospects.length === 0) {
          const why =
            funnel.rawFound === 0
              ? errors[0]
                ? friendlyServerError(new Error(errors[0]))
                : `No ${config.trades.join(", ").toLowerCase()} businesses found around ${config.location}.`
              : `Found ${funnel.rawFound} listings, but none are new — every one is already on your sheet, contacted or opted out.`;
          return void (await finish(funnel.rawFound === 0 ? "failed" : "done", why, null));
        }

        // ── 2. DEDUPLICATING — into the sheet, against what is already there
        stage = "deduplicating";
        enter("deduplicating", `${funnel.unique} unique businesses → ${prospects.length} new to you`);
        const sheet = liveLeads(useLeadsStore.getState().leads);
        const fresh: Partial<Lead>[] = [];
        const merges: { id: string; patch: Partial<Lead> }[] = [];
        const ids = new Set<string>();
        for (const prospect of prospects) {
          const duplicate = findDuplicate(prospect, sheet);
          if (duplicate) {
            ids.add(duplicate.lead.id);
            const patch = fillMissingLead(duplicate.lead, leadFromProspect(prospect));
            if (patch) merges.push({ id: duplicate.lead.id, patch });
            continue;
          }
          const lead = leadFromProspect(prospect);
          fresh.push(lead);
          ids.add(lead.id as string);
        }
        const collapsed = prospects.length - ids.size;
        if (collapsed > 0) {
          funnel.selected -= collapsed;
          funnel.newCandidates -= collapsed;
          funnel.duplicatesAcrossAreas += collapsed;
        }
        const patched = new Set(merges.map((item) => item.id));
        for (const prospect of rediscovered) {
          const duplicate = findDuplicate(prospect, sheet);
          if (!duplicate || patched.has(duplicate.lead.id)) continue;
          const patch = fillMissingLead(duplicate.lead, leadFromProspect(prospect));
          if (patch) {
            patched.add(duplicate.lead.id);
            merges.push({ id: duplicate.lead.id, patch });
          }
        }
        if (fresh.length > 0) useLeadsStore.getState().addLeads(fresh);
        if (merges.length > 0) useLeadsStore.getState().updateLeads(merges);
        runLeadIds = [...ids];
        publish();
        const pushed = await pushSheet();
        if (pushed) return void (await finish("failed", pushed, null));
        if (campaignId) {
          await saveCampaign({ data: { action: "prospects", id: campaignId, leadIds: runLeadIds } }).catch(() => undefined);
          if (activateWhenFilled && runLeadIds.length > 0) {
            await saveCampaign({ data: { action: "status", id: campaignId, status: "ACTIVE" } }).catch(() => undefined);
          }
        }
        log(`${fresh.length} new prospects saved${merges.length ? ` · ${merges.length} existing leads topped up` : ""}.`, "good");
        await persist("running");
        if (stopping.current) return void (await finish("stopped", "Stopped after saving the new prospects.", null));

        // ── 3–5. VERIFYING, WEBSITES, EMAILS — one short server call per lead
        stage = "verifying";
        enter("verifying", "Checking each business's identity, website and public email…");
        const toCheck = liveLeads(useLeadsStore.getState().leads).filter((lead) => ids.has(lead.id));
        const patches: { id: string; patch: Partial<Lead> }[] = [];
        const verified = new Set<string>();
        const whyNoEmail = new Map<string, string>();
        let next = 0;
        let done = 0;
        const progress = (text: string) =>
          setRun((current) => ({ ...current, detail: text, progress: { done, total: toCheck.length } }));
        const worker = async () => {
          while (!stopping.current) {
            const at = next;
            next += 1;
            if (at >= toCheck.length) return;
            const lead = toCheck[at]!;
            let working: Lead = lead;
            if (discoveryIsFresh(lead)) {
              done += 1;
              progress(`Checked ${done} of ${toCheck.length} — ${lead.businessName} was checked recently`);
              continue;
            }
            try {
              if (lead.website.trim()) {
                setRun((current) => (current.stage === "verifying" ? { ...current, stage: "websites", completed: RUN_STAGES.slice(0, 3) } : current));
                const site = await checkLeadWebsite({ data: { website: lead.website, businessName: lead.businessName } });
                if (site.ok) {
                  const patch = websitePatch(working, site.check, site.checkedAt);
                  working = { ...working, ...patch };
                  patches.push({ id: lead.id, patch });
                }
              }
              const mail = await findLeadEmail({
                data: {
                  leadId: lead.id,
                  website: working.website,
                  existingEmail: working.email,
                  existingSource: working.emailSource,
                  businessName: working.businessName,
                  town: working.town,
                  trade: working.trade,
                  phone: working.phone,
                  address: working.address,
                },
              });
              setRun((current) =>
                current.stage === "verifying" || current.stage === "websites"
                  ? { ...current, stage: "emails", completed: RUN_STAGES.slice(0, 4) }
                  : current,
              );
              if (mail.ok) {
                const email = emailPatch(working, mail.found, mail.foundAt);
                const site = discoveredWebsitePatch({ ...working, ...email }, mail.website);
                patches.push({ id: lead.id, patch: { ...email, ...site } });
                if (mail.website) verified.add(lead.id);
                funnel.websitesRejected += mail.rejectedCandidates?.length ?? 0;
                funnel.emailsRejected += mail.rejectedEmails?.length ?? 0;
                if (!mail.found && mail.discovery.reason) {
                  const note = mail.searchFailure ? ` (${SEARCH_FAILURE_LABELS[mail.searchFailure] ?? mail.searchFailure})` : "";
                  whyNoEmail.set(lead.id, `${DISCOVERY_REASON_LABELS[mail.discovery.reason] ?? mail.discovery.reason}${note}`);
                }
              }
            } catch (error) {
              funnel.checkErrors += 1;
              log(`${lead.businessName}: ${friendlyServerError(error, "check failed")}`, "warn");
            } finally {
              done += 1;
              progress(`Checked ${done} of ${toCheck.length}`);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(CHECK_CONCURRENCY, toCheck.length)) }, worker));
        if (patches.length > 0) useLeadsStore.getState().updateLeads(mergePatches(patches));

        // Count what the checks produced, from the leads as they now stand.
        const checkedLeads = liveLeads(useLeadsStore.getState().leads).filter((lead) => ids.has(lead.id));
        funnel.checked = checkedLeads.length;
        for (const lead of checkedLeads) {
          const site = websiteOutcome(lead, verified.has(lead.id));
          if (site === "verified") funnel.websiteVerified += 1;
          else if (site === "listed") funnel.websiteListed += 1;
          else if (site === "socialOrDirectory") funnel.websiteSocialOrDirectory += 1;
          else funnel.websiteNone += 1;
          const usable = lead.email.trim() && (lead.emailConfidence === "HIGH" || lead.emailConfidence === "MEDIUM");
          if (usable) {
            funnel.emailsFound += 1;
            if (lead.emailConfidence === "HIGH") funnel.emailsHigh += 1;
            else funnel.emailsMedium += 1;
          } else funnel.noEmail += 1;
        }
        publish();
        log(
          `${funnel.websiteVerified} websites verified · ${funnel.emailsFound} public emails found (${funnel.emailsHigh} high, ${funnel.emailsMedium} medium confidence).`,
          funnel.emailsFound > 0 ? "good" : "warn",
        );
        const pushedAgain = await pushSheet();
        if (pushedAgain) return void (await finish("failed", pushedAgain, null));
        await persist("running");
        if (stopping.current) return void (await finish("stopped", "Stopped after checking websites and emails.", null));

        // ── 6. QUALIFYING — the same gate sending uses, on the server's rows ─
        stage = "qualifying";
        enter("qualifying", "Deciding who can be emailed, who to ring, and who to leave…");
        const state = await getOutreachState();
        if (!state.ok) return void (await finish("failed", state.error, null));
        const context = autoContext(state.emails, state.suppression.map((entry) => entry.email), state.settings);
        const serverLeads = (state.leads as OutreachLead[]).filter((lead) => ids.has(lead.id));
        const outcomes = tallyOutcomes(serverLeads, context);
        funnel.eligible = outcomes.eligible;
        funnel.call = outcomes.call;
        funnel.manualReview = outcomes.manualReview;
        funnel.goodWebsite = outcomes.goodWebsite;
        funnel.lowOpportunity = outcomes.lowOpportunity;
        funnel.alreadyInTouch = outcomes.alreadyInTouch;
        funnel.optedOut = outcomes.optedOut;
        funnel.closed = outcomes.closed;
        funnel.noWayToContact = outcomes.noWayToContact;
        funnel.otherSkipped = outcomes.otherSkipped;
        const plan = planTargets(serverLeads, context, Number.MAX_SAFE_INTEGER, ids, whyNoEmail);
        const callLeadIds = plan.ringing.map((entry) => entry.id);
        publish();
        log(`${funnel.eligible} can be emailed · ${funnel.call} to call · ${funnel.manualReview} held for you to check.`, funnel.eligible ? "good" : "warn");
        await persist("running");

        // ── 7. PERSONALISING ───────────────────────────────────────────────
        stage = "personalising";
        enter("personalising", `Writing ${plan.leadIds.length} personalised emails…`);
        const readyEmailIds: string[] = [];
        let attempted = 0;
        for (let at = 0; at < plan.leadIds.length; at += GENERATE_CHUNK) {
          if (stopping.current) break;
          const chunk = plan.leadIds.slice(at, at + GENERATE_CHUNK);
          attempted += chunk.length;
          const written = await generateEmails({
            data: { leadIds: chunk, mode: state.settings.defaultMode || "ai", kind: "initial", campaignId, runId },
          }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
          if (!written.ok) {
            funnel.prepareFailed += chunk.length;
            log(written.error, "bad");
            continue;
          }
          for (const row of written.rows) {
            if (row.ok && row.emailId) {
              readyEmailIds.push(row.emailId);
              funnel.prepared += 1;
              if (row.note) log(`${row.subject}: ${row.note}`, "warn");
            } else {
              funnel.prepareFailed += 1;
              log(`Could not write to a prospect: ${row.error ?? "unknown reason"}`, "warn");
            }
          }
          setRun((current) => ({ ...current, progress: { done: funnel.prepared + funnel.prepareFailed, total: plan.leadIds.length } }));
          publish();
        }
        funnel.notWritten = Math.max(0, funnel.eligible - attempted);

        // Today's room: the account's limit and the campaign's, whichever is tighter.
        const campaignRoom = Math.max(0, config.dailyLimit);
        const accountRoom = Math.max(0, state.allowance.remaining);
        funnel.readyToday = Math.min(funnel.prepared, campaignRoom, accountRoom);
        funnel.heldForTomorrow = funnel.prepared - funnel.readyToday;
        publish();

        const result: RunResult = { runId, campaignId, leadIds: runLeadIds, readyEmailIds, callLeadIds };
        if (stopping.current) {
          return void (await finish("stopped", `Stopped while writing — ${funnel.prepared} emails are ready to review.`, result));
        }
        await finish(
          "done",
          funnel.prepared > 0
            ? `${funnel.readyToday} emails ready to send today${funnel.heldForTomorrow ? ` · ${funnel.heldForTomorrow} held for tomorrow` : ""}.`
            : funnel.call > 0
              ? `No one to email this time — but ${funnel.call} good prospects are on your call list.`
              : "No one in this run can be contacted right now.",
          result,
        );
      } catch (error) {
        await finish("failed", friendlyServerError(error, "The run stopped unexpectedly."), null);
      } finally {
        active.current = false;
        stopping.current = false;
        onFinished?.();
      }
    },
    [enter, log, onFinished],
  );

  return { run, start, stop, reset, running: run.status === "running" };
}
