import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDuplicate } from "./leads.ts";
import {
  buildProspectPool,
  funnelReconciles,
  type PoolDiagnostics,
} from "./prospect-pool.ts";
import type { Prospect } from "./research.ts";

/**
 * The pipeline at the scale it will actually run at.
 *
 * A Perth search already pools ~600 businesses; UK-wide will pool thousands.
 * Two properties have to hold at every size, and neither is obvious from
 * reading the code: the funnel's numbers must reconcile exactly, and the cost
 * must not be quadratic — dedupe compares each candidate against everything
 * already pooled, which is the classic place for an O(n²) regression to hide.
 */

function prospect(partial: Partial<Prospect> & { businessName: string }): Prospect {
  return {
    trade: "Joiner", town: "Perth", address: "", phone: "", email: "", rating: "",
    reviews: "", website: "", mapsLink: "", websiteStatus: "No Website Found", notes: "",
    source: "Companies House", priority: "WARM", reason: "", lat: "", lng: "", placeId: "",
    foundAt: "2026-01-01", businessStatus: "", ...partial,
  };
}

const TOWNS = [
  "Perth", "Scone", "Bridge of Earn", "Methven", "Errol", "Stanley", "Abernethy",
  "Dunning", "Kinross", "Coupar Angus", "Auchterarder", "Crieff", "Blairgowrie", "Dunkeld",
];

/**
 * A realistic area result: prominent firms every town surfaces, a local tail,
 * and the awkward shapes — Facebook-only, directory-only, no website at all.
 */
function areaRows(town: string, index: number, shared: number, local: number): Prospect[] {
  const rows: Prospect[] = [];
  for (let i = 0; i < shared; i += 1) {
    rows.push(prospect({
      businessName: `Perthshire Joinery ${i} Limited`,
      town,
      phone: `01738 ${String(200000 + i).slice(-6)}`,
      placeId: `shared-${i}`,
      source: i % 2 === 0 ? "Companies House" : "OpenStreetMap via Nominatim",
    }));
  }
  for (let i = 0; i < local; i += 1) {
    const flavour = i % 4;
    rows.push(prospect({
      businessName: `${town} Joinery ${i} Limited`,
      town,
      phone: `01738 ${String(300000 + index * 1000 + i).slice(-6)}`,
      placeId: `local-${index}-${i}`,
      website:
        flavour === 0 ? `https://${town.toLowerCase().replace(/\s/g, "")}joinery${i}.co.uk`
          : flavour === 1 ? `https://facebook.com/${town}-${i}`
            : flavour === 2 ? `https://yell.com/biz/${town}-${i}`
              : "",
      source: flavour === 3 ? "OpenStreetMap via Overpass" : "OpenStreetMap",
    }));
  }
  return rows;
}

function build(towns: number, shared: number, local: number): Prospect[] {
  return TOWNS.slice(0, towns).flatMap((town, index) => areaRows(town, index, shared, local));
}

describe("the funnel reconciles at every scale", () => {
  const shapes: { name: string; towns: number; shared: number; local: number; target: number }[] = [
    { name: "1 town", towns: 1, shared: 5, local: 20, target: 60 },
    { name: "5 towns", towns: 5, shared: 12, local: 20, target: 60 },
    { name: "14 towns", towns: 14, shared: 31, local: 40, target: 60 },
    { name: "100+ raw rows", towns: 4, shared: 10, local: 20, target: 25 },
    { name: "500+ raw rows", towns: 14, shared: 20, local: 25, target: 60 },
    { name: "1000+ raw rows", towns: 14, shared: 40, local: 45, target: 200 },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: every business leaves by exactly one door`, () => {
      const rows = build(shape.towns, shape.shared, shape.local);
      const { diagnostics } = buildProspectPool(rows, { target: shape.target });
      assert.equal(diagnostics.collected, rows.length);
      assert.ok(funnelReconciles(diagnostics), JSON.stringify(diagnostics, null, 2));
    });
  }

  it("reconciles with heavy known, suppressed and contacted sets", () => {
    const rows = build(14, 31, 40);
    const unique = buildProspectPool(rows, { target: 500 }).prospects;
    const { diagnostics } = buildProspectPool(rows, {
      target: 60,
      known: unique.slice(0, 200),
      suppressed: unique.slice(200, 208),
      contacted: unique.slice(208, 222),
    });
    assert.ok(diagnostics.alreadyKnown >= 200);
    assert.equal(diagnostics.suppressed, 8);
    assert.equal(diagnostics.alreadyContacted, 14);
    assert.ok(funnelReconciles(diagnostics), JSON.stringify(diagnostics, null, 2));
  });

  it("reconciles when the safety ceiling bites", () => {
    const rows = build(14, 31, 40);
    const { diagnostics } = buildProspectPool(rows, { target: 60, ceiling: 100 });
    assert.equal(diagnostics.ceilingHit, true);
    assert.ok(funnelReconciles(diagnostics), JSON.stringify(diagnostics, null, 2));
  });

  it("reconciles when nothing at all is new", () => {
    const rows = build(5, 12, 20);
    const all = buildProspectPool(rows, { target: 500 }).prospects;
    const { prospects, diagnostics } = buildProspectPool(rows, { target: 60, known: all });
    assert.equal(prospects.length, 0);
    assert.ok(funnelReconciles(diagnostics), JSON.stringify(diagnostics, null, 2));
  });
});

describe("awkward shapes never merge two different businesses", () => {
  it("keeps Facebook-only and directory-only businesses separate", () => {
    const rows = [
      prospect({ businessName: "Alpha Joiners", town: "Perth", website: "https://facebook.com/a", phone: "01738 111111" }),
      prospect({ businessName: "Beta Joiners", town: "Scone", website: "https://facebook.com/b", phone: "01738 222222" }),
      prospect({ businessName: "Gamma Joiners", town: "Errol", website: "https://yell.com/biz/g", phone: "01738 333333" }),
      prospect({ businessName: "Delta Joiners", town: "Methven", website: "https://yell.com/biz/d", phone: "01738 444444" }),
    ];
    assert.equal(buildProspectPool(rows, { target: 60 }).prospects.length, 4);
  });

  it("merges genuine duplicate phones and genuine duplicate domains", () => {
    const rows = [
      prospect({ businessName: "Tay Joinery", town: "Perth", phone: "01738 555111" }),
      prospect({ businessName: "Tay Joinery Ltd", town: "Scone", phone: "+44 1738 555111" }),
      prospect({ businessName: "Almond Works", town: "Errol", website: "https://almondworks.co.uk" }),
      prospect({ businessName: "Almond Works Joinery", town: "Perth", website: "https://almondworks.co.uk/about" }),
    ];
    assert.equal(buildProspectPool(rows, { target: 60 }).prospects.length, 2);
  });

  it("keeps similarly-named businesses in different towns apart", () => {
    const rows = [
      prospect({ businessName: "Bell", town: "Perth", phone: "01738 111111" }),
      prospect({ businessName: "Bell", town: "Crieff", phone: "01764 222222" }),
      prospect({ businessName: "Bella", town: "Errol", phone: "01821 333333" }),
    ];
    assert.equal(buildProspectPool(rows, { target: 60 }).prospects.length, 3);
  });

  it("agrees with findDuplicate over a large mixed pool", () => {
    const rows = build(14, 31, 40);
    const { prospects } = buildProspectPool(rows, { target: 500 });
    // The pool's survivors must be mutually distinct by the original authority.
    for (let i = 0; i < prospects.length; i += 1) {
      const others = prospects.slice(0, i);
      assert.equal(
        findDuplicate(prospects[i]!, others),
        null,
        `${prospects[i]!.businessName} duplicates an earlier survivor`,
      );
    }
  });
});

describe("the pipeline does not become quadratic", () => {
  function timeFor(rows: Prospect[]): number {
    const started = Date.now();
    buildProspectPool(rows, { target: 200 });
    return Date.now() - started;
  }

  it("scales roughly linearly from 500 to 4,000 candidates", () => {
    const small = Array.from({ length: 500 }, (_, i) =>
      prospect({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${String(100000 + i).slice(-6)}`, placeId: `p-${i}` }),
    );
    const large = Array.from({ length: 4000 }, (_, i) =>
      prospect({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${String(100000 + i).slice(-6)}`, placeId: `p-${i}` }),
    );
    // Warm up, so the first run's JIT cost does not masquerade as growth.
    timeFor(small);
    const smallMs = Math.max(1, timeFor(small));
    const largeMs = Math.max(1, timeFor(large));
    // Eight times the input. Quadratic would be ~64x; linear ~8x. Twenty is a
    // wide margin that still fails loudly on an O(n²) regression.
    assert.ok(
      largeMs < smallMs * 20,
      `500 rows took ${smallMs}ms, 4,000 took ${largeMs}ms — that looks superlinear`,
    );
  });

  it("handles 4,000 candidates well inside a request budget", () => {
    const rows = Array.from({ length: 4000 }, (_, i) =>
      prospect({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${String(100000 + i).slice(-6)}`, placeId: `p-${i}` }),
    );
    const started = Date.now();
    const { diagnostics } = buildProspectPool(rows, { target: 200, ceiling: 5000 });
    assert.ok(Date.now() - started < 2000, "pooling 4,000 candidates should take well under two seconds");
    assert.equal(diagnostics.newCandidates, 4000);
    assert.ok(funnelReconciles(diagnostics as PoolDiagnostics));
  });
});
