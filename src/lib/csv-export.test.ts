import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead } from "./leads.ts";
import { CSV_HEADER, leadsToCsv } from "./csv-export.ts";

describe("CSV export", () => {
  it("carries the one score — band, priority, action, reason — beside the fields", () => {
    const csv = leadsToCsv([createLead({ businessName: "Wee Bakehouse", town: "Crieff", reviews: 47, rating: 4.8, websiteStatus: "No Website Found", phone: "01764 652184" })]);
    const [header, row] = csv.split("\n");
    assert.equal(header, CSV_HEADER.join(","));
    assert.match(row!, /Wee Bakehouse/);
    assert.match(row!, /prospect/i, "the band label is present");
    assert.doesNotMatch(csv, /\bHOT\b|\bWARM\b|\bCOLD\b/, "the old priority scale is gone");
  });

  it("escapes commas and quotes, and never hands a spreadsheet a formula", () => {
    const csv = leadsToCsv([createLead({ businessName: '=HYPERLINK("http://x")', notes: 'Said "call Tuesday", maybe' })]);
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
    assert.match(csv, /"Said ""call Tuesday"", maybe"/);
  });
});
