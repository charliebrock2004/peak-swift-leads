import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findLeaks, secretValues } from "./check-client-secrets.mjs";

describe("client secret check", () => {
  it("picks secret-looking variables, skips public and short ones", () => {
    const names = secretValues({ XAI_API_KEY: "xai-abcdefgh1234", VITE_AUTH_ENABLED: "true", GOOGLE_CLIENT_SECRET: "GOCSPX-secret-value", APP_URL: "https://example.com", CRON_SECRET: "short", DATABASE_URL: "postgres://u:p@h/db" }).map((entry) => entry.name);
    assert.deepEqual(names.sort(), ["DATABASE_URL", "GOOGLE_CLIENT_SECRET", "XAI_API_KEY"]);
  });

  it("finds a value in the client output, and not a name", () => {
    const dir = mkdtempSync(join(tmpdir(), "client-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "settings.js"), 'children:"Set XAI_API_KEY on the deployment"');
    assert.deepEqual(findLeaks(dir, [{ name: "XAI_API_KEY", value: "xai-abcdefgh1234" }]), []);
    writeFileSync(join(dir, "assets", "leak.js"), 'const key="xai-abcdefgh1234"');
    assert.deepEqual(findLeaks(dir, [{ name: "XAI_API_KEY", value: "xai-abcdefgh1234" }]).map((leak) => leak.name), ["XAI_API_KEY"]);
  });
});
