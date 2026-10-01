/**
 * Prospect-quality feedback and the workspace profile: every mark changes
 * what happens next by a rule you can read — scoring, the send gate, Find's
 * ranking and website matching — and nothing is learned behind your back.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { checkEligibility, emptyContext } from "../outreach/eligibility.ts";
import { sanitizeProfile, scoringProfile, effectiveProfile } from "../outreach/profile.ts";
import * as outreach from "../outreach/store.server.ts";
import type { OutreachLead } from "../outreach/types.ts";
import { rankProspects } from "../prospect-pool.ts";
import type { Prospect } from "../research.ts";
import { scoreProspect } from "../scoring/prospect-score.ts";
import { factsWith, searchedNoWebsite } from "../test-support/facts.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import { qualityBySource, sourceWeights, tradeAdvice, type FeedbackRow } from "./quality.ts";
import * as feedback from "./store.server.ts";
import { conflictsWith, parseVerdicts, type Verdict } from "./verdicts.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function lead(over: Partial<Lead> = {}, verdicts: Verdict[] = [], facts = factsWith()): OutreachLead {
  return {
    ...(createLead({
      id: "L",
      businessName: "Strathearn Joinery Ltd",
      trade: "Joiner",
      town: "Crieff",
      phone: "01764 223344",
      email: "hello@strathearnjoinery.co.uk",
      emailConfidence: "HIGH",
      emailSource: "Contact page",
      reviews: 30,
      rating: 4.8,
      ...over,
    }) as OutreachLead),
    facts: { ...facts, feedback: verdicts },
  };
}

const noSite = factsWith({ websiteEvidence: searchedNoWebsite({ checkedAt: ago(2) }) });
const company = factsWith({ websiteEvidence: searchedNoWebsite({ checkedAt: ago(2) }), companyNumber: "SC123456", companyStatus: "active", companyType: "ltd", companyCheckedAt: ago(3) });

describe("feedback in the score", () => {
  it("a rejected business is skipped, whatever else it has going for it", () => {
    for (const verdict of ["bad", "irrelevant", "not_in_trade", "wrong_business", "duplicate"] as Verdict[]) {
      const score = scoreProspect(lead({}, [verdict], noSite));
      assert.equal(score.action, "SKIP", verdict);
      assert.equal(score.band, "NONE");
      assert.match(score.actionReason, /^You marked it/);
    }
  });

  it("a good prospect gets a small, labelled lift", () => {
    const plain = scoreProspect(lead({}, [], noSite));
    const good = scoreProspect(lead({}, ["good"], noSite));
    assert.equal(good.value.score - plain.value.score, Math.min(10, 100 - plain.value.score));
    assert.ok(good.value.reasons.some((reason) => reason.source === "your feedback"));
  });

  it("'already has a good website' leaves nothing to offer", () => {
    const score = scoreProspect(lead({ website: "https://strathearnjoinery.co.uk" }, ["good_website"]));
    assert.equal(score.need.score, 5);
    assert.equal(score.action, "SKIP");
  });

  it("a website marked wrong is set aside, and so is an email on its domain — even once the site is cleared", () => {
    const facts = factsWith({ wrongWebsite: "https://strathearnjoinery.co.uk" });
    const onRecord = scoreProspect(lead({ website: "https://strathearnjoinery.co.uk" }, ["wrong_website"], facts));
    assert.equal(onRecord.action, "REVIEW");
    assert.ok(onRecord.blockers.includes("Find their real website"));
    assert.equal(onRecord.reach.email, "NONE");

    const cleared = scoreProspect(lead({ website: "" }, ["wrong_website"], { ...facts, websiteEvidence: noSite.websiteEvidence }));
    assert.notEqual(cleared.action, "REVIEW");
    assert.equal(cleared.reach.email, "NONE", "the address came from someone else's site");
    const elsewhere = scoreProspect(lead({ website: "", email: "info@realjoinery.co.uk" }, ["wrong_website"], { ...facts, websiteEvidence: noSite.websiteEvidence }));
    assert.notEqual(elsewhere.reach.email, "NONE");
  });

  it("contact details marked wrong are not used", () => {
    const score = scoreProspect(lead({}, ["wrong_contact"], noSite));
    assert.equal(score.reach.channel, "none");
    assert.equal(score.action, "SKIP");
  });
});

describe("feedback at the send gate", () => {
  const reasons = (subject: OutreachLead) => {
    const verdict = checkEligibility(subject, emptyContext());
    return verdict.eligible ? [] : verdict.reasons;
  };
  it("refuses a rejected business, wrong contact details and an email from the wrong website — for follow-ups too", () => {
    assert.ok(reasons(lead({}, ["not_in_trade"], company)).includes("rejected-by-you"));
    assert.ok(reasons(lead({}, ["wrong_contact"], company)).includes("wrong-contact"));
    assert.ok(reasons(lead({ website: "" }, ["wrong_website"], { ...company, wrongWebsite: "strathearnjoinery.co.uk" })).includes("wrong-website"));
    const followUp = checkEligibility(lead({}, ["duplicate"], company), emptyContext(), "follow-up-1");
    assert.ok(!followUp.eligible && followUp.reasons.includes("rejected-by-you"));
  });

  it("a good mark refuses nothing", () => {
    assert.ok(!reasons(lead({}, ["good"], company)).some((reason) => ["rejected-by-you", "wrong-contact", "wrong-website"].includes(reason)));
  });
});

describe("the workspace profile in the score", () => {
  it("email-only: a business you could only ring is skipped, with the reason", () => {
    const callOnly = lead({ email: "" }, [], noSite);
    assert.equal(scoreProspect(callOnly).action, "CALL");
    const score = scoreProspect(callOnly, { profile: { contactMethods: "email" } });
    assert.equal(score.action, "SKIP");
    assert.match(score.actionReason, /don't make first contact by phone/);
  });

  it("phone-only: never suggests an email", () => {
    const score = scoreProspect(lead({}, [], company), { profile: { contactMethods: "phone" } });
    assert.equal(score.action, "CALL");
    assert.equal(score.reach.channel, "call");
  });

  it("excluded and preferred trades, and a minimum job the trade rarely buys", () => {
    assert.equal(scoreProspect(lead({}, [], noSite), { profile: { excludedTrades: ["joiner"] } }).action, "SKIP");
    const takeaway = lead({ trade: "Takeaway" }, [], noSite);
    const base = scoreProspect(takeaway).value.score;
    assert.equal(scoreProspect(takeaway, { profile: { minimumProjectPounds: 2000 } }).value.score, base - 10);
    assert.equal(scoreProspect(takeaway, { profile: { preferredTrades: ["takeaway"] } }).value.reasons[0]?.source, "your profile");
  });

  it("the profile's lists, prices and contact method are cleaned and handed to scoring", () => {
    const { profile, problems } = sanitizeProfile({
      targetTrades: "Joiner, Roofer,, joiner",
      excludedTrades: "Takeaway\nPub",
      minimumProject: "£1,500",
      typicalProject: "2.5k",
      contactMethods: "EMAIL",
      examples: "Built a site for a roofer in Perth",
    });
    assert.deepEqual(problems, []);
    assert.equal(profile.targetTrades, "Joiner, Roofer");
    assert.equal(profile.typicalProject, "2500");
    const scoring = scoringProfile(effectiveProfile(profile));
    assert.deepEqual(scoring, { preferredTrades: [], excludedTrades: ["Takeaway", "Pub"], contactMethods: "email", minimumProjectPounds: 1500 });
    assert.equal(sanitizeProfile({ minimumProject: "a lot" }).problems[0]?.field, "minimumProject");
    assert.equal(scoringProfile(effectiveProfile(null)).contactMethods, "both");
  });
});

describe("measurable feedback", () => {
  const rows = (source: string, good: number, bad: number, trade = "Joiner"): FeedbackRow[] => [
    ...Array.from({ length: good }, (_, index) => ({ leadId: `${source}-g${index}`, verdict: "good" as Verdict, source, trade, town: "Perth" })),
    ...Array.from({ length: bad }, (_, index) => ({ leadId: `${source}-b${index}`, verdict: "not_in_trade" as Verdict, source, trade, town: "Perth" })),
  ];

  it("counts good vs rejected per source, and only weights a source once there are enough marks", () => {
    const marks = [...rows("Companies House", 1, 5), ...rows("OpenStreetMap", 6, 0), ...rows("OpenStreetMap (Overpass)", 1, 2)];
    const bySource = qualityBySource(marks);
    assert.deepEqual(bySource.find((row) => row.key === "companiesHouse"), { key: "companiesHouse", marked: 6, good: 1, rejected: 5, rejectedRate: { value: (5 / 6) * 100, numerator: 5, denominator: 6, smallSample: false } });
    assert.deepEqual(sourceWeights(marks), { companiesHouse: -10, photon: 5 });
  });

  it("a correction alone says nothing about quality", () => {
    assert.deepEqual(qualityBySource([{ leadId: "x", verdict: "wrong_website", source: "OpenStreetMap", trade: "Joiner", town: "Perth" }]), []);
  });

  it("warns about a trade search you mostly reject — not before", () => {
    assert.equal(tradeAdvice(rows("OpenStreetMap", 1, 3, "Kitchen"), "kitchen"), "");
    assert.match(tradeAdvice(rows("OpenStreetMap", 1, 5, "Kitchen"), "kitchen"), /You rejected 5 of 6 "Kitchen" prospects/);
  });

  it("Find ranks a source down by its weight, and never drops anything", () => {
    const prospect = (name: string, source: string): Prospect =>
      ({ businessName: name, trade: "Joiner", town: "Perth", phone: "01738 000000", email: "", address: "", rating: "", reviews: "", website: "", mapsLink: "", websiteStatus: "No Website Found", placeId: name, foundAt: "", businessStatus: "", source }) as unknown as Prospect;
    const list = [prospect("From registry", "Companies House"), prospect("From map", "OpenStreetMap")];
    assert.deepEqual(rankProspects(list).map((item) => item.businessName), ["From registry", "From map"]);
    assert.deepEqual(rankProspects(list, { sourceWeights: { companiesHouse: -10 } }).map((item) => item.businessName), ["From map", "From registry"]);
  });

  it("marks parse and conflict as stored", () => {
    assert.deepEqual(parseVerdicts("good,wrong_website,nonsense"), ["good", "wrong_website"]);
    assert.ok(conflictsWith("good").includes("bad"));
    assert.ok(conflictsWith("duplicate").includes("useful"));
    assert.deepEqual(conflictsWith("wrong_contact"), []);
  });
});

describe("feedback against the real schema", () => {
  const USER = "owner-1";
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  async function seed(over: Partial<Lead> = {}) {
    const row = createLead({ id: "l1", businessName: "Tayside Roofing", trade: "Roofer", town: "Perth", phone: "01738 440011", website: "https://taysideroofing.co.uk", source: "Companies House", ...over });
    const { text, params } = buildLeadUpsert(USER, [row]);
    await db.sql.query(text, params);
    return row;
  }

  it("marks ride along with the business, and the latest word stands", async () => {
    await seed();
    await feedback.setFeedback(db.sql, USER, { leadId: "l1", verdict: "bad", on: true });
    await feedback.setFeedback(db.sql, USER, { leadId: "l1", verdict: "wrong_contact", on: true });
    assert.deepEqual((await outreach.loadLead(db.sql, USER, "l1"))?.facts?.feedback, ["bad", "wrong_contact"]);
    const after = await feedback.setFeedback(db.sql, USER, { leadId: "l1", verdict: "good", on: true });
    assert.deepEqual(after.verdicts, ["good", "wrong_contact"], "good withdraws bad");
    await feedback.clearCorrected(db.sql, USER, "l1", { contact: true });
    assert.deepEqual(await feedback.verdictsFor(db.sql, USER, "l1"), ["good"]);
    const rows = await feedback.loadFeedback(db.sql, USER);
    assert.equal(rows[0]?.source, "Companies House", "the source is copied with the mark");
    assert.deepEqual(await feedback.loadFeedback(db.sql, "someone-else"), []);
    await assert.rejects(feedback.setFeedback(db.sql, "someone-else", { leadId: "l1", verdict: "bad", on: true }), /no longer exists/);
  });

  it("a rejected business stays known to Find after it is removed", async () => {
    await seed();
    await feedback.setFeedback(db.sql, USER, { leadId: "l1", verdict: "not_in_trade", on: true });
    await db.sql.query(`update leads set deleted_at = now() where user_id = $1 and id = 'l1'`, [USER]);
    const rejected = await feedback.rejectedIdentities(db.sql, USER);
    assert.equal(rejected[0]?.businessName, "Tayside Roofing");
    assert.equal(rejected[0]?.phone, "01738 440011");
  });

  it("an audit of a different site than the one on record is not the business's", async () => {
    await seed();
    await db.sql.query(
      `insert into website_audits (user_id, id, lead_id, url, status, opportunity, points, key_findings) values ($1, 'a1', 'l1', 'https://taysideroofing.co.uk', 'ok', 'strong', 20, '[]'::jsonb)`,
      [USER],
    );
    assert.equal((await outreach.loadLead(db.sql, USER, "l1"))?.facts?.audit?.id, "a1");
    await feedback.setFeedback(db.sql, USER, { leadId: "l1", verdict: "wrong_website", on: true });
    await db.sql.query(`update leads set website = '' where user_id = $1 and id = 'l1'`, [USER]);
    const lead = await outreach.loadLead(db.sql, USER, "l1");
    assert.equal(lead?.facts?.audit, null);
    assert.equal(lead?.facts?.wrongWebsite, "https://taysideroofing.co.uk");
  });
});
