import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blockingKeys, createIdentityIndex, findDuplicate, indexOf, matchLead, recordFor, type MatchSubject } from "./identity-index.ts";

function business(partial: Partial<MatchSubject> & { businessName: string }): MatchSubject {
  return { town: "Perth", phone: "", mapsLink: "", ...partial };
}

type Expect = "same" | "possible" | "different";

/**
 * A business is only "already known" on evidence. Each case states what the
 * index must conclude, and `findDuplicate` (which only accepts "same") and the
 * index must agree with it.
 */
const CASES: { name: string; stored: MatchSubject[]; candidate: MatchSubject; expect: Expect }[] = [
  {
    name: "the same source record is the same business",
    stored: [business({ businessName: "Tay Joinery", placeId: "osm:node:1" })],
    candidate: business({ businessName: "Completely Different", town: "Elgin", placeId: "osm:node:1" }),
    expect: "same",
  },
  {
    name: "the same Companies House number under a trading name",
    stored: [business({ businessName: "Tay Joinery", companyNumber: "SC612222" })],
    candidate: business({ businessName: "T J Contracts Ltd", town: "Scone", sourceIds: ["osm:node:9", "ch:SC612222"] }),
    expect: "same",
  },
  {
    name: "two different company numbers are never merged, whatever the name",
    stored: [business({ businessName: "Strathearn Joinery Ltd", companyNumber: "SC100001", address: "1 High St, Perth PH1 5AA" })],
    candidate: business({ businessName: "Strathearn Joinery Ltd", companyNumber: "SC100002", address: "1 High St, Perth PH1 5AA" }),
    expect: "different",
  },
  {
    name: "same phone, different formatting, matching name",
    stored: [business({ businessName: "Tay Joinery", phone: "01738 555111" })],
    candidate: business({ businessName: "Tay Joinery Ltd", phone: "+44 1738 555111" }),
    expect: "same",
  },
  {
    name: "a shared email with a different name is only possible (one owner, two firms)",
    stored: [business({ businessName: "Tay Joinery", email: "hello@tay.co.uk" })],
    candidate: business({ businessName: "Other Firm", town: "Errol", email: "HELLO@TAY.CO.UK" }),
    expect: "possible",
  },
  {
    name: "same independent website on different paths",
    stored: [business({ businessName: "Tay Joinery", website: "https://tayjoinery.co.uk" })],
    candidate: business({ businessName: "Tay & Sons", town: "Scone", website: "https://tayjoinery.co.uk/contact" }),
    expect: "same",
  },
  {
    name: "one website at two postcodes is a chain or branches — possible, not merged",
    stored: [business({ businessName: "Tayside Roofing", website: "https://taysideroofing.co.uk", address: "2 Main St, Perth PH1 1AA" })],
    candidate: business({ businessName: "Tayside Roofing", town: "Dundee", website: "https://taysideroofing.co.uk", address: "9 Dock St, Dundee DD1 3DR" }),
    expect: "possible",
  },
  {
    name: "two Wix sites are two businesses",
    stored: [business({ businessName: "Joe's Roofing", website: "https://joesroofing.wixsite.com/home" })],
    candidate: business({ businessName: "Bob's Builders", town: "Scone", website: "https://bobsbuilders.wixsite.com/site" }),
    expect: "different",
  },
  {
    name: "two listings on one directory are two businesses",
    stored: [business({ businessName: "Bridgend Joiners", website: "https://www.checkatrade.com/trades/bridgendjoiners" })],
    candidate: business({ businessName: "Craigie Woodwork", town: "Scone", website: "https://www.checkatrade.com/trades/craigiewoodwork" }),
    expect: "different",
  },
  {
    name: "both only on Facebook — not the same business",
    stored: [business({ businessName: "Bridgend Joiners", website: "https://facebook.com/a" })],
    candidate: business({ businessName: "Craigie Woodwork", town: "Scone", website: "https://facebook.com/b" }),
    expect: "different",
  },
  {
    name: "companies registered at one accountant's postcode are not one business",
    stored: [business({ businessName: "Almond Plumbing Ltd", address: "Suite 4, 10 Tay St, Perth PH2 8LQ", companyNumber: "SC300001" })],
    candidate: business({ businessName: "Kinnoull Electrical Ltd", address: "Suite 4, 10 Tay St, Perth PH2 8LQ" }),
    expect: "different",
  },
  {
    name: "a shared postcode-centre map pin is not evidence",
    stored: [business({ businessName: "Almond Plumbing Ltd", mapsLink: "https://www.google.com/maps?q=56.39,-3.43" })],
    candidate: business({ businessName: "Kinnoull Electrical Ltd", town: "Perth", mapsLink: "https://www.google.com/maps?q=56.39,-3.43" }),
    expect: "different",
  },
  {
    name: "the same long name in a different town is only possible",
    stored: [business({ businessName: "Strathearn Joinery Limited", town: "Crieff" })],
    candidate: business({ businessName: "Strathearn Joinery Ltd", town: "Perth" }),
    expect: "possible",
  },
  {
    name: "a similar but different name in another town is not even possible evidence of the same firm",
    stored: [business({ businessName: "Perth Property Maintenance", town: "Perth" })],
    candidate: business({ businessName: "Glasgow Property Maintenance", town: "Glasgow" }),
    expect: "different",
  },
  {
    name: "the same short name in the same town, nothing contradicting",
    stored: [business({ businessName: "Bell", town: "Perth" })],
    candidate: business({ businessName: "Bell", town: "Perth" }),
    expect: "same",
  },
  {
    name: "the same name in the same town with different phones is only possible",
    stored: [business({ businessName: "Bell Joinery", town: "Perth", phone: "01738 111111" })],
    candidate: business({ businessName: "Bell Joinery", town: "Perth", phone: "01738 222222" }),
    expect: "possible",
  },
  {
    name: "same name and postcode is the same premises",
    stored: [business({ businessName: "Tay Joinery", address: "4 Mill St, Perth PH1 5HZ" })],
    candidate: business({ businessName: "Tay Joinery Ltd", town: "Perth", address: "Unit 4, Mill Street, PH1 5HZ" }),
    expect: "same",
  },
  {
    name: "different businesses sharing nothing",
    stored: [business({ businessName: "Tay Joinery", phone: "01738 111111" })],
    candidate: business({ businessName: "Almond Woodwork", phone: "01738 222222" }),
    expect: "different",
  },
  {
    name: "short phone fragments never collide",
    stored: [business({ businessName: "Tay Joinery", phone: "555" })],
    candidate: business({ businessName: "Almond Woodwork", town: "Errol", phone: "555" }),
    expect: "different",
  },
];

describe("duplicates need evidence", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const match = matchLead(testCase.candidate, testCase.stored);
      const verdict: Expect = match ? match.verdict : "different";
      assert.equal(verdict, testCase.expect, match ? `reasons: ${match.reasons.join("; ")}` : "no match");
      assert.equal(findDuplicate(testCase.candidate, testCase.stored) !== null, testCase.expect === "same", "findDuplicate only accepts certain matches");
    });
  }
});

describe("blocking keys", () => {
  it("never narrow away a match the resolver would make", () => {
    for (const testCase of CASES.filter((item) => item.expect !== "different")) {
      const candidate = new Set(blockingKeys(recordFor(testCase.candidate)));
      const stored = blockingKeys(recordFor(testCase.stored[0]!));
      assert.ok(stored.some((key) => candidate.has(key)), `${testCase.name}: no shared key`);
    }
  });

  it("carry no key for a directory or a bare website builder", () => {
    const keys = blockingKeys(recordFor(business({ businessName: "AB", town: "", website: "https://yell.com/biz/ab" })));
    assert.ok(!keys.some((key) => key.startsWith("web:")));
    const bare = blockingKeys(recordFor(business({ businessName: "AB", town: "", website: "https://sites.google.com/view/ab" })));
    assert.ok(!bare.some((key) => key.startsWith("web:")));
  });

  it("read the company number from a source id", () => {
    assert.equal(recordFor(business({ businessName: "X", sourceIds: ["ch:sc123456"] })).companyNumber, "SC123456");
  });
});

describe("the index as a container", () => {
  it("prefers a certain match to a possible one", () => {
    const index = createIdentityIndex<string>();
    index.add(business({ businessName: "Strathearn Joinery", town: "Crieff" }), "possible");
    index.add(business({ businessName: "Other Name", phone: "01764 652211" }), "phone");
    const found = index.find(business({ businessName: "Strathearn Joinery", town: "Perth", phone: "01764 652211" }));
    assert.equal(found?.verdict, "possible", "a shared phone with a different name is not certain either");
    const certain = index.find(business({ businessName: "Strathearn Joinery", town: "Crieff", phone: "01764 652211" }));
    assert.equal(certain?.verdict, "same");
    assert.equal(certain?.entry, "possible");
  });

  it("counts every entry added, not every key", () => {
    const index = createIdentityIndex<string>();
    index.add(business({ businessName: "Strathearn Joinery Ltd", phone: "01764 652211" }), "a");
    assert.equal(index.size, 1);
  });

  it("stays fast enough for a full pool", () => {
    const index = indexOf(Array.from({ length: 2000 }, (_, i) => business({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${100000 + i}` })));
    const started = Date.now();
    for (let i = 0; i < 2000; i += 1) index.find(business({ businessName: `Firm Number ${i} Ltd`, phone: `01738 ${100000 + i}` }));
    assert.ok(Date.now() - started < 2000, "2,000 lookups against 2,000 entries should take well under two seconds");
  });
});
