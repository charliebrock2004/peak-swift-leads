import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead } from "../leads.ts";
import type { Lead } from "../leads.ts";
import type { OutreachEmail } from "./types.ts";
import {
  RATE_MIN_SENT,
  formatRate,
  segmentsByTown,
  segmentsByTrade,
  whereToSearchNext,
} from "./analytics.ts";

function lead(id: string, town: string, trade: string, email = ""): Lead {
  return createLead({ id, businessName: id, town, trade, email });
}

function mail(id: string, leadId: string, status: OutreachEmail["status"]): OutreachEmail {
  return {
    id,
    leadId,
    businessName: leadId,
    recipient: "a@b.co.uk",
    subject: "s",
    body: "b",
    status,
    kind: "initial",
    generatedBy: "ai",
    sendingAccount: "",
    gmailMessageId: "",
    gmailThreadId: "",
    error: "",
    attempts: 0,
    approvedAt: "",
    sentAt: status === "sent" || status === "replied" ? "2026-01-01T00:00:00.000Z" : "",
    repliedAt: status === "replied" ? "2026-01-02T00:00:00.000Z" : "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    personalisationEvidence: "",
    campaignId: "",
  };
}

describe("segmentsByTown", () => {
  it("counts prospects, emails on file, sent and replies per town", () => {
    const leads = [
      lead("a", "Perth", "Joiner", "a@x.co.uk"),
      lead("b", "Perth", "Joiner"),
      lead("c", "Crieff", "Plumber", "c@x.co.uk"),
    ];
    const emails = [mail("e1", "a", "sent"), mail("e2", "c", "replied")];
    const towns = segmentsByTown(leads, emails);

    const perth = towns.find((t) => t.name === "Perth")!;
    assert.equal(perth.prospects, 2);
    assert.equal(perth.withEmail, 1);
    assert.equal(perth.sent, 1);
    assert.equal(perth.replies, 0);

    const crieff = towns.find((t) => t.name === "Crieff")!;
    assert.equal(crieff.sent, 1, "a replied email was also sent");
    assert.equal(crieff.replies, 1);
  });

  it("does not count queued, draft or failed emails as sent", () => {
    const leads = [lead("a", "Perth", "Joiner")];
    const emails = [mail("e1", "a", "draft"), mail("e2", "a", "queued"), mail("e3", "a", "failed")];
    const perth = segmentsByTown(leads, emails)[0]!;
    assert.equal(perth.sent, 0);
    assert.equal(perth.replies, 0);
  });

  it("refuses a reply rate until the sample is big enough", () => {
    const leads = Array.from({ length: 10 }, (_, i) => lead(`l${i}`, "Perth", "Joiner"));
    const few = leads.slice(0, RATE_MIN_SENT - 1).map((l, i) => mail(`e${i}`, l.id, "sent"));
    assert.equal(segmentsByTown(leads, few)[0]!.replyRate, null);

    const enough = leads.slice(0, RATE_MIN_SENT).map((l, i) => mail(`e${i}`, l.id, "sent"));
    assert.equal(segmentsByTown(leads, enough)[0]!.replyRate, 0, "zero replies is a real zero");
  });

  it("computes the rate from sent, not from prospects", () => {
    const leads = Array.from({ length: 100 }, (_, i) => lead(`l${i}`, "Perth", "Joiner"));
    const emails = leads
      .slice(0, 10)
      .map((l, i) => mail(`e${i}`, l.id, i < 2 ? "replied" : "sent"));
    const perth = segmentsByTown(leads, emails)[0]!;
    assert.equal(perth.sent, 10);
    assert.equal(perth.replies, 2);
    assert.equal(perth.replyRate, 20);
  });

  it("ignores leads with no town rather than inventing a blank segment", () => {
    const towns = segmentsByTown([lead("a", "", "Joiner"), lead("b", "Perth", "Joiner")], []);
    assert.deepEqual(
      towns.map((t) => t.name),
      ["Perth"],
    );
  });

  it("ignores an email whose lead is not in the sheet", () => {
    const towns = segmentsByTown([lead("a", "Perth", "Joiner")], [mail("e1", "ghost", "sent")]);
    assert.equal(towns[0]!.sent, 0);
  });

  it("puts the town that replies first, and never-emailed towns last", () => {
    const leads = [
      lead("a", "Perth", "Joiner"),
      lead("b", "Crieff", "Joiner"),
      ...Array.from({ length: 50 }, (_, i) => lead(`u${i}`, "Untouched", "Joiner")),
    ];
    const emails = [mail("e1", "a", "sent"), mail("e2", "b", "replied")];
    const names = segmentsByTown(leads, emails).map((t) => t.name);
    assert.equal(names[0], "Crieff");
    assert.equal(names[1], "Perth");
    assert.equal(names[2], "Untouched");
  });

  it("treats spelling with stray spaces as the same town", () => {
    const towns = segmentsByTown([lead("a", " Perth ", "Joiner"), lead("b", "Perth", "Joiner")], []);
    assert.equal(towns.length, 1);
    assert.equal(towns[0]!.prospects, 2);
  });
});

describe("segmentsByTrade", () => {
  it("splits the same leads by trade", () => {
    const leads = [
      lead("a", "Perth", "Joiner"),
      lead("b", "Crieff", "Joiner"),
      lead("c", "Perth", "Plumber"),
    ];
    const trades = segmentsByTrade(leads, [mail("e1", "c", "replied")]);
    assert.equal(trades[0]!.name, "Plumber");
    assert.equal(trades[0]!.replies, 1);
    assert.equal(trades.find((t) => t.name === "Joiner")!.prospects, 2);
  });
});

describe("whereToSearchNext", () => {
  it("says nothing at all until something has actually replied", () => {
    const leads = Array.from({ length: 20 }, (_, i) => lead(`l${i}`, "Perth", "Joiner"));
    const emails = leads.map((l, i) => mail(`e${i}`, l.id, "sent"));
    const towns = segmentsByTown(leads, emails);
    const trades = segmentsByTrade(leads, emails);
    assert.equal(whereToSearchNext(towns, trades), "");
    assert.equal(whereToSearchNext([], []), "");
  });

  it("names the best town and trade once there is evidence", () => {
    const leads = Array.from({ length: 10 }, (_, i) => lead(`l${i}`, "Perth", "Joiner"));
    const emails = leads.map((l, i) => mail(`e${i}`, l.id, i < 3 ? "replied" : "sent"));
    const line = whereToSearchNext(segmentsByTown(leads, emails), segmentsByTrade(leads, emails));
    assert.match(line, /Joiner in Perth/);
    assert.match(line, /3 replies from 10 sent/);
  });

  it("uses the singular for a single reply", () => {
    const leads = Array.from({ length: 6 }, (_, i) => lead(`l${i}`, "Perth", "Joiner"));
    const emails = leads.map((l, i) => mail(`e${i}`, l.id, i < 1 ? "replied" : "sent"));
    const line = whereToSearchNext(segmentsByTown(leads, emails), segmentsByTrade(leads, emails));
    assert.match(line, /1 reply from 6 sent/);
  });
});

describe("formatRate", () => {
  it("shows a dash rather than a fake zero when there is no rate", () => {
    assert.equal(formatRate(null), "—");
    assert.equal(formatRate(0), "0%");
    assert.equal(formatRate(20), "20%");
    assert.equal(formatRate(16.666), "17%");
  });
});
