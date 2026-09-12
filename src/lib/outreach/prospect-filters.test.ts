import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { matchesProspectFilter, PROSPECT_FILTERS } from "../decision.ts";
import { checkEligibility, emptyContext } from "./eligibility.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";
import {
  ANY,
  NO_REFINEMENT,
  campaignsByLead,
  isRefined,
  matchesRefinement,
  refinementCount,
  refinementOptions,
  stagesByLead,
} from "./prospect-filters.ts";
import { lifecycleOf } from "./lifecycle.ts";

function lead(partial: Partial<Lead> = {}): Lead {
  return createLead({ id: "l1", businessName: "Test Joinery", town: "Perth", trade: "Joiner", ...partial });
}

function mail(partial: Partial<OutreachEmail> = {}): OutreachEmail {
  return {
    id: "e1", leadId: "l1", businessName: "Test Joinery", recipient: "a@b.co.uk",
    subject: "s", body: "b", status: "draft", kind: "initial", generatedBy: "ai",
    sendingAccount: "", gmailMessageId: "", gmailThreadId: "", error: "", attempts: 0,
    approvedAt: "", sentAt: "", repliedAt: "", createdAt: "", updatedAt: "",
    personalisationEvidence: "", campaignId: "", ...partial,
  };
}

const NO_CONTEXT = { stage: "DISCOVERED" as const, campaigns: new Set<string>() };

describe("the existing chips keep working", () => {
  it("still recognises every filter it recognised before", () => {
    for (const filter of PROSPECT_FILTERS) {
      const l = lead() as OutreachLead;
      const verdict = matchesProspectFilter(l, checkEligibility(l, emptyContext()), filter);
      assert.equal(typeof verdict, "boolean", `${filter} should still return a verdict`);
    }
    assert.ok(PROSPECT_FILTERS.includes("hot"));
    assert.ok(PROSPECT_FILTERS.includes("warm"));
    assert.ok(PROSPECT_FILTERS.includes("call"));
    assert.ok(PROSPECT_FILTERS.includes("skipped"));
  });
});

describe("matchesRefinement", () => {
  it("lets everything through when nothing is set", () => {
    assert.ok(matchesRefinement(lead(), NO_REFINEMENT, NO_CONTEXT));
    assert.equal(isRefined(NO_REFINEMENT), false);
    assert.equal(refinementCount(NO_REFINEMENT), 0);
  });

  it("filters by town and trade exactly", () => {
    const l = lead({ town: "Perth", trade: "Joiner" });
    assert.ok(matchesRefinement(l, { ...NO_REFINEMENT, town: "Perth" }, NO_CONTEXT));
    assert.equal(matchesRefinement(l, { ...NO_REFINEMENT, town: "Crieff" }, NO_CONTEXT), false);
    assert.ok(matchesRefinement(l, { ...NO_REFINEMENT, trade: "Joiner" }, NO_CONTEXT));
    assert.equal(matchesRefinement(l, { ...NO_REFINEMENT, trade: "Plumber" }, NO_CONTEXT), false);
  });

  it("filters by campaign, and excludes a lead in no campaign", () => {
    const inOne = { stage: "DISCOVERED" as const, campaigns: new Set(["c1"]) };
    assert.ok(matchesRefinement(lead(), { ...NO_REFINEMENT, campaign: "c1" }, inOne));
    assert.equal(matchesRefinement(lead(), { ...NO_REFINEMENT, campaign: "c2" }, inOne), false);
    assert.equal(matchesRefinement(lead(), { ...NO_REFINEMENT, campaign: "c1" }, NO_CONTEXT), false);
  });

  it("lets a prospect in two campaigns match either", () => {
    const both = { stage: "DISCOVERED" as const, campaigns: new Set(["c1", "c2"]) };
    assert.ok(matchesRefinement(lead(), { ...NO_REFINEMENT, campaign: "c1" }, both));
    assert.ok(matchesRefinement(lead(), { ...NO_REFINEMENT, campaign: "c2" }, both));
  });

  it("filters by lifecycle stage", () => {
    const sent = { stage: "SENT" as const, campaigns: new Set<string>() };
    assert.ok(matchesRefinement(lead(), { ...NO_REFINEMENT, stage: "SENT" }, sent));
    assert.equal(matchesRefinement(lead(), { ...NO_REFINEMENT, stage: "REPLIED" }, sent), false);
  });

  it("filters by website status and email confidence", () => {
    const noSite = lead({ website: "", websiteStatus: "No Website Found" });
    assert.ok(
      matchesRefinement(noSite, { ...NO_REFINEMENT, websiteStatus: "No Website Found" }, NO_CONTEXT),
    );
    assert.equal(
      matchesRefinement(noSite, { ...NO_REFINEMENT, websiteStatus: "Proper Website" }, NO_CONTEXT),
      false,
    );

    const high = lead({ email: "a@b.co.uk", emailConfidence: "HIGH" });
    assert.ok(matchesRefinement(high, { ...NO_REFINEMENT, emailConfidence: "HIGH" }, NO_CONTEXT));
    assert.equal(matchesRefinement(high, { ...NO_REFINEMENT, emailConfidence: "LOW" }, NO_CONTEXT), false);
  });

  it("treats a lead with no email as 'none' rather than any confidence", () => {
    const blank = lead({ email: "", emailConfidence: "HIGH" });
    assert.ok(matchesRefinement(blank, { ...NO_REFINEMENT, emailConfidence: "none" }, NO_CONTEXT));
    assert.equal(matchesRefinement(blank, { ...NO_REFINEMENT, emailConfidence: "HIGH" }, NO_CONTEXT), false);
  });

  it("stacks: every active refinement must pass", () => {
    const l = lead({ town: "Perth", trade: "Joiner" });
    assert.ok(matchesRefinement(l, { ...NO_REFINEMENT, town: "Perth", trade: "Joiner" }, NO_CONTEXT));
    assert.equal(
      matchesRefinement(l, { ...NO_REFINEMENT, town: "Perth", trade: "Plumber" }, NO_CONTEXT),
      false,
    );
  });

  it("counts how many refinements are active", () => {
    assert.equal(refinementCount({ ...NO_REFINEMENT, town: "Perth", trade: "Joiner" }), 2);
    assert.ok(isRefined({ ...NO_REFINEMENT, stage: "SENT" }));
  });
});

describe("refinementOptions", () => {
  it("offers only values that real leads have", () => {
    const leads = [lead({ id: "a", town: "Perth", trade: "Joiner" }), lead({ id: "b", town: "Crieff", trade: "Plumber" })];
    const options = refinementOptions(leads, () => "DISCOVERED");
    assert.deepEqual(options.towns, ["Crieff", "Perth"]);
    assert.deepEqual(options.trades, ["Joiner", "Plumber"]);
    assert.ok(!options.towns.includes("Glasgow"));
  });

  it("skips blank towns and trades rather than offering an empty chip", () => {
    const options = refinementOptions([lead({ town: "", trade: "" })], () => "DISCOVERED");
    assert.deepEqual(options.towns, []);
    assert.deepEqual(options.trades, []);
  });

  it("offers the stages actually present", () => {
    const options = refinementOptions(
      [lead({ id: "a" }), lead({ id: "b" })],
      (l) => (l.id === "a" ? "SENT" : "DISCOVERED"),
    );
    assert.deepEqual([...options.stages].sort(), ["DISCOVERED", "SENT"]);
  });
});

describe("campaignsByLead", () => {
  it("maps each lead to every campaign it is in", () => {
    const map = campaignsByLead([
      { campaignId: "c1", leadId: "a" },
      { campaignId: "c2", leadId: "a" },
      { campaignId: "c1", leadId: "b" },
    ]);
    assert.deepEqual([...map.get("a")!].sort(), ["c1", "c2"]);
    assert.deepEqual([...map.get("b")!], ["c1"]);
    assert.equal(map.get("c"), undefined);
  });
});

describe("stagesByLead", () => {
  it("computes the same stage the single-lead helper would", () => {
    const leads = [lead({ id: "a" }), lead({ id: "b" })];
    const emails = [mail({ leadId: "a", status: "sent", sentAt: "2026-01-01T00:00:00Z" })];
    const stages = stagesByLead(leads, emails);
    assert.equal(stages.get("a"), lifecycleOf(leads[0]!, emails));
    assert.equal(stages.get("a"), "SENT");
    assert.equal(stages.get("b"), "DISCOVERED");
  });

  it("never lets one lead's email set another lead's stage", () => {
    const stages = stagesByLead([lead({ id: "a" }), lead({ id: "b" })], [mail({ leadId: "a", status: "sent" })]);
    assert.equal(stages.get("b"), "DISCOVERED");
  });

  it("passes the automated verdict through when one is given", () => {
    const stages = stagesByLead([lead({ id: "a" })], [], new Map([["a", { level: "CALL" }]]));
    assert.equal(stages.get("a"), "CALL");
  });
});

describe("ANY is the neutral value everywhere", () => {
  it("uses the same sentinel in every field", () => {
    for (const value of Object.values(NO_REFINEMENT)) assert.equal(value, ANY);
  });
});
