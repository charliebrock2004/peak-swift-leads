/**
 * Upgrading a database with real leads in it to 0010 (source records,
 * evidence, contactability).
 *
 * 0010 backfills one thing: businesses found through the old Companies House
 * search carry their company number in `place_id`, and that search only ever
 * returned active companies. Everything else is new tables and new columns
 * with defaults. This checks the backfill does exactly that and nothing more,
 * that re-running it changes nothing, and that the app reads the result.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sqlFrom } from "./test-support/pglite.ts";
import * as store from "./outreach/store.server.ts";
import { checkEligibility, emptyContext } from "./outreach/eligibility.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => a.localeCompare(b));
const NEW = "0010_evidence_contactability.sql";
const USER = "legacy-user";

let pg: PGlite;

async function apply(names: string[]) {
  for (const name of names) await pg.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
}

type Row = { id: string; company_number: string; company_status: string; company_checked_at: string; legal_form_override: string; updated_at: string };
async function rows(): Promise<Row[]> {
  return (
    await pg.query<Row>(
      `select id, company_number, company_status, company_checked_at, legal_form_override, updated_at::text from leads where user_id = $1 order by id`,
      [USER],
    )
  ).rows;
}

describe("upgrading a live database to 0010", () => {
  let before0010: { id: string; business_name: string; email: string; place_id: string; updated_at: string }[] = [];

  before(async () => {
    pg = new PGlite({ parsers: { 20: Number, 1082: (v: string) => v, 1186: (v: string) => v } });
    await pg.waitReady;
    assert.ok(files.includes(NEW), "0010 must exist");
    await apply(files.filter((name) => name < NEW));
    const insert = (id: string, name: string, placeId: string, foundAt: string, email = "") =>
      pg.query(
        `insert into leads (user_id, id, business_name, trade, town, email, email_confidence, email_source, place_id, found_at, website_status)
         values ($1, $2, $3, 'Joiner', 'Perth', $4, 'HIGH', 'Contact page', $5, $6, 'No Website Found')`,
        [USER, id, name, email, placeId, foundAt],
      );
    await insert("ch-lead", "TAYSIDE ROOFING SERVICES LTD", "ch:sc555555", "2026-08-01T09:00:00.000Z", "info@taysideroofing.co.uk");
    await insert("osm-lead", "Strathearn Joinery", "osm:node:123", "2026-08-02T09:00:00.000Z", "hello@strathearnjoinery.co.uk");
    await insert("hand-lead", "Kinnoull Kitchens", "", "");
    before0010 = (await pg.query<{ id: string; business_name: string; email: string; place_id: string; updated_at: string }>(
      `select id, business_name, email, place_id, updated_at::text from leads where user_id = $1 order by id`,
      [USER],
    )).rows;
    // 0010, then everything after it: the loaders below are today's code.
    await apply(files.filter((name) => name >= NEW));
  });

  after(async () => {
    await pg.close();
  });

  it("fills the company number, status and date for Companies House finds only", async () => {
    const byId = new Map((await rows()).map((row) => [row.id, row]));
    assert.deepEqual(
      { number: byId.get("ch-lead")!.company_number, status: byId.get("ch-lead")!.company_status, at: byId.get("ch-lead")!.company_checked_at },
      { number: "SC555555", status: "active", at: "2026-08-01T09:00:00.000Z" },
    );
    for (const id of ["osm-lead", "hand-lead"]) {
      assert.equal(byId.get(id)!.company_number, "", id);
      assert.equal(byId.get(id)!.company_status, "", id);
      assert.equal(byId.get(id)!.legal_form_override, "", id);
    }
  });

  it("changes nothing the browser syncs (and does not bump updated_at, so no sync storm)", async () => {
    const now = (await pg.query<{ id: string; business_name: string; email: string; place_id: string; updated_at: string }>(
      `select id, business_name, email, place_id, updated_at::text from leads where user_id = $1 order by id`,
      [USER],
    )).rows;
    assert.deepEqual(now, before0010);
  });

  it("is idempotent, and never overwrites a company number already set", async () => {
    await pg.query(`update leads set company_number = 'SC999999', company_status = 'dissolved' where user_id = $1 and id = 'ch-lead'`, [USER]);
    const first = await rows();
    await apply([NEW]);
    assert.deepEqual(await rows(), first);
    assert.equal(first.find((row) => row.id === "ch-lead")!.company_number, "SC999999");
    await pg.query(`update leads set company_number = 'SC555555', company_status = 'active' where user_id = $1 and id = 'ch-lead'`, [USER]);
  });

  it("refuses a legal form that is not one of the four", async () => {
    await assert.rejects(pg.query(`update leads set legal_form_override = 'PROBABLY_FINE' where user_id = $1 and id = 'osm-lead'`, [USER]));
  });

  it("the app reads the facts, and the send gate uses them", async () => {
    const sql = sqlFrom(pg);
    const leads = await store.loadLeads(sql, USER);
    const ch = leads.find((lead) => lead.id === "ch-lead")!;
    assert.equal(ch.facts.companyNumber, "SC555555");
    assert.equal(checkEligibility(ch, emptyContext()).legal.basis, "companies_house");
    const osm = leads.find((lead) => lead.id === "osm-lead")!;
    const verdict = checkEligibility(osm, emptyContext());
    assert.equal(verdict.eligible, false, "not confirmed as a company: held, never emailed");
    assert.equal(verdict.manualReview, true);
    const settings = await store.loadSettings(sql, USER);
    assert.deepEqual(settings.contactRules, { trustCompanySuffix: true, companyStatusMaxAgeDays: 180 });
  });
});
