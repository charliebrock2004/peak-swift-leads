import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import type { OutreachEmail } from "./types.ts";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_TRANSITIONS,
  CAMPAIGN_TARGET_MAX,
  campaignCanRun,
  campaignLooksComplete,
  campaignProblem,
  campaignProgress,
  campaignStartProblem,
  campaignSummary,
  campaignTransitionProblem,
  canCampaignTransition,
  clampCampaign,
  newCampaign,
  splitList,
  type Campaign,
  type CampaignStatus,
} from "./campaigns.ts";

const LIMITS = { dailyMax: 30, batchMax: 10 };
const NOW = "2026-03-04T10:00:00.000Z";

function campaign(partial: Partial<Campaign> = {}): Campaign {
  return {
    ...newCampaign("c1", NOW),
    name: "Glasgow Joiners",
    locations: "Glasgow",
    trades: "Joiner",
    ...partial,
  };
}

function lead(partial: Partial<Lead> = {}): Lead {
  return createLead({ id: "l1", businessName: "Test Joinery", ...partial });
}

function mail(partial: Partial<OutreachEmail> = {}): OutreachEmail {
  return {
    id: "e1", leadId: "l1", businessName: "Test Joinery", recipient: "a@b.co.uk",
    subject: "s", body: "b", status: "draft", kind: "initial", generatedBy: "ai",
    sendingAccount: "", gmailMessageId: "", gmailThreadId: "", error: "", attempts: 0,
    approvedAt: "", sentAt: "", repliedAt: "", createdAt: NOW, updatedAt: NOW,
    personalisationEvidence: "",
    campaignId: "", ...partial,
  };
}

describe("campaign statuses", () => {
  it("has exactly the five statuses asked for", () => {
    assert.deepEqual([...CAMPAIGN_STATUSES], ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]);
    for (const status of CAMPAIGN_STATUSES) assert.ok(CAMPAIGN_STATUS_LABELS[status]);
  });

  it("supports start, pause and resume", () => {
    assert.ok(canCampaignTransition("DRAFT", "ACTIVE"), "start");
    assert.ok(canCampaignTransition("ACTIVE", "PAUSED"), "pause");
    assert.ok(canCampaignTransition("PAUSED", "ACTIVE"), "resume");
  });

  it("lets anything be archived and lets nothing come back", () => {
    for (const status of CAMPAIGN_STATUSES) {
      if (status === "ARCHIVED") continue;
      assert.ok(canCampaignTransition(status, "ARCHIVED"), `${status} should archive`);
    }
    for (const status of CAMPAIGN_STATUSES) {
      if (status === "ARCHIVED") continue;
      assert.equal(canCampaignTransition("ARCHIVED", status), false);
    }
    assert.deepEqual([...CAMPAIGN_TRANSITIONS.ARCHIVED], []);
  });

  it("does not reopen a completed campaign", () => {
    assert.equal(canCampaignTransition("COMPLETED", "ACTIVE"), false);
    assert.match(campaignTransitionProblem("COMPLETED", "ACTIVE"), /Start a new one/i);
    assert.match(campaignTransitionProblem("ARCHIVED", "ACTIVE"), /archived/i);
  });

  it("cannot jump straight from draft to paused", () => {
    assert.equal(canCampaignTransition("DRAFT", "PAUSED"), false);
    assert.equal(campaignTransitionProblem("DRAFT", "ACTIVE"), "");
  });

  it("only runs an active campaign", () => {
    assert.ok(campaignCanRun("ACTIVE"));
    for (const status of ["DRAFT", "PAUSED", "COMPLETED", "ARCHIVED"] as CampaignStatus[]) {
      assert.equal(campaignCanRun(status), false, `${status} must not run`);
    }
  });
});

describe("creating a campaign", () => {
  it("starts as a draft that cannot send", () => {
    const fresh = newCampaign("c9", NOW);
    assert.equal(fresh.status, "DRAFT");
    assert.equal(fresh.sendMode, "prepare");
    assert.equal(campaignCanRun(fresh.status), false);
  });

  it("refuses to save without a name, a location and a trade", () => {
    assert.match(campaignProblem(campaign({ name: "" })), /name/i);
    assert.match(campaignProblem(campaign({ locations: "" })), /location/i);
    assert.match(campaignProblem(campaign({ trades: "" })), /trade/i);
    assert.equal(campaignProblem(campaign()), "");
  });

  it("refuses to start a sending campaign with a daily target of zero", () => {
    assert.match(campaignStartProblem(campaign({ sendMode: "send", dailyTarget: 0 })), /daily target/i);
    assert.equal(campaignStartProblem(campaign({ sendMode: "prepare", dailyTarget: 0 })), "");
  });
});

describe("clampCampaign", () => {
  it("never lets a campaign raise a sending limit", () => {
    const big = clampCampaign({ id: "c1", dailyTarget: 5000, batchSize: 900 }, LIMITS, NOW);
    assert.equal(big.dailyTarget, LIMITS.dailyMax);
    assert.equal(big.batchSize, LIMITS.batchMax);
  });

  it("keeps a target inside the product range", () => {
    assert.equal(clampCampaign({ id: "c1", targetProspects: 99999 }, LIMITS, NOW).targetProspects, CAMPAIGN_TARGET_MAX);
    assert.equal(clampCampaign({ id: "c1", targetProspects: -4 }, LIMITS, NOW).targetProspects, 1);
    assert.equal(clampCampaign({ id: "c1", targetProspects: Number.NaN }, LIMITS, NOW).targetProspects, 50);
  });

  it("treats an unknown status and an unknown mode as the safe choice", () => {
    const odd = clampCampaign(
      { id: "c1", status: "BLASTING" as CampaignStatus, sendMode: "yolo" as Campaign["sendMode"] },
      LIMITS,
      NOW,
    );
    assert.equal(odd.status, "DRAFT");
    assert.equal(odd.sendMode, "prepare");
  });

  it("keeps the original creation time and moves the update time", () => {
    const later = "2026-04-01T00:00:00.000Z";
    const updated = clampCampaign({ id: "c1", createdAt: NOW }, LIMITS, later);
    assert.equal(updated.createdAt, NOW);
    assert.equal(updated.updatedAt, later);
  });
});

describe("splitList", () => {
  it("splits, trims and de-duplicates", () => {
    assert.deepEqual(splitList("Glasgow, Paisley ,glasgow"), ["Glasgow", "Paisley"]);
    assert.deepEqual(splitList("Joiner"), ["Joiner"]);
    assert.deepEqual(splitList(""), []);
    assert.deepEqual(splitList(" , , "), []);
  });

  it("stops at the cap", () => {
    assert.equal(splitList("a1, b1, c1, d1, e1, f1", 3).length, 3);
  });
});

describe("campaignProgress", () => {
  it("counts an untouched campaign as all zeros", () => {
    const progress = campaignProgress(campaign({ targetProspects: 100 }), [], []);
    assert.equal(progress.found, 0);
    assert.equal(progress.sent, 0);
    assert.equal(progress.replies, 0);
    assert.equal(progress.percent, 0);
  });

  it("counts the real funnel, and never a later stage above an earlier one", () => {
    const leads = [
      lead({ id: "a", email: "a@x.co.uk" }),
      lead({ id: "b", email: "b@x.co.uk" }),
      lead({ id: "c" }),
    ];
    const emails = [
      mail({ id: "e1", leadId: "a", status: "sent", sentAt: NOW }),
      mail({ id: "e2", leadId: "b", status: "draft" }),
    ];
    const progress = campaignProgress(campaign({ targetProspects: 10 }), leads, emails);
    assert.equal(progress.found, 3);
    assert.equal(progress.emailsFound, 2);
    assert.equal(progress.prepared, 2);
    assert.equal(progress.sent, 1);
    assert.ok(progress.prepared >= progress.sent, "prepared must never be below sent");
    assert.ok(progress.found >= progress.prepared, "found must never be below prepared");
  });

  it("counts a business once however many emails it was written", () => {
    const leads = [lead({ id: "a", email: "a@x.co.uk" })];
    const emails = [
      mail({ id: "e1", leadId: "a", status: "sent", sentAt: NOW }),
      mail({ id: "e2", leadId: "a", status: "sent", sentAt: NOW, kind: "follow-up-1" }),
    ];
    assert.equal(campaignProgress(campaign(), leads, emails).sent, 1);
  });

  it("counts replies, interested, booked and won from real outcomes only", () => {
    const leads = [
      lead({ id: "a" }),
      lead({ id: "b", callResult: "Interested" }),
      lead({ id: "c", callResult: "Booked" }),
      lead({ id: "d", callResult: "Won" }),
    ];
    const emails = [
      mail({ id: "e1", leadId: "a", status: "replied", sentAt: NOW, repliedAt: NOW }),
      mail({ id: "e2", leadId: "b", status: "replied", sentAt: NOW, repliedAt: NOW }),
    ];
    const progress = campaignProgress(campaign(), leads, emails);
    assert.equal(progress.replies, 4, "reply, interested, booked and won all followed a reply");
    assert.equal(progress.interested, 1);
    assert.equal(progress.booked, 1);
    assert.equal(progress.won, 1);
  });

  it("never invents a reply for a campaign that only prepared drafts", () => {
    const leads = [lead({ id: "a", email: "a@x.co.uk" })];
    const progress = campaignProgress(campaign(), leads, [mail({ leadId: "a", status: "draft" })]);
    assert.equal(progress.sent, 0);
    assert.equal(progress.replies, 0);
    assert.equal(progress.interested, 0);
    assert.equal(progress.booked, 0);
    assert.equal(progress.won, 0);
  });

  it("separates the call list from the skipped list", () => {
    const leads = [lead({ id: "a" }), lead({ id: "b" })];
    const decisions = new Map([
      ["a", { level: "CALL" }],
      ["b", { level: "SKIP" }],
    ]);
    const progress = campaignProgress(campaign(), leads, [], decisions);
    assert.equal(progress.call, 1);
    assert.equal(progress.skipped, 1);
  });

  it("caps the percentage at 100 rather than reporting 140% of a target", () => {
    const leads = Array.from({ length: 14 }, (_, i) => lead({ id: `l${i}` }));
    assert.equal(campaignProgress(campaign({ targetProspects: 10 }), leads, []).percent, 100);
    assert.equal(campaignProgress(campaign({ targetProspects: 20 }), leads, []).percent, 70);
  });

  it("does not divide by zero on a target of zero", () => {
    const progress = campaignProgress({ targetProspects: 0 }, [lead()], []);
    assert.ok(Number.isFinite(progress.percent));
    assert.equal(progress.percent, 100);
  });
});

describe("campaignLooksComplete", () => {
  const base = campaignProgress(campaign({ targetProspects: 10 }), [], []);

  it("is not complete before the target is reached", () => {
    assert.equal(campaignLooksComplete({ ...base, found: 4, sent: 4 }), false);
  });

  it("is not complete when prospects were found but never worked", () => {
    assert.equal(campaignLooksComplete({ ...base, found: 10, sent: 0 }), false);
  });

  it("is complete once every prospect has been sent, skipped or set aside to call", () => {
    assert.equal(campaignLooksComplete({ ...base, found: 10, sent: 6, skipped: 3, call: 1 }), true);
  });

  it("an empty campaign is never complete", () => {
    assert.equal(campaignLooksComplete({ ...base, found: 0 }), false);
  });
});

describe("campaignSummary", () => {
  it("reads as the brief asked", () => {
    const progress = { ...campaignProgress(campaign({ targetProspects: 100 }), [], []), found: 82, sent: 20, replies: 3 };
    assert.equal(campaignSummary(progress), "82 / 100 prospects · 20 sent · 3 replies");
  });

  it("uses the singular for one reply", () => {
    const progress = { ...campaignProgress(campaign({ targetProspects: 100 }), [], []), found: 1, sent: 1, replies: 1 };
    assert.match(campaignSummary(progress), /1 reply$/);
  });
});
