import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { googleConfig, oauthSetup } from "../gmail/client.server.ts";
import { missingAdvice, missingNames, NO_SETUP, whereRunning } from "./oauth-setup.ts";

const KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

describe("what the running server can see of the OAuth setup", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("names the variable that is missing, not just that something is", () => {
    process.env.GOOGLE_CLIENT_SECRET = "s3cret";
    assert.deepEqual(oauthSetup().missing, ["GOOGLE_CLIENT_ID"]);
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    assert.deepEqual(oauthSetup().missing, ["GOOGLE_CLIENT_SECRET"]);
    delete process.env.GOOGLE_CLIENT_ID;
    assert.deepEqual(oauthSetup().missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  });

  it("agrees with googleConfig about whether the app is set up", () => {
    assert.equal(googleConfig(), null);
    assert.equal(oauthSetup().missing.length, 2);
    process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "s3cret";
    assert.notEqual(googleConfig(), null);
    assert.deepEqual(oauthSetup().missing, []);
  });

  it("treats a value that is only quotes or whitespace as missing, as googleConfig does", () => {
    process.env.GOOGLE_CLIENT_ID = '  ""  ';
    process.env.GOOGLE_CLIENT_SECRET = "\n";
    assert.equal(googleConfig(), null);
    assert.deepEqual(oauthSetup().missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  });

  it("reports which build this is, from Vercel's own system variables", () => {
    process.env.VERCEL_ENV = "Preview";
    process.env.VERCEL_GIT_COMMIT_REF = "claude/production-overhaul";
    process.env.VERCEL_GIT_COMMIT_SHA = "21a81e553aefda2cee2843fcc2a11051aead7405";
    const setup = oauthSetup();
    assert.equal(setup.environment, "preview");
    assert.equal(setup.branch, "claude/production-overhaul");
    assert.equal(setup.commit, "21a81e5");
  });

  it("never carries a value — only names, and a short commit", () => {
    process.env.GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "GOCSPX-super-secret-value";
    process.env.VERCEL_ENV = "production";
    const text = JSON.stringify(oauthSetup());
    assert.doesNotMatch(text, /GOCSPX|super-secret|123-abc/);
  });
});

describe("saying it in words", () => {
  const preview = { missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const, environment: "preview", branch: "claude/x", commit: "21a81e5" };

  it("lists one variable or both", () => {
    assert.equal(missingNames({ missing: ["GOOGLE_CLIENT_ID"] }), "GOOGLE_CLIENT_ID");
    assert.equal(missingNames({ missing: [...preview.missing] }), "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    assert.equal(missingNames({ missing: [] }), "");
  });

  it("says which build is running", () => {
    assert.equal(whereRunning(preview), "the Preview build of claude/x (commit 21a81e5)");
    assert.equal(whereRunning({ environment: "production", branch: "", commit: "" }), "the Production build");
    assert.equal(whereRunning({ environment: "", branch: "", commit: "" }), "this server");
  });

  it("explains that an older build does not pick up later variables", () => {
    const advice = missingAdvice({ ...preview, missing: [...preview.missing] });
    assert.match(advice, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not visible to the Preview build of claude\/x/);
    assert.match(advice, /existed when that build was created/);
    assert.match(advice, /redeploy/);
    assert.match(advice, /ticked for Preview/);
  });

  it("says nothing when nothing is missing", () => {
    assert.equal(missingAdvice(NO_SETUP), "");
  });
});
