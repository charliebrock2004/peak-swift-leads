import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyWebsiteUrl,
  compareLeads,
  computePriority,
  createLead,
  extractIndependentUrl,
  findDuplicate,
  leadsToCsv,
  mergeWebsiteEvidence,
  migrateLead,
  normalizeName,
  normalizePhone,
  priorityReason,
  resolveWebsiteStatus,
  summarise,
  addDays,
  callOutcomePatch,
  todayIso,
  websiteActionLabel,
  type Lead,
} from "./leads.ts";

function lead(partial: Partial<Lead>): Lead {
  return createLead(partial);
}

describe("website classification", () => {
  it("treats empty as no website", () => {
    assert.equal(classifyWebsiteUrl(""), "No Website Found");
    assert.equal(classifyWebsiteUrl("none"), "No Website Found");
  });

  it("detects social and directory hosts", () => {
    assert.equal(classifyWebsiteUrl("https://www.facebook.com/foo"), "Social Only");
    assert.equal(classifyWebsiteUrl("instagram.com/bar"), "Social Only");
    assert.equal(classifyWebsiteUrl("https://www.yell.com/biz/foo"), "Directory Only");
    assert.equal(classifyWebsiteUrl("https://maps.google.com/?q=foo"), "Directory Only");
    assert.equal(classifyWebsiteUrl("https://bookabuilderuk.com/profile/matt"), "Directory Only");
  });

  it("treats independent domains as a proper website", () => {
    assert.equal(classifyWebsiteUrl("https://monziejoinery.co.uk"), "Proper Website");
  });

  it("does not treat a missing URL as a proper website even if hinted", () => {
    assert.equal(mergeWebsiteEvidence("proper", "", null), "Unclear");
    assert.equal(mergeWebsiteEvidence("none", "", null), "No Website Found");
    assert.equal(mergeWebsiteEvidence("proper", "https://facebook.com/x", null), "Social Only");
  });

  it("does not treat an unconfirmed independent URL as a proper website", () => {
    assert.equal(mergeWebsiteEvidence("proper", "https://gavinbrock-joiner.co.uk", null), "Unclear");
  });

  it("keeps a live independent URL as a proper website", () => {
    assert.equal(
      mergeWebsiteEvidence("proper", "https://monziejoinery.co.uk", "Proper Website"),
      "Proper Website",
    );
  });

  it("treats an empty URL with no hint as unclear", () => {
    assert.equal(mergeWebsiteEvidence("", "", null), "Unclear");
  });

  it("pulls an independent domain out of directory notes", () => {
    assert.equal(
      extractIndependentUrl("Yell listing. Website references to wbdodds.co.uk found in directories."),
      "https://wbdodds.co.uk",
    );
    assert.equal(extractIndependentUrl("https://www.yell.com/biz/dodds"), "");
  });

  it("does not treat ratings, postcodes or public suffixes as websites", () => {
    assert.equal(extractIndependentUrl("MyBuilder 4.9/5 from 48 reviews. Checkatrade 10/10."), "");
    assert.equal(extractIndependentUrl("Address 22 Monteath Street, PH7 3EG"), "");
    assert.equal(extractIndependentUrl("Some directories list a .co.uk site."), "");
  });
});

describe("priority", () => {
  it("keeps HOT as no proper site + 20 reviews + 4.5 rating", () => {
    assert.equal(
      computePriority(lead({ website: "", reviews: 47, rating: 4.8, websiteStatus: "No Website Found" })),
      "HOT",
    );
  });

  it("does not treat a proper website as HOT even with strong reviews", () => {
    assert.equal(
      computePriority(
        lead({
          website: "https://bridgeofallandental.co.uk",
          reviews: 120,
          rating: 4.9,
          websiteStatus: "Proper Website",
        }),
      ),
      "COLD",
    );
  });

  it("ranks directory-only listings as WARM even without review counts", () => {
    assert.equal(
      computePriority(
        lead({
          website: "https://www.yell.com/biz/dodds",
          reviews: "",
          rating: "",
          websiteStatus: "Directory Only",
        }),
      ),
      "WARM",
    );
  });

  it("ranks social-only with reviews as HOT when the numbers qualify", () => {
    assert.equal(
      computePriority(
        lead({
          website: "https://facebook.com/garage",
          reviews: 61,
          rating: 4.6,
          websiteStatus: "Social Only",
        }),
      ),
      "HOT",
    );
  });

  it("ranks no-site with some reviews as WARM", () => {
    assert.equal(
      computePriority(lead({ website: "", reviews: 8, rating: 5, websiteStatus: "No Website Found" })),
      "WARM",
    );
  });

  it("ranks unclear listings with no reviews as COLD", () => {
    assert.equal(
      computePriority(lead({ website: "", reviews: "", rating: "", websiteStatus: "Unclear" })),
      "COLD",
    );
  });

  it("explains the score in plain language", () => {
    const reason = priorityReason(
      lead({ website: "", reviews: 48, rating: 4.8, websiteStatus: "No Website Found", phone: "01764 650000" }),
    );
    assert.equal(reason, "HOT — 48 reviews, 4.8 rating, no proper website found.");
  });
});

describe("duplicates", () => {
  const existing: Lead[] = [
    lead({
      id: "a",
      businessName: "W B Dodds Ltd",
      town: "Crieff",
      phone: "01764 652264",
      mapsLink: "https://www.google.com/maps/search/?api=1&query=Dodds+Crieff",
    }),
  ];

  it("matches on phone", () => {
    const match = findDuplicate({ businessName: "Dodds", town: "Perth", phone: "+44 1764 652264", mapsLink: "" }, existing);
    assert.equal(match?.via, "phone");
  });

  it("matches on name + town ignoring Ltd", () => {
    const match = findDuplicate(
      { businessName: "WB Dodds", town: "Crieff", phone: "", mapsLink: "" },
      existing,
    );
    assert.equal(match?.via, "name+town");
    assert.equal(normalizeName("W B Dodds Ltd"), normalizeName("WB Dodds"));
  });

  it("matches on maps URL", () => {
    const match = findDuplicate(
      {
        businessName: "Other",
        town: "Perth",
        phone: "",
        mapsLink: "https://www.google.com/maps/search/?api=1&query=Dodds+Crieff",
      },
      existing,
    );
    assert.equal(match?.via, "maps");
  });

  it("does not treat different Maps search queries as the same place", () => {
    const match = findDuplicate(
      {
        businessName: "Cafe Rhubarb",
        town: "Crieff",
        phone: "",
        mapsLink: "https://www.google.com/maps/search/?api=1&query=Cafe+Rhubarb+Crieff",
      },
      existing,
    );
    assert.equal(match, null);
  });

  it("does not match a different business", () => {
    assert.equal(
      findDuplicate({ businessName: "Monzie Joinery", town: "Crieff", phone: "01764 111111", mapsLink: "" }, existing),
      null,
    );
  });

  it("matches a distinctive name even in another town", () => {
    const match = findDuplicate(
      { businessName: "W B Dodds Limited", town: "Perth", phone: "", mapsLink: "" },
      existing,
    );
    assert.equal(match?.via, "name");
  });
});

describe("migrate, csv, summary", () => {
  it("infers website status for old records", () => {
    const next = migrateLead({
      id: "old",
      businessName: "Test",
      website: "https://facebook.com/x",
    } as Partial<Lead>);
    assert.equal(resolveWebsiteStatus(next), "Social Only");
  });

  it("exports website status and reason", () => {
    const csv = leadsToCsv([
      lead({
        businessName: "Wee Bakehouse",
        town: "Crieff",
        reviews: 47,
        rating: 4.8,
        websiteStatus: "No Website Found",
      }),
    ]);
    assert.match(csv, /Website Status/);
    assert.match(csv, /No Website Found/);
    assert.match(csv, /HOT/);
  });

  it("counts follow-up due as callbacks", () => {
    const summary = summarise([
      lead({
        called: "Callback",
        callResult: "Callback",
        followUpDate: "2020-01-01",
      }),
      lead({ called: "Callback", callResult: "Callback", followUpDate: "2099-01-01" }),
    ]);
    assert.equal(summary.callbacks, 1);
  });

  it("counts an interested lead whose follow-up has arrived", () => {
    const summary = summarise([
      lead({ called: "Interested", callResult: "Interested", followUpDate: "2020-01-01" }),
    ]);
    assert.equal(summary.callbacks, 1, "an interested lead due today is still something to chase");
  });

  it("does not chase a lead that is already booked or dead", () => {
    const summary = summarise([
      lead({ called: "Called", callResult: "Booked", followUpDate: "2020-01-01" }),
      lead({ called: "Not Interested", callResult: "Not Interested", followUpDate: "2020-01-01" }),
      lead({ called: "Called", callResult: "Wrong Number", followUpDate: "2020-01-01" }),
    ]);
    assert.equal(summary.callbacks, 0);
  });

  it("sorts HOT before COLD by default", () => {
    const hot = lead({ reviews: 40, rating: 4.8, websiteStatus: "No Website Found" });
    const cold = lead({ reviews: 40, rating: 4.8, websiteStatus: "Proper Website", website: "https://x.co" });
    assert.ok(compareLeads(hot, cold, "priority", "asc") < 0);
  });
});

describe("phone normalize", () => {
  it("treats +44 and 0 prefixes as the same UK number", () => {
    assert.equal(normalizePhone("+44 1764 652264"), normalizePhone("01764 652264"));
  });
});

describe("recording a call outcome in one tap", () => {
  it("sets called, result and a sensible next date together", () => {
    const patch = callOutcomePatch("Callback", { followUpDate: "" });
    assert.equal(patch.called, "Callback");
    assert.equal(patch.callResult, "Callback");
    assert.equal(patch.followUpDate, addDays(todayIso(), 1));
  });

  it("never overwrites a follow-up date already chosen by hand", () => {
    const patch = callOutcomePatch("No Answer", { followUpDate: "2030-05-05" });
    assert.equal(patch.followUpDate, "2030-05-05");
  });

  it("clears the follow-up when the lead is closed out", () => {
    assert.equal(callOutcomePatch("Not Interested", { followUpDate: "2030-05-05" }).followUpDate, "");
    assert.equal(callOutcomePatch("Wrong Number", { followUpDate: "2030-05-05" }).followUpDate, "");
  });

  it("keeps the follow-up on a booked lead — that date is the appointment", () => {
    const patch = callOutcomePatch("Booked", { followUpDate: "2030-05-05" });
    assert.equal(patch.callResult, "Booked");
    assert.equal(patch.followUpDate, undefined);
  });
});

describe("date arithmetic", () => {
  it("adds days across a month boundary", () => {
    assert.equal(addDays("2026-01-30", 3), "2026-02-02");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });
});

describe("link labels", () => {
  it("labels social and directory links clearly", () => {
    assert.equal(websiteActionLabel("https://facebook.com/jed", "Social Only"), "Facebook");
    assert.equal(websiteActionLabel("https://www.yell.com/biz/x", "Directory Only"), "Listing");
    assert.equal(websiteActionLabel("https://monziejoinery.co.uk", "Proper Website"), "Website");
  });
});
