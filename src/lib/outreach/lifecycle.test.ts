import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import type { OutreachEmail } from "./types.ts";
import {
  CONTACTABLE_STAGES,
  LIFECYCLE_STAGES,
  STAGE_LABELS,
  TERMINAL_STAGES,
  TRANSITIONS,
  canTransition,
  lifecycleOf,
  resetsNeedManualAction,
  stageAllowsSending,
  tallyStages,
  transitionProblem,
  type LifecycleStage,
} from "./lifecycle.ts";
import { checkEligibility, emptyContext } from "./eligibility.ts";

function lead(partial: Partial<Lead> = {}): Lead {
  return createLead({ id: "l1", businessName: "Test Joinery", ...partial });
}

function mail(partial: Partial<OutreachEmail> = {}): OutreachEmail {
  return {
    id: "e1",
    leadId: "l1",
    businessName: "Test Joinery",
    recipient: "a@b.co.uk",
    subject: "s",
    body: "b",
    status: "draft",
    kind: "initial",
    generatedBy: "ai",
    sendingAccount: "",
    gmailMessageId: "",
    gmailThreadId: "",
    error: "",
    attempts: 0,
    approvedAt: "",
    sentAt: "",
    repliedAt: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    personalisationEvidence: "",
    campaignId: "",
    ...partial,
  };
}

describe("the stage table itself", () => {
  it("names every stage the brief asked for", () => {
    for (const stage of [
      "DISCOVERED", "QUALIFIED", "REVIEW", "APPROVED", "PREPARED", "QUEUED",
      "SENT", "REPLIED", "INTERESTED", "BOOKED", "WON", "NOT_INTERESTED",
      "UNSUBSCRIBED", "CALL", "SKIPPED",
    ]) {
      assert.ok(LIFECYCLE_STAGES.includes(stage as LifecycleStage), `${stage} is missing`);
    }
  });

  it("gives every stage a label and a transition list", () => {
    for (const stage of LIFECYCLE_STAGES) {
      assert.ok(STAGE_LABELS[stage], `${stage} has no label`);
      assert.ok(Array.isArray(TRANSITIONS[stage]), `${stage} has no transitions`);
    }
  });

  it("never names a destination that is not a real stage", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(LIFECYCLE_STAGES.includes(to), `${from} points at unknown stage ${to}`);
      }
    }
  });
});

describe("safe transitions", () => {
  it("allows the happy path end to end", () => {
    const path: LifecycleStage[] = [
      "DISCOVERED", "QUALIFIED", "REVIEW", "APPROVED", "PREPARED",
      "QUEUED", "SENT", "REPLIED", "INTERESTED", "BOOKED", "WON",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} → ${path[i + 1]} should be allowed`);
    }
  });

  it("allows the legitimate exits", () => {
    assert.ok(canTransition("REVIEW", "SKIPPED"));
    assert.ok(canTransition("QUALIFIED", "CALL"));
    assert.ok(canTransition("SENT", "NOT_INTERESTED"));
  });

  it("lets anyone still in play unsubscribe", () => {
    for (const stage of CONTACTABLE_STAGES) {
      assert.ok(canTransition(stage, "UNSUBSCRIBED"), `${stage} must be able to unsubscribe`);
    }
    assert.ok(canTransition("SENT", "UNSUBSCRIBED"));
    assert.ok(canTransition("REPLIED", "UNSUBSCRIBED"));
    assert.ok(canTransition("BOOKED", "UNSUBSCRIBED"));
  });

  it("NEVER lets an unsubscribed business be emailed again", () => {
    for (const stage of LIFECYCLE_STAGES) {
      if (stage === "UNSUBSCRIBED") continue;
      assert.equal(
        canTransition("UNSUBSCRIBED", stage),
        false,
        `UNSUBSCRIBED → ${stage} must be impossible`,
      );
    }
    assert.equal(canTransition("UNSUBSCRIBED", "SENT"), false);
    assert.equal(canTransition("UNSUBSCRIBED", "QUEUED"), false);
    assert.equal(canTransition("UNSUBSCRIBED", "QUALIFIED"), false);
  });

  it("NEVER lets a business that said no be emailed again", () => {
    assert.equal(canTransition("NOT_INTERESTED", "SENT"), false);
    assert.equal(canTransition("NOT_INTERESTED", "QUEUED"), false);
    assert.equal(canTransition("NOT_INTERESTED", "PREPARED"), false);
    assert.equal(canTransition("NOT_INTERESTED", "QUALIFIED"), false);
  });

  it("never reopens a won customer through outreach", () => {
    for (const stage of LIFECYCLE_STAGES) {
      if (stage === "WON") continue;
      assert.equal(canTransition("WON", stage), false, `WON → ${stage} must be impossible`);
    }
  });

  it("treats every terminal stage as a dead end that only a person can undo", () => {
    for (const stage of TERMINAL_STAGES) {
      assert.deepEqual([...TRANSITIONS[stage]], [], `${stage} must lead nowhere`);
      assert.ok(resetsNeedManualAction(stage));
    }
    assert.equal(resetsNeedManualAction("QUALIFIED"), false);
  });

  it("treats staying put as allowed, so a re-run is never an illegal move", () => {
    for (const stage of LIFECYCLE_STAGES) assert.ok(canTransition(stage, stage));
  });

  it("explains a refusal in words worth showing someone", () => {
    assert.equal(transitionProblem("QUALIFIED", "REVIEW"), "");
    assert.match(transitionProblem("UNSUBSCRIBED", "SENT"), /asked not to be contacted/i);
    assert.match(transitionProblem("NOT_INTERESTED", "SENT"), /deliberate manual change/i);
    assert.match(transitionProblem("WON", "SENT"), /already won/i);
    assert.match(transitionProblem("DISCOVERED", "SENT"), /does not lead to/i);
  });
});

describe("stageAllowsSending", () => {
  it("permits only stages that have not yet been contacted or closed", () => {
    for (const stage of CONTACTABLE_STAGES) assert.ok(stageAllowsSending(stage));
    for (const stage of ["SENT", "REPLIED", "INTERESTED", "BOOKED", "WON", "NOT_INTERESTED", "UNSUBSCRIBED", "CALL", "SKIPPED"] as LifecycleStage[]) {
      assert.equal(stageAllowsSending(stage), false, `${stage} must not allow sending`);
    }
  });
});

describe("lifecycleOf", () => {
  it("starts a brand new lead at DISCOVERED", () => {
    assert.equal(lifecycleOf(lead()), "DISCOVERED");
  });

  it("puts an unsubscribe above absolutely everything else", () => {
    const l = lead({ unsubscribed: "2026-01-01", callResult: "Won", outreachStatus: "Replied" });
    assert.equal(lifecycleOf(l, [mail({ status: "replied" })], { level: "HOT" }), "UNSUBSCRIBED");
    assert.equal(lifecycleOf(lead({ outreachStatus: "Unsubscribed" })), "UNSUBSCRIBED");
  });

  it("trusts what a person recorded over any email trail", () => {
    assert.equal(lifecycleOf(lead({ callResult: "Won" }), [mail({ status: "draft" })]), "WON");
    assert.equal(lifecycleOf(lead({ callResult: "Booked" }), [mail({ status: "sent" })]), "BOOKED");
    assert.equal(
      lifecycleOf(lead({ callResult: "Not Interested" }), [mail({ status: "sent" })]),
      "NOT_INTERESTED",
    );
  });

  it("reads the email trail when nobody has recorded a call outcome", () => {
    assert.equal(lifecycleOf(lead(), [mail({ status: "draft" })]), "PREPARED");
    assert.equal(lifecycleOf(lead(), [mail({ status: "approved" })]), "PREPARED");
    assert.equal(lifecycleOf(lead(), [mail({ status: "queued" })]), "QUEUED");
    assert.equal(lifecycleOf(lead(), [mail({ status: "sent" })]), "SENT");
    assert.equal(lifecycleOf(lead(), [mail({ status: "replied" })]), "REPLIED");
  });

  it("takes the furthest email, so a new follow-up draft never un-sends an email", () => {
    const emails = [mail({ id: "e1", status: "sent" }), mail({ id: "e2", status: "draft", kind: "follow-up-1" })];
    assert.equal(lifecycleOf(lead(), emails), "SENT");
  });

  it("ignores emails belonging to a different lead", () => {
    assert.equal(lifecycleOf(lead(), [mail({ leadId: "someone-else", status: "sent" })]), "DISCOVERED");
  });

  it("moves past REPLIED once a person says how the conversation went", () => {
    const emails = [mail({ status: "replied" })];
    assert.equal(lifecycleOf(lead(), emails), "REPLIED");
    assert.equal(lifecycleOf(lead({ callResult: "Interested" }), emails), "INTERESTED");
    assert.equal(lifecycleOf(lead({ callResult: "Booked" }), emails), "BOOKED");
  });

  it("falls back to the lead's own summary when there are no email rows", () => {
    assert.equal(lifecycleOf(lead({ outreachStatus: "Sent" })), "SENT");
    assert.equal(lifecycleOf(lead({ outreachStatus: "Followed up" })), "SENT");
    assert.equal(lifecycleOf(lead({ outreachStatus: "Replied" })), "REPLIED");
  });

  it("uses the automated verdict only when nothing else has an opinion", () => {
    assert.equal(lifecycleOf(lead(), [], { level: "HOT" }), "QUALIFIED");
    assert.equal(lifecycleOf(lead(), [], { level: "WARM" }), "QUALIFIED");
    assert.equal(lifecycleOf(lead(), [], { level: "CALL" }), "CALL");
    assert.equal(lifecycleOf(lead(), [], { level: "SKIP" }), "SKIPPED");
    assert.equal(lifecycleOf(lead(), [], { level: "HOT", reviewRequired: true }), "REVIEW");
  });

  it("never lets a verdict override a real contact record", () => {
    assert.equal(lifecycleOf(lead(), [mail({ status: "sent" })], { level: "SKIP" }), "SENT");
    assert.equal(lifecycleOf(lead({ unsubscribed: "x" }), [], { level: "HOT" }), "UNSUBSCRIBED");
  });

  it("only ever returns a stage that exists", () => {
    const cases = [
      lifecycleOf(lead()),
      lifecycleOf(lead({ callResult: "Wrong Number" })),
      lifecycleOf(lead({ called: "Not Interested" })),
      lifecycleOf(lead(), [mail({ status: "failed" })]),
    ];
    for (const stage of cases) assert.ok(LIFECYCLE_STAGES.includes(stage), `${stage} is not a stage`);
  });

  it("does not treat a failed send as contact", () => {
    assert.equal(lifecycleOf(lead(), [mail({ status: "failed" })]), "DISCOVERED");
  });
});

describe("tallyStages", () => {
  it("counts stages in lifecycle order and omits empty ones", () => {
    const tally = tallyStages(["SENT", "DISCOVERED", "SENT", "WON"]);
    assert.deepEqual(tally, [
      { stage: "DISCOVERED", count: 1 },
      { stage: "SENT", count: 2 },
      { stage: "WON", count: 1 },
    ]);
  });

  it("counts nothing as nothing", () => {
    assert.deepEqual(tallyStages([]), []);
  });
});

describe("the lifecycle agrees with the real eligibility gate", () => {
  // The transition table is the second lock; checkEligibility is the first and
  // runs on every send regardless. These prove the two never disagree in the
  // direction that matters: the lifecycle must never call a prospect
  // contactable that eligibility refuses on a safety ground.

  function sendable(partial: Partial<Lead> = {}) {
    return lead({
      email: "hello@testjoinery.co.uk",
      emailConfidence: "HIGH",
      emailSource: "Contact page",
      phone: "01764 700000",
      address: "1 High Street, Crieff PH7 3AB",
      website: "",
      websiteStatus: "No Website Found",
      reviews: 40,
      rating: 4.6,
      ...partial,
    });
  }

  it("agrees that an ordinary prospect is contactable", () => {
    const l = sendable();
    const eligibility = checkEligibility(l, emptyContext());
    assert.equal(
      eligibility.eligible,
      true,
      eligibility.eligible ? "" : eligibility.reasons.join(", "),
    );
    assert.ok(stageAllowsSending(lifecycleOf(l, [], { level: "HOT" })));
  });

  it("refuses an unsubscribed business at both locks", () => {
    const l = sendable({ unsubscribed: "2026-01-01" });
    assert.equal(checkEligibility(l, emptyContext()).eligible, false);
    assert.equal(lifecycleOf(l), "UNSUBSCRIBED");
    assert.equal(stageAllowsSending("UNSUBSCRIBED"), false);
  });

  it("refuses a business that said no at both locks", () => {
    const l = sendable({ callResult: "Not Interested" });
    assert.equal(checkEligibility(l, emptyContext()).eligible, false);
    assert.equal(lifecycleOf(l), "NOT_INTERESTED");
    assert.equal(stageAllowsSending("NOT_INTERESTED"), false);
  });

  it("refuses a won customer at both locks", () => {
    const l = sendable({ callResult: "Won" });
    assert.equal(checkEligibility(l, emptyContext()).eligible, false);
    assert.equal(stageAllowsSending(lifecycleOf(l)), false);
  });

  it("refuses a business that already replied at both locks", () => {
    const l = sendable({ outreachStatus: "Replied" });
    assert.equal(checkEligibility(l, emptyContext()).eligible, false);
    assert.equal(lifecycleOf(l), "REPLIED");
    assert.equal(stageAllowsSending("REPLIED"), false);
  });

  it("refuses a business already contacted at both locks", () => {
    const l = sendable();
    const contacted = { ...emptyContext(), alreadyContacted: new Set([l.id]) };
    assert.equal(checkEligibility(l, contacted).eligible, false);
    assert.equal(stageAllowsSending(lifecycleOf(l, [mail({ status: "sent" })])), false);
  });

  it("never calls a prospect contactable that eligibility refuses on a closed-out ground", () => {
    const closed: Partial<Lead>[] = [
      { unsubscribed: "2026-01-01" },
      { callResult: "Not Interested" },
      { called: "Not Interested" },
      { callResult: "Won" },
      { callResult: "Booked" },
      { outreachStatus: "Replied" },
      { outreachStatus: "Unsubscribed" },
    ];
    for (const partial of closed) {
      const l = sendable(partial);
      assert.equal(
        checkEligibility(l, emptyContext()).eligible,
        false,
        `eligibility should refuse ${JSON.stringify(partial)}`,
      );
      assert.equal(
        stageAllowsSending(lifecycleOf(l, [], { level: "HOT" })),
        false,
        `the lifecycle should also refuse ${JSON.stringify(partial)}`,
      );
    }
  });
});
