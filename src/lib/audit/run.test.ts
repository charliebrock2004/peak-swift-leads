/**
 * A whole website audit against the real schema (PGLite, every migration)
 * with the network scripted. Nothing here reaches the internet.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLead, type Lead } from "../leads.ts";
import { buildLeadUpsert } from "../leads-row.ts";
import { createTestDb, type TestDb } from "../test-support/pglite.ts";
import * as store from "../outreach/store.server.ts";
import { evidenceForLead } from "../contactability/store.server.ts";
import { websiteVerificationOf } from "./website-state.ts";
import { auditHistory, internalLinks, loadAudit, runWebsiteAudit, type AuditNetwork } from "./run.server.ts";
import type { PageFetch } from "./fetch.server.ts";

const USER = "owner-1";
const NOW = new Date("2026-09-30T10:00:00.000Z");
let db: TestDb;

const HOMEPAGE = `<html><head><title>Home</title></head><body><p>Strathearn Joinery — joinery in Perthshire. Call 01764 123456.</p>
<a href="/about">About</a> <a href="/gallery">Gallery</a> <a href="tel:01764123456">Call</a> <a href="https://facebook.com/x">Facebook</a>
<footer>© 2018</footer></body></html>`;

function network(overrides: Partial<AuditNetwork> = {}): AuditNetwork & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchPage: async (url): Promise<PageFetch> => {
      calls.push(`page ${url}`);
      return { ok: true, status: 200, finalUrl: "https://strathearnjoinery.co.uk/", redirects: ["https://strathearnjoinery.co.uk/"], html: HOMEPAGE, bytes: HOMEPAGE.length, responseMs: 820, contentType: "text/html" };
    },
    robots: async (origin) => {
      calls.push(`robots ${origin}`);
      return { found: true, disallowAll: false, sitemaps: [] };
    },
    sitemap: async () => false,
    links: async (urls) => {
      calls.push(`links ${urls.length}`);
      return { checked: urls.length, broken: [{ url: "https://strathearnjoinery.co.uk/gallery", status: 404 }] };
    },
    pagespeed: async () => ({
      ok: true,
      result: {
        strategy: "mobile",
        fetchedAt: NOW.toISOString(),
        finalUrl: "https://strathearnjoinery.co.uk/",
        performance: 38,
        accessibility: 80,
        seo: 85,
        bestPractices: 90,
        lab: { lcpMs: 6100, cls: 0.02, tbtMs: 500, fcpMs: 2500, speedIndexMs: 5000, pageBytes: 1_800_000 },
        field: null,
        failedMobileAudits: [],
      },
    }),
    ...overrides,
  };
}

async function addLead(overrides: Partial<Lead> = {}) {
  const lead = createLead({ id: "lead-1", businessName: "Strathearn Joinery", trade: "Joiner", town: "Crieff", website: "strathearnjoinery.co.uk", websiteStatus: "Proper Website", ...overrides });
  const { text, params } = buildLeadUpsert(USER, [lead]);
  await db.sql.query(text, params);
  return (await store.loadLead(db.sql, USER, lead.id))!;
}

beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

describe("running a website audit", () => {
  it("measures, stores the audit with its findings, and links it to the business", async () => {
    const lead = await addLead();
    const net = network();
    const audit = await runWebsiteAudit(db.sql, USER, lead, net, () => NOW);

    assert.equal(audit.status, "ok");
    assert.equal(audit.opportunity, "strong");
    assert.ok(net.calls.includes("page https://strathearnjoinery.co.uk"));
    assert.ok(audit.findings.some((f) => f.kind === "psi_performance" && /38\/100/.test(f.evidence)));
    assert.ok(audit.findings.some((f) => f.kind === "broken_links"));
    assert.ok(audit.findings.some((f) => f.kind === "stale_copyright" && f.value === "2018"));
    assert.ok(audit.keyFindings.length >= 3);

    const stored = await loadAudit(db.sql, USER, lead.id);
    assert.equal(stored?.id, audit.id);
    assert.equal(stored?.findings.length, audit.findings.length);
    assert.equal(stored?.pagespeed?.performance, 38);
    assert.deepEqual(stored?.redirects, ["https://strathearnjoinery.co.uk/"]);

    // The business now carries the audit summary, and its website is FOUND.
    const after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(after.facts.audit?.id, audit.id);
    assert.equal(after.facts.audit?.opportunity, "strong");
    assert.ok((after.facts.audit?.keyFindings.length ?? 0) >= 3);
    assert.equal(websiteVerificationOf(after, NOW).state, "WEBSITE_FOUND");

    const evidence = await evidenceForLead(db.sql, USER, lead.id);
    const item = evidence.find((entry) => entry.kind === "website_audit")!;
    assert.equal(item.sourceRef, audit.id);
    assert.match(item.label, /Strong website opportunity — \d+ measured findings, mobile PageSpeed 38\/100/);
  });

  it("records an unreachable site as unmeasured, and the website as unreachable", async () => {
    const lead = await addLead();
    const audit = await runWebsiteAudit(
      db.sql,
      USER,
      lead,
      network({
        fetchPage: async () => ({ ok: false, error: "The domain does not resolve (no DNS record).", redirects: [], responseMs: 40, status: 0, finalUrl: "https://strathearnjoinery.co.uk" }),
        pagespeed: async () => ({ ok: false, quota: false, error: "PageSpeed could not test this site: DNS" }),
      }),
      () => NOW,
    );
    assert.equal(audit.status, "unreachable");
    assert.equal(audit.opportunity, "unmeasured");
    assert.match(audit.findings[0]!.evidence, /could not be loaded.*does not resolve/);
    assert.equal(audit.pagespeedError, "PageSpeed could not test this site: DNS");
    const after = (await store.loadLead(db.sql, USER, lead.id))!;
    assert.equal(websiteVerificationOf(after, NOW).state, "WEBSITE_UNREACHABLE");
  });

  it("still audits the homepage when PageSpeed is unavailable, and says so", async () => {
    const lead = await addLead();
    const audit = await runWebsiteAudit(db.sql, USER, lead, network({ pagespeed: async () => ({ ok: false, quota: true, error: "PageSpeed quota reached for today." }) }), () => NOW);
    assert.equal(audit.status, "ok");
    assert.equal(audit.pagespeed, null);
    assert.equal(audit.pagespeedError, "PageSpeed quota reached for today.");
    assert.notEqual(audit.opportunity, "unmeasured");
  });

  it("refuses to 'audit' a social page or a business with no website", async () => {
    await assert.rejects(runWebsiteAudit(db.sql, USER, await addLead({ website: "https://facebook.com/strathearn" }), network(), () => NOW), /no independent website/);
    await assert.rejects(runWebsiteAudit(db.sql, USER, await addLead({ id: "lead-2", website: "" }), network(), () => NOW), /no independent website/);
  });

  it("keeps every audit as history, newest first", async () => {
    const lead = await addLead();
    await runWebsiteAudit(db.sql, USER, lead, network(), () => new Date("2026-08-01T10:00:00.000Z"));
    await runWebsiteAudit(db.sql, USER, lead, network(), () => NOW);
    const history = await auditHistory(db.sql, USER, lead.id);
    assert.equal(history.length, 2);
    assert.equal(history[0]!.finishedAt, NOW.toISOString());
    assert.equal(history[0]!.performance, 38);
    assert.equal((await evidenceForLead(db.sql, USER, lead.id)).filter((entry) => entry.kind === "website_audit").length, 1, "one current audit fact");
  });

  it("is scoped to the account", async () => {
    const lead = await addLead();
    await runWebsiteAudit(db.sql, USER, lead, network(), () => NOW);
    assert.equal(await loadAudit(db.sql, "owner-2", lead.id), null);
  });
});

describe("choosing links to check", () => {
  it("takes same-site pages only, once each, and skips files, phone and email links", () => {
    const links = internalLinks(
      `<a href="/about">a</a><a href="/about#team">b</a><a href="https://www.strathearnjoinery.co.uk/contact">c</a><a href="https://other.co.uk/x">d</a><a href="tel:1">e</a><a href="/brochure.pdf">f</a><a href="mailto:x@y.z">g</a>`,
      "https://strathearnjoinery.co.uk/",
    );
    assert.deepEqual(links, ["https://strathearnjoinery.co.uk/about", "https://www.strathearnjoinery.co.uk/contact"]);
  });
});
