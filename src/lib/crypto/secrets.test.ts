import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isSealed, openSecret, sealSecret, signOAuthState, STATE_MAX_AGE_MS, verifyOAuthState } from "./secrets.server.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["TOKEN_ENCRYPTION_KEY", "DATABASE_URL", "BETTER_AUTH_SECRET"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("sealing Gmail tokens at rest", () => {
  it("round-trips, and never stores the token in the clear", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const sealed = sealSecret("1//refresh-token-value");
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes("refresh-token-value"));
    assert.deepEqual(openSecret(sealed), { ok: true, value: "1//refresh-token-value", legacy: false });
  });

  it("uses a fresh IV every time", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    assert.notEqual(sealSecret("same"), sealSecret("same"));
  });

  it("reads a token stored before encryption existed, and flags it for re-sealing", () => {
    assert.deepEqual(openSecret("ya29.plain"), { ok: true, value: "ya29.plain", legacy: true });
  });

  it("names a changed key rather than returning garbage", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const sealed = sealSecret("secret");
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-two";
    assert.deepEqual(openSecret(sealed), { ok: false, reason: "key-changed" });
  });

  it("detects tampering", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-key-one";
    const sealed = sealSecret("secret");
    const parts = sealed.split(":");
    parts[4] = Buffer.from("tampered!").toString("base64url");
    assert.deepEqual(openSecret(parts.join(":")), { ok: false, reason: "corrupt" });
  });
});

describe("the OAuth state", () => {
  it("verifies for the account that started the flow", () => {
    const state = signOAuthState("owner-1", 1_000_000);
    assert.deepEqual(verifyOAuthState("owner-1", state, 1_000_000 + 60_000), { ok: true });
  });

  it("refuses a state minted for somebody else, forged, or expired", () => {
    const state = signOAuthState("owner-1", 1_000_000);
    assert.equal(verifyOAuthState("stranger", state, 1_000_000).ok, false);
    assert.deepEqual(verifyOAuthState("owner-1", `${state}x`, 1_000_000), { ok: false, reason: "forged" });
    assert.deepEqual(verifyOAuthState("owner-1", state, 1_000_000 + STATE_MAX_AGE_MS + 1), { ok: false, reason: "expired" });
    assert.deepEqual(verifyOAuthState("owner-1", "", 1_000_000), { ok: false, reason: "missing" });
  });
});
