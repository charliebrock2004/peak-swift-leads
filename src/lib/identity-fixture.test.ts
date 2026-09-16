import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDuplicate, type LeadIdentity } from "./identity.ts";
import { mergePlaces, type DiscoveredPlace } from "./osm-discover.ts";
import { buildProspectPool } from "./prospect-pool.ts";
import type { Prospect } from "./research.ts";

/**
 * A Perth-shaped candidate set with the answers written down.
 *
 * `truth` is the real-world business. Two rows sharing a `truth` ARE one
 * business and should merge; two rows with different `truth` are different
 * businesses and must not. Measured against the matcher as it stood before
 * Phase 14, this fixture produced three false merges — two firms called
 * Highland Joinery in different towns, two called Bell Joinery in one town,
 * and a Companies House record absorbed into an unrelated firm with the same
 * trading name. All three are named below so a regression names itself.
 */
type Row = LeadIdentity & { tag: string; truth: string };
const R = (tag: string, truth: string, p: Partial<LeadIdentity> & { businessName: string }): Row =>
  ({ town: "Perth", phone: "", mapsLink: "", tag, truth, ...p });

const FIXTURE: Row[] = [
  R("nominatim/Perth", "tay", { businessName: "Tay Joinery", town: "Perth", placeId: "osm:node:101", phone: "01738 555111", website: "https://tayjoinery.co.uk" }),
  R("nominatim/Scone", "tay", { businessName: "Tay Joinery", town: "Scone", placeId: "osm:node:101", phone: "01738 555111" }),
  R("nominatim/Errol", "tay", { businessName: "Tay Joinery", town: "Errol", placeId: "osm:node:101" }),
  R("photon/Perth", "tay", { businessName: "Tay Joinery", town: "Perth", placeId: "osm:N:101", phone: "01738 555111" }),
  R("photon/Methven", "tay", { businessName: "Tay Joinery Ltd", town: "Methven", phone: "+44 1738 555111" }),

  R("nominatim/Crieff", "strathearn", { businessName: "Strathearn Joinery Ltd", town: "Crieff", placeId: "osm:node:202", phone: "01764 652211" }),
  R("photon/Crieff", "strathearn", { businessName: "Strathearn Joinery", town: "Crieff", placeId: "osm:W:202", phone: "01764 652211" }),

  R("nominatim/Perth", "highland-perth", { businessName: "Highland Joinery Ltd", town: "Perth", placeId: "osm:node:301", phone: "01738 777111", website: "https://highlandjoinery.co.uk" }),
  R("nominatim/Blairgowrie", "highland-blair", { businessName: "Highland Joinery Ltd", town: "Blairgowrie", placeId: "osm:node:302", phone: "01250 888222", website: "https://highland-joinery.com" }),

  R("nominatim/Perth", "bell-a", { businessName: "Bell Joinery", town: "Perth", placeId: "osm:node:401", phone: "01738 111111" }),
  R("photon/Perth", "bell-b", { businessName: "Bell Joinery", town: "Perth", placeId: "osm:node:402", phone: "01738 999999" }),

  R("nominatim/Scone", "macd-a", { businessName: "MacDonald Joinery", town: "Scone", placeId: "osm:node:501", phone: "01738 333333" }),
  R("nominatim/Errol", "macd-b", { businessName: "MacDonald Joiners", town: "Errol", placeId: "osm:node:502", phone: "01821 444444" }),
  R("nominatim/Perth", "smith-a", { businessName: "J Smith Joinery", town: "Perth", placeId: "osm:node:601", phone: "01738 121212" }),
  R("nominatim/Perth", "smith-b", { businessName: "J Smith Joinery & Son", town: "Perth", placeId: "osm:node:602", phone: "01738 343434" }),

  R("photon/Perth", "fb-a", { businessName: "Alpha Joiners", town: "Perth", website: "https://facebook.com/alphajoiners", phone: "01738 151515" }),
  R("photon/Scone", "fb-b", { businessName: "Beta Joiners", town: "Scone", website: "https://facebook.com/betajoiners", phone: "01738 161616" }),
  R("nominatim/Perth", "dir-a", { businessName: "Gamma Joiners", town: "Perth", website: "https://yell.com/biz/gamma", phone: "01738 171717" }),
  R("nominatim/Errol", "dir-b", { businessName: "Delta Joiners", town: "Errol", website: "https://yell.com/biz/delta", phone: "01821 181818" }),

  R("ch", "chco", { businessName: "Perthshire Joinery Limited", town: "Perth", placeId: "ch:SC123456" }),
  R("ch", "chco", { businessName: "PERTHSHIRE JOINERY LTD", town: "Perth", placeId: "ch:SC123456" }),
  R("ch", "ch-other-highland", { businessName: "Highland Joinery Ltd", town: "Aberfeldy", placeId: "ch:SC999999" }),
  R("ch", "tay", { businessName: "Tay Joinery Ltd", town: "Perth", placeId: "ch:SC777777" }),

  R("nominatim/Dunning", "lonely", { businessName: "Dunning Woodcraft", town: "Dunning", placeId: "osm:node:701" }),
  R("photon/Dunning", "lonely", { businessName: "Dunning Woodcraft", town: "Dunning", placeId: "osm:N:701" }),
];

function run() {
  const kept: Row[] = [];
  const falseMerges: string[] = [];
  const missedMerges: string[] = [];
  let correctMerges = 0;
  for (const row of FIXTURE) {
    const hit = findDuplicate(row, kept);
    if (hit) {
      if (hit.lead.truth === row.truth) correctMerges += 1;
      else falseMerges.push(`${row.businessName} [${row.truth}] merged into ${hit.lead.businessName} [${hit.lead.truth}] via ${hit.reason}`);
    } else {
      if (kept.some((k) => k.truth === row.truth)) missedMerges.push(`${row.businessName} [${row.truth}]`);
      kept.push(row);
    }
  }
  return { kept, correctMerges, falseMerges, missedMerges };
}

describe("the Perth identity fixture", () => {
  const trueDistinct = new Set(FIXTURE.map((r) => r.truth)).size;

  it("merges every genuine duplicate", () => {
    const { correctMerges, missedMerges } = run();
    assert.deepEqual(missedMerges, [], "a genuine duplicate was left unmerged");
    assert.equal(correctMerges, FIXTURE.length - trueDistinct);
  });

  it("makes no false merge", () => {
    const { falseMerges } = run();
    assert.deepEqual(falseMerges, [], falseMerges.join("\n"));
  });

  it("lands on exactly the true number of distinct businesses", () => {
    // The old matcher produced 14 here against a truth of 17.
    assert.equal(run().kept.length, trueDistinct);
    assert.equal(trueDistinct, 17);
  });

  it("names the three merges that used to be wrong", () => {
    const { kept } = run();
    const truths = new Set(kept.map((k) => k.truth));
    assert.ok(truths.has("highland-perth") && truths.has("highland-blair"), "two Highland Joinery firms collapsed");
    assert.ok(truths.has("bell-a") && truths.has("bell-b"), "two Bell Joinery firms collapsed");
    assert.ok(truths.has("ch-other-highland"), "a Companies House record was absorbed by a same-name firm elsewhere");
  });
});

describe("the candidate pool uses the same decisions", () => {
  const asProspect = (row: Row): Prospect => ({
    businessName: row.businessName, trade: "Joiner", town: row.town, address: "",
    phone: row.phone, email: row.email ?? "", rating: "", reviews: "",
    website: row.website ?? "", mapsLink: row.mapsLink, websiteStatus: "No Website Found",
    notes: "", source: row.tag.startsWith("ch") ? "Companies House" : "OpenStreetMap via Nominatim",
    priority: "WARM", reason: "", lat: "", lng: "", placeId: row.placeId ?? "",
    foundAt: "2026-01-01", businessStatus: "",
  });

  it("delivers the same distinct count as the authority", () => {
    const { prospects, diagnostics } = buildProspectPool(FIXTURE.map(asProspect), { target: 200 });
    assert.equal(prospects.length, new Set(FIXTURE.map((r) => r.truth)).size);
    assert.equal(diagnostics.collected, FIXTURE.length);
  });

  it("records why each duplicate was a duplicate", () => {
    const { diagnostics } = buildProspectPool(FIXTURE.map(asProspect), { target: 200 });
    const byReason = diagnostics.duplicatesByReason;
    const total = Object.values(byReason).reduce((sum, n) => sum + n, 0);
    assert.equal(total, diagnostics.duplicatesAcrossAreas);
    assert.ok(byReason.PLACE_ID > 0, "OSM ids should account for some merges");
    assert.ok(diagnostics.duplicateSamples.length > 0);
    for (const note of diagnostics.duplicateSamples) {
      assert.ok(note.incoming && note.existing && note.reason);
    }
  });
});

describe("within-area merging uses the same authority", () => {
  const P = (o: Partial<DiscoveredPlace> & { businessName: string }): DiscoveredPlace => ({
    trade: "Joiner", town: "Perth", address: "", phone: "", email: "", website: "",
    lat: "", lng: "", mapsLink: "", source: "OpenStreetMap", notes: "", placeId: "",
    businessStatus: "", osmChecked: false, ...o,
  });

  it("no longer merges a short one-word name across towns", () => {
    // mergePlaces used to merge any two folded names of four characters or
    // more, with no space and no town required. "Tays" in Perth and "Tays" in
    // Crieff became one business before the pool ever saw them.
    const merged = mergePlaces(
      [P({ businessName: "Tays", town: "Perth", placeId: "osm:node:901", phone: "01738 444111" })],
      [P({ businessName: "Tays", town: "Crieff", placeId: "osm:node:902", phone: "01764 555222" })],
    );
    assert.equal(merged.length, 2);
  });

  it("no longer merges two firms whose only agreement is a name", () => {
    const merged = mergePlaces(
      [P({ businessName: "Highland Joinery Ltd", town: "Perth", placeId: "osm:node:301", phone: "01738 777111" })],
      [P({ businessName: "Highland Joinery Ltd", town: "Blairgowrie", placeId: "osm:node:302", phone: "01250 888222" })],
    );
    assert.equal(merged.length, 2);
  });

  it("still merges one business found by two sources, and fills its blanks", () => {
    const merged = mergePlaces(
      [P({ businessName: "Tay Joinery", town: "Perth", placeId: "osm:node:101" })],
      [P({ businessName: "Tay Joinery", town: "Scone", placeId: "osm:N:101", phone: "01738 555111", website: "https://tayjoinery.co.uk" })],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.phone, "01738 555111");
    assert.equal(merged[0]?.website, "https://tayjoinery.co.uk");
  });

  it("still merges on a shared phone when names differ", () => {
    const merged = mergePlaces(
      [P({ businessName: "Tay Joinery", phone: "01738 555111" })],
      [P({ businessName: "Tay Joinery and Sons", town: "Scone", phone: "+44 1738 555111" })],
    );
    assert.equal(merged.length, 1);
  });
});
