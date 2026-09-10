import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import {
  buildMimeMessage,
  buildRawMessage,
  decodeBase64Url,
  encodeHeader,
  formatAddress,
  sanitizeHeaderValue,
} from "../gmail/mime.ts";
import { buildAuthUrl, clientIdProblem, expiryFrom, hasRequiredScopes, isFatalAuthError, needsRefresh, SCOPE_STRING } from "../gmail/oauth.ts";
import { computeStats } from "./dashboard.ts";
import { emptyContext } from "./eligibility.ts";
import { followUpDueFor, followUpsDue } from "./follow-ups.ts";
import { allowance, dayKey, describeAllowance, nextBatch, sanitizeSettings, sentToday } from "./limits.ts";
import { DEFAULT_SETTINGS, type OutreachEmail, type OutreachLead, type OutreachSettings } from "./types.ts";

function email(partial: Partial<OutreachEmail> = {}): OutreachEmail {
  return {
    id: "e1",
    leadId: "l1",
    businessName: "Strathearn Joinery Ltd",
    recipient: "hello@strathearnjoinery.co.uk",
    subject: "A website?",
    body: "Hello",
    status: "queued",
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
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
    ...partial,
  };
}

function lead(partial: Partial<Lead> = {}): OutreachLead {
  return createLead({
    id: "l1",
    businessName: "Strathearn Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    email: "hello@strathearnjoinery.co.uk",
    emailConfidence: "HIGH",
    emailSource: "website contact page",
    websiteStatus: "No Website Found",
    ...partial,
  }) as OutreachLead;
}

const settings = (partial: Partial<OutreachSettings> = {}): OutreachSettings => ({
  ...DEFAULT_SETTINGS,
  ...partial,
});

describe("building the message Gmail sends", () => {
  it("produces headers and a base64 body", () => {
    const mime = buildMimeMessage({
      to: "hello@example.co.uk",
      from: "PeakSwiftStudio@gmail.com",
      fromName: "PeakSwift Studio",
      subject: "A website for you",
      body: "Hello there",
    });
    assert.match(mime, /^To: hello@example\.co\.uk\r\n/);
    assert.match(mime, /From: PeakSwift Studio <PeakSwiftStudio@gmail\.com>/);
    assert.match(mime, /Content-Transfer-Encoding: base64/);
    const body = mime.split("\r\n\r\n")[1];
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "Hello there");
  });

  it("refuses to let a newline create a new header", () => {
    // Header injection: without stripping, this would add a real Bcc.
    const mime = buildMimeMessage({
      to: "hello@example.co.uk\r\nBcc: victim@example.com",
      from: "me@example.com",
      subject: "Hi\r\nX-Evil: yes",
      body: "Body",
    });
    // The injected text survives as inert content on the To line; what must
    // never happen is it becoming a header of its own.
    const headerBlock = mime.split("\r\n\r\n")[0];
    const headerNames = headerBlock.split("\r\n").map((line) => line.split(":")[0]);
    assert.deepEqual(headerNames, ["To", "From", "Subject", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
    assert.equal(headerBlock.split("\r\n").some((line) => /^Bcc:/i.test(line)), false);
    assert.equal(headerBlock.split("\r\n").some((line) => /^X-Evil:/i.test(line)), false);
    assert.equal(sanitizeHeaderValue("a\r\nb"), "a b");
  });

  it("encodes a non-ASCII subject rather than putting it in raw", () => {
    const encoded = encodeHeader("Café £50");
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.equal(encodeHeader("Plain ascii"), "Plain ascii");
  });

  it("round-trips through base64url", () => {
    const raw = buildRawMessage({ to: "a@b.co", from: "c@d.co", subject: "Hi", body: "Line one\nLine two" });
    assert.equal(/[+/=]/.test(raw), false, "base64url has no +, / or padding");
    assert.match(decodeBase64Url(raw), /^To: a@b\.co/);
  });

  it("formats a display name only when there is one", () => {
    assert.equal(formatAddress("a@b.co"), "a@b.co");
    assert.equal(formatAddress("a@b.co", "Studio"), "Studio <a@b.co>");
  });
});

describe("the OAuth URL", () => {
  const url = buildAuthUrl({ clientId: "cid", redirectUri: "https://app.example/oauth/gmail", state: "s1" });

  it("asks for offline access and consent, or the connection dies in an hour", () => {
    assert.match(url, /access_type=offline/);
    assert.match(url, /prompt=consent/);
  });

  it("asks for exactly the scopes the app needs", () => {
    assert.ok(hasRequiredScopes(SCOPE_STRING));
    assert.equal(hasRequiredScopes("https://www.googleapis.com/auth/gmail.send"), false);
  });

  it("carries the state through", () => {
    assert.match(url, /state=s1/);
  });
});

describe("token expiry", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("refreshes before the token actually dies", () => {
    assert.equal(needsRefresh(expiryFrom(3600, now), now), false);
    assert.equal(needsRefresh(expiryFrom(60, now), now), true, "inside the margin");
    assert.equal(needsRefresh("", now), true);
    assert.equal(needsRefresh("nonsense", now), true);
  });

  it("knows which Google errors mean reconnect", () => {
    assert.ok(isFatalAuthError("invalid_grant: Token has been expired or revoked."));
    assert.ok(isFatalAuthError("invalid_client"));
    assert.equal(isFatalAuthError("rateLimitExceeded"), false);
    assert.equal(isFatalAuthError("backendError"), false);
  });
});

describe("the daily limit", () => {
  const now = new Date("2026-09-02T10:00:00.000Z");

  it("counts only what actually went out today", () => {
    const emails = [
      email({ id: "a", status: "sent", sentAt: "2026-09-02T08:00:00.000Z" }),
      email({ id: "b", status: "replied", sentAt: "2026-09-02T09:00:00.000Z" }),
      email({ id: "c", status: "sent", sentAt: "2026-09-01T23:00:00.000Z" }),
      email({ id: "d", status: "failed", sentAt: "2026-09-02T09:30:00.000Z" }),
      email({ id: "e", status: "queued" }),
    ];
    assert.equal(sentToday(emails, now), 2, "yesterday's and the failure do not count");
    assert.equal(dayKey(now), "2026-09-02");
  });

  it("never offers more than the limit allows", () => {
    const sentAlready = Array.from({ length: 28 }, (_, i) =>
      email({ id: `s${i}`, status: "sent", sentAt: "2026-09-02T08:00:00.000Z" }),
    );
    const room = allowance(sentAlready, settings({ dailyLimit: 30, batchSize: 5 }), now);
    assert.equal(room.remaining, 2);
    assert.equal(room.batch, 2, "the batch is clipped to what is left of the day");
    assert.equal(describeAllowance(room), "28 / 30");
  });

  it("stops dead at the limit", () => {
    const sentAlready = Array.from({ length: 30 }, (_, i) =>
      email({ id: `s${i}`, status: "sent", sentAt: "2026-09-02T08:00:00.000Z" }),
    );
    const all = [...sentAlready, email({ id: "q", status: "queued" })];
    const room = allowance(all, settings({ dailyLimit: 30 }), now);
    assert.ok(room.atLimit);
    assert.deepEqual(nextBatch(all, settings({ dailyLimit: 30 }), now), []);
  });

  it("takes the oldest approvals first, and only queued ones", () => {
    const queue = [
      email({ id: "new", status: "queued", approvedAt: "2026-09-02T09:00:00.000Z" }),
      email({ id: "old", status: "queued", approvedAt: "2026-09-02T07:00:00.000Z" }),
      email({ id: "draft", status: "draft" }),
      email({ id: "approved-not-queued", status: "approved" }),
    ];
    const batch = nextBatch(queue, settings({ batchSize: 5 }), now);
    assert.deepEqual(batch.map((item) => item.id), ["old", "new"]);
  });

  it("clamps settings a person typed", () => {
    const next = sanitizeSettings(
      { dailyLimit: 100000, batchSize: 0, delaySeconds: 1, maxFollowUps: 9, autoSend: true },
      DEFAULT_SETTINGS,
    );
    assert.equal(next.dailyLimit, 30);
    assert.equal(next.batchSize, 1);
    assert.equal(next.delaySeconds, 5);
    assert.equal(next.maxFollowUps, 2);
    assert.equal(next.autoSend, false);
  });

  it("refuses to turn automatic sending on", () => {
    const next = sanitizeSettings({ autoSend: true }, { ...DEFAULT_SETTINGS, autoSend: true });
    assert.equal(next.autoSend, false);
  });

  it("keeps the current value when given nonsense", () => {
    const next = sanitizeSettings({ dailyLimit: Number.NaN }, DEFAULT_SETTINGS);
    assert.equal(next.dailyLimit, DEFAULT_SETTINGS.dailyLimit);
  });
});

describe("follow-ups", () => {
  const now = new Date("2026-09-10T10:00:00.000Z");
  const on = settings({ followUpsOn: true, followUp1Days: 4, followUp2Days: 7, maxFollowUps: 2 });
  const initialSent = email({ id: "e1", status: "sent", kind: "initial", sentAt: "2026-09-01T10:00:00.000Z" });

  it("is off unless turned on", () => {
    assert.equal(followUpDueFor(lead(), [initialSent], DEFAULT_SETTINGS, emptyContext(), now), null);
  });

  it("comes due once enough days have passed", () => {
    const due = followUpDueFor(lead(), [initialSent], on, emptyContext(), now);
    assert.ok(due);
    assert.equal(due.kind, "follow-up-1");
  });

  it("waits until the gap has elapsed", () => {
    const tooSoon = new Date("2026-09-03T10:00:00.000Z");
    assert.equal(followUpDueFor(lead(), [initialSent], on, emptyContext(), tooSoon), null);
  });

  it("never follows up after a reply", () => {
    const replied = [email({ ...initialSent, status: "replied" })];
    assert.equal(followUpDueFor(lead(), replied, on, emptyContext(), now), null);
    assert.equal(
      followUpDueFor(lead({ outreachStatus: "Replied" }), [initialSent], on, emptyContext(), now),
      null,
    );
  });

  it("never follows up someone who unsubscribed, is booked, or was won", () => {
    for (const patch of [
      { unsubscribed: "2026-09-05T00:00:00.000Z" },
      { callResult: "Booked" as const },
      { callResult: "Won" as const },
      { callResult: "Not Interested" as const },
    ]) {
      assert.equal(followUpDueFor(lead(patch), [initialSent], on, emptyContext(), now), null, JSON.stringify(patch));
    }
  });

  it("moves on to the second follow-up, then stops", () => {
    const afterFirst = [
      initialSent,
      email({ id: "e2", status: "sent", kind: "follow-up-1", sentAt: "2026-09-02T10:00:00.000Z" }),
    ];
    const second = followUpDueFor(lead(), afterFirst, on, emptyContext(), now);
    assert.equal(second?.kind, "follow-up-2");

    const afterSecond = [
      ...afterFirst,
      email({ id: "e3", status: "sent", kind: "follow-up-2", sentAt: "2026-09-03T10:00:00.000Z" }),
    ];
    assert.equal(followUpDueFor(lead(), afterSecond, on, emptyContext(), now), null, "two is the cap");
  });

  it("respects a cap of one", () => {
    const afterFirst = [
      initialSent,
      email({ id: "e2", status: "sent", kind: "follow-up-1", sentAt: "2026-09-02T10:00:00.000Z" }),
    ];
    assert.equal(followUpDueFor(lead(), afterFirst, settings({ ...on, maxFollowUps: 1 }), emptyContext(), now), null);
  });

  it("never follows up a lead that was never written to", () => {
    assert.equal(followUpDueFor(lead(), [], on, emptyContext(), now), null);
    assert.equal(followUpDueFor(lead(), [email({ status: "queued" })], on, emptyContext(), now), null);
  });

  it("lists what is due, soonest first", () => {
    const due = followUpsDue([lead()], [initialSent], on, emptyContext(), now);
    assert.equal(due.length, 1);
  });
});

describe("the dashboard", () => {
  it("counts what is on the sheet and what has been sent", () => {
    const leads = [
      lead({ id: "l1" }),
      lead({ id: "l2", callResult: "Booked" }),
      lead({ id: "l3", callResult: "Won" }),
      lead({ id: "l4", unsubscribed: "2026-09-01T00:00:00.000Z" }),
      lead({ id: "l5", email: "", emailConfidence: "" }),
    ];
    const emails = [
      email({ id: "a", leadId: "l1", status: "sent", sentAt: "2026-09-02T09:00:00.000Z" }),
      email({ id: "b", leadId: "l2", status: "replied", sentAt: "2026-09-01T09:00:00.000Z" }),
      email({ id: "c", status: "queued" }),
      email({ id: "d", status: "draft" }),
      email({ id: "e", status: "failed" }),
    ];
    const stats = computeStats(leads, emails, DEFAULT_SETTINGS, emptyContext(), new Date("2026-09-02T12:00:00.000Z"));
    assert.equal(stats.leads, 5);
    assert.equal(stats.emailsAvailable, 4);
    assert.equal(stats.booked, 1);
    assert.equal(stats.won, 1);
    assert.equal(stats.unsubscribed, 1);
    assert.equal(stats.sentToday, 1);
    assert.equal(stats.totalSent, 2);
    assert.equal(stats.queued, 1);
    assert.equal(stats.awaitingApproval, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.replies, 1);
    assert.equal(stats.dailyLimit, DEFAULT_SETTINGS.dailyLimit);
  });
});

describe("google client id shape", () => {
  const VALID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";

  it("accepts a real client id", () => {
    assert.equal(clientIdProblem(VALID), null);
    assert.equal(clientIdProblem(`  ${VALID}  `), null, "surrounding whitespace is trimmed, not rejected");
  });

  it("names the swapped-secret mistake, which Google reports only as invalid_client", () => {
    const problem = clientIdProblem("GOCSPX-not-a-client-id");
    assert.match(problem ?? "", /SECRET/);
  });

  it("catches quotes copied in from a config file", () => {
    assert.match(clientIdProblem(`"${VALID}"`) ?? "", /quote/i);
    assert.match(clientIdProblem(`'${VALID}'`) ?? "", /quote/i);
  });

  it("catches an embedded newline, which a pasted variable often carries", () => {
    assert.match(clientIdProblem(`${VALID}\nextra`) ?? "", /space or line break/i);
  });

  it("catches a value that is not a Google client id at all", () => {
    assert.match(clientIdProblem("my-app-client") ?? "", /apps\.googleusercontent\.com/);
  });

  it("reports an empty value rather than building a doomed URL", () => {
    assert.match(clientIdProblem("") ?? "", /empty/i);
    assert.match(clientIdProblem("   ") ?? "", /empty/i);
  });

  it("cannot tell a deleted client from a live one — that is Google's to answer", () => {
    // Shape is all this checks. A well-formed id for a client that no longer
    // exists still passes here and still fails at Google, by design.
    assert.equal(clientIdProblem(VALID), null);
  });
});
