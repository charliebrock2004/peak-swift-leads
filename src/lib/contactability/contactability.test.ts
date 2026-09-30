import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyLegalForm,
  DEFAULT_CONTACT_RULES,
  kindFromCompanyNumber,
  kindFromCompanyType,
  sanitizeContactRules,
} from "./legal-form.ts";
import { classifyEmailAddress, emailContactability } from "./email.ts";
import { callContactability, normalizeUkPhone, SCREENING_VALID_DAYS } from "./phone.ts";

const NOW = new Date("2026-09-30T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe("legal form: the register decides when it can", () => {
  it("an active Ltd confirmed recently is a company, with high confidence", () => {
    const result = classifyLegalForm(
      { businessName: "Tayside Roofing", companyNumber: "SC555555", companyType: "ltd", companyStatus: "active", companyCheckedAt: daysAgo(3) },
      DEFAULT_CONTACT_RULES,
      NOW,
    );
    assert.equal(result.form, "CORPORATE");
    assert.equal(result.confidence, "high");
    assert.equal(result.basis, "companies_house");
    assert.match(result.reasons[0]!.text, /SC555555: private limited company, status active on/);
  });

  it("LLPs and Scottish partnerships are corporate; an English LP needs review", () => {
    assert.equal(kindFromCompanyType("llp")!.kind, "corporate");
    assert.equal(kindFromCompanyType("scottish-partnership")!.kind, "corporate");
    assert.equal(kindFromCompanyType("limited-partnership", "SL012345")!.kind, "corporate");
    assert.equal(kindFromCompanyType("limited-partnership", "LP012345")!.kind, "review");
    const lp = classifyLegalForm({ businessName: "X", companyNumber: "LP012345", companyType: "limited-partnership", companyStatus: "active", companyCheckedAt: daysAgo(1) }, DEFAULT_CONTACT_RULES, NOW);
    assert.equal(lp.form, "REVIEW_REQUIRED");
  });

  it("reads the entity from the number's prefix when the type was not stored", () => {
    assert.equal(kindFromCompanyNumber("SC612222")!.kind, "corporate");
    assert.equal(kindFromCompanyNumber("12345678")!.kind, "corporate");
    assert.equal(kindFromCompanyNumber("SO301234")!.label, "limited liability partnership");
    assert.equal(kindFromCompanyNumber("NL000123")!.kind, "review");
  });

  it("a dissolved or insolvent company needs review — it may now be a sole trader", () => {
    for (const status of ["dissolved", "liquidation", "administration"]) {
      const result = classifyLegalForm({ businessName: "Old Co Ltd", companyNumber: "SC1", companyType: "ltd", companyStatus: status, companyCheckedAt: daysAgo(1) }, DEFAULT_CONTACT_RULES, NOW);
      assert.equal(result.form, "REVIEW_REQUIRED", status);
    }
  });

  it("a stale or unchecked status still counts, at medium confidence, and says so", () => {
    const stale = classifyLegalForm({ businessName: "X", companyNumber: "SC1", companyType: "ltd", companyStatus: "active", companyCheckedAt: daysAgo(400) }, DEFAULT_CONTACT_RULES, NOW);
    assert.equal(stale.form, "CORPORATE");
    assert.equal(stale.confidence, "medium");
    assert.ok(stale.reasons.some((reason) => /re-check/.test(reason.text)));
  });
});

describe("legal form: without the register, conservative", () => {
  it("'Ltd' in the name is a company only if the rules trust it, and never at high confidence", () => {
    const trusted = classifyLegalForm({ businessName: "Strathearn Joinery Ltd" }, DEFAULT_CONTACT_RULES, NOW);
    assert.equal(trusted.form, "CORPORATE");
    assert.equal(trusted.confidence, "medium");
    assert.match(trusted.summary, /not yet confirmed/);
    const strict = classifyLegalForm({ businessName: "Strathearn Joinery Ltd" }, { ...DEFAULT_CONTACT_RULES, trustCompanySuffix: false }, NOW);
    assert.equal(strict.form, "REVIEW_REQUIRED");
  });

  it("'Ltd' in the name but no matching company on the register needs review", () => {
    const result = classifyLegalForm({ businessName: "Strathearn Joinery Ltd", companyCheckedAt: daysAgo(1) }, DEFAULT_CONTACT_RULES, NOW);
    assert.equal(result.form, "REVIEW_REQUIRED");
  });

  it("not found on Companies House is NOT proof of a sole trader: UNKNOWN", () => {
    const result = classifyLegalForm({ businessName: "Strathearn Joinery", companyCheckedAt: daysAgo(1) }, DEFAULT_CONTACT_RULES, NOW);
    assert.equal(result.form, "UNKNOWN");
    assert.equal(result.confidence, "low");
    assert.ok(result.reasons.some((reason) => /ICO/.test(reason.text)));
  });

  it("a personal mailbox with no company is an individual", () => {
    assert.equal(classifyLegalForm({ businessName: "Strathearn Joinery", email: "strathearnjoinery@gmail.com" }, DEFAULT_CONTACT_RULES, NOW).form, "INDIVIDUAL");
  });

  it("a person's name, searched and not found, is an individual; unsearched it is unknown", () => {
    assert.equal(classifyLegalForm({ businessName: "J Smith Joinery", companyCheckedAt: daysAgo(2) }, DEFAULT_CONTACT_RULES, NOW).form, "INDIVIDUAL");
    assert.equal(classifyLegalForm({ businessName: "J Smith Joinery" }, DEFAULT_CONTACT_RULES, NOW).form, "UNKNOWN");
  });

  it("a person's override wins, and is labelled as theirs", () => {
    const result = classifyLegalForm(
      { businessName: "J Smith Joinery", override: "CORPORATE", overrideNote: "Checked: trades as J Smith Joinery Ltd (SC999)", overrideAt: daysAgo(0) },
      DEFAULT_CONTACT_RULES,
      NOW,
    );
    assert.equal(result.form, "CORPORATE");
    assert.equal(result.basis, "override");
    assert.match(result.reasons[0]!.text, /Set by you on 2026-09-30: Checked/);
  });

  it("sanitises stored rules", () => {
    assert.deepEqual(sanitizeContactRules(null), DEFAULT_CONTACT_RULES);
    assert.deepEqual(sanitizeContactRules({ trustCompanySuffix: false, companyStatusMaxAgeDays: 99999 }), { trustCompanySuffix: false, companyStatusMaxAgeDays: 180 });
  });
});

describe("email addresses", () => {
  it("classifies role, named and personal mailboxes", () => {
    assert.equal(classifyEmailAddress("info@strathearn.co.uk").kind, "role");
    assert.equal(classifyEmailAddress("Enquiries2@strathearn.co.uk").kind, "role");
    assert.equal(classifyEmailAddress("john.smith@strathearn.co.uk").kind, "named");
    assert.equal(classifyEmailAddress("strathearn@btinternet.com").kind, "personal_mailbox");
  });

  it("knows whether it is on the business's own domain", () => {
    assert.equal(classifyEmailAddress("info@strathearn.co.uk", { website: "https://www.strathearn.co.uk/contact" }).onBusinessDomain, true);
    assert.equal(classifyEmailAddress("info@other.co.uk", { website: "strathearn.co.uk" }).onBusinessDomain, false);
    assert.equal(classifyEmailAddress("info@strathearn.co.uk").onBusinessDomain, null);
  });
});

describe("may we email them?", () => {
  const corporate = classifyLegalForm({ businessName: "X", companyNumber: "SC1", companyType: "ltd", companyStatus: "active", companyCheckedAt: daysAgo(1) }, DEFAULT_CONTACT_RULES, NOW);
  const unknown = classifyLegalForm({ businessName: "Strathearn Joinery" }, DEFAULT_CONTACT_RULES, NOW);
  const individual = classifyLegalForm({ businessName: "J Smith Joinery", companyCheckedAt: daysAgo(1) }, DEFAULT_CONTACT_RULES, NOW);
  const review = classifyLegalForm({ businessName: "X", companyNumber: "SC1", companyStatus: "dissolved" }, DEFAULT_CONTACT_RULES, NOW);

  it("a company's business address: yes", () => {
    const result = emailContactability({ email: "info@x.co.uk", legal: corporate });
    assert.equal(result.status, "ELIGIBLE");
    assert.deepEqual(result.reasons, []);
  });

  it("UNKNOWN is never email-eligible — it is held", () => {
    assert.equal(emailContactability({ email: "info@x.co.uk", legal: unknown }).status, "HOLD");
    assert.equal(emailContactability({ email: "info@x.co.uk", legal: review }).status, "HOLD");
  });

  it("an individual subscriber, or any personal mailbox, is blocked — even a company's", () => {
    assert.equal(emailContactability({ email: "info@x.co.uk", legal: individual }).status, "BLOCKED");
    const gmail = emailContactability({ email: "xltd@gmail.com", legal: corporate });
    assert.equal(gmail.status, "BLOCKED");
    assert.match(gmail.reasons[0]!, /Personal mailbox \(gmail\.com\)/);
  });

  it("an undeliverable address is blocked; catch-all is allowed but never called valid", () => {
    assert.equal(emailContactability({ email: "info@x.co.uk", legal: corporate, verification: { result: "invalid" } }).status, "BLOCKED");
    const catchAll = emailContactability({ email: "info@x.co.uk", legal: corporate, verification: { result: "catch_all" } });
    assert.equal(catchAll.status, "ELIGIBLE");
    assert.ok(catchAll.notes.some((note) => /cannot confirm/.test(note)));
  });

  it("notes a named person's address (UK GDPR)", () => {
    const result = emailContactability({ email: "john@x.co.uk", legal: corporate });
    assert.equal(result.status, "ELIGIBLE");
    assert.ok(result.notes.some((note) => /UK GDPR/.test(note)));
  });
});

describe("phone numbers", () => {
  it("normalises the ways UK numbers are written", () => {
    for (const raw of ["01764 123456", "+44 (0)1764 123456", "0044 1764 123456", "(01764) 123-456", "441764123456", "01764 123456 ext. 12"]) {
      assert.equal(normalizeUkPhone(raw)?.e164, "+441764123456", raw);
    }
    assert.equal(normalizeUkPhone("07700 900123")?.type, "mobile");
    assert.equal(normalizeUkPhone("0800 123 4567")?.type, "freephone");
    assert.equal(normalizeUkPhone("0909 123 4567")?.type, "premium");
    assert.equal(normalizeUkPhone("01764 123456")?.national, "01764 123456");
  });

  it("rejects what is not a UK number", () => {
    for (const raw of ["", "12345", "+1 415 555 0100", "call us", "07700 9001"]) assert.equal(normalizeUkPhone(raw), null, raw);
  });
});

describe("may we ring them?", () => {
  const base = { phone: "01764 123456" };

  it("an unscreened number is never presented as safe", () => {
    const result = callContactability(base, NOW);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.needsScreening, true);
    assert.match(result.reasons[0]!, /Not screened against TPS and CTPS/);
  });

  it("needs BOTH TPS and CTPS clear, within the validity window", () => {
    assert.equal(callContactability({ ...base, screening: { tps: "clear", ctps: "unchecked", checkedAt: daysAgo(1) } }, NOW).status, "UNKNOWN");
    assert.equal(callContactability({ ...base, screening: { tps: "clear", ctps: "clear", checkedAt: daysAgo(1) } }, NOW).status, "ELIGIBLE");
    const stale = callContactability({ ...base, screening: { tps: "clear", ctps: "clear", checkedAt: daysAgo(SCREENING_VALID_DAYS + 1) } }, NOW);
    assert.equal(stale.status, "UNKNOWN");
    assert.match(stale.reasons[0]!, /valid for 28 days/);
  });

  it("blocks TPS or CTPS registrations, the do-not-call list and past objections", () => {
    assert.equal(callContactability({ ...base, screening: { tps: "registered", ctps: "clear", checkedAt: daysAgo(1) } }, NOW).status, "BLOCKED");
    assert.equal(callContactability({ ...base, screening: { tps: "clear", ctps: "registered", checkedAt: daysAgo(1) } }, NOW).status, "BLOCKED");
    const dnc = callContactability({ ...base, screening: { tps: "clear", ctps: "clear", checkedAt: daysAgo(1) }, doNotCall: { source: "objection", reason: "asked not to be called" } }, NOW);
    assert.equal(dnc.status, "BLOCKED");
    assert.match(dnc.reasons[0]!, /objected/);
    assert.equal(callContactability({ ...base, callResult: "Not Interested" }, NOW).status, "BLOCKED");
    assert.equal(callContactability({ ...base, unsubscribed: "2026-09-01" }, NOW).status, "BLOCKED");
  });

  it("a callback they asked for is not unsolicited — but a do-not-call still wins", () => {
    assert.equal(callContactability({ ...base, callResult: "Callback" }, NOW).status, "ELIGIBLE");
    assert.equal(callContactability({ ...base, callResult: "Callback", doNotCall: { source: "internal", reason: "" } }, NOW).status, "BLOCKED");
    assert.equal(callContactability({ ...base, callResult: "Callback", screening: { tps: "registered", ctps: "unchecked", checkedAt: daysAgo(1) } }, NOW).status, "BLOCKED");
  });

  it("no number, a bad number or a premium-rate number is not callable", () => {
    assert.equal(callContactability({ phone: "" }, NOW).status, "BLOCKED");
    assert.equal(callContactability({ phone: "not a number" }, NOW).status, "BLOCKED");
    assert.equal(callContactability({ phone: "0909 123 4567" }, NOW).status, "BLOCKED");
  });
});
