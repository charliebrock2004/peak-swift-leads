/**
 * The real Gmail client, over real HTTP, against a local stand-in for Google.
 *
 * `GMAIL_API_BASE_URL` and `GOOGLE_OAUTH_BASE` exist only so this can happen:
 * the code under test is exactly the code production runs, and nothing leaves
 * the machine.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  classifyGmailStatus,
  classifyNetworkError,
  findSentMessage,
  getProfile,
  getThread,
  refreshAccessToken,
  sendMessage,
} from "./client.server.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let base = "";
let handler: Handler = (_req, res) => res.end("{}");

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GMAIL_API_BASE_URL = `${base}/gmail/v1`;
  process.env.GOOGLE_OAUTH_BASE = `${base}/oauth`;
  process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.GMAIL_API_BASE_URL;
  delete process.env.GOOGLE_OAUTH_BASE;
});

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

describe("sending", () => {
  it("returns Gmail's message id on success", async () => {
    let seen = "";
    handler = (req, res, body) => {
      seen = `${req.method} ${req.url} ${req.headers.authorization}`;
      assert.match(body, /"raw":"abc"/);
      json(res, 200, { id: "18c0ffee", threadId: "18c0ffee", labelIds: ["SENT"] });
    };
    const result = await sendMessage("tok", "abc");
    assert.deepEqual(result, { ok: true, messageId: "18c0ffee", threadId: "18c0ffee", labelIds: ["SENT"] });
    assert.equal(seen, "POST /gmail/v1/users/me/messages/send Bearer tok");
  });

  it("classifies each kind of refusal", async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { message: "Invalid Credentials" } }, "auth"],
      [403, { error: { message: "Request had insufficient authentication scopes." } }, "auth"],
      [429, { error: { message: "User-rate limit exceeded" } }, "rate_limit"],
      [400, { error: { message: "Invalid To header" } }, "permanent"],
      [503, { error: { message: "Backend Error" } }, "transient"],
    ];
    for (const [status, payload, kind] of cases) {
      handler = (_req, res) => json(res, status, payload);
      const result = await sendMessage("tok", "abc");
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.kind, kind, `${status}`);
    }
  });

  it("treats a 200 without a message id as unconfirmed, not sent", async () => {
    handler = (_req, res) => json(res, 200, {});
    const result = await sendMessage("tok", "abc");
    assert.equal(!result.ok && result.kind, "uncertain");
  });

  it("treats a connection dropped mid-request as uncertain — it may have gone", async () => {
    handler = (req) => req.socket.destroy();
    const result = await sendMessage("tok", "abc");
    assert.equal(!result.ok && result.kind, "uncertain");
  });

  it("treats a connection that never opened as transient — nothing went", async () => {
    const saved = process.env.GMAIL_API_BASE_URL;
    // A port that was listening a moment ago and is now closed: refused.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.GMAIL_API_BASE_URL = `http://127.0.0.1:${closedPort}/gmail/v1`;
    try {
      const result = await sendMessage("tok", "abc");
      assert.equal(!result.ok && result.kind, "transient");
    } finally {
      process.env.GMAIL_API_BASE_URL = saved;
    }
  });
});

describe("tokens", () => {
  it("reports a revoked refresh token as needing a reconnect", async () => {
    handler = (_req, res) => json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    const result = await refreshAccessToken("1//dead");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.fatal, true);
    assert.equal(!result.ok && result.kind, "auth");
  });

  it("keeps the stored refresh token when Google does not send a new one", async () => {
    handler = (_req, res) => json(res, 200, { access_token: "ya29.new", expires_in: 3599, scope: "a b" });
    const result = await refreshAccessToken("1//keep");
    assert.equal(result.ok && result.refreshToken, "1//keep");
  });

  it("reads the mailbox profile", async () => {
    handler = (_req, res) => json(res, 200, { emailAddress: "peakswiftstudio@gmail.com", messagesTotal: 12 });
    const result = await getProfile("tok");
    assert.equal(result.ok && result.email, "peakswiftstudio@gmail.com");
  });
});

describe("finding a message Gmail sent", () => {
  it("finds it by recipient and subject in Sent, and returns its real Message-ID", async () => {
    const queries: string[] = [];
    handler = (req, res) => {
      const url = new URL(req.url ?? "", base);
      if (url.pathname.endsWith("/messages")) {
        queries.push(url.searchParams.get("q") ?? "");
        // The Message-ID search finds nothing (Gmail replaced ours); the Sent search does.
        return json(res, 200, url.searchParams.get("q")?.startsWith("rfc822msgid") ? {} : { messages: [{ id: "m1" }] });
      }
      json(res, 200, {
        id: "m1",
        threadId: "t1",
        labelIds: ["SENT"],
        payload: {
          headers: [
            { name: "To", value: "hello@strathearnjoinery.co.uk" },
            { name: "Subject", value: "A website for Strathearn Joinery?" },
            { name: "Message-ID", value: "<CA123@mail.gmail.com>" },
          ],
        },
      });
    };
    const result = await findSentMessage("tok", {
      rfc822MessageId: "<peakswift.x@gmail.com>",
      to: "hello@strathearnjoinery.co.uk",
      subject: "A website for Strathearn Joinery?",
      sinceEpochSeconds: 1_700_000_000,
    });
    assert.deepEqual(result, { ok: true, found: true, id: "m1", threadId: "t1", rfc822MessageId: "<CA123@mail.gmail.com>" });
    assert.equal(queries[0], "rfc822msgid:peakswift.x@gmail.com");
    assert.match(queries[1] ?? "", /^in:sent to:hello@strathearnjoinery\.co\.uk after:\d+$/);
  });

  it("does not mistake a different email to the same address for this one", async () => {
    handler = (req, res) => {
      const url = new URL(req.url ?? "", base);
      if (url.pathname.endsWith("/messages")) return json(res, 200, { messages: [{ id: "m9" }] });
      json(res, 200, {
        id: "m9",
        threadId: "t9",
        labelIds: ["SENT"],
        payload: { headers: [{ name: "To", value: "hello@x.co.uk" }, { name: "Subject", value: "Something else" }] },
      });
    };
    const result = await findSentMessage("tok", { to: "hello@x.co.uk", subject: "A website?", sinceEpochSeconds: 0 });
    assert.deepEqual(result, { ok: true, found: false });
  });
});

describe("reading a thread", () => {
  it("returns each message's headers for reply classification", async () => {
    handler = (_req, res) =>
      json(res, 200, {
        messages: [
          { id: "a", labelIds: ["SENT"], snippet: "Hi", payload: { headers: [{ name: "From", value: "Charlie <peakswiftstudio@gmail.com>" }] } },
          {
            id: "b",
            labelIds: ["INBOX"],
            snippet: "I am out of the office",
            internalDate: "1700000000000",
            payload: {
              headers: [
                { name: "From", value: "Jim <jim@x.co.uk>" },
                { name: "Subject", value: "Automatic reply: A website?" },
                { name: "Auto-Submitted", value: "auto-replied" },
              ],
            },
          },
        ],
      });
    const result = await getThread("tok", "t1", "peakswiftstudio@gmail.com");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.messages[0]!.fromUs, true);
    assert.equal(result.messages[1]!.fromUs, false);
    assert.equal(result.messages[1]!.headers["auto-submitted"], "auto-replied");
    assert.equal(result.messages[1]!.subject, "Automatic reply: A website?");
  });
});

describe("classification helpers", () => {
  it("maps statuses", () => {
    assert.equal(classifyGmailStatus(401, ""), "auth");
    assert.equal(classifyGmailStatus(400, "invalid_grant"), "auth");
    assert.equal(classifyGmailStatus(500, ""), "transient");
    assert.equal(classifyGmailStatus(404, "Not Found"), "permanent");
  });
  it("maps thrown errors", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    assert.equal(classifyNetworkError(abort).kind, "uncertain");
    assert.equal(classifyNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })).kind, "transient");
    assert.equal(classifyNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })).kind, "uncertain");
  });
});
