/**
 * The nine critical journeys, end to end, through the real code: the Find
 * job, the audit, scoring, composing, the approval gate, the send engine,
 * reply classification, the sales actions, Today, revenue analytics,
 * unsubscribe and feedback — against a real Postgres (PGLite) with every
 * migration applied.
 *
 * Only the outside world is faked: the map search, the website crawler and
 * Companies House inside Find, the website's HTML for the audit, and Gmail.
 * Nothing here can reach a real prospect.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runWebsiteAudit, type AuditNetwork } from "../audit/run.server.ts";
import type { PageFetch } from "../audit/fetch.server.ts";
import { saveCompanyFacts } from "../contactability/store.server.ts";
import { signUnsubscribe, verifyUnsubscribe } from "../crypto/secrets.server.ts";
import * as feedback from "../feedback/store.server.ts";
import { onRejectedDomain } from "../feedback/verdicts.ts";
import type { MessageMeta, SendResult, SentLookup } from "../gmail/client.server.ts";
import { findHandler, type FindDeps } from "../jobs/find.server.ts";
import { runJobs, type HandlerLookup, type JobHandler } from "../jobs/runner.server.ts";
import * as jobs from "../jobs/store.server.ts";
import type { FindResult } from "../jobs/types.ts";
import { findDuplicate } from "../identity-index.ts";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { decideApproval } from "../outreach/approval.ts";
import { autoContext } from "../outreach/auto-run.ts";
import { composeEmail } from "../outreach/compose.ts";
import { checkEligibility } from "../outreach/eligibility.ts";
import { classifyReply } from "../outreach/replies.ts";
import { sendOne, type EngineDeps, type GmailApi } from "../outreach/send-engine.server.ts";
import * as store from "../outreach/store.server.ts";
import { DEFAULT_SETTINGS, type OutreachLead } from "../outreach/types.ts";
import type { Prospect } from "../research.ts";
import { afterReply, logCall, setStage } from "../sales/actions.server.ts";
import { derivedStage, effectiveStage } from "../sales/pipeline.ts";
import { revenueAnalytics } from "../sales/revenue.ts";
import * as sales from "../sales/store.server.ts";
import { buildToday } from "../sales/today.ts";
import { scoreAll } from "../scoring/records.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";

const USER = "owner-1";
const SENDER = "studio@peakswift.example";
let db: TestDb;

// ── The outside world, faked ─────────────────────────────────────────────────

/** Gmail that records what it was asked to send, and never reaches anyone. */
class FakeGmail implements GmailApi {
  sent: { id: string; to: string; subject: string }[] = [];
  async sendMessage(_token: string, raw: string): Promise<SendResult> {
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const to = /^To: (.*)$/m.exec(text)?.[1] ?? "";
    const subject = /^Subject: (.*)$/m.exec(text)?.[1] ?? "";
    const id = `gm-${this.sent.length + 1}`;
    this.sent.push({ id, to, subject });
    return { ok: true, messageId: id, threadId: `th-${id}`, labelIds: ["SENT"] };
  }
  async findSentMessage(): Promise<SentLookup> {
    return { ok: true, found: false };
  }
  async getMessageMeta(_token: string, id: string): Promise<({ ok: true } & MessageMeta) | { ok: false; notFound: true; error: string; fatal: false; kind: "permanent" }> {
    return { ok: true, id, threadId: `th-${id}`, labelIds: ["SENT"], headers: {}, snippet: "", internalDate: "" };
  }
}
let gmail: FakeGmail;
const engine = (): EngineDeps => ({ sql: db.sql, userId: USER, gmail, token: async () => ({ ok: true, accessToken: "token", email: SENDER }) });
const send = (emailId: string) => sendOne(engine(), emailId, { settings: { ...DEFAULT_SETTINGS, dailyLimit: 10 }, profile: null });

const HOMEPAGE = `<html><head><title>Strathearn Roofing</title></head><body><p>Strathearn Roofing — roofing in Crieff. Call 01764 111111.</p><footer>© 2016</footer></body></html>`;
const auditNetwork = (): AuditNetwork => ({
  fetchPage: async (): Promise<PageFetch> => ({ ok: true, status: 200, finalUrl: "https://strathearnroofing.co.uk/", redirects: [], html: HOMEPAGE, bytes: HOMEPAGE.length, responseMs: 900, contentType: "text/html" }),
  robots: async () => ({ found: false, disallowAll: false, sitemaps: [] }),
  sitemap: async () => false,
  links: async (urls) => ({ checked: urls.length, broken: [] }),
  pagespeed: async () => ({ ok: false, error: "not in tests", quota: false }),
});

const listing = (over: Partial<Prospect>): Prospect =>
  ({ businessName: "", trade: "Roofer", town: "Crieff", address: "", phone: "", email: "", rating: "", reviews: "", website: "", mapsLink: "", websiteStatus: "No Website Found", notes: "", source: "OpenStreetMap", priority: "Medium", reason: "", lat: "", lng: "", placeId: "", foundAt: "", businessStatus: "", ...over }) as Prospect;

const LISTINGS = [
  listing({ businessName: "Strathearn Roofing", website: "https://strathearnroofing.co.uk", websiteStatus: "Proper Website", phone: "01764 111111", placeId: "osm:1", address: "1 High St, Crieff PH7 3AA", reviews: 40, rating: 4.8 }),
  listing({ businessName: "Comrie Roof Repairs", phone: "07700 900222", placeId: "osm:2", address: "Comrie PH6 2AA" }),
  listing({ businessName: "Earn Valley Slaters", placeId: "osm:3", address: "Crieff PH7 4BB" }),
];

function findDeps(listings = LISTINGS): FindDeps {
  return {
    research: async () =>
      ({
        ok: true,
        prospects: listings,
        location: "Crieff",
        businessType: "Roofer",
        funnel: {
          queriesSent: 1,
          towns: ["Crieff"],
          terms: ["roofer"],
          listings: listings.length,
          rejected: { chain: 0, not_a_business: 0, wrong_trade: 0, outside_area: 0, inactive: 0 },
          rawBySource: { nominatim: listings.length, photon: 0, companiesHouse: 0, overpass: 0 },
          rawTotal: listings.length,
          unique: listings.length,
          duplicatesMerged: 0,
          withWebsite: 1,
          withoutWebsite: listings.length - 1,
          withListedEmail: 0,
          returned: listings.length,
        },
      }) as Awaited<ReturnType<FindDeps["research"]>>,
    checkWebsite: async () => ({ ok: false, error: "offline in tests" }),
    findEmail: async (data) => {
      const discovery = { status: "NOT_FOUND", email: null, confidence: null, score: null, source: null, sourceUrl: "", evidence: "", reason: "NO_WEBSITE", sourcesChecked: [], attempts: 0, alternatives: [], nextAction: "CALL" };
      const found = data.businessName === "Strathearn Roofing";
      return {
        ok: true,
        found: found ? { email: "info@strathearnroofing.co.uk", source: "Contact page", confidence: "HIGH" } : null,
        foundAt: new Date().toISOString(),
        message: "",
        discovery: found ? { ...discovery, status: "FOUND", email: "info@strathearnroofing.co.uk", reason: null, nextAction: "SEND" } : discovery,
      } as unknown as Awaited<ReturnType<FindDeps["findEmail"]>>;
    },
    checkCompany: async (sql, userId, lead) => {
      const checkedAt = new Date().toISOString();
      const ltd = lead.businessName === "Strathearn Roofing";
      await saveCompanyFacts(sql, userId, lead.id, { companyNumber: ltd ? "SC555555" : "", companyType: ltd ? "ltd" : "", companyStatus: ltd ? "active" : "", checkedAt });
      return ltd ? { status: "confirmed", companyNumber: "SC555555", legalName: lead.businessName, companyType: "ltd", companyStatus: "active", reasons: ["test"] } : { status: "no-match" };
    },
    audit: async (sql, userId, lead) => {
      const audit = await runWebsiteAudit(sql, userId, lead, auditNetwork());
      return { status: audit.status, opportunity: audit.opportunity };
    },
    // Drafting is journey 2's business; Find's own draft step only records ids.
    generate: async (data) => ({ ok: true, rows: data.leadIds.map((leadId) => ({ leadId, ok: true, emailId: `draft-${leadId}`, subject: "", body: "" })) }),
  };
}

async function runFind(listings = LISTINGS) {
  const { job } = await jobs.createJob(db.sql, USER, { type: "find", input: { location: "Crieff", trades: ["Roofer"], target: 10, dailyLimit: 5, radiusMiles: 10, campaignId: "", campaignName: "Crieff roofers" } });
  const handlers: HandlerLookup = async () => findHandler(findDeps(listings)) as unknown as JobHandler;
  for (let slice = 0; slice < 40; slice += 1) {
    await runJobs(db.sql, { handlers, budgetMs: 60_000, jobId: job.id });
    const current = await jobs.loadJob(db.sql, USER, job.id);
    if (current && current.status !== "queued" && current.status !== "running") return current;
  }
  throw new Error("Find did not finish");
}

// ── Helpers over the real store ──────────────────────────────────────────────

async function addLead(over: Partial<Lead>): Promise<Lead> {
  const lead = createLead({ trade: "Joiner", town: "Crieff", emailConfidence: "HIGH", emailSource: "Contact page", websiteStatus: "No Website Found", phone: "01764 123456", ...over });
  const { text, params } = buildLeadUpsert(USER, [lead]);
  await db.sql.query(text, params);
  return lead;
}

/** A confirmed limited company whose website was searched for and not found: a clean email prospect. */
async function companyProspect(id: string, name = `Strathearn Joinery ${id}`): Promise<OutreachLead> {
  await addLead({ id, businessName: `${name} Ltd`, email: `hello@${id}-joinery.co.uk`, reviews: 30, rating: 4.8 });
  await saveCompanyFacts(db.sql, USER, id, { companyNumber: `SC${id.length}00001`, companyType: "ltd", companyStatus: "active", checkedAt: new Date().toISOString() });
  await db.sql.query(
    `insert into lead_evidence (user_id, lead_id, kind, data) values ($1, $2, 'website', $3)`,
    [USER, id, JSON.stringify({ url: "", verified: false, via: "SEARCH", score: null, confidence: "NONE", signals: [], candidatesChecked: 3, candidatesRejected: 3, searchProvider: "tavily", searchesRun: 2, checkedAt: new Date().toISOString(), queries: [], rejections: [], searchFailure: "" })],
  );
  return (await store.loadLead(db.sql, USER, id))!;
}

/** Compose, put through the approval gate exactly as the Send screen does, and store. */
async function draftAndReview(lead: OutreachLead): Promise<{ emailId: string; action: string; reason: string }> {
  const composed = await composeEmail(lead);
  const emailId = `email-${lead.id}`;
  await store.upsertDraft(db.sql, USER, { id: emailId, leadId: lead.id, businessName: lead.businessName, recipient: lead.email, subject: composed.subject, body: composed.body, kind: "initial", generatedBy: composed.generatedBy, status: "draft", campaignId: "" });
  const emails = await store.loadEmails(db.sql, USER);
  const suppressed = [...(await store.suppressedSet(db.sql, USER))];
  const outcome = decideApproval({
    decision: "approve",
    email: (await store.loadEmail(db.sql, USER, emailId))!,
    lead,
    context: autoContext(emails.filter((email) => email.id !== emailId), suppressed, DEFAULT_SETTINGS),
    suppressed: new Set(suppressed),
    studio: "PeakSwift Studio",
  });
  if (outcome.action !== "refuse") await store.setEmailStatus(db.sql, USER, emailId, "approved", { approved: true });
  return { emailId, action: outcome.action, reason: outcome.action === "refuse" ? outcome.reason : "" };
}

async function todayPlan(now = new Date()) {
  const [leads, emails, tasks, opportunities] = await Promise.all([store.loadLeads(db.sql, USER), store.loadEmails(db.sql, USER), sales.openTasks(db.sql, USER), sales.loadOpportunities(db.sql, USER)]);
  const scores = scoreAll(leads, { contacted: new Set(emails.filter((email) => email.status === "sent" || email.status === "replied").map((email) => email.leadId)) });
  return buildToday({ now, leads, scores, emails, tasks, opportunities, sendReady: 0, draftsToReview: 0, followUpEmailsDue: 0, calls: [] });
}

beforeEach(async () => {
  db = await createTestDb();
  gmail = new FakeGmail();
  await db.sql.query(`insert into gmail_accounts (user_id, email, status) values ($1, $2, 'connected')`, [USER, SENDER]);
});
afterEach(async () => {
  await db.close();
});

// ── The journeys ─────────────────────────────────────────────────────────────

describe("Journey 1 — Find → results → audit → score", () => {
  it("a Find run saves real businesses, audits the one with a site, and ranks them with reasons", async () => {
    const done = await runFind();
    assert.equal(done.status, "done", done.error);
    const leads = await store.loadLeads(db.sql, USER);
    assert.equal(leads.length, 3);
    const roofing = leads.find((lead) => lead.businessName === "Strathearn Roofing")!;
    assert.ok(roofing.facts?.audit, "the website was audited");
    assert.ok(roofing.facts!.audit!.keyFindings.length > 0, "with findings on record");
    const result = done.result as FindResult;
    assert.equal(result.top[0]!.businessName, "Strathearn Roofing");
    const scores = scoreAll(leads);
    const score = scores.get(roofing.id)!;
    assert.ok(score.why.some((reason) => reason.source === "website audit"), "the score cites the audit");
    assert.equal(score.reach.email, "ELIGIBLE");
    assert.equal(gmail.sent.length, 0, "Find never sends");
  });
});

describe("Journey 2 — Prospect → email → review → send → sent", () => {
  it("an evidence-backed draft passes review, goes through Gmail, and is recorded as sent only on Gmail's word", async () => {
    const lead = await companyProspect("j2");
    const { emailId, action, reason } = await draftAndReview(lead);
    assert.notEqual(action, "refuse", reason);
    const outcome = await send(emailId);
    assert.equal(outcome.status, "sent", "reason" in outcome ? String(outcome.reason) : "");
    const row = (await store.loadEmail(db.sql, USER, emailId))!;
    assert.equal(row.status, "sent");
    assert.equal(row.gmailMessageId, "gm-1");
    assert.equal(gmail.sent.length, 1);
    assert.match(gmail.sent[0]!.to, /hello@j2-joinery\.co\.uk/);
    const after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(derivedStage(after, [row]).stage, "CONTACTED");
    // The same email cannot be sent twice.
    assert.notEqual((await send(emailId)).status, "sent");
    assert.equal(gmail.sent.length, 1);
  });
});

describe("Journey 3 — Prospect → call → outcome → interaction → task", () => {
  it("logging an interested call records it, moves the sale and books the follow-up", async () => {
    const lead = await addLead({ id: "j3", businessName: "Comrie Roof Repairs", trade: "Roofer", phone: "07700 900222" });
    const out = await logCall(db.sql, USER, { leadId: lead.id, outcome: "interested", note: "Wants a quote for a new site", durationSeconds: 300 });
    assert.equal(out.interaction.type, "call");
    assert.equal(out.interaction.detail.note, "Wants a quote for a new site");
    assert.equal(out.task?.type, "FOLLOW_UP");
    assert.equal((await sales.loadOpportunity(db.sql, USER, lead.id))?.stage, "CONVERSATION");
    // Not today's job yet — and on the day it falls due, it is on Today.
    assert.ok(Date.parse(out.task!.dueAt) > Date.now());
    assert.ok(!(await todayPlan()).steps.some((step) => step.leadId === lead.id));
    const dueDay = new Date(Date.parse(out.task!.dueAt) + 60 * 60 * 1000);
    assert.ok((await todayPlan(dueDay)).steps.some((step) => step.leadId === lead.id), "the follow-up is on Today when it is due");
    assert.equal((await sales.loadTime(db.sql, USER)).find((entry) => entry.kind === "call")?.seconds, 300);
  });
});

describe("Journey 4 — Reply → classification → Today → opportunity", () => {
  it("a person's positive reply becomes the first thing on Today and a conversation in the pipeline", async () => {
    const lead = await companyProspect("j4");
    const { emailId } = await draftAndReview(lead);
    assert.equal((await send(emailId)).status, "sent");
    const reply = { from: "Moira <hello@j4-joinery.co.uk>", subject: "Re: your email", snippet: "Yes please — could you give me a call on Thursday afternoon to talk about it?" };
    const verdict = classifyReply(reply);
    assert.equal(verdict.kind, "human");
    assert.equal(verdict.intent, "positive");
    await store.markReplied(db.sql, USER, emailId, { ...reply, kind: verdict.kind, suggestion: verdict.suggestion, intent: verdict.intent });
    const task = await afterReply(db.sql, USER, { emailId, leadId: lead.id, businessName: lead.businessName, intent: verdict.intent, snippet: reply.snippet });
    assert.equal(task?.type, "REPLY");
    assert.equal(task?.priority, "high");
    const plan = await todayPlan();
    assert.equal(plan.steps[0]?.leadId, lead.id, "the reply leads the day");
    const emails = await store.loadEmails(db.sql, USER);
    const now = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(effectiveStage(await sales.loadOpportunity(db.sql, USER, lead.id), derivedStage(now, emails.filter((email) => email.leadId === lead.id)).stage), "CONVERSATION");
    assert.equal(gmail.sent.length, 1, "nothing is sent in answer automatically");
  });
});

describe("Journey 5 — Opportunity → quote → won → revenue analytics", () => {
  it("a quoted job won shows as money, a customer, and a full funnel", async () => {
    const lead = await addLead({ id: "j5", businessName: "Earn Valley Slaters", trade: "Roofer", phone: "01764 555555" });
    await logCall(db.sql, USER, { leadId: lead.id, outcome: "interested" });
    await setStage(db.sql, USER, { leadId: lead.id, stage: "QUOTE_SENT", valuePence: 240_000 });
    const quoted = await sales.openTasks(db.sql, USER);
    assert.ok(quoted.some((task) => task.type === "QUOTE"), "a chase is booked");
    await setStage(db.sql, USER, { leadId: lead.id, stage: "WON" });
    const revenue = revenueAnalytics({
      now: new Date(),
      leads: await store.loadLeads(db.sql, USER),
      reachable: () => true,
      emails: await store.loadEmails(db.sql, USER),
      opportunities: await sales.loadOpportunities(db.sql, USER),
      interactions: await sales.saleHistory(db.sql, USER),
      time: await sales.loadTime(db.sql, USER),
    });
    assert.equal(revenue.money.wonPence, 240_000);
    assert.equal(revenue.money.wonCount, 1);
    assert.deepEqual(revenue.funnel.map((step) => step.count), [1, 1, 1, 1, 1, 1, 1]);
    assert.equal(revenue.channels.find((row) => row.channel === "call")?.won, 1);
    assert.equal((await sales.openTasks(db.sql, USER)).filter((task) => task.leadId === lead.id).length, 0, "a won sale's tasks close");
  });
});

describe("Journey 6 — Unsubscribe → suppression → attempted send blocked", () => {
  it("the link in the email suppresses the address, and a later approved email to it is refused at send time", async () => {
    const lead = await companyProspect("j6");
    const { emailId } = await draftAndReview(lead);
    assert.equal((await send(emailId)).status, "sent");
    const token = signUnsubscribe({ userId: USER, email: lead.email, emailId });
    const verified = verifyUnsubscribe(token);
    assert.ok(verified.ok);
    await store.unsubscribeByLink(db.sql, USER, { email: verified.claim.email, emailId: verified.claim.emailId });
    assert.ok((await store.suppressedSet(db.sql, USER)).has(lead.email.toLowerCase()));
    // Someone approves another email to the same address anyway (say, from a stale screen).
    await store.upsertDraft(db.sql, USER, { id: "again", leadId: lead.id, businessName: lead.businessName, recipient: lead.email, subject: "Following up", body: "Hi", kind: "follow-up-1", generatedBy: "manual", status: "draft", campaignId: "" });
    await store.setEmailStatus(db.sql, USER, "again", "approved", { approved: true }).catch(() => undefined);
    const outcome = await send("again");
    assert.notEqual(outcome.status, "sent");
    assert.equal(gmail.sent.length, 1, "the suppressed address was never contacted again");
    // A tampered token is worthless.
    assert.equal(verifyUnsubscribe(token.replace(/.$/, (char) => (char === "a" ? "b" : "a"))).ok, false);
  });
});

describe("Journey 7 — Duplicate prospect → dedupe", () => {
  it("the same businesses found again are not added twice, and one you rejected never comes back", async () => {
    await runFind();
    assert.equal((await store.loadLeads(db.sql, USER)).length, 3);
    const again = await runFind([...LISTINGS, listing({ businessName: "STRATHEARN ROOFING", phone: "01764 111111", placeId: "osm:99" })]);
    assert.equal(again.status, "done", again.error);
    assert.equal((await store.loadLeads(db.sql, USER)).length, 3, "no duplicates, even spelled differently");
    // Mark one a duplicate, remove it, and search again: it stays out.
    const slaters = (await store.loadLeads(db.sql, USER)).find((lead) => lead.businessName === "Earn Valley Slaters")!;
    await feedback.setFeedback(db.sql, USER, { leadId: slaters.id, verdict: "duplicate", on: true });
    await db.sql.query(`update leads set deleted_at = now() where user_id = $1 and id = $2`, [USER, slaters.id]);
    await runFind();
    assert.equal((await store.loadLeads(db.sql, USER)).filter((lead) => lead.businessName === "Earn Valley Slaters").length, 0);
    // The same rule an import uses.
    const sheet = await store.loadLeads(db.sql, USER);
    assert.ok(findDuplicate({ businessName: "Comrie Roof Repairs", town: "Comrie", phone: "07700 900222", mapsLink: "" }, sheet));
  });
});

describe("Journey 8 — Wrong website → rejection", () => {
  it("a site you say is not theirs comes off, its email is not used, its audit is ignored, and it is never attached again", async () => {
    await runFind();
    const roofing = (await store.loadLeads(db.sql, USER)).find((lead) => lead.businessName === "Strathearn Roofing")!;
    assert.ok(roofing.facts?.audit);
    await feedback.setFeedback(db.sql, USER, { leadId: roofing.id, verdict: "wrong_website", on: true });
    // What the business page's action does next.
    await db.sql.query(`update leads set website = '', website_status = '', updated_at = now() where user_id = $1 and id = $2`, [USER, roofing.id]);
    const after = (await store.loadLead(db.sql, USER, roofing.id))!;
    assert.equal(after.facts?.audit, null, "the audit described someone else's site");
    assert.equal(after.facts?.wrongWebsite, "https://strathearnroofing.co.uk");
    const verdict = checkEligibility(after);
    assert.ok(!verdict.eligible && verdict.reasons.includes("wrong-website"), "the email found on that site is refused");
    assert.equal(scoreAll([after]).get(after.id)!.reach.email, "NONE");
    const marks = await feedback.loadFeedback(db.sql, USER);
    const rejected = marks.filter((mark) => mark.leadId === roofing.id && mark.verdict === "wrong_website").map((mark) => mark.website ?? "");
    assert.ok(onRejectedDomain("https://www.strathearnroofing.co.uk/contact", rejected.map((url) => new URL(url).hostname)), "website discovery skips it");
    assert.equal(onRejectedDomain("https://strathearn-roofing-crieff.co.uk", rejected.map((url) => new URL(url).hostname)), false);
  });
});

describe("Journey 9 — Unknown legal status → email blocked", () => {
  it("a business that may be a sole trader is held for a check, refused at review and at send, and offered as a call", async () => {
    const lead = await addLead({ id: "j9", businessName: "Davie's Joinery", email: "davie@daviesjoinery.co.uk", phone: "01764 999999" });
    const loaded = (await store.loadLead(db.sql, USER, lead.id))!;
    const eligibility = checkEligibility(loaded);
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.legal.form, "UNKNOWN");
    const { emailId, action } = await draftAndReview(loaded);
    assert.equal(action, "refuse", "review refuses it");
    // Forced into the queue anyway, the send engine still refuses it.
    await store.setEmailStatus(db.sql, USER, emailId, "approved", { approved: true });
    assert.notEqual((await send(emailId)).status, "sent");
    assert.equal(gmail.sent.length, 0);
    const score = scoreAll([loaded]).get(loaded.id)!;
    assert.notEqual(score.action, "EMAIL");
    assert.ok(score.reach.email === "HOLD" || score.reach.email === "BLOCKED");
  });
});
