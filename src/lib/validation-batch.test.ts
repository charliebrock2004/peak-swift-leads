import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RATE_MIN,
  batchReport,
  batchTable,
  blankRow,
  parseBatch,
  rate,
  summariseBatch,
  type BatchRow,
} from "./validation-batch.ts";

function row(partial: Partial<BatchRow> = {}): BatchRow {
  return {
    ...blankRow({
      businessName: "Clark Joinery", town: "Perth", trade: "Joiner",
      phone: "01738 445566", address: "22 South Street, Perth PH2 8PG", website: "",
    }),
    ...partial,
  };
}

describe("parseBatch", () => {
  it("parses a full line", () => {
    const [entry] = parseBatch(
      "Clark Joinery | Perth | Joiner | 01738 445566 | 22 South Street, Perth PH2 8PG | https://x.co.uk",
    );
    assert.equal(entry!.businessName, "Clark Joinery");
    assert.equal(entry!.town, "Perth");
    assert.equal(entry!.phone, "01738 445566");
    assert.equal(entry!.address, "22 South Street, Perth PH2 8PG");
    assert.equal(entry!.website, "https://x.co.uk");
  });

  it("copes with missing trailing fields", () => {
    const [entry] = parseBatch("Clark Joinery | Perth");
    assert.equal(entry!.businessName, "Clark Joinery");
    assert.equal(entry!.trade, "");
    assert.equal(entry!.address, "");
  });

  it("skips comments, blanks and a pasted header row", () => {
    const entries = parseBatch(
      "# a comment\n\nBusiness | Town | Trade | Phone | Address | Website\nClark Joinery | Perth\n",
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.businessName, "Clark Joinery");
  });

  it("ignores a line with no usable name", () => {
    assert.deepEqual(parseBatch("|||\nX\n"), []);
  });
});

describe("summariseBatch", () => {
  it("counts an empty batch as zeros rather than dividing by zero", () => {
    const summary = summariseBatch([]);
    assert.equal(summary.tested, 0);
    assert.equal(summary.averageMs, 0);
    assert.deepEqual(summary.reasons, []);
  });

  it("counts what the run measured", () => {
    const summary = summariseBatch([
      row({ website: "https://a.co.uk", email: "a@a.co.uk", elapsedMs: 2000 }),
      row({ website: "https://b.co.uk", email: "", reason: "CONTACT_PAGE_NO_EMAIL", elapsedMs: 4000 }),
      row({ website: "", email: "", reason: "NO_WEBSITE", elapsedMs: 3000 }),
    ]);
    assert.equal(summary.completed, 3);
    assert.equal(summary.websitesVerified, 2);
    assert.equal(summary.emailsFound, 1);
    assert.equal(summary.averageMs, 3000);
  });

  it("does not count a run that errored as a completed run", () => {
    const summary = summariseBatch([row({ error: "network died" }), row({ email: "a@a.co.uk" })]);
    assert.equal(summary.tested, 2);
    assert.equal(summary.completed, 1);
  });

  it("NEVER counts an unconfirmed result as correct", () => {
    const summary = summariseBatch([
      row({ website: "https://a.co.uk", email: "a@a.co.uk" }),
      row({ website: "https://b.co.uk", email: "b@b.co.uk" }),
    ]);
    assert.equal(summary.emailsFound, 2);
    assert.equal(summary.emailsConfirmedCorrect, 0, "finding an email is not the same as it being right");
    assert.equal(summary.emailsChecked, 0);
    assert.equal(summary.websitesConfirmedCorrect, 0);
  });

  it("counts a confirmed wrong result as a false positive", () => {
    const summary = summariseBatch([
      row({ website: "https://wrong.co.uk", websiteCorrect: "WRONG", email: "x@wrong.co.uk", emailCorrect: "WRONG" }),
      row({ website: "https://right.co.uk", websiteCorrect: "CORRECT", email: "x@right.co.uk", emailCorrect: "CORRECT" }),
    ]);
    assert.equal(summary.falsePositiveWebsites, 1);
    assert.equal(summary.falsePositiveEmails, 1);
    assert.equal(summary.websitesConfirmedCorrect, 1);
    assert.equal(summary.emailsChecked, 2);
  });

  it("counts an honest miss, but not one where the wrong site was attached", () => {
    const summary = summariseBatch([
      row({ website: "", email: "", reason: "NO_WEBSITE" }),
      row({ website: "https://wrong.co.uk", websiteCorrect: "WRONG", email: "" }),
    ]);
    assert.equal(summary.honestNotFound, 1, "attaching the wrong site is not an honest miss");
  });

  it("ranks failure reasons commonest first", () => {
    const summary = summariseBatch([
      row({ reason: "NO_WEBSITE" }),
      row({ reason: "CONTACT_PAGE_NO_EMAIL" }),
      row({ reason: "NO_WEBSITE" }),
    ]);
    assert.deepEqual(summary.reasons[0], { reason: "NO_WEBSITE", count: 2 });
  });

  it("does not record a failure reason for a run that found an email", () => {
    const summary = summariseBatch([row({ email: "a@a.co.uk", reason: "" })]);
    assert.deepEqual(summary.reasons, []);
  });
});

describe("rate", () => {
  it("refuses to turn a tiny sample into a percentage", () => {
    assert.match(rate(1, RATE_MIN - 1), /too few to rate/);
    assert.match(rate(0, 1), /too few to rate/);
  });

  it("reports a percentage once the sample is big enough", () => {
    assert.equal(rate(5, 10), "5/10 (50%)");
    assert.equal(rate(0, 10), "0/10 (0%)");
  });
});

describe("batchTable", () => {
  it("has exactly the columns asked for", () => {
    const header = batchTable([]).split("\n")[0]!;
    for (const column of [
      "Business", "Website Found", "Correct Website", "Email Found",
      "Correct Email", "Confidence", "Failure Reason",
    ]) {
      assert.ok(header.includes(column), `missing column: ${column}`);
    }
  });

  it("shows an unconfirmed row as UNKNOWN, never as correct", () => {
    const line = batchTable([row({ website: "https://a.co.uk", email: "a@a.co.uk" })]).split("\n")[1]!;
    assert.ok(line.includes("UNKNOWN"), line);
  });
});

describe("batchReport", () => {
  it("says plainly when nothing has been confirmed", () => {
    const text = batchReport([row({ website: "https://a.co.uk", email: "a@a.co.uk" })]);
    assert.match(text, /accuracy cannot be reported until every row above is marked/i);
  });

  it("drops that warning once every row is confirmed", () => {
    const text = batchReport([
      row({ website: "https://a.co.uk", websiteCorrect: "CORRECT", email: "a@a.co.uk", emailCorrect: "CORRECT" }),
    ]);
    assert.ok(!/accuracy cannot be reported/i.test(text));
  });

  it("never prints a bare percentage for a tiny batch", () => {
    const text = batchReport([row({ website: "https://a.co.uk", email: "a@a.co.uk" })]);
    assert.match(text, /too few to rate/);
  });

  it("reports an empty batch without crashing", () => {
    assert.match(batchReport([]), /Businesses tested: 0/);
  });
});
