/**
 * Background jobs against the real schema (PGLite, every migration).
 *
 * The runner's promises — one runner per job, checkpoints that survive a
 * killed slice, retries that stop, cancels that tidy up — and a whole Find
 * run with the network scripted. Nothing here reaches the internet, and
 * nothing sends an email: drafting is a stub that records who it was asked
 * to write to.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import * as jobs from "./store.server.ts";
import { runJobs, runSlice, type HandlerLookup, type JobHandler } from "./runner.server.ts";
import { reconcileLedger } from "../discovery-ledger.ts";
import { findHandler, findInputProblem, sanitizeFindInput, type FindDeps } from "./find.server.ts";
import type { FindProgress, FindResult } from "./types.ts";
import { createLead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import type { Prospect } from "../research.ts";
import * as outreach from "../outreach/store.server.ts";
import { saveCompanyFacts } from "../contactability/store.server.ts";
import { runWebsiteAudit, type AuditNetwork } from "../audit/run.server.ts";
import type { PageFetch } from "../audit/fetch.server.ts";

const USER = "owner-1";
const OTHER = "owner-2";
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

async function expireLease(id: string) {
  await db.sql.query(`update jobs set lease_until = now() - interval '1 second' where id = $1`, [id]);
}

/** A handler that counts to `steps`, one step at a time. */
function counter(steps: number, options: { needs?: number; failOn?: number; calls?: number[] } = {}): JobHandler<{ steps: number }, { at: number }, { at: number; note?: string }, { total: number }> {
  return {
    init: () => ({ state: { at: 0 }, progress: { at: 0 } }),
    needs: () => options.needs ?? 0,
    cancel: async (_ctx, job) => ({ kind: "cancelled", state: job.state, progress: { ...job.progress, note: "stopped" } }),
    failed: async (_ctx, job, error) => ({ ...job.progress, note: `failed: ${error}` }),
    step: async (_ctx, job) => {
      options.calls?.push(job.state.at);
      if (options.failOn !== undefined && job.state.at === options.failOn) throw new Error("boom");
      const at = job.state.at + 1;
      if (at >= steps) return { kind: "done", state: { at }, progress: { at }, result: { total: at } };
      return { kind: "continue", state: { at }, progress: { at } };
    },
  };
}

const only = (handler: JobHandler<any, any, any, any>): HandlerLookup => async () => handler as unknown as JobHandler;

describe("job store", () => {
  it("starting the same job twice while it runs returns the first", async () => {
    const first = await jobs.createJob(db.sql, USER, { type: "find", input: { a: 1 }, idempotencyKey: "find" });
    const second = await jobs.createJob(db.sql, USER, { type: "find", input: { a: 2 }, idempotencyKey: "find" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.deepEqual(second.job.input, { a: 1 });
    // Another account's key is its own.
    const other = await jobs.createJob(db.sql, OTHER, { type: "find", input: {}, idempotencyKey: "find" });
    assert.equal(other.created, true);
  });

  it("once a job has finished, the same key starts a new one", async () => {
    const first = await jobs.createJob(db.sql, USER, { type: "reply_poll", input: {}, idempotencyKey: "reply_poll" });
    await runJobs(db.sql, { handlers: only(counter(1)), budgetMs: 10_000, userId: USER });
    assert.equal((await jobs.loadJob(db.sql, USER, first.job.id))?.status, "done");
    const again = await jobs.createJob(db.sql, USER, { type: "reply_poll", input: {}, idempotencyKey: "reply_poll" });
    assert.equal(again.created, true);
    assert.notEqual(again.job.id, first.job.id);
  });

  it("a leased job cannot be claimed twice; another user's job is never claimed for you", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    await jobs.createJob(db.sql, OTHER, { type: "find", input: {} });
    const claimed = await jobs.claimJob(db.sql, { userId: USER, leaseMs: 60_000 });
    assert.equal(claimed?.id, job.id);
    assert.equal(await jobs.claimJob(db.sql, { userId: USER, leaseMs: 60_000 }), null);
    const theirs = await jobs.claimJob(db.sql, { userId: OTHER, leaseMs: 60_000 });
    assert.equal(theirs?.userId, OTHER);
  });

  it("an abandoned job (lease expired while running) is reclaimed and counted as an attempt", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {}, maxAttempts: 3 });
    await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 });
    await expireLease(job.id);
    const again = await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 });
    assert.equal(again?.attempts, 1);
    await expireLease(job.id);
    await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 });
    await expireLease(job.id);
    // Third abandonment uses up the attempts: failed, not run again.
    assert.equal(await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }), null);
    const failed = await jobs.loadJob(db.sql, USER, job.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /repeated interruptions/);
  });

  it("a slice that lost its lease cannot overwrite the slice that took over", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    const stale = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
    await expireLease(job.id);
    const fresh = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
    await jobs.checkpoint(db.sql, fresh, { state: { at: 5 }, progress: { at: 5 }, leaseMs: 60_000 });
    await assert.rejects(jobs.checkpoint(db.sql, stale, { state: { at: 1 }, progress: { at: 1 }, leaseMs: 60_000 }), jobs.LostLease);
    assert.deepEqual((await jobs.loadJob(db.sql, USER, job.id))?.state, { at: 5 });
  });

  it("the browser's view carries no claim id", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    const claimed = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
    const view = jobs.toView(claimed);
    assert.equal(view.running, true);
    assert.equal(JSON.stringify(view).includes(claimed.claimId), false);
  });
});

describe("runner", () => {
  it("runs steps to the end, checkpointing each", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: { steps: 4 } });
    const out = await runJobs(db.sql, { handlers: only(counter(4)), budgetMs: 10_000, userId: USER });
    assert.deepEqual(out.ran.map((entry) => entry.outcome), ["done"]);
    const done = await jobs.loadJob(db.sql, USER, job.id);
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.result, { total: 4 });
    assert.ok(done?.finishedAt);
  });

  it("yields when the slice is out of time, and the next slice resumes — never restarts", async () => {
    const calls: number[] = [];
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    // Every step "needs" a minute, so each slice runs exactly one step.
    const handler = counter(3, { needs: 60_000, calls });
    for (let slice = 0; slice < 3; slice += 1) {
      const claimed = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
      await runSlice(db.sql, claimed, handler as unknown as JobHandler, 10_000);
    }
    assert.deepEqual(calls, [0, 1, 2]);
    assert.equal((await jobs.loadJob(db.sql, USER, job.id))?.status, "done");
  });

  it("a killed slice resumes from its last checkpoint", async () => {
    const calls: number[] = [];
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    const claimed = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
    await jobs.checkpoint(db.sql, claimed, { state: { at: 2 }, progress: { at: 2 }, leaseMs: 60_000 });
    // The function died here. Its lease runs out; the next runner picks up at 2.
    await expireLease(job.id);
    await runJobs(db.sql, { handlers: only(counter(4, { calls })), budgetMs: 10_000, jobId: job.id });
    assert.deepEqual(calls, [2, 3]);
    const done = await jobs.loadJob(db.sql, USER, job.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.attempts, 1);
  });

  it("a crashing step is retried with backoff, then failed for good with its error shown", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {}, maxAttempts: 2 });
    const handler = counter(5, { failOn: 1 });
    await runJobs(db.sql, { handlers: only(handler), budgetMs: 10_000, jobId: job.id });
    let row = await jobs.loadJob(db.sql, USER, job.id);
    assert.equal(row?.status, "queued");
    assert.equal(row?.attempts, 1);
    assert.ok(Date.parse(row!.runAfter) > Date.now() + 5_000, "retry is pushed back");
    // Not runnable until its backoff passes.
    assert.equal((await runJobs(db.sql, { handlers: only(handler), budgetMs: 10_000, jobId: job.id })).ran.length, 0);
    await db.sql.query(`update jobs set run_after = now() where id = $1`, [job.id]);
    await runJobs(db.sql, { handlers: only(handler), budgetMs: 10_000, jobId: job.id });
    row = await jobs.loadJob(db.sql, USER, job.id);
    assert.equal(row?.status, "failed");
    assert.equal(row?.error, "boom");
    assert.equal((row?.progress as { note?: string }).note, "failed: boom");
  });

  it("a cancel is honoured at the next checkpoint, tidily", async () => {
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    const handler = counter(10, { needs: 60_000 });
    await runJobs(db.sql, { handlers: only(handler), budgetMs: 10_000, jobId: job.id });
    assert.equal(await jobs.requestCancel(db.sql, USER, job.id), true);
    assert.equal(await jobs.requestCancel(db.sql, OTHER, job.id), false, "only the owner can stop it");
    await runJobs(db.sql, { handlers: only(handler), budgetMs: 10_000, jobId: job.id });
    const row = await jobs.loadJob(db.sql, USER, job.id);
    assert.equal(row?.status, "cancelled");
    assert.equal((row?.progress as { note?: string }).note, "stopped");
  });

  it("retention removes old finished jobs and leaves active ones", async () => {
    const old = await jobs.createJob(db.sql, USER, { type: "reply_poll", input: {} });
    await runJobs(db.sql, { handlers: only(counter(1)), budgetMs: 10_000, jobId: old.job.id });
    await db.sql.query(`update jobs set finished_at = now() - interval '40 days' where id = $1`, [old.job.id]);
    const active = await jobs.createJob(db.sql, USER, { type: "find", input: {} });
    await db.sql.query(`update jobs set created_at = now() - interval '40 days' where id = $1`, [active.job.id]);
    assert.equal(await jobs.pruneJobs(db.sql, 30), 1);
    assert.ok(await jobs.loadJob(db.sql, USER, active.job.id));
  });
});

// ── A whole Find run ─────────────────────────────────────────────────────────

const HOMEPAGE = `<html><head><title>Strathearn Roofing</title></head><body><p>Strathearn Roofing — roofing in Crieff. Call 01764 111111.</p><footer>© 2016</footer></body></html>`;

function auditNetwork(): AuditNetwork {
  return {
    fetchPage: async (): Promise<PageFetch> => ({ ok: true, status: 200, finalUrl: "https://strathearnroofing.co.uk/", redirects: [], html: HOMEPAGE, bytes: HOMEPAGE.length, responseMs: 900, contentType: "text/html" }),
    robots: async () => ({ found: false, disallowAll: false, sitemaps: [] }),
    sitemap: async () => false,
    links: async (urls) => ({ checked: urls.length, broken: [] }),
    pagespeed: async () => ({ ok: false, error: "not in tests", quota: false }),
  };
}

function prospect(over: Partial<Prospect>): Prospect {
  return {
    businessName: "",
    trade: "Roofer",
    town: "Crieff",
    address: "",
    phone: "",
    email: "",
    rating: "",
    reviews: "",
    website: "",
    mapsLink: "",
    websiteStatus: "No Website Found",
    notes: "",
    source: "OpenStreetMap",
    priority: "Medium",
    reason: "",
    lat: "",
    lng: "",
    placeId: "",
    foundAt: "",
    businessStatus: "",
    ...over,
  } as Prospect;
}

const LISTINGS = [
  prospect({ businessName: "Strathearn Roofing", website: "https://strathearnroofing.co.uk", websiteStatus: "Proper Website", phone: "01764 111111", placeId: "osm:1", address: "1 High St, Crieff PH7 3AA", reviews: 40, rating: 4.8 }),
  prospect({ businessName: "Comrie Roof Repairs", phone: "07700 900222", placeId: "osm:2", address: "Comrie PH6 2AA" }),
  prospect({ businessName: "Earn Valley Slaters", placeId: "osm:3", address: "Crieff PH7 4BB" }),
  prospect({ businessName: "Known Roofers", phone: "01764 333333", placeId: "osm:4", address: "Crieff PH7 5CC" }),
];

type Calls = { research: number; locations: string[]; findEmail: string[]; company: string[]; audit: string[]; generate: string[][] };

function fakeDeps(calls: Calls, listings = LISTINGS, down = false): FindDeps {
  return {
    research: async (input) => {
      calls.research += 1;
      calls.locations.push(input.location);
      if (down) return { ok: false, error: "Lead search is temporarily unavailable (Photon: HTTP 503). Try again in a minute." };
      const funnel = {
        queriesSent: 1,
        towns: [input.location],
        terms: ["roofer"],
        listings: listings.length + 1,
        rejected: { chain: 1, not_a_business: 0, wrong_trade: 0, outside_area: 0, inactive: 0 },
        rawBySource: { nominatim: listings.length, photon: 0, companiesHouse: 0, overpass: 0 },
        rawTotal: listings.length,
        unique: listings.length,
        duplicatesMerged: 0,
        withWebsite: listings.filter((item) => item.website).length,
        withoutWebsite: listings.filter((item) => !item.website).length,
        withListedEmail: 0,
        returned: listings.length,
      };
      return { ok: true, prospects: listings, location: input.location, businessType: "Roofer", funnel } as Awaited<ReturnType<FindDeps["research"]>>;
    },
    checkWebsite: async () => ({ ok: false, error: "offline in tests" }),
    findEmail: async (data) => {
      calls.findEmail.push(data.businessName);
      const discovery = { status: "NOT_FOUND", email: null, confidence: null, score: null, source: null, sourceUrl: "", evidence: "", reason: "NO_WEBSITE", sourcesChecked: [], attempts: 0, alternatives: [], nextAction: "CALL" };
      if (data.businessName === "Strathearn Roofing") {
        return {
          ok: true,
          found: { email: "info@strathearnroofing.co.uk", source: "Contact page", confidence: "HIGH" },
          foundAt: new Date().toISOString(),
          message: "",
          discovery: { ...discovery, status: "FOUND", email: "info@strathearnroofing.co.uk", reason: null, nextAction: "SEND" },
        } as unknown as Awaited<ReturnType<FindDeps["findEmail"]>>;
      }
      return { ok: true, found: null, foundAt: new Date().toISOString(), message: "", discovery } as unknown as Awaited<ReturnType<FindDeps["findEmail"]>>;
    },
    checkCompany: async (sql, userId, lead) => {
      calls.company.push(lead.businessName);
      const checkedAt = new Date().toISOString();
      if (lead.businessName === "Strathearn Roofing") {
        await saveCompanyFacts(sql, userId, lead.id, { companyNumber: "SC555555", companyType: "ltd", companyStatus: "active", checkedAt });
        return { status: "confirmed", companyNumber: "SC555555", legalName: lead.businessName, companyType: "ltd", companyStatus: "active", reasons: ["test"] };
      }
      await saveCompanyFacts(sql, userId, lead.id, { companyNumber: "", companyType: "", companyStatus: "", checkedAt });
      return { status: "no-match" };
    },
    audit: async (sql, userId, lead) => {
      calls.audit.push(lead.businessName);
      const audit = await runWebsiteAudit(sql, userId, lead, auditNetwork());
      return { status: audit.status, opportunity: audit.opportunity };
    },
    generate: async (data) => {
      calls.generate.push(data.leadIds);
      return { ok: true, rows: data.leadIds.map((leadId) => ({ leadId, ok: true, emailId: `draft-${leadId}`, subject: "Hello", body: "" })) };
    },
  };
}

const newCalls = (): Calls => ({ research: 0, locations: [], findEmail: [], company: [], audit: [], generate: [] });

/** Widening off: these tests follow one discovery through every later step. Widening has its own tests. */
const INPUT = { location: "Crieff", trades: ["Roofer"], target: 10, dailyLimit: 5, radiusMiles: 10, campaignId: "", campaignName: "Crieff roofers", widen: false };

async function seedKnown() {
  // Already on the sheet: re-found, never re-added.
  const known = createLead({ id: "known-1", businessName: "Known Roofers", trade: "Roofer", town: "Crieff", placeId: "osm:4", phone: "01764 333333" });
  const { text, params } = buildLeadUpsert(USER, [known]);
  await db.sql.query(text, params);
}

async function runToEnd(deps: FindDeps, jobId: string, budgetMs = 60_000, maxSlices = 40) {
  const handlers: HandlerLookup = async () => findHandler(deps) as unknown as JobHandler;
  for (let slice = 0; slice < maxSlices; slice += 1) {
    if (budgetMs >= 10_000) await runJobs(db.sql, { handlers, budgetMs, jobId });
    else {
      // Tiny budgets go straight to one slice: exactly one step, then yield.
      const claimed = await jobs.claimJob(db.sql, { jobId, leaseMs: 60_000 });
      if (claimed) await runSlice(db.sql, claimed, findHandler(deps) as unknown as JobHandler, budgetMs);
    }
    const job = await jobs.loadJob(db.sql, USER, jobId);
    if (job && job.status !== "queued" && job.status !== "running") return job;
  }
  throw new Error("Find job did not finish");
}

describe("the Find job", () => {
  it("validates its input", () => {
    const input = sanitizeFindInput({ location: " Crieff ", trades: ["Roofer", "Roofer", "x", "Joiner", "Plumber", "Builder", "Electrician"], target: 9999, dailyLimit: 999, campaignName: "C" }, 20);
    assert.deepEqual(input.trades, ["Roofer", "Joiner", "Plumber", "Builder"]);
    assert.equal(input.target, 200);
    assert.equal(input.dailyLimit, 20);
    assert.equal(findInputProblem(input), "Name the campaign.");
    assert.equal(findInputProblem({ ...input, location: "" }), "Choose an area.");
  });

  it("finds, saves, checks, enriches, scores and drafts — and sends nothing", async () => {
    await seedKnown();
    const calls = newCalls();
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT, idempotencyKey: "find" });
    const done = await runToEnd(fakeDeps(calls), job.id);
    assert.equal(done.status, "done", done.error);
    const progress = done.progress as FindProgress;
    const result = done.result as FindResult;

    // Three new businesses saved under fixed ids; the known one was not re-added.
    const leads = await outreach.loadLeads(db.sql, USER);
    assert.equal(leads.length, 4);
    assert.equal(leads.filter((lead) => lead.businessName === "Known Roofers").length, 1);
    assert.equal(progress.funnel.alreadyKnown, 1);
    assert.equal(progress.funnel.selected, 3);
    assert.deepEqual(progress.reconcileProblems, []);
    // Every listing has one outcome: 5 returned = 1 chain refused + 1 already yours + 3 new.
    assert.equal(progress.ledger.listings, 5);
    assert.equal(progress.ledger.outcomes.invalid, 1);
    assert.equal(progress.ledger.outcomes.in_database, 1);
    assert.equal(progress.ledger.outcomes.accepted, 3);
    assert.deepEqual(reconcileLedger(progress.ledger), []);
    assert.equal(progress.diagnosis, null, "a run with someone to contact needs no diagnosis");

    // The email it found was written onto the lead.
    const roofing = leads.find((lead) => lead.businessName === "Strathearn Roofing")!;
    assert.equal(roofing.email, "info@strathearnroofing.co.uk");
    assert.equal(roofing.emailConfidence, "HIGH");
    // Companies House confirmed it, and its website was audited.
    assert.equal(roofing.facts.companyNumber, "SC555555");
    assert.ok(roofing.facts.audit, "audited");
    assert.deepEqual(calls.audit, ["Strathearn Roofing"]);
    assert.equal(progress.enrichment.companiesConfirmed, 1);
    assert.equal(progress.enrichment.audited, 1);

    // Only the eligible business was drafted; drafting is not sending.
    assert.deepEqual(calls.generate.flat(), [roofing.id]);
    assert.equal(progress.funnel.prepared, 1);
    const sent = await db.sql.query(`select count(*)::int as n from outreach_emails where user_id = $1`, [USER]);
    assert.equal(sent[0]?.n, 0);

    // The summary answers "who do I contact, and how".
    assert.equal(result.summary.found, 3);
    assert.equal(result.summary.emailReady, 1);
    assert.ok(result.summary.callReady >= 1, "the sole trader with a phone is a call");
    assert.ok(result.top.length >= 1);
    assert.equal(result.top[0]!.businessName, "Strathearn Roofing");

    // A campaign was created, switched on, and holds the run's businesses.
    const campaigns = await outreach.loadCampaigns(db.sql, USER);
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0]!.status, "ACTIVE");
    // The run is on record as done.
    const run = await outreach.loadRunRow(db.sql, USER, result.runId);
    assert.equal(run?.status, "done");
  });

  it("run one step per slice, it reaches the same answer without repeating work", async () => {
    await seedKnown();
    const calls = newCalls();
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT });
    // 1ms budgets: every slice runs exactly one step, then yields.
    const done = await runToEnd(fakeDeps(calls), job.id, 1, 80);
    assert.equal(done.status, "done", done.error);
    assert.equal(calls.research, 1, "discovery ran once");
    assert.equal(new Set(calls.findEmail).size, calls.findEmail.length, "each business checked once");
    assert.equal((await outreach.loadLeads(db.sql, USER)).length, 4);
  });

  it("a slice killed after saving resumes without duplicating leads", async () => {
    const calls = newCalls();
    const deps = fakeDeps(calls);
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT });
    const handler = findHandler(deps) as unknown as JobHandler;
    // Run until the leads have been written (setup, discover, plan, write).
    for (let i = 0; i < 4; i += 1) {
      const claimed = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
      await runSlice(db.sql, claimed, handler, 1);
    }
    assert.equal((await outreach.loadLeads(db.sql, USER)).length, 4);
    // Now the platform kills a slice mid-verify: claimed, never released.
    await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 });
    await expireLease(job.id);
    const done = await runToEnd(deps, job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal((await outreach.loadLeads(db.sql, USER)).length, 4);
    assert.equal(calls.research, 1);
  });

  it("stopped part-way, it says how far it got and keeps what it saved", async () => {
    const calls = newCalls();
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT });
    const handler = findHandler(fakeDeps(calls)) as unknown as JobHandler;
    for (let i = 0; i < 5; i += 1) {
      const claimed = (await jobs.claimJob(db.sql, { jobId: job.id, leaseMs: 60_000 }))!;
      await runSlice(db.sql, claimed, handler, 1);
    }
    await jobs.requestCancel(db.sql, USER, job.id);
    const done = await runToEnd(fakeDeps(calls), job.id);
    assert.equal(done.status, "cancelled");
    const progress = done.progress as FindProgress;
    assert.equal(progress.status, "stopped");
    assert.match(progress.detail, /Stopped after saving/);
    assert.equal((await outreach.loadLeads(db.sql, USER)).length, 4);
    assert.equal(calls.generate.length, 0);
    const run = await outreach.loadRunRow(db.sql, USER, progress.runId);
    assert.equal(run?.status, "stopped");
  });

  it("nothing new is not Ready: it ends at de-duplication with the reason and every listing accounted for", async () => {
    await seedKnown();
    const calls = newCalls();
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT });
    const known = await runToEnd(fakeDeps(calls, [LISTINGS[3]!]), job.id);
    assert.equal(known.status, "done");
    const progress = known.progress as FindProgress;
    assert.equal(progress.status, "empty");
    assert.notEqual(progress.stage, "ready");
    assert.ok(!progress.completed.includes("ready"));
    assert.equal(progress.stage, "deduplicating");
    assert.match(progress.detail, /already yours/);
    assert.equal(progress.diagnosis?.stage, "deduplication");
    assert.deepEqual(progress.diagnosis?.exhausted.map((row) => row.area), ["Crieff"]);
    assert.equal(progress.ledger.outcomes.in_database, 1);
    assert.deepEqual(reconcileLedger(progress.ledger), []);
    const run = await outreach.loadRunRow(db.sql, USER, progress.runId);
    assert.equal(run?.status, "empty");
  });

  it("nothing at all is not Ready either: it ends at discovery and says the sources came back empty", async () => {
    const empty = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT });
    const none = await runToEnd(fakeDeps(newCalls(), []), empty.job.id);
    const progress = none.progress as FindProgress;
    assert.equal(progress.status, "empty");
    assert.equal(progress.diagnosis?.stage, "discovery");
    assert.equal(progress.stage, "discovering");
    assert.ok(progress.ledger.listings > 0, "the refused chain is still a listing");
    assert.deepEqual(reconcileLedger(progress.ledger), []);
  });

  it("every source down: failed, saying nothing was searched", async () => {
    const down = await jobs.createJob(db.sql, USER, { type: "find", input: INPUT });
    const failed = await runToEnd(fakeDeps(newCalls(), [], true), down.job.id);
    assert.equal(failed.status, "failed");
    const progress = failed.progress as FindProgress;
    assert.match(progress.detail, /every search failed/);
    assert.equal(progress.ledger.searches[0]?.error.includes("503"), true);
  });

  it("short of its target, a run searches further afield — never a town it already searched", async () => {
    const calls = newCalls();
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: { ...INPUT, widen: true } });
    const done = await runToEnd(fakeDeps(calls), job.id);
    assert.equal(done.status, "done", done.error);
    assert.ok(calls.locations.length > 1, "it widened");
    assert.equal(calls.locations[0], "Crieff");
    assert.equal(new Set(calls.locations).size, calls.locations.length, `searched twice: ${calls.locations.join(", ")}`);
    const progress = done.progress as FindProgress;
    // The same three businesses come back from every town: duplicates, not new and not "known".
    assert.equal(progress.ledger.outcomes.accepted, 4);
    assert.equal(progress.ledger.outcomes.in_database, 0);
    assert.ok(progress.ledger.duplicates.acrossAreas > 0);
    assert.deepEqual(reconcileLedger(progress.ledger), []);
    assert.ok(progress.log.some((event) => /further afield/.test(event.text)));
  });

  it("remembers what it searched: the next run starts somewhere new and rests a worked-out town", async () => {
    await seedKnown();
    const first = await jobs.createJob(db.sql, USER, { type: "find", input: { ...INPUT, location: "Perthshire", target: 8 } });
    const calls1 = newCalls();
    await runToEnd(fakeDeps(calls1, [LISTINGS[3]!]), first.job.id);
    const rows = await db.sql.query<{ area_key: string; exhausted_until: unknown; searches: number }>(`select area_key, exhausted_until, searches from search_coverage where user_id = $1`, [USER]);
    assert.equal(rows.length, calls1.locations.length);
    assert.ok(rows.every((row) => row.exhausted_until), "every town that found only known businesses is rested");

    const second = await jobs.createJob(db.sql, USER, { type: "find", input: { ...INPUT, location: "Perthshire", target: 8 } });
    const calls2 = newCalls();
    const done = await runToEnd(fakeDeps(calls2, [LISTINGS[3]!]), second.job.id);
    const overlap = calls2.locations.filter((town) => calls1.locations.includes(town));
    assert.deepEqual(overlap, [], "the second run did not repeat the first run's towns");
    assert.ok((done.progress as FindProgress).log.some((event) => /left out \d+ towns searched recently/.test(event.text)));
  });

  it("enrich mode checks businesses you already have — no search, no drafts", async () => {
    const calls = newCalls();
    const mine = [
      createLead({ id: "own-1", businessName: "Strathearn Roofing", trade: "Roofer", town: "Crieff", website: "https://strathearnroofing.co.uk", websiteStatus: "Proper Website", phone: "01764 111111" }),
      createLead({ id: "own-2", businessName: "Comrie Roof Repairs", trade: "Roofer", town: "Comrie", phone: "07700 900222" }),
    ];
    const { text, params } = buildLeadUpsert(USER, mine);
    await db.sql.query(text, params);
    const input = sanitizeFindInput({ mode: "enrich", leadIds: ["own-1", "own-2", "own-1"] }, 20);
    assert.deepEqual(input.leadIds, ["own-1", "own-2"]);
    assert.equal(findInputProblem(input), "");
    assert.equal(findInputProblem(sanitizeFindInput({ mode: "enrich", leadIds: [] })), "Choose some businesses to check.");
    const { job } = await jobs.createJob(db.sql, USER, { type: "find", input });
    const done = await runToEnd(fakeDeps(calls), job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal(calls.research, 0);
    assert.deepEqual([...calls.findEmail].sort(), ["Comrie Roof Repairs", "Strathearn Roofing"]);
    assert.equal(calls.generate.length, 0, "no drafts are written for businesses you already have");
    const progress = done.progress as FindProgress;
    assert.match(progress.detail, /^Checked 2 businesses/);
    assert.equal((await outreach.loadLead(db.sql, USER, "own-1"))?.email, "info@strathearnroofing.co.uk");
  });
});
