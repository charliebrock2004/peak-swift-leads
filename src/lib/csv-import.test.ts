import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, type Lead } from "./leads.ts";
import {
  detectDelimiter,
  guessColumnMap,
  mergePatch,
  normalizeDate,
  normalizeWebsiteStatus,
  parseDelimited,
  planImport,
  rowToDraft,
  summarizePlan,
  type ImportField,
} from "./csv-import.ts";

function lead(partial: Partial<Lead>): Lead {
  return createLead(partial);
}

describe("delimited parsing", () => {
  it("handles quoted fields containing commas and newlines", () => {
    const rows = parseDelimited('name,notes\n"Smith, J","line one\nline two"');
    assert.deepEqual(rows, [
      ["name", "notes"],
      ["Smith, J", "line one\nline two"],
    ]);
  });

  it("unescapes doubled quotes and strips the Excel BOM", () => {
    const rows = parseDelimited('\uFEFFname\n"The ""Wee"" Bakehouse"');
    assert.deepEqual(rows, [["name"], ['The "Wee" Bakehouse']]);
  });

  it("detects tab-separated paste from a spreadsheet", () => {
    assert.equal(detectDelimiter("name\ttown\ttrade\nA\tB\tC"), "\t");
    assert.deepEqual(parseDelimited("name\ttown\nWee Bakehouse\tCrieff"), [
      ["name", "town"],
      ["Wee Bakehouse", "Crieff"],
    ]);
  });

  it("ignores a trailing blank line", () => {
    assert.equal(parseDelimited("a,b\n1,2\n").length, 2);
  });
});

describe("column mapping", () => {
  it("maps the real spreadsheet's headers", () => {
    const map = guessColumnMap([
      "Business Name",
      "Town",
      "Trade",
      "Contact Information",
      "Website Status",
      "Ratings",
      "Verification Notes",
    ]);
    assert.deepEqual(map, [
      "businessName",
      "town",
      "trade",
      "phone",
      "websiteStatus",
      "rating",
      "notes",
    ]);
  });

  it("never assigns one field to two columns", () => {
    const map = guessColumnMap(["Name", "Business Name", "Town"]);
    const assigned = map.filter(Boolean);
    assert.equal(new Set(assigned).size, assigned.length);
  });

  it("leaves unknown columns unmapped", () => {
    assert.deepEqual(guessColumnMap(["Business Name", "Sausage index"]), [
      "businessName",
      null,
    ]);
  });
});

describe("cell normalisation", () => {
  it("reads free-text website status", () => {
    assert.equal(normalizeWebsiteStatus("no website"), "No Website Found");
    assert.equal(normalizeWebsiteStatus("Facebook only"), "Social Only");
    assert.equal(normalizeWebsiteStatus("yell listing"), "Directory Only");
    assert.equal(normalizeWebsiteStatus("has a website"), "Proper Website");
    assert.equal(normalizeWebsiteStatus("Proper Website"), "Proper Website");
    assert.equal(normalizeWebsiteStatus("banana"), "");
  });

  it("reads UK dates as well as ISO", () => {
    assert.equal(normalizeDate("2026-09-02"), "2026-09-02");
    assert.equal(normalizeDate("02/09/2026"), "2026-09-02");
    assert.equal(normalizeDate("2/9/26"), "2026-09-02");
    assert.equal(normalizeDate("not a date"), "");
  });

  it("treats a 'none' website cell as evidence, not a URL", () => {
    const map: (ImportField | null)[] = ["businessName", "website"];
    const draft = rowToDraft(["Comrie Cut", "none"], map);
    assert.equal(draft?.website, "");
    assert.equal(draft?.websiteStatus, "No Website Found");
  });

  it("skips a row with no usable business name", () => {
    assert.equal(rowToDraft(["", "Crieff"], ["businessName", "town"]), null);
  });

  it("strips stars and commas out of ratings and review counts", () => {
    const draft = rowToDraft(
      ["Wee Bakehouse", "4.8 stars", "1,247"],
      ["businessName", "rating", "reviews"],
    );
    assert.equal(draft?.rating, 4.8);
    assert.equal(draft?.reviews, 1247);
  });
});

describe("merging into an existing lead", () => {
  const existing = lead({
    businessName: "The Wee Bakehouse",
    town: "Crieff",
    phone: "01764 652184",
    trade: "",
    notes: "Busy Saturday queue.",
    called: "Interested",
    callResult: "Interested",
    followUpDate: "2026-09-10",
  });

  it("fills empty fields only", () => {
    const patch = mergePatch(existing, {
      businessName: "The Wee Bakehouse",
      trade: "Bakery",
      town: "Perth",
      phone: "01111 111111",
    });
    assert.equal(patch.trade, "Bakery");
    assert.equal(patch.town, undefined, "town was already set — must not be overwritten");
    assert.equal(patch.phone, undefined, "phone was already set — must not be overwritten");
  });

  it("never touches call history", () => {
    const patch = mergePatch(existing, {
      businessName: "The Wee Bakehouse",
      called: "Not Called",
      callResult: "No Answer",
      followUpDate: "2030-01-01",
    });
    assert.equal(patch.called, undefined);
    assert.equal(patch.callResult, undefined);
    assert.equal(patch.followUpDate, undefined);
  });

  it("appends new notes and ignores ones it already has", () => {
    const added = mergePatch(existing, {
      businessName: "The Wee Bakehouse",
      notes: "Verified by phone.",
    });
    assert.equal(added.notes, "Busy Saturday queue.\nVerified by phone.");

    const repeat = mergePatch(existing, {
      businessName: "The Wee Bakehouse",
      notes: "Busy Saturday queue.",
    });
    assert.equal(repeat.notes, undefined);
  });
});

describe("import planning", () => {
  const sheet = [
    lead({ businessName: "The Wee Bakehouse", town: "Crieff", phone: "01764 652184" }),
  ];
  const map: (ImportField | null)[] = ["businessName", "town", "trade", "phone"];

  it("marks a matching row as a merge and a fresh row as an add", () => {
    const plan = planImport(
      [
        ["The Wee Bakehouse", "Crieff", "Bakery", "01764 652184"],
        ["Highland Handyman", "Perth", "Handyman", "01738 441276"],
      ],
      map,
      sheet,
    );
    assert.equal(plan.entries[0].action, "merge");
    assert.equal(plan.entries[0].matchedVia, "phone");
    assert.deepEqual(plan.entries[0].fills, ["trade"]);
    assert.equal(plan.entries[1].action, "add");
    assert.deepEqual(summarizePlan(plan.entries), { added: 1, merged: 1, skipped: 0 });
  });

  it("skips a duplicate that would add nothing", () => {
    const plan = planImport([["The Wee Bakehouse", "Crieff", "", "01764 652184"]], map, sheet);
    assert.equal(plan.entries[0].action, "skip");
  });

  it("catches a business listed twice in the same file", () => {
    const plan = planImport(
      [
        ["Strathearn Auto", "Auchterarder", "Garage", "01764 663901"],
        ["Strathearn Auto", "Auchterarder", "Garage", "01764 663901"],
      ],
      map,
      [],
    );
    assert.equal(plan.entries[0].action, "add");
    assert.notEqual(plan.entries[1].action, "add");
  });

  it("counts rows it could not read", () => {
    const plan = planImport([["", "Crieff", "", ""]], map, []);
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.skippedRows, 1);
  });

  it("re-importing the same file changes nothing the second time", () => {
    const rows = [["Highland Handyman", "Perth", "Handyman", "01738 441276"]];
    const first = planImport(rows, map, []);
    const imported = lead({ ...first.entries[0].draft } as Partial<Lead>);
    const second = planImport(rows, map, [imported]);
    assert.equal(second.entries[0].action, "skip");
  });
});
