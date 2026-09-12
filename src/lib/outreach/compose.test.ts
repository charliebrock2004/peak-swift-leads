import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildPrompt, composeEmail, leadFacts, parseAiDraft } from "./compose.ts";
import { checkEmailQuality, hasOptOut, readsAsUnsubscribe } from "./quality.ts";
import {
  composeFromTemplate,
  DEFAULT_TEMPLATES,
  leftoverVariables,
  renderTemplate,
  templateForLead,
  variablesFor,
} from "./templates.ts";
import type { OutreachLead } from "./types.ts";

function lead(partial: Partial<Lead> = {}): OutreachLead {
  return createLead({
    businessName: "Strathearn Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    email: "hello@strathearnjoinery.co.uk",
    emailConfidence: "HIGH",
    emailSource: "website contact page",
    websiteStatus: "No Website Found",
    ...partial,
  }) as OutreachLead;
}

describe("template variables", () => {
  it("fills in what it knows", () => {
    const out = renderTemplate("Hi {{business_name}} in {{location}}", variablesFor(lead()));
    assert.equal(out, "Hi Strathearn Joinery Ltd in Crieff");
  });

  it("leaves an unknown variable alone so the gate can catch it", () => {
    const out = renderTemplate("Hi {{nonsense}}", variablesFor(lead()));
    assert.match(out, /\{\{nonsense\}\}/);
    assert.deepEqual(leftoverVariables(out), ["nonsense"]);
  });

  it("says the right thing about each website situation", () => {
    assert.match(variablesFor(lead()).website_status, /no website/);
    assert.match(
      variablesFor(lead({ websiteStatus: "Social Only", website: "https://facebook.com/x" })).website_status,
      /Facebook/,
    );
    assert.match(
      variablesFor(lead({ websiteStatus: "Basic Website", website: "https://x.co", websiteQuality: "poor" }))
        .website_status,
      /basic website/,
    );
  });
});

describe("the shipped templates", () => {
  it("render with no placeholders left and pass the quality gate", () => {
    for (const template of DEFAULT_TEMPLATES) {
      const target = template.kind === "no-website" ? lead() : lead({ websiteStatus: "Basic Website", website: "https://x.co", websiteQuality: "improve" });
      const composed = composeFromTemplate(target, template);
      assert.deepEqual(leftoverVariables(composed.subject), [], `${template.id} subject`);
      assert.deepEqual(leftoverVariables(composed.body), [], `${template.id} body`);
      const verdict = checkEmailQuality({
        subject: composed.subject,
        body: composed.body,
        recipient: target.email,
        lead: target,
      });
      assert.equal(verdict.ok, true, `${template.id}: ${!verdict.ok ? verdict.problems.map((p) => p.message).join("; ") : ""}`);
    }
  });

  it("picks the template that fits the lead", () => {
    assert.equal(templateForLead(lead(), DEFAULT_TEMPLATES).kind, "no-website");
    assert.equal(
      templateForLead(lead({ websiteStatus: "Basic Website", website: "https://x.co", websiteQuality: "improve" }), DEFAULT_TEMPLATES).kind,
      "improvement",
    );
    assert.equal(
      templateForLead(lead({ websiteStatus: "Unclear", website: "" }), DEFAULT_TEMPLATES).kind,
      "general",
    );
  });

  it("never insults the recipient", () => {
    for (const template of DEFAULT_TEMPLATES) {
      assert.doesNotMatch(template.body, /terrible|awful|ugly|embarrassing|outdated/i, template.id);
    }
  });

  it("always offers a way to opt out", () => {
    for (const template of DEFAULT_TEMPLATES) {
      assert.ok(hasOptOut(template.body), `${template.id} must offer an opt-out`);
    }
  });
});

describe("the AI prompt", () => {
  it("only ever states facts we hold", () => {
    const facts = leadFacts(lead({ rating: "", reviews: "" }));
    assert.ok(facts.some((fact) => fact.startsWith("Business name:")));
    assert.equal(facts.some((fact) => fact.startsWith("Public rating:")), false, "no rating means no rating claimed");
  });

  it("forbids invention and insults, and demands the opt-out", () => {
    const prompt = buildPrompt(lead());
    assert.match(prompt, /Never invent/i);
    assert.match(prompt, /Never call it bad/i);
    assert.match(prompt, /rather I didn't contact you again/i);
    assert.match(prompt, /JSON only/i);
  });

  it("asks for something different for a follow-up", () => {
    assert.match(buildPrompt(lead(), "follow-up-2"), /final follow-up/i);
  });
});

describe("reading the AI back", () => {
  it("accepts plain JSON and a fenced block", () => {
    assert.deepEqual(parseAiDraft('{"subject":"Hi","body":"There"}'), { subject: "Hi", body: "There" });
    assert.deepEqual(parseAiDraft('```json\n{"subject":"Hi","body":"There"}\n```'), {
      subject: "Hi",
      body: "There",
    });
    assert.deepEqual(parseAiDraft('Sure!\n{"subject":"Hi","body":"There"}'), { subject: "Hi", body: "There" });
  });

  it("returns nothing rather than guessing", () => {
    for (const bad of ["", "not json", "{}", '{"subject":"Hi"}', '{"subject":"","body":"x"}']) {
      assert.equal(parseAiDraft(bad), null, `"${bad}" should not parse`);
    }
  });
});

describe("composing", () => {
  it("uses a template when no AI is configured, and says so", async () => {
    const result = await composeEmail(lead());
    assert.match(result.generatedBy, /^template:/);
    assert.match(result.fellBackBecause ?? "", /not configured/i);
  });

  it("uses a good AI draft", async () => {
    const result = await composeEmail(lead(), {
      generate: async () => ({
        subject: "A website for Strathearn Joinery Ltd?",
        body: "Hi,\n\nI'm Charlie from PeakSwift Studio. I couldn't find a website for Strathearn Joinery Ltd in Crieff, which means people looking for a joiner nearby may not be finding you. I'd be glad to put a simple one together and show you first.\n\nIf you'd rather I didn't contact you again, just let me know and I won't.",
      }),
    });
    assert.equal(result.generatedBy, "ai");
    assert.match(result.body, /PeakSwift Studio/);
    assert.equal(result.fellBackBecause, undefined);
  });

  it("falls back when the AI insults the business", async () => {
    const result = await composeEmail(lead(), {
      generate: async () => ({
        subject: "Your terrible website",
        body: "Hi, I noticed your website is terrible and awful. PeakSwift Studio can help Strathearn Joinery Ltd. If you'd rather I didn't contact you again, just let me know and I won't.",
      }),
    });
    assert.match(result.generatedBy, /^template:/);
    assert.match(result.fellBackBecause ?? "", /insulting/i);
  });

  it("falls back when the AI leaves a placeholder in", async () => {
    const result = await composeEmail(lead(), {
      generate: async () => ({
        subject: "Website for {{business_name}}",
        body: "Hi, PeakSwift Studio here about Strathearn Joinery Ltd and {{business_name}}. This body is long enough to pass the length check comfortably, and it ends properly. If you'd rather I didn't contact you again, just let me know and I won't.",
      }),
    });
    assert.match(result.generatedBy, /^template:/);
    assert.match(result.fellBackBecause ?? "", /placeholder/i);
  });

  it("falls back when the AI throws or returns nothing", async () => {
    const threw = await composeEmail(lead(), {
      generate: async () => {
        throw new Error("network down");
      },
    });
    assert.match(threw.generatedBy, /^template:/);
    const nothing = await composeEmail(lead(), { generate: async () => null });
    assert.match(nothing.fellBackBecause ?? "", /did not respond/i);
  });

  it("uses the template asked for by id", async () => {
    const result = await composeEmail(lead(), { mode: "general", templates: DEFAULT_TEMPLATES });
    assert.equal(result.generatedBy, "template:general");
  });
});

describe("the send-time quality gate", () => {
  const good = composeFromTemplate(lead(), DEFAULT_TEMPLATES[0]);

  it("passes a real email", () => {
    assert.equal(checkEmailQuality({ ...good, recipient: "hello@x.co.uk", lead: lead() }).ok, true);
  });

  it("refuses a placeholder that survived", () => {
    const verdict = checkEmailQuality({
      subject: "Hi {{business_name}}",
      body: good.body,
      recipient: "hello@x.co.uk",
      lead: lead(),
    });
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "placeholder"));
  });

  it("refuses an email that never names the business", () => {
    const verdict = checkEmailQuality({
      subject: "Hello there",
      body: "Hi, I build websites for small businesses and thought I would get in touch about yours. PeakSwift Studio. If you'd rather I didn't contact you again, just let me know and I won't.",
      recipient: "hello@x.co.uk",
      lead: lead(),
    });
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "not-personalised"));
  });

  it("refuses an email that never says who sent it", () => {
    const verdict = checkEmailQuality({
      subject: "About Strathearn Joinery Ltd",
      body: "Hi, I noticed Strathearn Joinery Ltd has no website and I could build you one. It would take a week or so and I would show you a mock-up first. If you'd rather I didn't contact you again, just let me know and I won't.",
      recipient: "hello@x.co.uk",
      lead: lead(),
    });
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "unidentified"));
  });

  it("refuses an email with no opt-out", () => {
    const verdict = checkEmailQuality({
      subject: "About Strathearn Joinery Ltd",
      body: "Hi, PeakSwift Studio here. I noticed Strathearn Joinery Ltd has no website and I could build you one. It would take a week or so and I would show you a mock-up before you decide anything at all.",
      recipient: "hello@x.co.uk",
      lead: lead(),
    });
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "no-opt-out"));
  });

  it("refuses a guessed or low-confidence address", () => {
    const guessed = checkEmailQuality({ ...good, recipient: "hello@x.co.uk", lead: lead({ emailSource: "guessed from domain" }) });
    assert.ok(!guessed.ok && guessed.problems.some((p) => p.code === "guessed-email"));
    const low = checkEmailQuality({ ...good, recipient: "hello@x.co.uk", lead: lead({ emailConfidence: "LOW" }) });
    assert.ok(!low.ok && low.problems.some((p) => p.code === "low-confidence"));
  });

  it("refuses a suppressed address", () => {
    const verdict = checkEmailQuality({
      ...good,
      recipient: "hello@x.co.uk",
      lead: lead(),
      suppressed: new Set(["hello@x.co.uk"]),
    });
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "suppressed"));
  });

  it("refuses a model talking about itself", () => {
    const verdict = checkEmailQuality({
      subject: "About Strathearn Joinery Ltd",
      body: "As an AI language model I cannot browse, but PeakSwift Studio would love to build Strathearn Joinery Ltd a website that works well for you. If you'd rather I didn't contact you again, just let me know and I won't.",
      recipient: "hello@x.co.uk",
      lead: lead(),
    });
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "broken"));
  });
});

describe("reading a reply as an unsubscribe", () => {
  it("catches the clear ones", () => {
    for (const text of [
      "Please remove me from your list",
      "unsubscribe",
      "Do not contact me again",
      "take me off your mailing list",
      "Please stop emailing me",
    ]) {
      assert.ok(readsAsUnsubscribe(text), `"${text}" should suppress`);
    }
  });

  it("does not treat a soft no as a permanent opt-out", () => {
    for (const text of [
      "No thanks, not right now",
      "We're not looking at the moment",
      "Maybe next year",
      "Can you send me a price?",
    ]) {
      assert.equal(readsAsUnsubscribe(text), false, `"${text}" should stay a normal reply`);
    }
  });
});

describe("the gate refuses claims nothing measured", () => {
  const recipient = "hello@x.co.uk";
  const send = (body: string) =>
    checkEmailQuality({ subject: "A website for Strathearn Joinery", body, recipient, lead: lead() });
  const frame = (claim: string) =>
    "Hi there, I'm Charlie from PeakSwiftStudio. Strathearn Joinery Ltd came up when " +
    `I was looking at joiners in Crieff. ${claim} ` +
    "If you'd rather I didn't get in touch again, just say and I won't.";

  it("EVERY template we ship still passes", () => {
    // The point of a fabrication rule is to stop the model inventing things.
    // If it also refuses our own copy, sending stops altogether — so this is
    // the test that has to hold before any of the others matter.
    for (const template of DEFAULT_TEMPLATES) {
      const composed = composeFromTemplate(lead(), template);
      const verdict = checkEmailQuality({ ...composed, recipient, lead: lead() });
      assert.equal(
        verdict.ok,
        true,
        `${template.id}: ${verdict.ok ? "" : verdict.problems.map((p) => p.message).join("; ")}`,
      );
    }
  });

  it("refuses a claim about load speed", () => {
    const verdict = send(frame("I noticed your website is quite slow to load."));
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "fabricated"));
  });

  it("refuses a claim about search ranking", () => {
    assert.equal(send(frame("Your SEO could be better so you rank higher on Google.")).ok, false);
  });

  it("refuses a claim about mobile rendering", () => {
    assert.equal(send(frame("Your site is not mobile friendly on a phone.")).ok, false);
  });

  it("refuses a claim that the site is dated", () => {
    assert.equal(send(frame("Your website looks a bit outdated these days.")).ok, false);
  });

  it("refuses a claim about traffic or conversion", () => {
    assert.equal(send(frame("Your conversion rate is probably suffering.")).ok, false);
  });

  it("refuses an observation about their site that was never made", () => {
    assert.equal(send(frame("I noticed your website is missing a few things.")).ok, false);
  });

  it("refuses a circular's greeting", () => {
    assert.equal(send(frame("Dear Business Owner, I can help with your web presence.")).ok, false);
    assert.equal(send(frame("I hope this email finds you well.")).ok, false);
  });

  it("ALLOWS the honest, evidenced things we do say", () => {
    // These are recorded observations with a field behind them, and they are
    // the reason most of these emails are worth sending at all.
    for (const honest of [
      "You don't seem to have a website yet, which is why I got in touch.",
      "It looks like Strathearn Joinery Ltd is on Facebook but has no site of its own.",
      "Strathearn Joinery Ltd has 40 reviews averaging 4.6 — a lot of goodwill to build on.",
    ]) {
      const verdict = send(frame(honest));
      assert.equal(
        verdict.ok,
        true,
        `refused an honest line: ${verdict.ok ? "" : verdict.problems.map((p) => p.message).join("; ")}`,
      );
    }
  });
});
