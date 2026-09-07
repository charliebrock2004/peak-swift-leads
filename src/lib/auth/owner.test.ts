import assert from "node:assert/strict";
import { test } from "node:test";

import { checkOwner, parseOwnerList, type OwnerPolicy } from "./owner.ts";

const policy = (overrides: Partial<OwnerPolicy> = {}): OwnerPolicy => ({
  allowlist: [],
  enforced: true,
  databaseConfigured: true,
  ...overrides,
});

test("parseOwnerList: empty, absent and whitespace all mean no allowlist", () => {
  assert.deepEqual(parseOwnerList(undefined), []);
  assert.deepEqual(parseOwnerList(null), []);
  assert.deepEqual(parseOwnerList(""), []);
  assert.deepEqual(parseOwnerList("   "), []);
  assert.deepEqual(parseOwnerList(" , , "), []);
});

test("parseOwnerList: lowercases, trims and accepts several addresses", () => {
  assert.deepEqual(parseOwnerList("  Charlie@Example.COM "), ["charlie@example.com"]);
  assert.deepEqual(parseOwnerList("a@x.com, B@Y.com"), ["a@x.com", "b@y.com"]);
});

test("the Grok gate is left alone — an unenforced policy admits anyone", () => {
  const verdict = checkOwner("stranger@example.com", policy({ enforced: false }));
  assert.equal(verdict.ok, true);
});

test("local work with no database still admits anyone", () => {
  const verdict = checkOwner("dev@example.com", policy({ databaseConfigured: false }));
  assert.equal(verdict.ok, true);
});

test("a deployment with no allowlist fails CLOSED", () => {
  const verdict = checkOwner("whoever@example.com", policy());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "no-allowlist");
  // The message has to name the fix, or the owner is left guessing.
  assert.match(verdict.ok === false ? verdict.message : "", /APP_OWNER_EMAIL/);
});

test("the owner is admitted, case- and whitespace-insensitively", () => {
  const p = policy({ allowlist: ["charlie@example.com"] });
  assert.equal(checkOwner("charlie@example.com", p).ok, true);
  assert.equal(checkOwner("  Charlie@Example.com  ", p).ok, true);
});

test("a signed-up stranger is refused even though they authenticated", () => {
  const p = policy({ allowlist: ["charlie@example.com"] });
  const verdict = checkOwner("stranger@example.com", p);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "not-owner");
});

test("a session with no email address is refused when an allowlist exists", () => {
  const p = policy({ allowlist: ["charlie@example.com"] });
  assert.equal(checkOwner(null, p).ok, false);
  assert.equal(checkOwner("", p).ok, false);
  assert.equal(checkOwner("   ", p).ok, false);
});

test("a second allowed address works without a code change", () => {
  const p = policy({ allowlist: parseOwnerList("charlie@example.com, spare@example.com") });
  assert.equal(checkOwner("spare@example.com", p).ok, true);
  assert.equal(checkOwner("nope@example.com", p).ok, false);
});

test("no substring or domain confusion", () => {
  const p = policy({ allowlist: ["charlie@example.com"] });
  // A lookalike address must not pass just because it contains the owner's.
  assert.equal(checkOwner("charlie@example.com.evil.net", p).ok, false);
  assert.equal(checkOwner("notcharlie@example.com", p).ok, false);
  assert.equal(checkOwner("charlie@example.co", p).ok, false);
});
