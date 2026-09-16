import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contradicts,
  evidenceOf,
  findDuplicate,
  normalisePlaceId,
  placeIdNamespace,
  sameBusiness,
  type LeadIdentity,
} from "./identity.ts";

const id = (p: Partial<LeadIdentity> & { businessName: string }): LeadIdentity =>
  ({ town: "Perth", phone: "", mapsLink: "", ...p });

/** Reads better than findDuplicate for a pair: the reason, or null. */
const pair = (a: LeadIdentity, b: LeadIdentity) => sameBusiness(b, a);

// ───────────────────────────────────────────────────────────────────────────
describe("GROUP A — obvious duplicates still merge", () => {
  it("1. same OSM id, written the two ways this codebase writes it", () => {
    assert.equal(
      pair(id({ businessName: "Tay Joinery", placeId: "osm:node:101" }),
           id({ businessName: "Tay Joinery", town: "Scone", placeId: "osm:N:101" })),
      "PLACE_ID",
    );
  });

  it("2. same phone, different formatting", () => {
    assert.equal(
      pair(id({ businessName: "Tay Joinery", phone: "01738 555111" }),
           id({ businessName: "Tay Joinery Ltd", town: "Errol", phone: "+44 1738 555111" })),
      "PHONE",
    );
  });

  it("3. same email, different casing", () => {
    assert.equal(
      pair(id({ businessName: "Tay Joinery", email: "hello@tay.co.uk" }),
           id({ businessName: "Something Else", town: "Crieff", email: "HELLO@TAY.CO.UK" })),
      "EMAIL",
    );
  });

  it("4. same independent domain, www vs non-www and a deeper path", () => {
    assert.equal(
      pair(id({ businessName: "Tay Joinery", website: "https://www.tayjoinery.co.uk" }),
           id({ businessName: "Tay & Sons", town: "Scone", website: "https://tayjoinery.co.uk/contact" })),
      "DOMAIN",
    );
  });

  it("5. same maps URL, trailing slash", () => {
    assert.equal(
      pair(id({ businessName: "A", mapsLink: "https://maps.example/x" }),
           id({ businessName: "B", town: "Errol", mapsLink: "https://maps.example/x/" })),
      "MAPS_URL",
    );
  });

  it("6. same Companies House company number", () => {
    assert.equal(
      pair(id({ businessName: "Perthshire Joinery Limited", placeId: "ch:SC123456" }),
           id({ businessName: "PERTHSHIRE JOINERY LTD", town: "Scone", placeId: "ch:sc123456" })),
      "PLACE_ID",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("GROUP B — legitimately different businesses stay separate", () => {
  it("7. same name, different OSM ids, phones and websites", () => {
    assert.equal(
      pair(id({ businessName: "Highland Joinery Ltd", placeId: "osm:node:301", phone: "01738 777111", website: "https://highlandjoinery.co.uk" }),
           id({ businessName: "Highland Joinery Ltd", placeId: "osm:node:302", phone: "01250 888222", website: "https://highland-joinery.com" })),
      null,
    );
  });

  it("8. same name, different towns, different phones and websites", () => {
    assert.equal(
      pair(id({ businessName: "Highland Joinery Ltd", town: "Perth", phone: "01738 777111" }),
           id({ businessName: "Highland Joinery Ltd", town: "Blairgowrie", phone: "01250 888222" })),
      null,
    );
  });

  it("9. MacDonald Joinery vs MacDonald Joiners, different towns and phones", () => {
    assert.equal(
      pair(id({ businessName: "MacDonald Joinery", town: "Scone", phone: "01738 333333" }),
           id({ businessName: "MacDonald Joiners", town: "Errol", phone: "01821 444444" })),
      null,
    );
  });

  it("10. J Smith Joinery vs J Smith Joinery & Son, different phones", () => {
    assert.equal(
      pair(id({ businessName: "J Smith Joinery", phone: "01738 121212" }),
           id({ businessName: "J Smith Joinery & Son", phone: "01738 343434" })),
      null,
    );
  });

  it("11. two businesses sharing only a Facebook page", () => {
    assert.equal(
      pair(id({ businessName: "Alpha Joiners", website: "https://facebook.com/alpha", phone: "01738 151515" }),
           id({ businessName: "Beta Joiners", town: "Scone", website: "https://facebook.com/beta", phone: "01738 161616" })),
      null,
    );
  });

  it("12. two businesses sharing only a directory listing", () => {
    assert.equal(
      pair(id({ businessName: "Gamma Joiners", website: "https://yell.com/biz/g", phone: "01738 171717" }),
           id({ businessName: "Delta Joiners", town: "Errol", website: "https://yell.com/biz/d", phone: "01821 181818" })),
      null,
    );
  });

  it("the same-name-same-town merge is refused when the phones disagree", () => {
    assert.equal(
      pair(id({ businessName: "Bell Joinery", town: "Perth", phone: "01738 111111", placeId: "osm:node:401" }),
           id({ businessName: "Bell Joinery", town: "Perth", phone: "01738 999999", placeId: "osm:node:402" })),
      null,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("GROUP C — incomplete records", () => {
  it("13. same name and town, neither carries a phone or website", () => {
    // Nothing contradicts, so the name and town are allowed to carry it. This
    // is the weakest merge the matcher will make, and it is why the town is
    // required: the same two names in different towns would stay separate.
    assert.equal(
      pair(id({ businessName: "Dunning Woodcraft", town: "Dunning" }),
           id({ businessName: "Dunning Woodcraft", town: "Dunning" })),
      "NAME_TOWN",
    );
  });

  it("14. same name and town, one has a phone and the other does not", () => {
    // Silence is not disagreement: a missing phone contradicts nothing.
    assert.equal(
      pair(id({ businessName: "Dunning Woodcraft", town: "Dunning", phone: "01764 100100" }),
           id({ businessName: "Dunning Woodcraft", town: "Dunning" })),
      "NAME_TOWN",
    );
  });

  it("15. same name, different towns, one has no phone", () => {
    assert.equal(
      pair(id({ businessName: "Dunning Woodcraft", town: "Dunning", phone: "01764 100100" }),
           id({ businessName: "Dunning Woodcraft", town: "Perth" })),
      null,
    );
  });

  it("16. same company number, completely different names", () => {
    assert.equal(
      pair(id({ businessName: "Crieff Construction", town: "Crieff", placeId: "ch:SC612222" }),
           id({ businessName: "Something Quite Different", town: "Perth", placeId: "ch:SC612222" })),
      "PLACE_ID",
    );
  });

  it("17. same phone, slightly different names — the phone still wins", () => {
    assert.equal(
      pair(id({ businessName: "Tay Joinery", phone: "01738 555111" }),
           id({ businessName: "Tay Joinery and Sons", town: "Scone", phone: "01738 555111" })),
      "PHONE",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("GROUP D — source combinations", () => {
  it("18/19. Nominatim and Photon spellings of one OSM node merge", () => {
    assert.equal(
      pair(id({ businessName: "Tay Joinery", town: "Perth", placeId: "osm:node:101" }),
           id({ businessName: "Tay Joinery", town: "Scone", placeId: "osm:N:101" })),
      "PLACE_ID",
    );
  });

  it("a node and a way with the same number are NOT the same object", () => {
    assert.equal(
      pair(id({ businessName: "A Business", town: "Perth", placeId: "osm:node:202" }),
           id({ businessName: "B Business", town: "Perth", placeId: "osm:way:202" })),
      null,
    );
  });

  it("20. Companies House and OSM merge on deterministic evidence", () => {
    // Same town, same name, and nothing comparable disagrees — a CH record
    // carries no phone or site, so there is nothing to contradict.
    assert.equal(
      pair(id({ businessName: "Tay Joinery Ltd", town: "Perth", placeId: "osm:node:101", phone: "01738 555111" }),
           id({ businessName: "Tay Joinery", town: "Perth", placeId: "ch:SC777777" })),
      "NAME_TOWN",
    );
  });

  it("21. Companies House to Companies House, same company number", () => {
    assert.equal(
      pair(id({ businessName: "Perthshire Joinery Limited", placeId: "ch:SC123456" }),
           id({ businessName: "Perthshire Joinery Ltd", placeId: "ch:SC123456" })),
      "PLACE_ID",
    );
  });

  it("22. Companies House record is not absorbed by a same-name OSM firm elsewhere", () => {
    // The defect this phase exists to remove.
    assert.equal(
      pair(id({ businessName: "Highland Joinery Ltd", town: "Perth", placeId: "osm:node:301", phone: "01738 777111" }),
           id({ businessName: "Highland Joinery Ltd", town: "Aberfeldy", placeId: "ch:SC999999" })),
      null,
    );
  });

  it("a CH and an OSM place id never contradict each other", () => {
    // Different registries describe a business differently; that is not
    // disagreement, and treating it as such would block every CH↔OSM merge.
    assert.equal(
      contradicts(
        evidenceOf(id({ businessName: "A", placeId: "osm:node:1" })),
        evidenceOf(id({ businessName: "A", placeId: "ch:SC1" })),
      ),
      false,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("place id normalisation", () => {
  it("folds the two OSM spellings this codebase produces", () => {
    assert.equal(normalisePlaceId("osm:node:101"), normalisePlaceId("osm:N:101"));
    assert.equal(normalisePlaceId("osm:way:202"), normalisePlaceId("osm:W:202"));
    assert.equal(normalisePlaceId("osm:relation:9"), normalisePlaceId("osm:R:9"));
  });

  it("keeps different OSM object types apart", () => {
    assert.notEqual(normalisePlaceId("osm:node:202"), normalisePlaceId("osm:way:202"));
  });

  it("invents no conversion for a namespace it does not own", () => {
    assert.equal(normalisePlaceId("ch:SC123456"), "ch:sc123456");
    assert.equal(normalisePlaceId("google:ChIJabc"), "google:chijabc");
    assert.equal(normalisePlaceId(""), "");
    assert.equal(normalisePlaceId(undefined), "");
  });

  it("reads the namespace for the contradiction rule", () => {
    assert.equal(placeIdNamespace("osm:n:1"), "osm");
    assert.equal(placeIdNamespace("ch:sc1"), "ch");
    assert.equal(placeIdNamespace("bare"), "");
  });
});

describe("findDuplicate ordering", () => {
  it("prefers a strong match later in the list over a name match first", () => {
    const sheet = [
      id({ businessName: "Bell Joinery", town: "Perth" }),
      id({ businessName: "Totally Different", town: "Perth", phone: "01738 555111" }),
    ];
    const match = findDuplicate(id({ businessName: "Bell Joinery", town: "Perth", phone: "01738 555111" }), sheet);
    assert.equal(match?.reason, "PHONE");
    assert.equal(match?.lead.businessName, "Totally Different");
  });

  it("walks past a contradicting same-name record to a clean one", () => {
    const sheet = [
      id({ businessName: "Bell Joinery", town: "Perth", phone: "01738 111111" }),
      id({ businessName: "Bell Joinery", town: "Perth" }),
    ];
    const match = findDuplicate(id({ businessName: "Bell Joinery", town: "Perth", phone: "01738 999999" }), sheet);
    assert.equal(match?.reason, "NAME_TOWN");
    assert.equal(match?.lead.phone, "");
  });

  it("reports both spellings of the reason", () => {
    const match = findDuplicate(
      id({ businessName: "X", placeId: "osm:node:1" }),
      [id({ businessName: "Y", town: "Scone", placeId: "osm:N:1" })],
    );
    assert.equal(match?.reason, "PLACE_ID");
    assert.equal(match?.via, "place");
  });
});
