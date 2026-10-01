import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyReply, decideThread, isAutoReply, isBounce, leadOutcomeForStage } from "./replies.ts";

const msg = (from: string, subject: string, snippet: string, headers: Record<string, string> = {}) => ({
  from,
  subject,
  snippet,
  headers,
});

describe("sorting what came back on a thread", () => {
  it("recognises a Gmail bounce, which is not a reply", () => {
    const bounce = msg(
      "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "Delivery Status Notification (Failure)",
      "Address not found Your message wasn't delivered to hello@x.co.uk because the address couldn't be found",
    );
    assert.equal(isBounce(bounce), true);
    assert.equal(classifyReply(bounce).kind, "bounce");
  });

  it("recognises an Exchange non-delivery report and the X-Failed-Recipients header", () => {
    assert.equal(isBounce(msg("postmaster@x.co.uk", "Undeliverable: Website?", "Delivery has failed")), true);
    assert.equal(isBounce(msg("someone@x.co.uk", "Re: hi", "", { "x-failed-recipients": "a@x.co.uk" })), true);
  });

  it("recognises out-of-office replies by header, subject and wording", () => {
    assert.equal(isAutoReply(msg("a@x.co.uk", "Re: Website?", "", { "auto-submitted": "auto-replied" })), true);
    assert.equal(isAutoReply(msg("a@x.co.uk", "Automatic reply: Website?", "")), true);
    assert.equal(isAutoReply(msg("a@x.co.uk", "Re: Website?", "I am currently out of the office until Monday.")), true);
    assert.equal(isAutoReply(msg("a@x.co.uk", "Re: Website?", "", { "auto-submitted": "no" })), false);
  });

  it("treats a person's reply as a reply, and suggests a stage", () => {
    assert.deepEqual(classifyReply(msg("Jim <jim@x.co.uk>", "Re: Website?", "Sounds good, how much would it cost?")), {
      kind: "human",
      suggestion: "interested",
      intent: "positive",
    });
    assert.equal(classifyReply(msg("jim@x.co.uk", "Re: Website?", "No thanks, we're sorted.")).suggestion, "not_interested");
    assert.equal(classifyReply(msg("jim@x.co.uk", "Re: Website?", "Could you pop in on Tuesday at 10?")).suggestion, "booked");
    assert.equal(classifyReply(msg("jim@x.co.uk", "Re: Website?", "Who gave you this address?")).suggestion, "needs_follow_up");
    assert.equal(classifyReply(msg("jim@x.co.uk", "Re: Website?", "Cheers")).suggestion, "new");
  });

  it("treats a request to stop as an unsubscribe", () => {
    assert.equal(classifyReply(msg("jim@x.co.uk", "Re: Website?", "Please remove me from your list")).kind, "unsubscribe");
  });

  it("lets a later human reply win over an earlier out-of-office", () => {
    const decided = decideThread([
      msg("jim@x.co.uk", "Automatic reply: Website?", "I'm on holiday"),
      msg("jim@x.co.uk", "Re: Website?", "Back now — yes, interested."),
    ]);
    assert.equal(decided?.verdict.kind, "human");
    assert.equal(decided?.verdict.suggestion, "interested");
  });

  it("reports an out-of-office alone as an auto-reply, not a conversation", () => {
    assert.equal(decideThread([msg("jim@x.co.uk", "Out of office", "Away until 3 October")])?.verdict.kind, "auto_reply");
    assert.equal(decideThread([]), null);
  });

  it("maps stages onto the lead record the rest of the app reads", () => {
    assert.deepEqual(leadOutcomeForStage("not_interested"), { called: "Not Interested", callResult: "Not Interested" });
    assert.equal(leadOutcomeForStage("booked")?.callResult, "Booked");
    assert.equal(leadOutcomeForStage("won")?.callResult, "Won");
    assert.equal(leadOutcomeForStage("new"), null);
  });
});

describe("what a reply meant", () => {
  const intent = (snippet: string, subject = "Re: Website?") => classifyReply(msg("jim@x.co.uk", subject, snippet)).intent;
  it("rules decide, in order", () => {
    assert.equal(intent("Sounds good — can you give me a ring?"), "positive");
    assert.equal(intent("Could you pop in on Tuesday at 10?"), "positive");
    assert.equal(intent("No thanks, we're sorted."), "negative");
    assert.equal(intent("Honestly it's too expensive for us."), "objection");
    assert.equal(intent("We get all our work through word of mouth."), "objection");
    assert.equal(intent("Maybe next year, we're flat out."), "later");
    assert.equal(intent("Too busy at the moment, try me after Christmas"), "later");
    assert.equal(intent("You'll want to speak to my partner Sarah about that."), "referral");
    assert.equal(intent("Wrong person I'm afraid, Dave left the company."), "wrong_person");
    assert.equal(intent("Who gave you this address?"), "neutral");
    assert.equal(intent("Please remove me from your list"), "unsubscribe");
    assert.equal(classifyReply(msg("jim@x.co.uk", "Out of office", "Away until 3 October")).intent, "ooo");
  });

  it("a plain no is a no, even with a time in it — unless it leaves the door open", () => {
    assert.equal(intent("Not interested, thanks."), "negative");
    assert.equal(intent("No thanks — not interested right now or next year."), "negative");
    assert.equal(intent("Not interested right now, but maybe next year."), "later");
  });
});
