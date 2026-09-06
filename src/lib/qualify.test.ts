import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead, computeOpportunity, opportunityBand } from "./leads.ts";
import {
  extractEmails,
  inventingEmailWouldBe,
  pickBusinessEmail,
  scoreWebsitePage,
} from "./qualify.ts";

describe("scoreWebsitePage", () => {
  it("does not treat a simple complete site as poor", () => {
    const html = `
      <html><head><title>Comrie Cut</title><meta name="viewport" content="width=device-width"></head>
      <body>
        <h1>Comrie Cut</h1>
        <p>Haircuts in Comrie. Call 01764 670553 or <a href="mailto:hello@comriecut.co.uk">email us</a>.</p>
        <p>Open Tuesday to Saturday.</p>
      </body></html>`;
    const result = scoreWebsitePage({
      url: "https://comriecut.co.uk",
      finalUrl: "https://comriecut.co.uk/",
      status: 200,
      html,
      businessName: "Comrie Cut",
    });
    assert.equal(result.quality, "improve");
    assert.equal(typeof result.score, "number");
    assert.ok(Number(result.score) >= 50, String(result.score));
    assert.match(result.analysis, /little information|works/i);
  });

  it("scores a complete modern site as good", () => {
    const body = Array.from({ length: 40 }, () => "We offer joinery, kitchens and doors across Perthshire. ").join("");
    const html = `
      <html><head><title>Monzie Joinery</title><meta name="viewport" content="width=device-width"></head>
      <body>
        <h1>Monzie Joinery</h1>
        <p>${body}</p>
        <p>Our services include kitchens, doors and staircases.</p>
        <a href="tel:01764650000">Call</a>
        <a href="/contact">Contact us</a>
        <form><input type="submit" value="Send"></form>
      </body></html>`;
    const result = scoreWebsitePage({
      url: "https://monziejoinery.co.uk",
      finalUrl: "https://monziejoinery.co.uk/",
      status: 200,
      html,
      businessName: "Monzie Joinery",
    });
    assert.equal(result.quality, "good");
    assert.ok(Number(result.score) >= 70, String(result.score));
  });

  it("marks a parked domain as poor", () => {
    const result = scoreWebsitePage({
      url: "https://example-parked.co.uk",
      finalUrl: "https://example-parked.co.uk/",
      status: 200,
      html: "<html><body>This domain is parked free with GoDaddy. Buy this domain.</body></html>",
      businessName: "Example",
    });
    assert.equal(result.quality, "poor");
    assert.match(result.analysis, /parked/i);
  });

  it("does not fetch-score a Facebook URL as a business website", () => {
    const result = scoreWebsitePage({
      url: "https://www.facebook.com/strathearnauto",
      finalUrl: "https://www.facebook.com/strathearnauto",
      status: 200,
      html: "",
      businessName: "Strathearn Auto",
    });
    assert.equal(result.quality, "poor");
    assert.equal(result.websiteStatus, "Social Only");
    assert.match(result.analysis, /social/i);
  });

  it("returns unable when the site cannot be reached", () => {
    const result = scoreWebsitePage({
      url: "https://down.example",
      businessName: "Gone",
      unreachable: true,
    });
    assert.equal(result.quality, "unable");
    assert.equal(result.score, "");
    assert.match(result.analysis, /could not reach/i);
  });
});

describe("email extraction", () => {
  it("picks a same-domain role address as HIGH", () => {
    const html = `Contact <a href="mailto:info@monziejoinery.co.uk">info@monziejoinery.co.uk</a>`;
    const picked = pickBusinessEmail(extractEmails(html), "https://monziejoinery.co.uk");
    assert.equal(picked?.email, "info@monziejoinery.co.uk");
    assert.equal(picked?.confidence, "HIGH");
    assert.match(picked?.source ?? "", /website/i);
  });

  it("does not invent info@ from a domain", () => {
    const html = "<html><body>No addresses here, just a phone 01764 650000.</body></html>";
    const emails = extractEmails(html);
    assert.equal(emails.length, 0);
    assert.equal(pickBusinessEmail(emails, "https://monziejoinery.co.uk"), null);
    assert.equal(inventingEmailWouldBe("monziejoinery.co.uk"), "info@monziejoinery.co.uk");
  });

  it("treats a gmail found on the site as MEDIUM, not HIGH", () => {
    const html = `Email jane@gmail.com for bookings`;
    const picked = pickBusinessEmail(extractEmails(html), "https://comriecut.co.uk");
    assert.equal(picked?.email, "jane@gmail.com");
    assert.equal(picked?.confidence, "MEDIUM");
  });

  it("drops tracker and image false-positives", () => {
    const html = `file@2x.png foo@sentry.io x@example.com real@shop.scot`;
    const emails = extractEmails(html);
    assert.deepEqual(emails, ["real@shop.scot"]);
  });
});

describe("opportunity score", () => {
  it("rates no website + email + phone as high opportunity", () => {
    const score = computeOpportunity(
      createLead({
        website: "",
        websiteStatus: "No Website Found",
        email: "info@example.co.uk",
        phone: "01764 650000",
        businessStatus: "Active",
      }),
    );
    assert.ok(score >= 70, String(score));
    assert.equal(opportunityBand(score), "High");
  });

  it("rates a good existing website as low opportunity", () => {
    const score = computeOpportunity(
      createLead({
        website: "https://monziejoinery.co.uk",
        websiteStatus: "Proper Website",
        websiteQuality: "good",
        websiteScore: 86,
        phone: "01764 650000",
      }),
    );
    assert.ok(score < 45, String(score));
    assert.equal(opportunityBand(score), "Low");
  });

  it("never invents an email just because a domain exists", () => {
    const html = "<html><body>Monzie Joinery. Call 01764 650000.</body></html>";
    assert.equal(extractEmails(html).length, 0);
  });

  it("caps opportunity after not interested", () => {
    const score = computeOpportunity(
      createLead({
        website: "",
        websiteStatus: "No Website Found",
        email: "info@x.co.uk",
        phone: "01764 650000",
        called: "Not Interested",
        callResult: "Not Interested",
      }),
    );
    assert.ok(score <= 22, String(score));
  });
});
