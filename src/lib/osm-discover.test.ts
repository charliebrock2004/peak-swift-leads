import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bboxFrom,
  isMerchantName,
  isNationalChain,
  isRejectedOsm,
  listingWebsiteHint,
  mergePlaces,
  milesBetween,
  nominatimViewbox,
  profileFor,
  type DiscoveredPlace,
} from "./osm-discover.ts";

function place(partial: Partial<DiscoveredPlace> & { businessName: string }): DiscoveredPlace {
  return {
    trade: "Joiner",
    town: "Perth",
    address: "",
    phone: "",
    email: "",
    website: "",
    lat: "",
    lng: "",
    mapsLink: "",
    source: "test",
    notes: "",
    placeId: "",
    businessStatus: "",
    osmChecked: false,
    ...partial,
  };
}

describe("profileFor", () => {
  it("maps joiners to Photon queries, not a BizData category", () => {
    const profile = profileFor("Joiner");
    assert.deepEqual(profile.queries, ["joinery", "joiner", "carpenter"]);
    assert.deepEqual(profile.nominatim, ["joinery", "carpenter"]);
    assert.equal(profile.bizdata, undefined);
  });

  it("maps restaurants to BizData", () => {
    assert.equal(profileFor("Restaurant").bizdata, "restaurant");
  });

  it("maps garages to car_repair", () => {
    assert.equal(profileFor("Mechanic").bizdata, "car_repair");
    assert.equal(profileFor("Garage").bizdata, "car_repair");
  });

  it("maps tilers, flooring and gyms", () => {
    assert.deepEqual(profileFor("Tiler").queries, ["tiler", "tiling"]);
    assert.deepEqual(profileFor("Flooring").queries, ["flooring", "floorer"]);
    assert.ok(profileFor("Gym").queries.includes("gym"));
  });
});

describe("filters", () => {
  it("drops national chains", () => {
    assert.equal(isNationalChain("Howdens Joinery"), true);
    assert.equal(isNationalChain("City Plumbing Supplies"), true);
    assert.equal(isNationalChain("Craig Murray Joinery"), false);
  });

  it("drops merchants that are not local trades", () => {
    assert.equal(isMerchantName("Joinery and Construction Supplies"), true);
    assert.equal(isMerchantName("City Plumbing"), true);
    assert.equal(isMerchantName("John Clarkson Plumbing Ltd"), false);
    assert.equal(isMerchantName("Campbell & Gay Builders"), false);
  });

  it("drops streets, charging points and cafes named Joinery", () => {
    assert.equal(isRejectedOsm("highway", "residential", "Joiners Close"), true);
    assert.equal(isRejectedOsm("amenity", "charging_station", "Electric A9"), true);
    assert.equal(isRejectedOsm("amenity", "cafe", "The Joinery"), true);
    assert.equal(isRejectedOsm("craft", "carpenter", "Craig Murray Joinery"), false);
  });
});

describe("geo", () => {
  it("measures Crieff to Perth at about 16 miles", () => {
    const miles = milesBetween({ lat: 56.3727, lng: -3.8389 }, { lat: 56.3959, lng: -3.4303 });
    assert.ok(miles > 14 && miles < 20, String(miles));
  });

  it("builds a bbox around a point", () => {
    const box = bboxFrom({ lat: 56.3959, lng: -3.4303 }, 25);
    const [minLon, minLat, maxLon, maxLat] = box.split(",").map(Number);
    assert.ok(minLon! < -3.43 && maxLon! > -3.43);
    assert.ok(minLat! < 56.39 && maxLat! > 56.39);
    const view = nominatimViewbox({ lat: 56.3959, lng: -3.4303 }, 25);
    const [left, top, right, bottom] = view.split(",");
    assert.equal(left, minLon!.toFixed(4));
    assert.equal(top, maxLat!.toFixed(4));
    assert.equal(right, maxLon!.toFixed(4));
    assert.equal(bottom, minLat!.toFixed(4));
  });
});

describe("mergePlaces", () => {
  it("dedupes the same phone found twice", () => {
    const next = mergePlaces(
      [place({ businessName: "Dodds", phone: "01764 652264" })],
      [place({ businessName: "W B Dodds Ltd", town: "Crieff", phone: "+44 1764 652264" })],
    );
    assert.equal(next.length, 1);
  });

  it("merges Ltd suffix names and keeps a website from either source", () => {
    const next = mergePlaces(
      [place({ businessName: "Crieff Construction", website: "", osmChecked: true })],
      [
        place({
          businessName: "Crieff Construction Ltd",
          website: "https://crieffconstruction.co.uk",
          source: "Companies House",
          placeId: "ch:SC612222",
        }),
      ],
    );
    assert.equal(next.length, 1);
    assert.equal(next[0]?.website, "https://crieffconstruction.co.uk");
    assert.equal(next[0]?.osmChecked, true);
  });
});

describe("listingWebsiteHint", () => {
  it("does not treat a Companies House listing as missing a website", () => {
    assert.equal(
      listingWebsiteHint({ website: "", source: "Companies House", osmChecked: false }),
      "unconfirmed",
    );
  });

  it("treats an OSM listing with no website tag as no website", () => {
    assert.equal(
      listingWebsiteHint({ website: "", source: "OpenStreetMap", osmChecked: true }),
      "osm-none",
    );
  });

  it("treats a URL as a website regardless of source", () => {
    assert.equal(
      listingWebsiteHint({
        website: "https://monziejoinery.co.uk",
        source: "Companies House",
        osmChecked: false,
      }),
      "url",
    );
  });
});
