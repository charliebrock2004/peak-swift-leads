import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { emptyContext } from "./eligibility.ts";
import { classifyRunLead, emptyFunnel, parseFunnel, reconcileFunnel, tallyOutcomes, websiteOutcome } from "./run-funnel.ts";
import type { OutreachLead } from "./types.ts";

const lead = (partial: Partial<Lead>): OutreachLead =>
  createLead({
    businessName: "Tay Joinery Ltd",
    trade: "Joiner",
    town: "Perth",
    phone: "01738 123456",
    websiteStatus: "No Website Found",
    ...partial,
  }) as OutreachLead;

describe("where each prospect ends up", () => {
  it("puts every lead in exactly one bucket, with opt-outs and closed deals first", () => {
    const context = emptyContext({ suppressed: new Set(["stop@x.co.uk"]) });
    assert.equal(classifyRunLead(lead({ email: "hi@tay.co.uk", emailConfidence: "HIGH", emailSource: "Contact page" }), context), "eligible");
    assert.equal(classifyRunLead(lead({}), context), "call");
    assert.equal(classifyRunLead(lead({ phone: "" }), context), "noWayToContact");
    assert.equal(classifyRunLead(lead({ email: "stop@x.co.uk", emailConfidence: "HIGH" }), context), "optedOut");
    assert.equal(classifyRunLead(lead({ callResult: "Booked", email: "hi@tay.co.uk", emailConfidence: "HIGH" }), context), "closed");
    assert.equal(classifyRunLead(lead({ websiteStatus: "Proper Website", website: "tay.co.uk", websiteQuality: "good" }), context), "goodWebsite");
    // A personal mailbox is an individual subscriber: ring them instead.
    assert.equal(
      classifyRunLead(lead({ email: "tay.joinery@gmail.com", emailConfidence: "HIGH", emailSource: "Contact page" }), context),
      "call",
    );
    // Not confirmed as a company: held until someone confirms it.
    assert.equal(
      classifyRunLead(lead({ businessName: "Tay Joinery", email: "hi@tay.co.uk", emailConfidence: "HIGH", emailSource: "Contact page" }), context),
      "manualReview",
    );
    assert.equal(classifyRunLead(lead({ lastEmailedAt: "2026-09-01T00:00:00.000Z", email: "hi@tay.co.uk", emailConfidence: "HIGH" }), context), "alreadyInTouch");
  });

  it("counts sum to the number of leads", () => {
    const leads = [lead({}), lead({ phone: "" }), lead({ email: "hi@tay.co.uk", emailConfidence: "HIGH", emailSource: "x" })];
    const tally = tallyOutcomes(leads, emptyContext());
    const { byLead, ...counts } = tally;
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), leads.length);
    assert.equal(byLead.size, leads.length);
  });

  it("classifies the website outcome", () => {
    assert.equal(websiteOutcome({ website: "", websiteStatus: "No Website Found" }, false), "none");
    assert.equal(websiteOutcome({ website: "facebook.com/tay", websiteStatus: "Social Only" }, false), "socialOrDirectory");
    assert.equal(websiteOutcome({ website: "tay.co.uk", websiteStatus: "Proper Website" }, true), "verified");
    assert.equal(websiteOutcome({ website: "tay.co.uk", websiteStatus: "Proper Website" }, false), "listed");
  });
});

describe("the funnel adds up, or says where it does not", () => {
  const good = () => ({
    ...emptyFunnel(),
    rawFound: 142,
    unique: 103,
    invalid: 30,
    duplicatesAcrossAreas: 9,
    alreadyKnown: 14,
    alreadyContacted: 2,
    suppressed: 1,
    needsReview: 9,
    newCandidates: 77,
    notNeeded: 27,
    selected: 50,
    checked: 50,
    websiteVerified: 12,
    websiteListed: 6,
    websiteSocialOrDirectory: 9,
    websiteNone: 23,
    emailsFound: 19,
    emailsHigh: 12,
    emailsMedium: 7,
    noEmail: 31,
    eligible: 15,
    call: 18,
    manualReview: 4,
    goodWebsite: 5,
    lowOpportunity: 3,
    noWayToContact: 5,
    prepared: 14,
    prepareFailed: 1,
    readyToday: 10,
    heldForTomorrow: 4,
  });

  it("accepts a funnel where every business leaves by one door", () => {
    assert.deepEqual(reconcileFunnel(good()), []);
  });

  it("names the equation a mystery loss breaks", () => {
    const broken = { ...good(), eligible: 16 };
    const problems = reconcileFunnel(broken);
    assert.equal(problems.length, 2);
    assert.match(problems.join("\n"), /every qualification outcome/);
    assert.match(problems.join("\n"), /eligible = written/);
  });

  it("does not demand numbers from stages a stopped run never reached", () => {
    assert.deepEqual(reconcileFunnel({ ...emptyFunnel(), rawFound: 40, unique: 30, invalid: 10, newCandidates: 30, selected: 30 }), []);
  });

  it("catches a listing with no outcome", () => {
    const problems = reconcileFunnel({ ...good(), alreadyKnown: 13 });
    assert.match(problems.join("\n"), /listings = invalid \+ duplicates/);
  });

  it("round-trips through storage and tolerates old runs", () => {
    assert.deepEqual(parseFunnel(JSON.stringify(good())), good());
    assert.equal(parseFunnel(""), null);
    assert.equal(parseFunnel("{not json"), null);
  });
});
