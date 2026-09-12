/**
 * The adversarial matrix for the send-time quality gate.
 *
 * Two real regressions reached production from this gate, both the same
 * mistake: a rule written literally enough to refuse ordinary English. A bare
 * "slow" refused "winter is a slow month"; an exact "PeakSwiftStudio" refused
 * the signature the model actually writes. Both silently blocked approval,
 * because a refused draft never reaches the send queue.
 *
 * So this file attacks the gate from both sides at once. Every rule has to be
 * STRICT about claims nothing measured, and TOLERANT of how people write. A
 * change that trades one for the other fails here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { checkEmailQuality, hasOptOut, mentionsBusiness } from "./quality.ts";
import { composeFromTemplate, DEFAULT_TEMPLATES, identifiesSender } from "./templates.ts";
import type { OutreachLead } from "./types.ts";

function lead(partial: Partial<Lead> = {}): OutreachLead {
  return createLead({
    id: "L", businessName: "Strathearn Joinery Ltd", trade: "Joiner", town: "Crieff",
    phone: "01764 700000", address: "1 High Street, Crieff PH7 3AB",
    email: "hello@strathearn.co.uk", emailConfidence: "HIGH", emailSource: "Contact page",
    websiteStatus: "No Website Found", reviews: 40, rating: 4.6, ...partial,
  }) as OutreachLead;
}

const OPT_OUT = "If you'd rather I didn't contact you again, just let me know and I won't.";
const SIGNATURE = "\n\nCharlie\nPeakSwift Studio";

/** A complete, realistic email built around one sentence. */
function mail(middle: string, name = "Strathearn Joinery Ltd", optOut = OPT_OUT): string {
  return `Hi,\n\nI came across ${name} while looking at joiners around Crieff. ${middle}\n\n${optOut}${SIGNATURE}`;
}

function gate(body: string, subject = "A website for Strathearn Joinery") {
  return checkEmailQuality({ subject, body, recipient: "hello@strathearn.co.uk", lead: lead() });
}

function why(verdict: ReturnType<typeof gate>): string {
  return verdict.ok ? "" : verdict.problems.map((p) => `${p.code}: ${p.message}`).join(" | ");
}

// ── Twenty legitimate emails ─────────────────────────────────────────────────

const LEGITIMATE: [string, string][] = [
  ["plain no-website", "You don't seem to have a website yet, and I build small fast sites for trades."],
  ["offers to build one", "I can build you a simple website that shows your work and lets people get in touch."],
  ["mobile-friendly as OUR service", "I build mobile friendly websites that work well on a phone."],
  ["responsive as OUR service", "Everything I build is responsive, so it reads properly on any screen."],
  ["fast as OUR promise", "I build fast, simple sites — nothing bloated."],
  ["load times as OUR promise", "I keep load times down by keeping things simple."],
  ["Facebook to website", "I can help turn your Facebook presence into a proper website."],
  ["the word converting", "Converting your Facebook page into a website is usually a day's work."],
  ["declining SEO work", "I'm not an SEO person — I just build straightforward websites."],
  ["Google as a place people look", "People often look on Google first, and a simple site helps them find you."],
  ["a slow month", "If winter is a slow month for you, it can be a good time to sort this."],
  ["modern", "I'd keep it modern and simple, nothing fussy."],
  ["professional", "It would look professional without costing a fortune."],
  ["customers and leads", "It gives customers somewhere to look and can bring in a few more leads."],
  ["visibility, plainly", "Mostly it's about being easy to find when someone asks around."],
  ["evidenced reviews", "Forty reviews averaging 4.6 is a lot of goodwill to build on."],
  ["social only", "It looks like you're on Facebook but don't have a site of your own."],
  ["a compliment", "You clearly care about your work, and a site should show that."],
  ["short and plain", "I build websites for trades around Perthshire and wondered if you'd want one."],
  ["British spelling", "I'd get it optimised for whatever you need, and keep the colours simple."],
];

describe("twenty legitimate emails, every one of which must approve", () => {
  for (const [label, middle] of LEGITIMATE) {
    it(`approves: ${label}`, () => {
      const verdict = gate(mail(middle));
      assert.equal(verdict.ok, true, why(verdict));
    });
  }

  it("approves all twenty", () => {
    const approved = LEGITIMATE.filter(([, middle]) => gate(mail(middle)).ok).length;
    assert.equal(approved, 20, `only ${approved} of 20 legitimate emails approved`);
  });
});

// ── Twenty unsafe emails ─────────────────────────────────────────────────────

const UNSAFE: [string, string][] = [
  ["their site is slow", "I noticed your website is quite slow to load."],
  ["their site loads slowly", "Your site loads slowly on a phone."],
  ["their page speed", "Your page speed could really be better."],
  ["their SEO is poor", "Your SEO could be improved so you rank higher on Google."],
  ["they are not ranking", "You aren't ranking well in search results at the moment."],
  ["first page of Google", "I can get you on the first page of Google."],
  ["not mobile friendly", "Your website isn't mobile friendly."],
  ["does not work on a phone", "Your site doesn't work on a phone."],
  ["site is outdated", "Your website looks a bit outdated these days."],
  ["design is looking dated", "Your design is looking quite dated."],
  ["conversion rate", "Your conversion rate is probably suffering."],
  ["bounce rate", "Your bounce rate must be high."],
  ["web traffic", "Your web traffic must be low."],
  ["invented observation", "I noticed your website is missing a few things."],
  ["insulting: terrible", "Your website is terrible and needs replacing."],
  ["insulting: amateur", "The site looks amateur."],
  ["condescending", "You clearly don't have anything online at all."],
  ["AI talking about itself", "As an AI language model I can help with your website."],
  ["unfilled placeholder", "Hi [business name], I can build you a website."],
  ["circular's greeting", "Dear Business Owner, I can help with your web presence."],
];

describe("twenty unsafe emails, every one of which must refuse", () => {
  for (const [label, middle] of UNSAFE) {
    it(`refuses: ${label}`, () => {
      assert.equal(gate(mail(middle)).ok, false, `this should never be sendable: ${middle}`);
    });
  }

  it("refuses all twenty", () => {
    const refused = UNSAFE.filter(([, middle]) => !gate(mail(middle)).ok).length;
    assert.equal(refused, 20, `only ${refused} of 20 unsafe emails were refused`);
  });
});

// ── Ten sender-name variations ───────────────────────────────────────────────

describe("ten spellings of the studio's own name", () => {
  const VARIATIONS = [
    "PeakSwiftStudio", "PeakSwift Studio", "Peak Swift Studio", "Peak-Swift Studio",
    "peakswift studio", "PEAKSWIFT STUDIO", "PeakSwiftStudios", "Peak  Swift  Studio",
    "peakSwiftStudio", "PeakSwift  Studio",
  ];

  for (const studio of VARIATIONS) {
    it(`accepts "${studio}"`, () => {
      assert.ok(identifiesSender(`Charlie\n${studio}`));
      const verdict = gate(
        `Hi,\n\nI came across Strathearn Joinery Ltd. I build sites for trades.\n\n${OPT_OUT}\n\nCharlie\n${studio}`,
      );
      assert.equal(verdict.ok, true, why(verdict));
    });
  }

  it("still refuses somebody else's name", () => {
    for (const impostor of ["Acme Web Design", "Peak Studio", "Swift Studio", "Peak Mountain Studio", "Google"]) {
      assert.equal(identifiesSender(`Charlie\n${impostor}`), false, impostor);
    }
  });
});

// ── Ten phrases that must not trip a fabrication rule ────────────────────────

describe("ten ordinary phrases that must not read as fabrication", () => {
  const PHRASES: [string, string][] = [
    ["a slow month", "Trade can be slow in January."],
    ["working fast", "I work fast and keep it simple."],
    ["converting a building", "I once helped a joiner converting a shed into a showroom."],
    ["conversation", "I'd rather start a conversation than sell you anything."],
    ["google as a verb", "If someone googles joiners in Crieff they should find you."],
    ["a mobile number", "My mobile number is at the bottom of this message."],
    ["old buildings", "You work on old buildings, which suits a simple site."],
    ["modern kitchens", "Your modern kitchen work would photograph well."],
    ["traffic on the street", "The traffic on the High Street makes parking tricky."],
    ["customers asking", "Customers often ask where to see previous work."],
  ];

  for (const [label, middle] of PHRASES) {
    it(`allows: ${label}`, () => {
      const verdict = gate(mail(middle));
      assert.equal(verdict.ok, true, why(verdict));
    });
  }
});

// ── The recipient's own name ─────────────────────────────────────────────────

describe("naming the business, however the model writes it", () => {
  it("accepts the name with a dropped or spelled-out suffix", () => {
    for (const written of ["Strathearn Joinery Ltd", "Strathearn Joinery", "Strathearn Joinery Limited", "Strathearn"]) {
      const verdict = gate(mail("I build websites for trades.", written));
      assert.equal(verdict.ok, true, `"${written}": ${why(verdict)}`);
    }
  });

  it("handles &/and, apostrophes and capitalisation", () => {
    assert.ok(mentionsBusiness("Smith and Sons Joinery", "Smith & Sons Joinery Ltd"));
    assert.ok(mentionsBusiness("Smith & Sons Joinery", "Smith and Sons Joinery"));
    assert.ok(mentionsBusiness("OBriens Barbers", "O'Brien's Barbers"));
    assert.ok(mentionsBusiness("THE STRATHEARN JOINERY", "Strathearn Joinery Ltd"));
  });

  it("STILL refuses an email that names nobody", () => {
    const verdict = gate(
      `Hi,\n\nI build websites for trades around Crieff.\n\n${OPT_OUT}${SIGNATURE}`,
      "A website for your business",
    );
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "not-personalised"));
  });

  it("STILL refuses an email that names a different business", () => {
    const verdict = gate(
      `Hi,\n\nI came across Dunblane Roofing while looking around.\n\n${OPT_OUT}${SIGNATURE}`,
      "A website for your business",
    );
    assert.equal(verdict.ok, false);
  });

  it("counts a name that appears only in the subject", () => {
    const verdict = gate(
      `Hi,\n\nI build websites for trades around Crieff.\n\n${OPT_OUT}${SIGNATURE}`,
      "A website for Strathearn Joinery",
    );
    assert.equal(verdict.ok, true, why(verdict));
  });
});

// ── The opt-out, which is a required rule ────────────────────────────────────

describe("recognising an opt-out however it is worded", () => {
  it("accepts the ways a person actually writes one", () => {
    for (const line of [
      "If you'd rather I didn't contact you again, just let me know and I won't.",
      "If you'd prefer I didn't get in touch again, just say and I won't.",
      "If you'd rather not hear from me, just say.",
      "Let me know if you'd like me to stop and I will.",
      "Tell me to stop and I won't contact you again.",
      "If this isn't welcome, just say the word and I'll leave it there.",
      "Happy to leave you be if you'd rather — just reply and say so.",
      "Reply STOP and that's the end of it.",
    ]) {
      assert.ok(hasOptOut(line), `not recognised as an opt-out: "${line}"`);
    }
  });

  it("STILL refuses an email that gives no way out", () => {
    for (const line of [
      "Hope to hear from you.",
      "Thanks for your time.",
      "Let me know what you think.",
      "Call me any time.",
    ]) {
      assert.equal(hasOptOut(line), false, `wrongly counted as an opt-out: "${line}"`);
    }
    const verdict = gate(`Hi,\n\nStrathearn Joinery Ltd could use a website. I build them.${SIGNATURE}`);
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.problems.some((p) => p.code === "no-opt-out"));
  });
});

// ── The gate must never refuse our own copy ──────────────────────────────────

describe("our own templates", () => {
  it("every template we ship still passes the gate", () => {
    for (const template of DEFAULT_TEMPLATES) {
      const composed = composeFromTemplate(lead(), template);
      const verdict = checkEmailQuality({
        subject: composed.subject,
        body: composed.body,
        recipient: "hello@strathearn.co.uk",
        lead: lead(),
      });
      assert.equal(verdict.ok, true, `${template.id}: ${why(verdict)}`);
    }
  });
});

// ── The distinction the whole gate turns on ──────────────────────────────────

describe("an offer about our work versus a verdict on theirs", () => {
  const pairs: [string, string][] = [
    ["I can build a website that loads quickly.", "Your website is quite slow to load."],
    ["I build mobile friendly sites.", "Your site isn't mobile friendly."],
    ["Everything I build is responsive.", "Your website is not responsive."],
    ["I keep designs modern and simple.", "Your design is looking quite dated."],
    ["I can help turn your Facebook presence into a website.", "Your conversion rate is probably suffering."],
    ["I'm not an SEO person.", "I can improve your SEO."],
  ];

  for (const [offer, verdict] of pairs) {
    it(`allows "${offer}" and refuses "${verdict}"`, () => {
      assert.equal(gate(mail(offer)).ok, true, why(gate(mail(offer))));
      assert.equal(gate(mail(verdict)).ok, false, `this is a claim we never measured: ${verdict}`);
    });
  }
});
