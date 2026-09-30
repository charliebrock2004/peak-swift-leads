import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead } from "../leads.ts";
import { DEFAULT_PROFILE, effectiveProfile, fromName, profileIsSetUp, profileSignature, sanitizeProfile } from "./profile.ts";
import { buildPrompt, composeEmail } from "./compose.ts";
import { checkEmailQuality } from "./quality.ts";
import { composeFromTemplate, DEFAULT_TEMPLATES } from "./templates.ts";
import type { OutreachLead } from "./types.ts";

const lead = createLead({
  businessName: "Strathearn Joinery Ltd",
  trade: "Joiner",
  town: "Crieff",
  email: "hello@strathearnjoinery.co.uk",
  emailConfidence: "HIGH",
  emailSource: "Business contact page",
  websiteStatus: "No Website Found",
}) as OutreachLead;

const mine = effectiveProfile({
  businessName: "Peak Swift Studio",
  senderName: "Charlie",
  location: "Perth",
  cta: "I'd be glad to put a free mock-up together.",
  signature: "Charlie Brock\nPeak Swift Studio\n07700 900123",
});

describe("the business profile", () => {
  it("defaults to exactly what the app always sent", () => {
    assert.equal(DEFAULT_PROFILE.businessName, "PeakSwiftStudio");
    assert.equal(DEFAULT_PROFILE.senderName, "Charlie");
    assert.equal(profileIsSetUp(null), false);
    assert.equal(profileIsSetUp({ businessName: "Peak Swift Studio", senderName: "Charlie" }), true);
  });

  it("refuses header injection and bad URLs, and says so", () => {
    const { profile, problems } = sanitizeProfile({
      senderName: "Charlie\r\nBcc: everyone@x.com",
      website: "javascript:alert(1)",
      senderEmail: "not-an-email",
      optOutLine: "Thanks for reading.",
    });
    assert.ok(!/[\r\n]/.test(profile.senderName));
    assert.equal(profile.website, "");
    assert.equal(profile.senderEmail, "");
    assert.equal(profile.optOutLine, "", "an opt-out that gives no way out is not kept");
    assert.deepEqual(problems.map((problem) => problem.field).sort(), ["optOutLine", "senderEmail", "website"]);
  });

  it("builds the From name and signature from the profile", () => {
    assert.equal(fromName(mine), "Charlie at Peak Swift Studio");
    assert.equal(profileSignature(mine), "Charlie Brock\nPeak Swift Studio\n07700 900123");
    assert.equal(profileSignature(effectiveProfile({ businessName: "Peak Swift Studio", senderName: "Charlie" })), "Charlie\nPeak Swift Studio");
  });

  it("puts the owner's details and call to action into the prompt", () => {
    const prompt = buildPrompt(lead, "initial", mine);
    assert.match(prompt, /Studio: Peak Swift Studio/);
    assert.match(prompt, /free mock-up/);
    assert.match(prompt, /Never pretend to have spoken to them/);
    assert.match(prompt, /70 to 120 words/);
  });

  it("renders every template with the profile and still passes the gate for that studio", () => {
    for (const template of DEFAULT_TEMPLATES) {
      const composed = composeFromTemplate(lead, template, mine);
      assert.match(composed.body, /Charlie Brock\nPeak Swift Studio/, template.id);
      assert.doesNotMatch(composed.body, /Perthshire/, `${template.id} uses the profile's location`);
      const verdict = checkEmailQuality({ ...composed, recipient: lead.email, lead, studio: mine.businessName });
      assert.equal(verdict.ok, true, `${template.id}: ${verdict.ok ? "" : verdict.problems.map((p) => p.message).join("; ")}`);
    }
  });

  it("refuses an email that names a different studio from the profile's", () => {
    const composed = composeFromTemplate(lead, DEFAULT_TEMPLATES[0]!);
    const verdict = checkEmailQuality({ ...composed, recipient: lead.email, lead, studio: "Tay Web Co" });
    assert.ok(!verdict.ok && verdict.problems.some((problem) => problem.code === "unidentified"));
  });

  it("falls back to the template when the AI invents a claim, and says why", async () => {
    const result = await composeEmail(lead, {
      profile: mine,
      generate: async () => ({
        subject: "Website for Strathearn Joinery",
        body:
          "Hi, I'm Charlie from Peak Swift Studio. Strathearn Joinery Ltd has 52 five-star reviews and I couldn't find a website for you. " +
          "I build simple sites for trades around Perth. If you'd rather I didn't contact you again, just let me know and I won't.",
        personalisation: "Used their reviews.",
      }),
    });
    assert.match(result.generatedBy, /^template:/);
    assert.match(result.fellBackBecause ?? "", /52 reviews/);
    assert.match(result.personalisation, /Template/);
  });

  it("keeps an honest AI draft and its personalisation note", async () => {
    const result = await composeEmail(lead, {
      profile: mine,
      generate: async () => ({
        subject: "Website for Strathearn Joinery",
        body:
          "Hi, I'm Charlie from Peak Swift Studio in Perth. I was looking at joiners in Crieff and couldn't find a website for Strathearn Joinery Ltd. " +
          "I build simple sites for local trades and would be glad to put a free mock-up together. If you'd rather I didn't contact you again, just let me know and I won't.",
        personalisation: "Referenced their joinery work in Crieff and that no website was found.",
      }),
    });
    assert.equal(result.generatedBy, "ai");
    assert.equal(result.personalisation, "Referenced their joinery work in Crieff and that no website was found.");
    assert.match(result.body, /Charlie Brock\nPeak Swift Studio/);
  });
});
