import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { emptyContext, type EligibilityContext } from "./eligibility.ts";
import { composeFromTemplate, DEFAULT_TEMPLATES } from "./templates.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";
import { decideApproval, isReadyToSend, readyCount, READY_TO_SEND } from "./approval.ts";

function lead(partial: Partial<Lead> = {}): OutreachLead {
  return createLead({
    id: "l1",
    businessName: "Strathearn Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    phone: "01764 700000",
    address: "1 High Street, Crieff PH7 3AB",
    email: "hello@strathearnjoinery.co.uk",
    emailConfidence: "HIGH",
    emailSource: "website contact page",
    websiteStatus: "No Website Found",
    reviews: 40,
    rating: 4.6,
    ...partial,
  }) as OutreachLead;
}

/** A draft built from a real template, so the quality gate sees real copy. */
function email(partial: Partial<OutreachEmail> = {}): OutreachEmail {
  const composed = composeFromTemplate(lead(), DEFAULT_TEMPLATES[0]!);
  return {
    id: "e1",
    leadId: "l1",
    businessName: "Strathearn Joinery Ltd",
    recipient: "hello@strathearnjoinery.co.uk",
    subject: composed.subject,
    body: composed.body,
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

function approve(
  overrides: {
    email?: OutreachEmail | null;
    lead?: OutreachLead | null;
    context?: EligibilityContext;
    suppressed?: ReadonlySet<string>;
    decision?: "approve" | "queue" | "skip";
  } = {},
) {
  return decideApproval({
    decision: overrides.decision ?? "queue",
    email: overrides.email === undefined ? email() : overrides.email,
    lead: overrides.lead === undefined ? lead() : overrides.lead,
    context: overrides.context ?? emptyContext(),
    suppressed: overrides.suppressed ?? new Set<string>(),
  });
}

describe("approving one email", () => {
  it("stores it as queued, which is what the send batch picks up", () => {
    const outcome = approve();
    assert.equal(outcome.action, "store", outcome.action === "refuse" ? outcome.reason : "");
    assert.equal(outcome.action === "store" && outcome.status, "queued");
  });

  it("the status it stores is genuinely the one the queue reads", () => {
    const outcome = approve();
    assert.ok(outcome.action === "store");
    assert.ok(
      READY_TO_SEND.includes(outcome.status),
      `approve stored "${outcome.status}" but the queue only reads ${READY_TO_SEND.join(", ")}`,
    );
    assert.ok(isReadyToSend({ status: outcome.status }));
  });

  it("never sends anything itself — the furthest it goes is choosing a status", () => {
    const outcome = approve();
    assert.ok(outcome.action === "store");
    assert.notEqual(outcome.status, "sent");
    assert.notEqual(outcome.status, "sending");
  });

  it("is idempotent: approving an already-approved email succeeds again", () => {
    const first = approve({ email: email({ status: "approved" }) });
    assert.equal(first.action, "store");
    const second = approve({ email: email({ status: "queued" }) });
    assert.equal(second.action, "store");
    assert.equal(second.action === "store" && second.status, "queued");
  });

  it("keeps the campaign it belongs to — approval only changes status", () => {
    const outcome = approve({ email: email({ campaignId: "camp-1" }) });
    assert.equal(outcome.action, "store");
    // Nothing in the outcome can clear a campaign: the decision returns a
    // status and nothing else, so the stored campaign cannot be touched.
    assert.deepEqual(Object.keys(outcome).sort(), ["action", "status"]);
  });
});

describe("approving several emails", () => {
  it("decides each one on its own merits", () => {
    const good = approve({ email: email({ id: "a" }) });
    const sent = approve({ email: email({ id: "b", status: "sent" }) });
    const alsoGood = approve({ email: email({ id: "c" }) });
    assert.equal(good.action, "store");
    assert.equal(sent.action, "refuse");
    assert.equal(alsoGood.action, "store", "one refusal must not poison the rest of the batch");
  });
});

describe("what can never become ready to send", () => {
  it("an email that has already been sent", () => {
    const outcome = approve({ email: email({ status: "sent" }) });
    assert.equal(outcome.action, "refuse");
    assert.match(outcome.action === "refuse" ? outcome.reason : "", /already sent/i);
  });

  it("an email that has already been replied to", () => {
    assert.equal(approve({ email: email({ status: "replied" }) }).action, "refuse");
  });

  it("an email mid-flight, which would race the sender", () => {
    const outcome = approve({ email: email({ status: "sending" }) });
    assert.equal(outcome.action, "refuse");
    assert.match(outcome.action === "refuse" ? outcome.reason : "", /being sent/i);
  });

  it("a skipped email is not silently resurrected by an approve", () => {
    // A skipped email CAN be deliberately re-approved — that is the "changed my
    // mind" path — but it must pass every check again to get there.
    const revived = approve({ email: email({ status: "skipped" }) });
    assert.equal(revived.action, "store");
    const stillRefused = approve({
      email: email({ status: "skipped" }),
      lead: lead({ unsubscribed: "2026-01-01" }),
    });
    assert.equal(stillRefused.action, "refuse", "a skipped email cannot bypass eligibility");
  });

  it("a recipient who unsubscribed", () => {
    const outcome = approve({ lead: lead({ unsubscribed: "2026-01-01" }) });
    assert.equal(outcome.action, "refuse");
  });

  it("a recipient on the suppression list", () => {
    const outcome = approve({
      context: { ...emptyContext(), suppressed: new Set(["hello@strathearnjoinery.co.uk"]) },
      suppressed: new Set(["hello@strathearnjoinery.co.uk"]),
    });
    assert.equal(outcome.action, "refuse");
  });

  it("a business already contacted — duplicate protection still applies", () => {
    const outcome = approve({
      context: { ...emptyContext(), alreadyContacted: new Set(["l1"]) },
    });
    assert.equal(outcome.action, "refuse");
  });

  it("a business that said no", () => {
    assert.equal(approve({ lead: lead({ callResult: "Not Interested" }) }).action, "refuse");
  });

  it("an email whose draft fails the quality gate", () => {
    const outcome = approve({
      email: email({ body: "Hi. Your website is quite slow to load. Charlie, PeakSwiftStudio" }),
    });
    assert.equal(outcome.action, "refuse");
  });

  it("an email whose lead has been deleted", () => {
    const outcome = approve({ lead: null });
    assert.equal(outcome.action, "refuse");
    assert.match(outcome.action === "refuse" ? outcome.reason : "", /lead is gone/i);
  });
});

describe("an id that no longer resolves", () => {
  it("is REFUSED with a reason, never skipped silently", () => {
    // A silent skip returned `changed: 0, refused: []`, which the UI could only
    // render as the Approve button having done nothing whatsoever.
    const outcome = approve({ email: null });
    assert.equal(outcome.action, "refuse");
    assert.match(outcome.action === "refuse" ? outcome.reason : "", /no longer exists/i);
  });
});

describe("skipping", () => {
  it("always works on a live email, without needing to pass any check", () => {
    const outcome = approve({ decision: "skip", lead: lead({ unsubscribed: "2026-01-01" }) });
    assert.equal(outcome.action, "store");
    assert.equal(outcome.action === "store" && outcome.status, "skipped");
  });

  it("never happens to an email that already went out", () => {
    assert.equal(approve({ decision: "skip", email: email({ status: "sent" }) }).action, "refuse");
  });

  it("does not make anything ready to send", () => {
    const outcome = approve({ decision: "skip" });
    assert.ok(outcome.action === "store");
    assert.equal(isReadyToSend({ status: outcome.status }), false);
  });
});

describe("the ready-to-send count the Send button uses", () => {
  it("counts queued emails and nothing else", () => {
    assert.equal(
      readyCount([
        { status: "queued" },
        { status: "queued" },
        { status: "draft" },
        { status: "approved" },
        { status: "skipped" },
        { status: "sent" },
        { status: "failed" },
      ]),
      2,
    );
  });

  it("is zero when nothing has been approved", () => {
    assert.equal(readyCount([{ status: "draft" }, { status: "draft" }]), 0);
  });

  it("rises by one for each email approved", () => {
    const emails: { status: string }[] = [{ status: "draft" }, { status: "draft" }];
    assert.equal(readyCount(emails as never), 0);
    const first = approve();
    assert.ok(first.action === "store");
    emails[0] = { status: first.status };
    assert.equal(readyCount(emails as never), 1);
    const second = approve({ email: email({ id: "e2" }) });
    assert.ok(second.action === "store");
    emails[1] = { status: second.status };
    assert.equal(readyCount(emails as never), 2);
  });
});

describe("identifying the sender — every spelling of the studio's own name", () => {
  /** The sign-off the model actually writes, from a real Review screen. */
  const REAL_SIGNOFF = "PeakSwift Studio";

  function signedAs(studio: string): OutreachEmail {
    return email({
      body: [
        "Hi,",
        "",
        "I came across Strathearn Joinery Ltd while looking at joiners around Crieff",
        "and it doesn't look like you have a website yet.",
        "",
        `I'm Charlie — I run ${studio} and build small, fast sites for trades.`,
        "",
        "If you'd rather I didn't contact you again, just let me know and I won't.",
        "",
        "Charlie",
        studio,
      ].join("\n"),
    });
  }

  it("APPROVES the exact sign-off from the screenshot", () => {
    // "Charlie / PeakSwift Studio" was being refused as unidentified, because
    // "peakswift studio" does not contain the substring "peakswiftstudio".
    const outcome = approve({ email: signedAs(REAL_SIGNOFF) });
    assert.equal(
      outcome.action,
      "store",
      outcome.action === "refuse" ? outcome.reason : "",
    );
    assert.equal(outcome.action === "store" && outcome.status, "queued");
  });

  it("the screenshot email is genuinely ready to send once approved", () => {
    const outcome = approve({ email: signedAs(REAL_SIGNOFF) });
    assert.ok(outcome.action === "store");
    assert.ok(isReadyToSend({ status: outcome.status }));
    assert.equal(readyCount([{ status: outcome.status }]), 1);
  });

  it("accepts every harmless spelling of the studio", () => {
    for (const studio of [
      "PeakSwiftStudio",
      "PeakSwift Studio",
      "Peak Swift Studio",
      "Peak-Swift Studio",
      "peakswift studio",
      "PEAKSWIFT STUDIO",
      "PeakSwiftStudios",
    ]) {
      const outcome = approve({ email: signedAs(studio) });
      assert.equal(
        outcome.action,
        "store",
        `"${studio}" should identify the sender: ${outcome.action === "refuse" ? outcome.reason : ""}`,
      );
    }
  });

  it("STILL REFUSES an email that names somebody else instead", () => {
    for (const impostor of [
      "Acme Web Design",
      "Google",
      "Peak Studio",
      "Swift Studio",
      "Peak Mountain Studio",
      "Peak Digital Swift Studio",
      "Speak Swift Studio",
    ]) {
      const outcome = approve({ email: signedAs(impostor) });
      assert.equal(
        outcome.action,
        "refuse",
        `"${impostor}" is not this studio and must not identify it`,
      );
      assert.match(outcome.action === "refuse" ? outcome.reason : "", /does not identify/i);
    }
  });

  it("STILL REFUSES an email that identifies nobody at all", () => {
    const outcome = approve({
      email: email({
        body:
          "Hi, I build websites for trades around Crieff and thought Strathearn " +
          "Joinery Ltd might want one. If you'd rather I didn't contact you again, " +
          "just let me know and I won't.\n\nCharlie",
      }),
    });
    assert.equal(outcome.action, "refuse");
  });

  it("does not let a tolerant brand check smuggle a fabricated claim through", () => {
    // The identification fix must not become a way around the other rules.
    const outcome = approve({
      email: signedAs(REAL_SIGNOFF),
    });
    assert.equal(outcome.action, "store");
    const fabricated = approve({
      email: email({
        body: signedAs(REAL_SIGNOFF).body.replace(
          "it doesn't look like you have a website yet.",
          "your website is quite slow to load.",
        ),
      }),
    });
    assert.equal(fabricated.action, "refuse", "a fabricated speed claim is still refused");
    assert.match(
      fabricated.action === "refuse" ? fabricated.reason : "",
      /load speed/i,
      "and refused for the right reason",
    );
  });
});

describe("one Approve and a bulk Approve take the same path", () => {
  it("decides a single email and a batch by the identical function", () => {
    // The Review card's Approve and the bulk Approve both call
    // actions.decide(ids, "queue") -> setEmailDecision -> decideApproval, and
    // the card's own "cannot approve" note calls decideApproval too. Same
    // inputs must therefore give the same answer every way round.
    const one = email({ id: "a" });
    const single = approve({ email: one });
    const asBatch = [one, email({ id: "b" }), email({ id: "c" })].map((entry) =>
      approve({ email: entry }),
    );
    assert.equal(single.action, "store");
    for (const outcome of asBatch) {
      assert.equal(outcome.action, single.action);
      assert.equal(
        outcome.action === "store" && outcome.status,
        single.action === "store" && single.status,
      );
    }
  });

  it("a refusal in a batch matches what the card would have said", () => {
    const bad = email({ id: "x", status: "sent" });
    const inBatch = approve({ email: bad });
    const onCard = approve({ email: bad });
    assert.equal(inBatch.action, "refuse");
    assert.deepEqual(inBatch, onCard);
  });
});
