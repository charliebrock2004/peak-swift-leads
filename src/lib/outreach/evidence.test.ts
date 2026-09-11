import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import {
  evidenceFacts,
  evidenceSummary,
  gatherEvidence,
  hasRealPersonalisation,
  parseEvidenceSummary,
  strongestEvidence,
} from "./evidence.ts";
import { buildPrompt } from "./compose.ts";
import { DEFAULT_SIGNATURE, SENDER_STUDIO } from "./templates.ts";
import type { OutreachLead } from "./types.ts";

const lead = (over: Partial<Lead> = {}): OutreachLead =>
  createLead({
    businessName: "Strathearn Joinery Ltd", trade: "Joiner", town: "Crieff",
    businessStatus: "Active", ...over,
  }) as OutreachLead;

describe("what we can honestly say about a prospect", () => {
  it("says a business has no website when the listing confirms it", () => {
    const found = gatherEvidence(lead({ websiteStatus: "No Website Found" }));
    assert.equal(found[0].kind, "NO_WEBSITE");
    assert.equal(found[0].strength, "STRONG");
    assert.match(found[0].text, /Strathearn Joinery Ltd/);
  });

  it("distinguishes social-only from no presence at all", () => {
    assert.equal(gatherEvidence(lead({ websiteStatus: "Social Only" }))[0].kind, "SOCIAL_ONLY");
    assert.equal(gatherEvidence(lead({ websiteStatus: "Directory Only" }))[0].kind, "DIRECTORY_ONLY");
  });

  it("only comments on a site's content when a check recorded something", () => {
    const withNote = gatherEvidence(lead({
      websiteStatus: "Basic Website", websiteAnalysis: "No contact form and no services page.",
    }));
    assert.ok(withNote.some((e) => e.kind === "SITE_OBSERVATION"));
    const without = gatherEvidence(lead({ websiteStatus: "Basic Website" }));
    assert.equal(without.some((e) => e.kind === "SITE_OBSERVATION"), false);
  });

  it("NEVER manufactures a claim about speed, mobile or ranking", () => {
    // Nothing in the app measures these, so nothing may assert them.
    const all = gatherEvidence(lead({
      websiteStatus: "Basic Website", websiteQuality: "poor", websiteAnalysis: "Thin page.",
      reviews: 40, rating: 4.8,
    }));
    const text = all.map((e) => e.text).join(" ").toLowerCase();
    for (const forbidden of ["slow", "mobile", "outdated", "ranking", "seo", "traffic", "ugly", "old"]) {
      assert.equal(text.includes(forbidden), false, `must not claim "${forbidden}"`);
    }
  });

  it("mentions reviews only when there are enough to mean anything", () => {
    assert.ok(gatherEvidence(lead({ reviews: 40, rating: 4.8 })).some((e) => e.kind === "WELL_REVIEWED"));
    assert.equal(gatherEvidence(lead({ reviews: 2 })).some((e) => e.kind === "WELL_REVIEWED"), false);
  });

  it("puts the strongest observation first", () => {
    const found = gatherEvidence(lead({ websiteStatus: "No Website Found", reviews: 40 }));
    assert.equal(found[0].strength, "STRONG");
  });

  it("traces every observation back to the field that justified it", () => {
    for (const item of gatherEvidence(lead({ websiteStatus: "No Website Found", reviews: 40 }))) {
      assert.ok(item.source.length > 0, item.kind);
    }
  });
});

describe("choosing what to write about", () => {
  it("takes at most three, strongest first", () => {
    const picked = strongestEvidence(gatherEvidence(lead({
      websiteStatus: "No Website Found", websiteAnalysis: "x", reviews: 40, rating: 4.9,
    })));
    assert.ok(picked.length <= 3);
    assert.equal(picked[0].strength, "STRONG");
  });

  it("never repeats the same kind of observation", () => {
    const picked = strongestEvidence(gatherEvidence(lead({ websiteStatus: "No Website Found" })));
    assert.equal(new Set(picked.map((p) => p.kind)).size, picked.length);
  });

  it("knows when there is nothing worth personalising from", () => {
    // Trade and town alone is a mail merge wearing a business's name.
    const thin = gatherEvidence(lead({ websiteStatus: "Proper Website", websiteQuality: "good" }));
    assert.equal(hasRealPersonalisation(thin), false);
    assert.ok(hasRealPersonalisation(gatherEvidence(lead({ websiteStatus: "No Website Found" }))));
  });
});

describe("storing why an email said what it said", () => {
  it("round-trips through storage", () => {
    const original = strongestEvidence(gatherEvidence(lead({
      websiteStatus: "No Website Found", reviews: 40, rating: 4.8,
    })));
    const back = parseEvidenceSummary(evidenceSummary(original));
    assert.equal(back.length, original.length);
    assert.equal(back[0].kind, original[0].kind);
    assert.equal(back[0].source, original[0].source);
  });

  it("survives an empty or malformed stored value", () => {
    assert.deepEqual(parseEvidenceSummary(""), []);
    assert.deepEqual(parseEvidenceSummary("   "), []);
    assert.equal(parseEvidenceSummary("something unstructured")[0].text, "something unstructured");
  });

  it("is bounded, so one row cannot grow without limit", () => {
    const huge = Array.from({ length: 200 }, () => gatherEvidence(lead({ websiteStatus: "No Website Found" }))[0]);
    assert.ok(evidenceSummary(huge).length <= 2000);
  });
});

describe("PeakSwiftStudio branding", () => {
  it("signs as PeakSwiftStudio", () => {
    assert.equal(SENDER_STUDIO, "PeakSwiftStudio");
    assert.match(DEFAULT_SIGNATURE, /Charlie/);
    assert.match(DEFAULT_SIGNATURE, /PeakSwiftStudio/);
  });

  it("omits the website line rather than inventing a URL", () => {
    // PEAKSWIFT_WEBSITE is unset in tests, so the line must simply be absent.
    assert.equal(DEFAULT_SIGNATURE.split("\n").filter(Boolean).length, 2);
    assert.equal(/https?:\/\//.test(DEFAULT_SIGNATURE), false);
  });

  it("tells the model to name the studio and forbids the claims we cannot support", () => {
    const prompt = buildPrompt(lead({ websiteStatus: "No Website Found" }));
    assert.ok(prompt.includes("PeakSwiftStudio"));
    assert.match(prompt, /Never claim anything about speed, mobile, design age, search ranking or traffic/);
    assert.match(prompt, /Never invent a first name/);
  });

  it("gives the model only observations that came from a field", () => {
    const facts = evidenceFacts(lead({ websiteStatus: "No Website Found", reviews: 40, rating: 4.8 }));
    for (const fact of facts.filter((f) => f.startsWith("Observed"))) {
      assert.match(fact, /^Observed \([^)]+\):/, fact);
    }
  });

  it("has nothing to PITCH about a business with a good site", () => {
    // Context like "Joiner in Crieff" is a fact and fine to pass on. What must
    // be absent is any strong or useful observation, because there is nothing
    // wrong with their web presence to write about — and eligibility refuses
    // such a lead anyway.
    const found = gatherEvidence(lead({ websiteStatus: "Proper Website", websiteQuality: "good" }));
    assert.equal(hasRealPersonalisation(found), false);
    assert.ok(found.every((item) => item.strength === "CONTEXT"));
  });
});
