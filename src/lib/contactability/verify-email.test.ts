import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredVerifier, dnsVerifier, neverBounceVerifier, zeroBounceVerifier } from "./verify-email.server.ts";

const err = (code: string) => Object.assign(new Error(code), { code });

describe("email verification", () => {
  it("DNS: a domain that accepts mail is 'unknown' (the mailbox is not checked), never 'valid'", async () => {
    const verifier = dnsVerifier({ resolveMx: async () => [{ exchange: "mx.example.co.uk" }], resolve4: async () => [] });
    assert.equal((await verifier.verify("info@example.co.uk")).result, "unknown");
  });

  it("DNS: a domain that does not exist is invalid; a failed lookup is unknown", async () => {
    const gone = dnsVerifier({ resolveMx: async () => Promise.reject(err("ENOTFOUND")), resolve4: async () => Promise.reject(err("ENOTFOUND")) });
    assert.equal((await gone.verify("info@no-such-domain.co.uk")).result, "invalid");
    const flaky = dnsVerifier({ resolveMx: async () => Promise.reject(err("ETIMEOUT")), resolve4: async () => [] });
    assert.equal((await flaky.verify("info@example.co.uk")).result, "unknown");
    const nullMx = dnsVerifier({ resolveMx: async () => [{ exchange: "." }], resolve4: async () => [] });
    assert.equal((await nullMx.verify("info@example.co.uk")).result, "invalid");
  });

  it("providers map onto the five results; catch-all is never valid; an outage is unknown", async () => {
    const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    assert.equal((await zeroBounceVerifier("k", answer({ status: "catch-all" })).verify("a@b.co.uk")).result, "catch_all");
    assert.equal((await zeroBounceVerifier("k", answer({ status: "invalid" })).verify("a@b.co.uk")).result, "invalid");
    assert.equal((await neverBounceVerifier("k", answer({ result: "catchall" })).verify("a@b.co.uk")).result, "catch_all");
    assert.equal((await neverBounceVerifier("k", answer({ result: "disposable" })).verify("a@b.co.uk")).result, "risky");
    const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    assert.equal((await zeroBounceVerifier("k", down).verify("a@b.co.uk")).result, "unknown");
  });

  it("is chosen by configuration, and a paid provider without a key falls back to DNS", () => {
    assert.equal(configuredVerifier({}).name, "dns");
    assert.equal(configuredVerifier({ EMAIL_VERIFIER: "zerobounce" }).name, "dns");
    assert.equal(configuredVerifier({ EMAIL_VERIFIER: "zerobounce", EMAIL_VERIFIER_API_KEY: "x" }).name, "zerobounce");
    assert.equal(configuredVerifier({ EMAIL_VERIFIER: "NeverBounce", EMAIL_VERIFIER_API_KEY: "x" }).name, "neverbounce");
  });
});
