import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAuthUrl } from "./oauth.ts";
import { chooseRedirectUri, sameOrigin, type RedirectEnv } from "./redirect.ts";

// The real addresses of this project's deployments.
const BRANCH_HOST = "peak-swift-leads-git-claude-production-overhaul-charlie-brock.vercel.app";
const DEPLOYMENT_HOST = "peak-swift-leads-31d44ujxz-charlie-brock.vercel.app";
const PRODUCTION_HOST = "peak-swift-leads.vercel.app";
const REGISTERED_PREVIEW = `https://${BRANCH_HOST}/oauth/gmail`;
const REGISTERED_PRODUCTION = `https://${PRODUCTION_HOST}/oauth/gmail`;

const preview: RedirectEnv = {
  VERCEL_ENV: "preview",
  VERCEL_BRANCH_URL: BRANCH_HOST,
  VERCEL_URL: DEPLOYMENT_HOST,
  VERCEL_PROJECT_PRODUCTION_URL: PRODUCTION_HOST,
};
const production: RedirectEnv = {
  VERCEL_ENV: "production",
  VERCEL_BRANCH_URL: "peak-swift-leads-git-main-charlie-brock.vercel.app",
  VERCEL_URL: "peak-swift-leads-g1bhachcd-charlie-brock.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: PRODUCTION_HOST,
};

/** What Google actually receives: the decoded `redirect_uri` of the auth URL. */
function sentToGoogle(redirectUri: string): string {
  const url = buildAuthUrl({ clientId: "x.apps.googleusercontent.com", redirectUri, state: "s" });
  return new URL(url).searchParams.get("redirect_uri") ?? "";
}

describe("the redirect_uri a Preview deployment sends", () => {
  it("is the registered branch URI, character for character, from the per-deployment URL", () => {
    // The address a preview could previously only be used on (sign-in trusted no other).
    const choice = chooseRedirectUri(preview, `https://${DEPLOYMENT_HOST}`);
    assert.equal(choice.uri, REGISTERED_PREVIEW);
    assert.equal(sentToGoogle(choice.uri), REGISTERED_PREVIEW);
    assert.equal(choice.source, "branch");
  });

  it("is the same from the branch alias, and from any other address", () => {
    for (const origin of [`https://${BRANCH_HOST}`, "https://peak-swift-leads-aku5jpum2-charlie-brock.vercel.app", ""]) {
      assert.equal(chooseRedirectUri(preview, origin).uri, REGISTERED_PREVIEW, origin);
    }
  });

  it("stays the same across commits, because only the per-deployment URL changes", () => {
    const nextPush = { ...preview, VERCEL_URL: "peak-swift-leads-zz99xyz12-charlie-brock.vercel.app" };
    assert.equal(chooseRedirectUri(nextPush, `https://${nextPush.VERCEL_URL}`).uri, REGISTERED_PREVIEW);
  });

  it("falls back to this deployment's own URL only if Vercel gives no branch URL", () => {
    const choice = chooseRedirectUri({ ...preview, VERCEL_BRANCH_URL: "" }, "https://anything.example");
    assert.equal(choice.uri, `https://${DEPLOYMENT_HOST}/oauth/gmail`);
    assert.equal(choice.source, "deployment");
  });
});

describe("the redirect_uri Production sends", () => {
  it("is the production domain from every production alias", () => {
    for (const origin of [
      `https://${PRODUCTION_HOST}`,
      "https://peak-swift-leads-charlie-brock.vercel.app",
      "https://peak-swift-leads-git-main-charlie-brock.vercel.app",
      "https://peak-swift-leads-g1bhachcd-charlie-brock.vercel.app",
    ]) {
      assert.equal(chooseRedirectUri(production, origin).uri, REGISTERED_PRODUCTION, origin);
    }
    assert.equal(sentToGoogle(chooseRedirectUri(production, "").uri), REGISTERED_PRODUCTION);
  });
});

describe("what always wins, and what is cleaned", () => {
  it("uses GOOGLE_REDIRECT_URI exactly when it is set", () => {
    const choice = chooseRedirectUri({ ...preview, GOOGLE_REDIRECT_URI: "https://leads.example.co.uk/oauth/gmail" }, `https://${DEPLOYMENT_HOST}`);
    assert.equal(choice.uri, "https://leads.example.co.uk/oauth/gmail");
    assert.equal(choice.origin, "https://leads.example.co.uk");
    assert.equal(choice.source, "configured");
  });

  it("strips what an env var picks up in transit: quotes, whitespace, a scheme, a trailing slash, capitals", () => {
    const messy = { ...preview, VERCEL_BRANCH_URL: `  "https://${BRANCH_HOST.toUpperCase()}/"\n` };
    assert.equal(chooseRedirectUri(messy, "").uri, REGISTERED_PREVIEW);
    assert.equal(chooseRedirectUri({ GOOGLE_REDIRECT_URI: ` "${REGISTERED_PREVIEW}"\n` }, "").uri, REGISTERED_PREVIEW);
  });

  it("never adds a trailing slash, a double slash or a query", () => {
    const uri = chooseRedirectUri(preview, "").uri;
    assert.ok(!uri.endsWith("/"));
    assert.equal(uri.split("//").length, 2);
    assert.ok(!uri.includes("?"));
  });
});

describe("off Vercel (local development)", () => {
  it("uses the browser's own origin, as before", () => {
    assert.equal(chooseRedirectUri({}, "http://localhost:8080").uri, "http://localhost:8080/oauth/gmail");
    assert.equal(chooseRedirectUri({}, "http://127.0.0.1:8080/").uri, "http://127.0.0.1:8080/oauth/gmail");
    assert.equal(chooseRedirectUri({}, "http://localhost:8080").source, "browser");
  });

  it("refuses to invent one from something that is not an origin", () => {
    assert.equal(chooseRedirectUri({}, "").uri, "");
    assert.equal(chooseRedirectUri({}, "javascript:alert(1)").uri, "");
    assert.equal(chooseRedirectUri({}, "https://a.example/path").uri, "");
  });
});

describe("whether the tab must move first", () => {
  it("compares origins, ignoring case and a trailing slash", () => {
    assert.equal(sameOrigin(`https://${BRANCH_HOST}`, `https://${BRANCH_HOST.toUpperCase()}/`), true);
    assert.equal(sameOrigin(`https://${BRANCH_HOST}`, `https://${DEPLOYMENT_HOST}`), false);
  });

  it("moves a tab on the per-deployment URL to the branch alias", () => {
    const choice = chooseRedirectUri(preview, `https://${DEPLOYMENT_HOST}`);
    assert.equal(sameOrigin(choice.origin, `https://${DEPLOYMENT_HOST}`), false);
    assert.equal(choice.origin, `https://${BRANCH_HOST}`);
  });
});
