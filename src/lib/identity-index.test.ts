import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIdentityIndex, identityKeys, indexOf } from "./identity-index.ts";
import { findDuplicate, type LeadIdentity } from "./identity.ts";

function identity(partial: Partial<LeadIdentity> & { businessName: string }): LeadIdentity {
  return { town: "Perth", phone: "", mapsLink: "", ...partial };
}

/**
 * The index exists only to make `findDuplicate` fast enough to run against
 * thousands of pooled candidates. If the two ever disagree about whether a
 * business is a duplicate, the index is wrong — so the matrix below asks both.
 */
const CASES: { name: string; stored: LeadIdentity[]; candidate: LeadIdentity; duplicate: boolean }[] = [
  {
    name: "same place id",
    stored: [identity({ businessName: "Tay Joinery", placeId: "abc" })],
    candidate: identity({ businessName: "Completely Different", town: "Elgin", placeId: "abc" }),
    duplicate: true,
  },
  {
    name: "same phone, different formatting",
    stored: [identity({ businessName: "Tay Joinery", phone: "01738 555111" })],
    candidate: identity({ businessName: "Tay Joinery Ltd", phone: "+44 1738 555111" }),
    duplicate: true,
  },
  {
    name: "same email",
    stored: [identity({ businessName: "Tay Joinery", email: "hello@tay.co.uk" })],
    candidate: identity({ businessName: "Other Firm", town: "Errol", email: "HELLO@TAY.CO.UK" }),
    duplicate: true,
  },
  {
    name: "same independent host on different paths",
    stored: [identity({ businessName: "Tay Joinery", website: "https://tayjoinery.co.uk" })],
    candidate: identity({ businessName: "Tay & Sons", town: "Scone", website: "https://tayjoinery.co.uk/contact" }),
    duplicate: true,
  },
  {
    name: "both only on Facebook — not the same business",
    stored: [identity({ businessName: "Bridgend Joiners", website: "https://facebook.com/a" })],
    candidate: identity({ businessName: "Craigie Woodwork", town: "Scone", website: "https://facebook.com/b" }),
    duplicate: false,
  },
  {
    // Changed deliberately in Phase 14. A trading name shared across two towns
    // is not evidence of one business, and this rule was merging a Companies
    // House record in one town into an unrelated firm in another.
    name: "same long multi-word name in a different town — no longer merged",
    stored: [identity({ businessName: "Strathearn Joinery Limited", town: "Crieff" })],
    candidate: identity({ businessName: "Strathearn Joinery Ltd", town: "Perth" }),
    duplicate: false,
  },
  {
    name: "same short name in a different town — not merged",
    stored: [identity({ businessName: "Bell", town: "Crieff" })],
    candidate: identity({ businessName: "Bell", town: "Perth" }),
    duplicate: false,
  },
  {
    name: "same short name in the same town — merged",
    stored: [identity({ businessName: "Bell", town: "Perth" })],
    candidate: identity({ businessName: "Bell", town: "Perth" }),
    duplicate: true,
  },
  {
    name: "different businesses sharing nothing",
    stored: [identity({ businessName: "Tay Joinery", phone: "01738 111111" })],
    candidate: identity({ businessName: "Almond Woodwork", phone: "01738 222222" }),
    duplicate: false,
  },
  {
    name: "empty fields never collide",
    stored: [identity({ businessName: "Tay Joinery" })],
    candidate: identity({ businessName: "Almond Woodwork", town: "Errol" }),
    duplicate: false,
  },
  {
    name: "short phone fragments never collide",
    stored: [identity({ businessName: "Tay Joinery", phone: "555" })],
    candidate: identity({ businessName: "Almond Woodwork", town: "Errol", phone: "555" }),
    duplicate: false,
  },
  {
    name: "same maps link",
    stored: [identity({ businessName: "Tay Joinery", mapsLink: "https://maps.example/x" })],
    candidate: identity({ businessName: "Other", town: "Errol", mapsLink: "https://maps.example/x/" }),
    duplicate: true,
  },
];

describe("the identity index agrees with findDuplicate", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const viaFunction = findDuplicate(testCase.candidate, testCase.stored) !== null;
      const viaIndex = indexOf(testCase.stored).find(testCase.candidate) !== null;
      assert.equal(viaFunction, testCase.duplicate, "findDuplicate disagreed with the expectation");
      assert.equal(viaIndex, viaFunction, "the index disagreed with findDuplicate");
    });
  }
});

describe("identityKeys", () => {
  it("emits nothing a missing field could collide on", () => {
    const keys = identityKeys(identity({ businessName: "AB", town: "" }));
    assert.deepEqual(keys, []);
  });

  it("orders strong signals ahead of the loose name rule", () => {
    const keys = identityKeys(
      identity({ businessName: "Strathearn Joinery Limited", town: "Crieff", phone: "01764 652211", placeId: "p1" }),
    );
    assert.equal(keys[0]?.via, "PLACE_ID");
    assert.equal(keys[1]?.via, "PHONE");
    assert.equal(keys.at(-1)?.via, "NAME_TOWN");
  });

  it("ignores a directory URL as an identity", () => {
    const keys = identityKeys(
      identity({ businessName: "AB", town: "", website: "https://yell.com/biz/ab" }),
    );
    assert.ok(!keys.some((key) => key.via === "DOMAIN"));
  });
});

describe("the index as a container", () => {
  it("keeps the first business to claim a key", () => {
    const index = createIdentityIndex<string>();
    index.add(identity({ businessName: "First", phone: "01738 555111" }), "first");
    index.add(identity({ businessName: "Second", phone: "01738 555111" }), "second");
    assert.equal(index.find(identity({ businessName: "Third", phone: "01738 555111" }))?.entry, "first");
  });

  it("counts every entry added, not every key", () => {
    const index = createIdentityIndex<string>();
    index.add(identity({ businessName: "Strathearn Joinery Ltd", phone: "01764 652211" }), "a");
    assert.equal(index.size, 1);
  });

  it("stays fast enough for a full pool", () => {
    const index = createIdentityIndex<number>();
    for (let i = 0; i < 2000; i += 1) {
      index.add(identity({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${100000 + i}` }), i);
    }
    const started = Date.now();
    for (let i = 0; i < 2000; i += 1) {
      index.find(identity({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${100000 + i}` }));
    }
    assert.ok(Date.now() - started < 500, "2,000 lookups against 2,000 entries should be near-instant");
  });
});
