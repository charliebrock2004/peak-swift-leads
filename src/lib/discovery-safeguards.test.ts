import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { DISCOVERY_SAFETY } from "./discovery-limits.ts";
import { decide, scoreCandidate, type EmailCandidate, type ScoreContext } from "./email-discovery.ts";
import { buildProspectPool } from "./prospect-pool.ts";
import { scoreWebsiteMatch, WEBSITE_MIN_SCORE } from "./website-discovery.ts";
import { AUTO_DAILY_MAX, AUTO_TARGET_MAX, clampAutoConfig, DEFAULT_AUTO_CONFIG } from "./outreach/auto-run.ts";
import { sanitizeSettings } from "./outreach/limits.ts";
import { DEFAULT_SETTINGS } from "./outreach/types.ts";
import type { Prospect } from "./research.ts";

/**
 * Widening discovery must not have loosened anything downstream.
 *
 * These are not new rules. Each one belongs to a module this change did not
 * mean to touch, and is asserted here because the pipeline that feeds those
 * modules was rebuilt: more businesses reaching the gate is only an improvement
 * if the gate is exactly as strict as it was.
 */

function prospect(partial: Partial<Prospect> & { businessName: string }): Prospect {
  return {
    trade: "Joiner", town: "Perth", address: "", phone: "", email: "", rating: "",
    reviews: "", website: "", mapsLink: "", websiteStatus: "No Website Found", notes: "",
    source: "test", priority: "WARM", reason: "", lat: "", lng: "", placeId: "",
    foundAt: "2026-01-01", businessStatus: "", ...partial,
  };
}

describe("no email is ever invented", () => {
  it("returns NOT_FOUND rather than constructing an address from the domain", () => {
    const result = decide({
      candidates: [],
      context: { businessName: "Tay Joinery", websiteUrl: "https://tayjoinery.co.uk" },
      sourcesChecked: ["https://tayjoinery.co.uk", "https://tayjoinery.co.uk/contact"],
      attempts: 2,
      sawContactPage: true,
    });
    assert.equal(result.status, "NOT_FOUND");
    assert.equal(result.email, null);
    assert.equal(result.confidence, null);
  });

  it("does not put an address on a pooled business that had none", () => {
    const { prospects } = buildProspectPool(
      [
        prospect({ businessName: "Bridgend Carpentry", phone: "01738 555444" }),
        prospect({ businessName: "Craigie Joiners", website: "https://craigiejoiners.co.uk" }),
      ],
      { target: 60 },
    );
    assert.equal(prospects.length, 2);
    for (const item of prospects) assert.equal(item.email, "");
  });

  it("keeps a business with no website in the run instead of guessing for it", () => {
    const { prospects, diagnostics } = buildProspectPool(
      [prospect({ businessName: "Bridgend Carpentry", phone: "01738 555444" })],
      { target: 60 },
    );
    assert.equal(prospects.length, 1);
    assert.equal(diagnostics.withoutWebsite, 1);
    assert.equal(prospects[0]?.email, "");
  });
});

describe("email confidence rules are unchanged", () => {
  const context: ScoreContext = {
    businessName: "Tay Joinery",
    websiteUrl: "https://tayjoinery.co.uk",
  };

  function candidate(partial: Partial<EmailCandidate> & { email: string }): EmailCandidate {
    return {
      source: "OFFICIAL_CONTACT_PAGE",
      sourceUrl: "https://tayjoinery.co.uk/contact",
      method: "MAILTO_LINK",
      evidence: "",
      ...partial,
    };
  }

  it("still needs 75 to call an address HIGH", () => {
    const onOwnDomain = scoreCandidate(candidate({ email: "hello@tayjoinery.co.uk" }), context);
    assert.equal(onOwnDomain.confidence, "HIGH");
    assert.ok(onOwnDomain.score >= 75);
  });

  it("still refuses to promote an off-domain address to HIGH", () => {
    const elsewhere = scoreCandidate(
      candidate({ email: "info@somebodyelse.co.uk", source: "PUBLIC_DIRECTORY", method: "PAGE_TEXT" }),
      context,
    );
    assert.notEqual(elsewhere.confidence, "HIGH");
  });

  it("still routes a LOW-confidence address to the call list, never to outreach", () => {
    const result = decide({
      candidates: [
        {
          email: "someone@unrelated-host.com",
          source: "PUBLIC_DIRECTORY",
          sourceUrl: "https://yell.com/x",
          method: "PAGE_TEXT",
          evidence: "",
        },
      ],
      context,
      sourcesChecked: ["https://yell.com/x"],
      attempts: 1,
    });
    // The address is kept so a person can look at it; what matters is that it
    // is marked LOW and routed to CALL, so nothing is ever written to it.
    assert.equal(result.status, "LOW_CONFIDENCE");
    assert.equal(result.nextAction, "CALL");
    assert.notEqual(result.confidence, "HIGH");
  });
});

describe("the sending protections are untouched", () => {
  it("still caps the daily limit at 30", () => {
    assert.equal(AUTO_DAILY_MAX, 30);
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, dailyLimit: 999 }).dailyLimit, 30);
  });

  it("still defaults to prepare, never to send", () => {
    assert.equal(DEFAULT_AUTO_CONFIG.mode, "prepare");
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, mode: undefined }).mode, "prepare");
  });

  it("still keeps follow-ups off by default", () => {
    assert.equal(DEFAULT_SETTINGS.followUpsOn, false);
  });

  it("still sends in batches of five", () => {
    assert.equal(DEFAULT_SETTINGS.batchSize, 5);
    // And the server clamps anything larger back down to five.
    assert.equal(sanitizeSettings({ batchSize: 99 }, DEFAULT_SETTINGS).batchSize, 5);
  });

  it("keeps one-live-email-per-recipient duplicate protection in the schema", () => {
    // Widening discovery means many more businesses reach outreach, so the
    // index that stops one of them being written to twice matters more, not
    // less. It is keyed on the recipient and deliberately not on the campaign.
    const outreach = readFileSync(new URL("../../migrations/0005_outreach.sql", import.meta.url), "utf8");
    assert.match(outreach, /create unique index[^;]*outreach_emails_one_live_per_recipient_idx/i);
    assert.match(outreach, /on outreach_emails \(user_id, lower\(recipient\), kind\)/i);

    const campaigns = readFileSync(new URL("../../migrations/0008_campaigns.sql", import.meta.url), "utf8");
    assert.doesNotMatch(campaigns, /create unique index[^;]*outreach_emails/i);
  });
});

describe("the target is bounded but honest", () => {
  it("lets the user ask for more than the old silent clamp of 50", () => {
    assert.ok(AUTO_TARGET_MAX > 50);
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, target: 60 }).target, 60);
  });

  it("still refuses an unbounded target", () => {
    assert.equal(clampAutoConfig({ ...DEFAULT_AUTO_CONFIG, target: 999999 }).target, AUTO_TARGET_MAX);
  });

  it("keeps the engine ceiling above what the UI can ask for", () => {
    assert.ok(DISCOVERY_SAFETY.targetMax >= AUTO_TARGET_MAX);
    assert.ok(DISCOVERY_SAFETY.poolCeiling > DISCOVERY_SAFETY.targetMax);
  });

  it("keeps the per-area fetch budget independent of the target", () => {
    assert.ok(DISCOVERY_SAFETY.fetchPerArea > 0);
    assert.notEqual(DISCOVERY_SAFETY.fetchPerArea, AUTO_TARGET_MAX);
    assert.notEqual(DISCOVERY_SAFETY.fetchPerArea, DISCOVERY_SAFETY.targetMax);
  });

  it("bounds the number of areas one run may search", () => {
    assert.ok(DISCOVERY_SAFETY.maxAreas > 0 && DISCOVERY_SAFETY.maxAreas <= 100);
  });
});

describe("what reaches email discovery", () => {
  it("hands websites and emails through the pool untouched", () => {
    const source = prospect({
      businessName: "Tay Joinery",
      website: "https://tayjoinery.co.uk",
      websiteStatus: "Proper Website",
      email: "hello@tayjoinery.co.uk",
      phone: "01738 555111",
    });
    const { prospects } = buildProspectPool([source], { target: 60 });
    assert.deepEqual(prospects[0], source);
  });

  it("puts businesses with real sites ahead of those without, so they are crawled first", () => {
    const { prospects } = buildProspectPool(
      [
        prospect({ businessName: "No Site Joinery", phone: "01738 111111" }),
        prospect({ businessName: "Real Site Joinery", website: "https://realsitejoinery.co.uk", phone: "01738 222222" }),
      ],
      { target: 60, tradeTerms: ["joiner"] },
    );
    assert.equal(prospects[0]?.businessName, "Real Site Joinery");
    assert.equal(prospects[1]?.businessName, "No Site Joinery");
  });
});

describe("widening the domain guess did not widen what gets attached", () => {
  const identity = {
    businessName: "Smith Joiners",
    town: "Perth",
    trade: "Joiner",
    phone: "01738 555111",
    address: "1 Mill Street, Perth, PH1 5HZ",
  };

  it("refuses a substituted domain that carries none of the business's details", () => {
    // smithjoinery.co.uk is now generated as a candidate. That must change
    // nothing about whether it can be attached: a page with no matching phone,
    // postcode or address is somebody else's business.
    const match = scoreWebsiteMatch(
      {
        url: "https://smithjoinery.co.uk",
        text: "Quality joinery in Aberdeen. Call 01224 999888. 4 Union Street, Aberdeen, AB10 1BA.",
        title: "Smith Joinery Aberdeen",
      },
      identity,
    );
    assert.ok(match.score < WEBSITE_MIN_SCORE, `scored ${match.score}: ${match.evidence.join("; ")}`);
  });

  it("accepts a substituted domain that does corroborate the business", () => {
    const match = scoreWebsiteMatch(
      {
        url: "https://smithjoinery.co.uk",
        text: "Smith Joiners, Perth. Call 01738 555111. 1 Mill Street, Perth, PH1 5HZ.",
        title: "Smith Joiners Perth",
      },
      identity,
    );
    assert.ok(match.score >= WEBSITE_MIN_SCORE, `scored ${match.score}: ${match.evidence.join("; ")}`);
  });

  it("a name resemblance alone is never enough", () => {
    const match = scoreWebsiteMatch(
      { url: "https://smithjoinery.co.uk", text: "Smith Joinery", title: "Smith Joinery" },
      identity,
    );
    assert.ok(match.score < WEBSITE_MIN_SCORE, `scored ${match.score}: ${match.evidence.join("; ")}`);
  });

  it("keeps the probe budget and the candidate list the same size", () => {
    // Generating candidates nothing ever fetches is how the real domain got
    // missed; probing more than were generated would be a wasted request.
    const source = readFileSync(new URL("./qualify-server.ts", import.meta.url), "utf8");
    assert.match(source, /const WEBSITE_PROBES = MAX_WEBSITE_CANDIDATES;/);
  });
});
