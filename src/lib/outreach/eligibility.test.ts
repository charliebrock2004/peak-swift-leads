import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import {
  checkEligibility,
  emptyContext,
  looksLikeEmail,
  matchesFilter,
  needsManualReview,
  rankEligible,
} from "./eligibility.ts";
import type { OutreachLead } from "./types.ts";

/** A lead that passes every rule, so each test can break exactly one thing. */
function sendable(partial: Partial<Lead> = {}): OutreachLead {
  return createLead({
    businessName: "Strathearn Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    email: "hello@strathearnjoinery.co.uk",
    emailConfidence: "HIGH",
    emailSource: "website contact page",
    websiteStatus: "No Website Found",
    phone: "01764 652264",
    businessStatus: "Active",
    ...partial,
  }) as OutreachLead;
}

describe("email addresses", () => {
  it("accepts ordinary business addresses", () => {
    assert.ok(looksLikeEmail("hello@strathearnjoinery.co.uk"));
    assert.ok(looksLikeEmail("first.last+tag@example.com"));
  });

  it("rejects anything that is not one", () => {
    for (const bad of ["", "hello", "hello@", "@example.com", "a b@example.com", "hello@example", "hello@.com", "hello@ex..com"]) {
      assert.equal(looksLikeEmail(bad), false, `${bad} should be rejected`);
    }
  });
});

describe("who may be emailed", () => {
  it("lets through a qualified lead with a public email", () => {
    const result = checkEligibility(sendable());
    assert.equal(result.eligible, true);
    assert.equal(result.band, "High");
  });

  it("refuses a lead with no email", () => {
    const result = checkEligibility(sendable({ email: "", emailConfidence: "" }));
    assert.equal(result.eligible, false);
    assert.ok(!result.eligible && result.reasons.includes("no-email"));
  });

  it("refuses a LOW-confidence email", () => {
    const result = checkEligibility(sendable({ emailConfidence: "LOW" }));
    assert.ok(!result.eligible && result.reasons.includes("low-confidence"));
  });

  it("refuses an email that was guessed rather than found", () => {
    const result = checkEligibility(sendable({ emailSource: "guessed from domain" }));
    assert.ok(!result.eligible && result.reasons.includes("guessed-email"));
  });

  it("refuses anyone who has unsubscribed", () => {
    const result = checkEligibility(sendable({ unsubscribed: "2026-09-01T00:00:00.000Z" }));
    assert.ok(!result.eligible && result.reasons.includes("unsubscribed"));
  });

  it("refuses an address on the suppression list even if the lead looks fine", () => {
    const context = emptyContext({ suppressed: new Set(["hello@strathearnjoinery.co.uk"]) });
    const result = checkEligibility(sendable(), context);
    assert.ok(!result.eligible && result.reasons.includes("suppressed"));
  });

  it("refuses a lead already contacted, by id, by address, or by its own record", () => {
    const byId = checkEligibility(sendable({ id: "lead-1" }), emptyContext({ alreadyContacted: new Set(["lead-1"]) }));
    assert.ok(!byId.eligible && byId.reasons.includes("already-contacted"));

    const byAddress = checkEligibility(
      sendable(),
      emptyContext({ contactedAddresses: new Set(["hello@strathearnjoinery.co.uk"]) }),
    );
    assert.ok(!byAddress.eligible && byAddress.reasons.includes("already-contacted"));

    const byLead = checkEligibility(sendable({ lastEmailedAt: "2026-09-01T00:00:00.000Z" }));
    assert.ok(!byLead.eligible && byLead.reasons.includes("already-contacted"));
  });

  it("still allows a follow-up to someone already contacted", () => {
    const context = emptyContext({ alreadyContacted: new Set(["lead-1"]) });
    const result = checkEligibility(sendable({ id: "lead-1", lastEmailedAt: "2026-09-01T00:00:00.000Z" }), context, "follow-up-1");
    assert.equal(result.eligible, true, "follow-ups are for people you have already written to");
  });

  it("refuses everyone the funnel is finished with", () => {
    for (const [patch, reason] of [
      [{ callResult: "Not Interested" as const }, "not-interested"],
      [{ callResult: "Booked" as const }, "booked"],
      [{ callResult: "Won" as const }, "won"],
      [{ outreachStatus: "replied" }, "replied"],
    ] as const) {
      const result = checkEligibility(sendable(patch));
      assert.ok(!result.eligible && result.reasons.includes(reason as never), `${reason} should refuse`);
    }
  });

  it("refuses a business whose website is already good", () => {
    const result = checkEligibility(
      sendable({ websiteStatus: "Proper Website", website: "https://example.co.uk", websiteQuality: "good" }),
    );
    assert.ok(!result.eligible && result.reasons.includes("no-opportunity"));
  });

  it("holds LOW opportunity back unless it is explicitly asked for", () => {
    const lead = sendable({
      websiteStatus: "Proper Website",
      website: "https://example.co.uk",
      websiteQuality: "improve",
      email: "",
      phone: "",
      emailConfidence: "",
      businessStatus: "",
    });
    const held = checkEligibility(lead);
    assert.equal(held.band, "Low");
    assert.ok(!held.eligible && held.reasons.includes("low-opportunity"));

    // Turning it on removes that reason (the missing email still refuses).
    const opened = checkEligibility(lead, emptyContext({ settings: { includeLow: true } }));
    assert.ok(!opened.eligible && !opened.reasons.includes("low-opportunity"));
  });
});

describe("manual review", () => {
  it("holds a personal mailbox for review", () => {
    assert.ok(needsManualReview(sendable({ email: "j.smith@gmail.com" })));
    const result = checkEligibility(sendable({ email: "j.smith@gmail.com" }));
    assert.equal(result.eligible, false);
    assert.ok(!result.eligible && result.manualReview);
  });

  it("holds what looks like a sole trader trading under their own name", () => {
    assert.ok(needsManualReview(sendable({ businessName: "J Smith Joinery" })));
  });

  it("does not hold an incorporated company", () => {
    assert.equal(needsManualReview(sendable({ businessName: "Strathearn Joinery Ltd" })), false);
    assert.equal(needsManualReview(sendable({ businessName: "Highland Builders Limited" })), false);
  });

  it("never lets a held lead through as eligible", () => {
    const result = checkEligibility(sendable({ email: "j.smith@gmail.com" }));
    assert.equal(result.eligible, false, "manual review is a hold, not a green light");
  });
});

describe("ordering", () => {
  it("puts High opportunity first, then the strongest score", () => {
    const leads = [
      sendable({ id: "a", businessName: "Low Co Ltd", websiteStatus: "Proper Website", website: "https://a.co", websiteQuality: "improve" }),
      sendable({ id: "b", businessName: "Best Co Ltd", websiteStatus: "No Website Found", reviews: 40, rating: 4.8 }),
      sendable({ id: "c", businessName: "Mid Co Ltd", websiteStatus: "Social Only", website: "https://facebook.com/mid" }),
    ];
    const ranked = rankEligible(leads);
    assert.equal(ranked[0].lead.businessName, "Best Co Ltd");
    assert.ok(ranked.every((entry) => entry.eligibility.eligible));
  });

  it("leaves ineligible leads out entirely", () => {
    const ranked = rankEligible([sendable({ unsubscribed: "2026-01-01" })]);
    assert.equal(ranked.length, 0);
  });
});

describe("filters", () => {
  const lead = sendable({ websiteStatus: "No Website Found" });
  const eligibility = checkEligibility(lead);

  it("matches the bands and the website states", () => {
    assert.ok(matchesFilter(lead, eligibility, "all"));
    assert.ok(matchesFilter(lead, eligibility, "high"));
    assert.ok(matchesFilter(lead, eligibility, "no-website"));
    assert.ok(matchesFilter(lead, eligibility, "email-found"));
    assert.ok(matchesFilter(lead, eligibility, "never-contacted"));
    assert.equal(matchesFilter(lead, eligibility, "medium"), false);
    assert.equal(matchesFilter(lead, eligibility, "poor-website"), false);
  });

  it("finds leads held for manual review", () => {
    const held = sendable({ email: "j.smith@gmail.com" });
    assert.ok(matchesFilter(held, checkEligibility(held), "manual-review"));
  });
});
