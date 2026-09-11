import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLead } from "../leads.ts";
import { assessHealth } from "./health.ts";
import type { GmailConnection, OutreachLead } from "./types.ts";

function lead(partial: Partial<OutreachLead> = {}): OutreachLead {
  return createLead({
    businessName: "ECG Joinery Ltd",
    trade: "Joiner",
    town: "Crieff",
    phone: "01764 652264",
    websiteStatus: "No Website Found",
    ...partial,
  }) as OutreachLead;
}

function connection(partial: Partial<GmailConnection> = {}): GmailConnection {
  return {
    email: "peakswiftstudio@gmail.com",
    status: "connected",
    lastError: "",
    connectedAt: "2026-09-01T00:00:00.000Z",
    configured: true,
    clientProject: "",
    clientMasked: "",
    redirectUriOverride: "",
    ...partial,
  };
}

describe("system health", () => {
  it("reports a connected, database-backed workspace as healthy", () => {
    const report = assessHealth({
      database: "neon",
      connection: connection(),
      leads: [lead()],
      emails: [],
      aiAvailable: true,
    });
    const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
    assert.equal(byId.database.level, "HEALTHY");
    assert.equal(byId.gmail.level, "HEALTHY");
    assert.equal(byId.sending.level, "HEALTHY");
    assert.equal(byId.personalise.level, "HEALTHY");
  });

  it("warns when many businesses have no public email", () => {
    const leads = Array.from({ length: 10 }, (_, index) =>
      lead({ id: `l${index}`, businessName: `Biz ${index} Ltd`, phone: `01764 65000${index}` }),
    );
    const report = assessHealth({
      database: "neon",
      connection: connection(),
      leads,
      emails: [],
      aiAvailable: false,
    });
    const email = report.items.find((item) => item.id === "email");
    assert.equal(email?.level, "WARNING");
    assert.match(email?.detail ?? "", /call list/i);
    assert.equal(report.items.find((item) => item.id === "personalise")?.level, "WARNING");
  });

  it("marks Gmail as off when OAuth is not configured", () => {
    const report = assessHealth({
      database: "none",
      connection: connection({ configured: false, status: "disconnected", email: "" }),
      leads: [],
      emails: [],
      aiAvailable: false,
    });
    assert.equal(report.items.find((item) => item.id === "database")?.level, "ERROR");
    assert.equal(report.items.find((item) => item.id === "gmail")?.level, "OFF");
  });
});
