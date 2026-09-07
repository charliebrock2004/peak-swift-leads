import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifySetupError,
  SETUP_COPY,
  SETUP_REASONS,
  UNDEFINED_TABLE,
} from "./setup-state.ts";

test("every reason has copy, and every copy names the problem", () => {
  for (const reason of SETUP_REASONS) {
    const copy = SETUP_COPY[reason];
    assert.ok(copy, `no copy for ${reason}`);
    assert.ok(copy.title.length > 0, `${reason} has no title`);
    assert.ok(copy.detail.length > 0, `${reason} has no detail`);
  }
});

test("every reason except the catch-all offers a fix", () => {
  for (const reason of SETUP_REASONS) {
    if (reason === "unknown") continue;
    assert.ok(SETUP_COPY[reason].fix, `${reason} leaves the reader with nothing to do`);
  }
});

test("each message reassures that the lead sheet is unaffected", () => {
  // Every one of these states leaves the local-first lead sheet working, and
  // the owner should not have to wonder whether 146 leads just vanished.
  for (const reason of SETUP_REASONS) {
    assert.match(SETUP_COPY[reason].detail, /lead sheet is unaffected/i, `${reason} does not say so`);
  }
});

// The literal strings the app throws. If one of these is reworded without
// updating the classifier, this test fails rather than the UI silently
// regressing to the generic message.
test("the real no-database error from db.ts is classified", () => {
  const actual =
    "No database configured. Set DATABASE_URL to persist data in production " +
    "(the embedded PGLite fallback is development-only — see `dbSource`).";
  assert.equal(classifySetupError(actual), "no-database");
});

test("the real fail-closed auth error is auth-off, not a missing database", () => {
  // verify.server.ts throws this when auth is off and DATABASE_URL is set. It
  // mentions DATABASE_URL, so it used to be mistaken for a missing database —
  // which told the owner to add a variable they already had.
  const actual =
    "Auth is disabled (VITE_AUTH_ENABLED=false) but DATABASE_URL is set — " +
    "refusing to fall back to the shared dev user against a real database.";
  assert.equal(classifySetupError(actual), "auth-off");
});

test("the auth middleware's Unauthorized is a signed-out state, not a database one", () => {
  assert.equal(classifySetupError("Unauthorized"), "signed-out");
});

test("the owner refusal is distinguished from being signed out", () => {
  assert.equal(classifySetupError("That account is not the owner of this app."), "not-owner");
  assert.equal(
    classifySetupError(
      "This deployment has no APP_OWNER_EMAIL set, so no account may use it. " +
        "Add APP_OWNER_EMAIL to the server environment and redeploy.",
    ),
    "not-owner",
  );
});

test("a missing table is read as an unapplied migration", () => {
  assert.equal(classifySetupError('relation "outreach_settings" does not exist'), "schema-missing");
  assert.equal(classifySetupError(`error ${UNDEFINED_TABLE}`), "schema-missing");
});

test("nothing useful in, catch-all out", () => {
  assert.equal(classifySetupError(""), "unknown");
  assert.equal(classifySetupError(null), "unknown");
  assert.equal(classifySetupError(undefined), "unknown");
  assert.equal(classifySetupError("socket hang up"), "unknown");
});

test("owner refusal wins over the word unauthorized appearing too", () => {
  // Ordering matters: signing in again cannot fix a wrong-account refusal, so
  // it must never be reported as merely signed out.
  assert.equal(
    classifySetupError("Unauthorized: that account is not the owner of this app"),
    "not-owner",
  );
});

test("auth-off wins over the word DATABASE_URL appearing in the same message", () => {
  assert.equal(
    classifySetupError("VITE_AUTH_ENABLED=false but DATABASE_URL is set"),
    "auth-off",
  );
});
