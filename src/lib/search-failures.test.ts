import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifySearchFailure,
  isRetryable,
  looksLikeJson,
  parseRetryAfter,
  SEARCH_FAILURE_LABELS,
  SEARCH_FAILURES,
} from "./search-provider.ts";

/**
 * How a live search API actually fails.
 *
 * These are the responses that decide whether the first real call succeeds or
 * silently returns nothing for months. The one that matters most is a rejected
 * key: it yields no results, exactly like a business with no website, and
 * without naming it a mistyped key looks like poor discovery rather than a
 * five-second fix.
 */
describe("reading a live provider's failures", () => {
  it("names a rejected key rather than absorbing it", () => {
    assert.equal(classifySearchFailure(401, "Unauthorized").kind, "AUTH");
    assert.equal(classifySearchFailure(403, "Forbidden").kind, "AUTH");
  });

  it("separates quota exhaustion from rate limiting", () => {
    // Brave signals quota on 429; Azure on 403. Neither uses a clean code, so
    // the body is what separates "wait" from "you have run out".
    assert.equal(classifySearchFailure(429, "Rate limit exceeded").kind, "RATE_LIMIT");
    assert.equal(classifySearchFailure(429, "Monthly quota exceeded").kind, "QUOTA");
    assert.equal(classifySearchFailure(403, "Out of call volume quota. Quota will be replenished").kind, "QUOTA");
    assert.equal(classifySearchFailure(403, "Subscription expired").kind, "QUOTA");
  });

  it("treats a provider outage as a server fault", () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(classifySearchFailure(status).kind, "SERVER", String(status));
    }
  });

  it("treats a rejected query as a bad response, not an outage", () => {
    assert.equal(classifySearchFailure(422, "query too long").kind, "BAD_RESPONSE");
  });

  it("retries only what is worth retrying", () => {
    assert.ok(isRetryable("TIMEOUT") && isRetryable("SERVER") && isRetryable("NETWORK"));
    // Retrying a rejected key just spends the budget failing.
    assert.equal(isRetryable("AUTH"), false);
    assert.equal(isRetryable("QUOTA"), false);
    assert.equal(isRetryable("RATE_LIMIT"), false);
  });

  it("has actionable wording for every failure", () => {
    for (const kind of SEARCH_FAILURES) {
      assert.ok(SEARCH_FAILURE_LABELS[kind].length > 20, kind);
    }
    assert.match(SEARCH_FAILURE_LABELS.AUTH, /key was rejected/i);
  });
});

describe("Retry-After", () => {
  const now = new Date("2026-09-11T12:00:00.000Z");
  it("reads a seconds value", () => {
    assert.equal(parseRetryAfter("30", now), 30_000);
  });
  it("reads an HTTP date", () => {
    assert.equal(parseRetryAfter("Fri, 11 Sep 2026 12:00:20 GMT", now), 20_000);
  });
  it("never waits longer than a minute", () => {
    assert.equal(parseRetryAfter("9999", now), 60_000);
  });
  it("ignores nonsense", () => {
    assert.equal(parseRetryAfter(null, now), undefined);
    assert.equal(parseRetryAfter("soon", now), undefined);
  });
  it("never returns a negative wait", () => {
    assert.equal(parseRetryAfter("Fri, 11 Sep 2026 11:59:00 GMT", now), 0);
  });
});

describe("spotting a response that is not a search payload", () => {
  it("accepts real JSON", () => {
    assert.ok(looksLikeJson("application/json", '{"web":{}}'));
    assert.ok(looksLikeJson("application/json; charset=utf-8", "{}"));
  });
  it("accepts JSON sent with no content type", () => {
    assert.ok(looksLikeJson(null, '  {"web":{}}'));
    assert.ok(looksLikeJson(null, "[1]"));
  });
  it("REJECTS an HTML error page answering 200", () => {
    // A WAF or interstitial answering 200 with HTML is how a parser starts
    // throwing in production.
    assert.equal(looksLikeJson("text/html", "<!doctype html><html>Access denied</html>"), false);
    assert.equal(looksLikeJson(null, "<html>blocked</html>"), false);
  });
  it("rejects an empty body", () => {
    assert.equal(looksLikeJson(null, ""), false);
  });
});
