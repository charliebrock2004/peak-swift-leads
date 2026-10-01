import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyWebsiteUrl,
  createLead,
  extractIndependentUrl,
  findDuplicate,
  fillMissingLead,
  mergeWebsiteEvidence,
  migrateLead,
  normalizeName,
  normalizePhone,
  resolveWebsiteStatus,
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
    assert.equal(
      classifyWebsiteUrl("https://www.locallife.co.uk/c-p/brock-contracts-crieff.asp"),
      "Directory Only",
    );
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

  it("matches on place id before name", () => {
    const sheet = [lead({ id: "ch", businessName: "Crieff Construction", town: "Crieff", placeId: "ch:SC612222" })];
    const match = findDuplicate(
      { businessName: "Other Name", town: "Perth", phone: "", mapsLink: "", placeId: "ch:SC612222" },
      sheet,
    );
    assert.equal(match?.via, "place");
  });

  it("matches on a public email", () => {
    const sheet = [lead({ id: "a", businessName: "ECG Joinery", town: "Crieff", email: "info@ecgjoinery.co.uk" })];
    const match = findDuplicate(
      { businessName: "Other", town: "Perth", phone: "", mapsLink: "", email: "info@ecgjoinery.co.uk" },
      sheet,
    );
    assert.equal(match?.via, "email");
  });

  it("matches on an independent website host, not a directory listing", () => {
    const sheet = [lead({ id: "a", businessName: "ECG", town: "Crieff", website: "https://ecgjoinery.co.uk" })];
    assert.equal(
      findDuplicate(
        { businessName: "Other", town: "Perth", phone: "", mapsLink: "", website: "http://www.ecgjoinery.co.uk/contact" },
        sheet,
      )?.via,
      "website",
    );
    assert.equal(
      findDuplicate(
        { businessName: "Other", town: "Perth", phone: "", mapsLink: "", website: "https://www.yell.com/biz/ecg" },
        sheet,
      ),
      null,
    );
  });
});

describe("fillMissingLead", () => {
  it("fills empty fields and never overwrites what is already set", () => {
    const existing = lead({
      id: "a",
      businessName: "ECG Joinery Ltd",
      town: "Crieff",
      phone: "",
      email: "info@ecgjoinery.co.uk",
      website: "",
    });
    const patch = fillMissingLead(existing, {
      phone: "01764 652264",
      email: "other@ecgjoinery.co.uk",
      website: "https://ecgjoinery.co.uk",
      outreachStatus: "sent",
    });
    assert.equal(patch?.phone, "01764 652264");
    assert.equal(patch?.website, "https://ecgjoinery.co.uk");
    assert.equal(patch?.email, undefined);
    assert.equal((patch as { outreachStatus?: string } | null)?.outreachStatus, undefined);
  });
});

describe("migrating old records", () => {
  it("infers website status for old records", () => {
    const next = migrateLead({
      id: "old",
      businessName: "Test",
      website: "https://facebook.com/x",
    } as Partial<Lead>);
    assert.equal(resolveWebsiteStatus(next), "Social Only");
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

  it("moves a follow-up that was due today or overdue, so the call leaves today's list", () => {
    assert.equal(callOutcomePatch("No Answer", { followUpDate: todayIso() }).followUpDate, addDays(todayIso(), 2));
    assert.equal(callOutcomePatch("Callback", { followUpDate: "2020-01-01" }).followUpDate, addDays(todayIso(), 1));
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
