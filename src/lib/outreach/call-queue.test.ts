import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { callQueue } from "./call-queue.ts";

const lead = (partial: Partial<Lead>) =>
  createLead({ businessName: "Tay Joinery", trade: "Joiner", town: "Perth", phone: "01738 123456", websiteStatus: "No Website Found", ...partial });

describe("the call list", () => {
  it("puts due follow-ups first, then the strongest uncalled prospects with no email", () => {
    const leads = [
      lead({ id: "fresh" }),
      lead({ id: "cb", called: "Callback", callResult: "Callback", followUpDate: "2026-09-29" }),
      lead({ id: "future", called: "Callback", callResult: "Callback", followUpDate: "2026-10-05" }),
    ];
    const queue = callQueue(leads, "2026-09-30");
    assert.deepEqual(queue.today.map((item) => item.lead.id), ["cb", "fresh"]);
    assert.equal(queue.today[0]!.reason, "Callback due");
    assert.deepEqual(queue.later.map((item) => item.lead.id), ["future"]);
  });

  it("never lists anyone who said no, opted out, was booked, won, or has no phone", () => {
    const leads = [
      lead({ id: "no", callResult: "Not Interested", called: "Not Interested" }),
      lead({ id: "unsub", unsubscribed: "yes" }),
      lead({ id: "won", callResult: "Won" }),
      lead({ id: "booked", callResult: "Booked", followUpDate: "2026-09-01" }),
      lead({ id: "nophone", phone: "" }),
      lead({ id: "wrong", callResult: "Wrong Number" }),
    ];
    const queue = callQueue(leads, "2026-09-30");
    assert.deepEqual([...queue.today, ...queue.later], []);
  });

  it("leaves prospects that can be emailed to the email workflow", () => {
    const emailable = lead({ id: "e", email: "hi@tay.co.uk", emailConfidence: "HIGH", emailSource: "Contact page" });
    assert.equal(callQueue([emailable], "2026-09-30").today.length, 0);
  });
});
