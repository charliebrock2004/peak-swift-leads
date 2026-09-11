import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "./leads.ts";
import {
  decideProspect,
  describeBottleneck,
  isCallLead,
  matchesProspectFilter,
  needsAiReview,
  toProspectRecord,
  websiteGrade,
} from "./decision.ts";
import { checkEligibility, emptyContext } from "./outreach/eligibility.ts";

function lead(partial: Partial<Lead> = {}): Lead {
  return createLead({
    businessName: "ECG Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    phone: "01764 652264",
    websiteStatus: "No Website Found",
    businessStatus: "Active",
    called: "Not Called",
    ...partial,
  });
}

describe("website grades", () => {
  it("maps stored fields onto the sales grades", () => {
    assert.equal(websiteGrade("No Website Found", ""), "NO WEBSITE");
    assert.equal(websiteGrade("Directory Only", "poor"), "POOR");
    assert.equal(websiteGrade("Social Only", ""), "POOR");
    assert.equal(websiteGrade("Basic Website", "improve"), "BASIC");
    assert.equal(websiteGrade("Proper Website", "good"), "STRONG");
    assert.equal(websiteGrade("Proper Website", ""), "DECENT");
    assert.equal(websiteGrade("Unclear", "unable"), "UNKNOWN");
  });
});

describe("decideProspect", () => {
  it("makes a strong no-website business with a phone a CALL, not SKIP", () => {
    const decision = decideProspect(lead());
    assert.equal(decision.level, "CALL");
    assert.equal(decision.nextAction, "CALL");
    assert.ok(decision.reasons.some((reason) => /no website/i.test(reason)));
    assert.ok(decision.reasons.some((reason) => /no safe public email/i.test(reason)));
    assert.ok(decision.evidence.some((line) => /phone/i.test(line)));
    assert.equal(isCallLead(lead()), true);
  });

  it("treats a directory listing with a phone as a CALL", () => {
    const decision = decideProspect(
      lead({
        website: "https://www.yell.com/biz/ecg",
        websiteStatus: "Directory Only",
        websiteQuality: "poor",
        websiteAnalysis: "This is a directory listing, not a business website.",
      }),
    );
    assert.equal(decision.level, "CALL");
    assert.equal(decision.websiteGrade, "POOR");
    assert.ok(decision.reasons.some((reason) => /directory/i.test(reason)));
  });

  it("never invents an email — missing address is a reason, not a guess", () => {
    const decision = decideProspect(lead({ email: "", emailConfidence: "" }));
    assert.ok(decision.reasons.some((reason) => /never guessed/i.test(reason)));
    assert.notEqual(decision.nextAction, "EMAIL");
    assert.equal(decision.level, "CALL");
  });

  it("marks a high-opportunity business with a public email HOT", () => {
    const decision = decideProspect(
      lead({
        email: "info@ecgjoinery.co.uk",
        emailConfidence: "HIGH",
        emailSource: "Business website",
        websiteStatus: "No Website Found",
      }),
    );
    assert.equal(decision.level, "HOT");
    assert.equal(decision.nextAction, "EMAIL");
    assert.ok(decision.score >= 70);
  });

  it("skips a business whose website is already good", () => {
    const decision = decideProspect(
      lead({
        website: "https://ecgjoinery.co.uk",
        websiteStatus: "Proper Website",
        websiteQuality: "good",
        email: "hello@ecgjoinery.co.uk",
        emailConfidence: "HIGH",
        emailSource: "Business website",
      }),
    );
    assert.equal(decision.level, "SKIP");
    assert.equal(decision.nextAction, "SKIP");
  });

  it("skips a closed or unsubscribed lead even if the opportunity is high", () => {
    assert.equal(decideProspect(lead({ callResult: "Not Interested" })).level, "SKIP");
    assert.equal(decideProspect(lead({ unsubscribed: "2026-01-01" })).level, "SKIP");
    assert.equal(decideProspect(lead({ outreachStatus: "replied" })).level, "SKIP");
    assert.equal(decideProspect(lead({ callResult: "Won" })).level, "SKIP");
  });

  it("holds an uncertain sole-trader-shaped lead for review rather than sending", () => {
    const decision = decideProspect(
      lead({
        businessName: "J Smith Joinery",
        email: "john@gmail.com",
        emailConfidence: "MEDIUM",
        emailSource: "Business website (other mailbox)",
        websiteStatus: "Basic Website",
      }),
    );
    assert.equal(decision.reviewRequired, true);
    assert.equal(needsAiReview(lead({
      businessName: "J Smith Joinery",
      email: "john@gmail.com",
      emailConfidence: "MEDIUM",
      emailSource: "Business website (other mailbox)",
      websiteStatus: "Basic Website",
    })), true);
  });
});

describe("bottleneck copy", () => {
  it("names the missing-email pile when that is the story", () => {
    const calls = [decideProspect(lead()), decideProspect(lead({ businessName: "Other Ltd", phone: "01764 111111" }))];
    assert.match(describeBottleneck(calls), /no public email/i);
  });
});

describe("the structured prospect record", () => {
  it("maps existing lead fields rather than inventing a second model", () => {
    const record = toProspectRecord(lead({ email: "", websiteStatus: "No Website Found" }));
    assert.equal(record.businessName, "ECG Joinery Ltd");
    assert.equal(record.location, "Crieff");
    assert.equal(record.opportunityLevel, "CALL");
    assert.equal(record.nextAction, "CALL");
    assert.equal(record.websiteGrade, "NO WEBSITE");
    assert.ok(record.qualificationConfidence > 0);
  });
});

describe("prospect filters", () => {
  it("puts a no-email joiner on CALL, not SKIPPED", () => {
    const row = lead();
    const eligibility = checkEligibility(row as never, emptyContext());
    assert.equal(matchesProspectFilter(row, eligibility, "call"), true);
    assert.equal(matchesProspectFilter(row, eligibility, "skipped"), false);
    assert.equal(matchesProspectFilter(row, eligibility, "hot"), false);
  });
});
