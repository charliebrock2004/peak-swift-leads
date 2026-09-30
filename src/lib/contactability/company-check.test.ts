/**
 * The Companies House check, the provenance it leaves, and the other
 * contactability records — against the real schema (PGLite, every migration)
 * and a scripted Companies House. Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import * as store from "../outreach/store.server.ts";
import { checkEligibility, emptyContext } from "../outreach/eligibility.ts";
import type { ChClientOptions } from "../companies-house.ts";
import { matchCompany } from "./company-match.ts";
import { checkCompanyForLead, confirmCompanyForLead } from "./company-check.server.ts";
import * as contacts from "./store.server.ts";
import { callContactability } from "./phone.ts";
import { mergePlaces, sourceRecordsFor, type DiscoveredPlace } from "../osm-discover.ts";

const USER = "owner-1";
const NOW = new Date("2026-09-30T12:00:00Z");

type Scripted = { status?: number; body: unknown };

function fakeRegister(routes: Record<string, Scripted>) {
  const calls: string[] = [];
  const client: ChClientOptions = {
    apiKey: "test-key",
    limiter: async () => true,
    fetchImpl: (async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      const route = routes[url.pathname] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  };
  return { client, calls };
}

const searchItem = (name: string, number: string, locality: string, postcode: string, status = "active", type = "ltd") => ({
  title: name,
  company_number: number,
  company_status: status,
  company_type: type,
  date_of_creation: "2014-03-01",
  address: { address_line_1: "1 High Street", locality, postal_code: postcode },
  address_snippet: `1 High Street, ${locality}, ${postcode}`,
});

let db: TestDb;

async function addLead(overrides: Partial<Lead>) {
  const lead = createLead({ id: "lead-1", businessName: "Strathearn Joinery", trade: "Joiner", town: "Crieff", email: "hello@strathearnjoinery.co.uk", emailConfidence: "HIGH", emailSource: "Contact page", phone: "01764 123456", ...overrides });
  const { text, params } = buildLeadUpsert(USER, [lead]);
  await db.sql.query(text, params);
  return (await store.loadLead(db.sql, USER, lead.id))!;
}

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

describe("matching a business to the register", () => {
  it("takes the one company with the same name registered locally", () => {
    const match = matchCompany({ businessName: "Strathearn Joinery", town: "Crieff" }, [
      { ...hit("STRATHEARN JOINERY LTD", "SC100001", "Crieff", "PH7 3AA") },
      { ...hit("STRATHEARN JOINERY LTD", "SC100002", "Aberdeen", "AB10 1AA") },
    ]);
    assert.equal(match.kind, "match");
    assert.equal(match.kind === "match" && match.hit.companyNumber, "SC100001");
  });

  it("never guesses between two local companies with the same name", () => {
    const match = matchCompany({ businessName: "Strathearn Joinery", town: "Crieff" }, [
      hit("STRATHEARN JOINERY LTD", "SC100001", "Crieff", "PH7 3AA"),
      hit("STRATHEARN JOINERY (CRIEFF) LTD", "SC100003", "Crieff", "PH7 4BB"),
      hit("STRATHEARN JOINERY LIMITED", "SC100004", "Crieff", "PH7 5CC", "dissolved"),
    ]);
    assert.equal(match.kind, "ambiguous");
  });

  it("offers, but does not take, a same-name company registered elsewhere", () => {
    const match = matchCompany({ businessName: "Tayside Roofing", town: "Perth", address: "Unit 2, Inveralmond, PH1 3TW" }, [
      hit("TAYSIDE ROOFING SERVICES LTD", "SC555555", "Dundee", "DD1 4QB"),
    ]);
    assert.equal(match.kind, "ambiguous");
  });

  it("takes a longer legal name at the very same postcode", () => {
    const match = matchCompany({ businessName: "Tayside Roofing", town: "Perth", address: "Unit 2, Inveralmond, PH1 3TW" }, [
      hit("TAYSIDE ROOFING SERVICES LTD", "SC555555", "Perth", "PH1 3TW"),
    ]);
    assert.equal(match.kind, "match");
  });

  it("finds nothing when no name relates", () => {
    assert.equal(matchCompany({ businessName: "Strathearn Joinery", town: "Crieff" }, [hit("KINNOULL KITCHENS LTD", "SC1", "Perth", "PH2 7AA")]).kind, "none");
  });
});

function hit(legalName: string, companyNumber: string, town: string, postcode: string, companyStatus = "active") {
  return {
    businessName: legalName,
    legalName,
    companyNumber,
    companyType: "ltd",
    companyStatus,
    sicCodes: [],
    incorporatedOn: "2014-03-01",
    address: `1 High Street, ${town}, ${postcode}`,
    town,
    postcode,
    lat: "" as const,
    lng: "" as const,
    notes: "",
  };
}

describe("checking a business on Companies House", () => {
  it("links the single local match, records evidence and a source record, and releases the hold", async () => {
    const lead = await addLead({});
    assert.equal(checkEligibility(lead, emptyContext()).manualReview, true, "held before the check");
    const { client, calls } = fakeRegister({
      "/search/companies": { body: { items: [searchItem("STRATHEARN JOINERY LTD", "SC612222", "Crieff", "PH7 3AA")] } },
    });
    const outcome = await checkCompanyForLead(db.sql, USER, lead, client, NOW);
    assert.equal(outcome.status, "confirmed");
    assert.equal(calls.length, 1, "one request");

    const after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.deepEqual(
      { number: after.facts.companyNumber, type: after.facts.companyType, status: after.facts.companyStatus, at: after.facts.companyCheckedAt },
      { number: "SC612222", type: "ltd", status: "active", at: NOW.toISOString() },
    );
    const verdict = checkEligibility(after, emptyContext());
    assert.equal(verdict.eligible, true, "a confirmed company may be emailed");
    assert.equal(verdict.legal.basis, "companies_house");

    const evidence = await contacts.evidenceForLead(db.sql, USER, lead.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.kind, "company_record");
    assert.equal(evidence[0]!.source, "companies_house");
    assert.equal(evidence[0]!.sourceRef, "SC612222");
    assert.match(evidence[0]!.sourceUrl, /company\/SC612222$/);
    const sources = await contacts.sourceRecordsForLead(db.sql, USER, after);
    assert.equal(sources[0]!.id, "ch:SC612222");
    assert.equal(sources[0]!.fields.companyStatus, "active");
  });

  it("records 'searched, no match' — evidence, not proof — and keeps the business off email", async () => {
    const lead = await addLead({ businessName: "J Smith Joinery" });
    const { client } = fakeRegister({ "/search/companies": { body: { items: [searchItem("KINNOULL KITCHENS LTD", "SC1", "Perth", "PH2 7AA")] } } });
    assert.equal((await checkCompanyForLead(db.sql, USER, lead, client, NOW)).status, "no-match");
    const after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(after.facts.companyNumber, "");
    assert.equal(after.facts.companyCheckedAt, NOW.toISOString());
    const verdict = checkEligibility(after, emptyContext());
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.legal.form, "INDIVIDUAL", "a person's name, searched and not found");
  });

  it("records candidates for a person to pick, links nothing, and lets them confirm one", async () => {
    const lead = await addLead({});
    const { client } = fakeRegister({
      "/search/companies": {
        body: {
          items: [
            searchItem("STRATHEARN JOINERY LTD", "SC100001", "Crieff", "PH7 3AA"),
            searchItem("STRATHEARN JOINERY (CRIEFF) LTD", "SC100003", "Crieff", "PH7 4BB"),
          ],
        },
      },
      "/company/SC100003": {
        body: { company_number: "SC100003", company_name: "STRATHEARN JOINERY (CRIEFF) LTD", type: "ltd", company_status: "active", registered_office_address: { locality: "Crieff", postal_code: "PH7 4BB" } },
      },
    });
    const outcome = await checkCompanyForLead(db.sql, USER, lead, client, NOW);
    assert.equal(outcome.status, "ambiguous");
    assert.equal(outcome.status === "ambiguous" && outcome.candidates.length, 2);
    assert.equal((await store.loadLead(db.sql, USER, lead.id))!.facts.companyNumber, "", "nothing linked on a guess");

    const confirmed = await confirmCompanyForLead(db.sql, USER, lead, "sc100003", client, NOW);
    assert.equal(confirmed.status, "confirmed");
    const after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(after.facts.companyNumber, "SC100003");
    const current = await contacts.evidenceForLead(db.sql, USER, lead.id);
    assert.ok(current.some((item) => item.kind === "company_record" && /confirmed by you/.test(item.label)));
  });

  it("refreshes a known company from its profile, and a dissolved one goes back on hold", async () => {
    const lead = await addLead({ businessName: "Tayside Roofing Ltd", placeId: "ch:SC555555", foundAt: "2026-01-01T00:00:00.000Z" });
    const { client, calls } = fakeRegister({
      "/company/SC555555": {
        body: { company_number: "SC555555", company_name: "TAYSIDE ROOFING LTD", type: "ltd", company_status: "dissolved", date_of_cessation: "2026-06-01" },
      },
    });
    const outcome = await checkCompanyForLead(db.sql, USER, lead, client, NOW);
    assert.equal(outcome.status, "confirmed");
    assert.deepEqual(calls, ["/company/SC555555"]);
    const verdict = checkEligibility((await store.loadLead(db.sql, USER, lead.id))!, emptyContext());
    assert.equal(verdict.legal.form, "REVIEW_REQUIRED");
    assert.equal(verdict.eligible, false);
  });

  it("changes nothing when Companies House is not configured", async () => {
    const lead = await addLead({});
    const outcome = await checkCompanyForLead(db.sql, USER, lead, { apiKey: "", limiter: async () => true }, NOW);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.status === "error" && outcome.kind, "no-key");
    assert.equal((await store.loadLead(db.sql, USER, lead.id))!.facts.companyCheckedAt, "");
  });
});

describe("evidence history", () => {
  it("a newer fact retires the older one, which is kept as history", async () => {
    await contacts.addEvidence(db.sql, USER, "lead-1", [{ kind: "company_record", value: "SC1", label: "first", source: "companies_house", confidence: "high" }]);
    await contacts.addEvidence(db.sql, USER, "lead-1", [{ kind: "company_record", value: "SC2", label: "second", source: "companies_house", confidence: "high" }]);
    const current = await contacts.evidenceForLead(db.sql, USER, "lead-1");
    assert.deepEqual(current.map((item) => item.value), ["SC2"]);
    const history = await contacts.evidenceForLead(db.sql, USER, "lead-1", { history: true });
    assert.equal(history.length, 2);
    assert.ok(history.find((item) => item.value === "SC1")!.supersededAt);
  });

  it("is scoped to the account", async () => {
    await contacts.addEvidence(db.sql, USER, "lead-1", [{ kind: "k", value: "v", label: "l", source: "manual", confidence: "high" }]);
    assert.equal((await contacts.evidenceForLead(db.sql, "owner-2", "lead-1")).length, 0);
  });
});

describe("legal-form rulings", () => {
  it("a person's ruling releases a hold, is labelled as theirs, and can be cleared", async () => {
    const lead = await addLead({});
    await contacts.setLegalFormOverride(db.sql, USER, lead.id, { form: "CORPORATE", note: "SC612222 on the register", at: NOW.toISOString() });
    let after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(checkEligibility(after, emptyContext()).eligible, true);
    assert.equal(checkEligibility(after, emptyContext()).legal.basis, "override");
    await contacts.setLegalFormOverride(db.sql, USER, lead.id, { form: "", note: "", at: NOW.toISOString() });
    after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(checkEligibility(after, emptyContext()).manualReview, true);
  });

  it("does not bump updated_at, so a server-side fact never triggers a device re-sync", async () => {
    const lead = await addLead({});
    const [before] = await db.sql.query<{ updated_at: string }>(`select updated_at::text from leads where user_id = $1 and id = $2`, [USER, lead.id]);
    await contacts.saveCompanyFacts(db.sql, USER, lead.id, { companyNumber: "SC1", companyType: "ltd", companyStatus: "active", checkedAt: NOW.toISOString() });
    const [after] = await db.sql.query<{ updated_at: string }>(`select updated_at::text from leads where user_id = $1 and id = $2`, [USER, lead.id]);
    assert.equal(after!.updated_at, before!.updated_at);
  });
});

describe("screening and the do-not-call list", () => {
  it("stores numbers in E.164 so every way of writing one number matches", async () => {
    await contacts.recordScreening(db.sql, USER, "+44 (0)1764 123456", { tps: "clear", ctps: "clear", checkedAt: NOW.toISOString(), method: "TPS Assure" });
    const screenings = await contacts.loadScreenings(db.sql, USER);
    assert.ok(screenings.has("+441764123456"));
    const status = callContactability({ phone: "01764 123456", screening: screenings.get("+441764123456") }, NOW);
    assert.equal(status.status, "ELIGIBLE");
  });

  it("an objection blocks, cannot be downgraded, and cannot be removed from the list", async () => {
    await contacts.addDoNotCall(db.sql, USER, { phone: "01764 123456", reason: "asked us not to call", source: "objection" });
    await contacts.addDoNotCall(db.sql, USER, { phone: "+441764123456", reason: "", source: "internal" });
    await contacts.removeDoNotCall(db.sql, USER, "01764 123456");
    const dnc = await contacts.loadDoNotCall(db.sql, USER);
    assert.deepEqual(dnc.get("+441764123456")?.source, "objection");
    assert.equal(dnc.get("+441764123456")?.reason, "asked us not to call");
    await contacts.addDoNotCall(db.sql, USER, { phone: "07700 900123", reason: "", source: "internal" });
    await contacts.removeDoNotCall(db.sql, USER, "07700 900123");
    assert.equal((await contacts.loadDoNotCall(db.sql, USER)).has("+447700900123"), false);
  });

  it("refuses something that is not a UK number", async () => {
    await assert.rejects(contacts.recordScreening(db.sql, USER, "call us", { tps: "clear", ctps: "clear", checkedAt: NOW.toISOString(), method: "x" }));
  });
});

describe("discovery keeps provenance through a merge", () => {
  const place = (partial: Partial<DiscoveredPlace> & { businessName: string }): DiscoveredPlace => ({
    trade: "Roofer",
    town: "Perth",
    address: "",
    phone: "",
    email: "",
    website: "",
    lat: "",
    lng: "",
    mapsLink: "",
    source: "OpenStreetMap",
    notes: "",
    placeId: "",
    businessStatus: "",
    osmChecked: true,
    ...partial,
    sourceIds: partial.placeId ? [partial.placeId] : [],
  });

  it("merges a register record into the same business and records both sources against it", async () => {
    const osm = place({ businessName: "Tayside Roofing", address: "Unit 2, PH1 3TW", placeId: "osm:node:77" });
    const ch = place({ businessName: "Tayside Roofing Services Ltd", address: "Unit 2, PH1 3TW", placeId: "ch:SC555555", source: "Companies House", notes: "Companies House SC555555 (ltd)" });
    const merged = mergePlaces([osm], [ch]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.sourceIds, ["osm:node:77", "ch:SC555555"]);
    const records = sourceRecordsFor(merged, [osm], [{ ...hit("TAYSIDE ROOFING SERVICES LTD", "SC555555", "Perth", "PH1 3TW") }]);
    assert.deepEqual(records.map((record) => [record.id, record.primaryId]).sort(), [["ch:SC555555", "osm:node:77"], ["osm:node:77", "osm:node:77"]]);
    await contacts.upsertSourceRecords(db.sql, USER, records);
    // The business is saved with the map listing's place id; both records are its.
    const lead = await addLead({ businessName: "Tayside Roofing", placeId: "osm:node:77", notes: merged[0]!.notes });
    const sources = await contacts.sourceRecordsForLead(db.sql, USER, lead);
    assert.deepEqual(sources.map((source) => source.id).sort(), ["ch:SC555555", "osm:node:77"]);
    // …and the register's number reaches the legal-form rules.
    assert.equal(checkEligibility(lead, emptyContext()).legal.basis, "companies_house");
  });

  it("does NOT merge a like-named company registered in another town — no borrowed legal form", () => {
    const soleTrader = place({ businessName: "Highland Joinery", town: "Crieff", address: "PH7 3AA", placeId: "osm:node:5", phone: "07700 900123" });
    const company = place({ businessName: "Highland Joinery Ltd", town: "Inverness", address: "IV1 1AA", placeId: "ch:SC999999", source: "Companies House", notes: "Companies House SC999999 (ltd)" });
    const merged = mergePlaces([soleTrader], [company]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.notes, "", "the sole trader did not inherit the company's number");
  });
});
