/**
 * Phase 2 server functions: one website check or one email lookup per request.
 *
 * Bulk actions run on the client in small concurrent batches so a Vercel Hobby
 * function never has to inspect 20 sites in one 10-second window.
 *
 * Nothing here sends email.
 */
import { createServerFn } from "@tanstack/react-start";
import { classifyWebsiteUrl, hasWebsite, websiteHref } from "@/lib/leads";
import {
  contactLinksFrom,
  extractEmails,
  pickBusinessEmail,
  scoreWebsitePage,
  type FoundEmail,
  type WebsiteCheck,
} from "@/lib/qualify";

const USER_AGENT = "PeakSwiftLeads/1.0 (public website check)";

function asString(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : value == null ? "" : String(value).trim().slice(0, max);
}

async function fetchPage(
  url: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; finalUrl: string; html: string }> {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    const type = response.headers.get("content-type") ?? "";
    const html = /html|xml|text/i.test(type) || !type ? (await response.text()).slice(0, 400_000) : "";
    return { ok: response.ok, status: response.status, finalUrl: response.url || href, html };
  } finally {
    clearTimeout(timer);
  }
}

export type CheckWebsiteResult =
  | { ok: true; check: WebsiteCheck; checkedAt: string }
  | { ok: false; error: string };

export type FindEmailResult =
  | { ok: true; found: FoundEmail | null; foundAt: string; message: string }
  | { ok: false; error: string };

export const checkLeadWebsite = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing website");
    const website = asString((input as { website?: unknown }).website, 500);
    const businessName = asString((input as { businessName?: unknown }).businessName, 160);
    if (!hasWebsite(website)) throw new Error("No website to check");
    return { website, businessName };
  })
  .handler(async ({ data }): Promise<CheckWebsiteResult> => {
    const href = websiteHref(data.website) ?? data.website;
    const classified = classifyWebsiteUrl(href);
    if (classified === "Social Only" || classified === "Directory Only") {
      return {
        ok: true,
        check: scoreWebsitePage({ url: href, finalUrl: href, businessName: data.businessName, html: "", status: 200 }),
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      const page = await fetchPage(href, 5000);
      return {
        ok: true,
        check: scoreWebsitePage({
          url: href,
          finalUrl: page.finalUrl,
          status: page.status,
          html: page.html,
          businessName: data.businessName,
        }),
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        ok: true,
        check: scoreWebsitePage({
          url: href,
          businessName: data.businessName,
          unreachable: true,
        }),
        checkedAt: new Date().toISOString(),
      };
    }
  });

export const findLeadEmail = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Missing lead");
    const website = asString((input as { website?: unknown }).website, 500);
    const existingEmail = asString((input as { existingEmail?: unknown }).existingEmail, 160).toLowerCase();
    const existingSource = asString((input as { existingSource?: unknown }).existingSource, 80);
    return { website, existingEmail, existingSource };
  })
  .handler(async ({ data }): Promise<FindEmailResult> => {
    const foundAt = new Date().toISOString();
    const href = websiteHref(data.website);

    if (href && classifyWebsiteUrl(href) === "Proper Website") {
      try {
        const home = await fetchPage(href, 5000);
        const fromHome = pickBusinessEmail(extractEmails(home.html), home.finalUrl || href);
        if (fromHome) {
          return { ok: true, found: fromHome, foundAt, message: "" };
        }
        const extra = contactLinksFrom(home.html, home.finalUrl || href)[0];
        if (extra) {
          try {
            const contact = await fetchPage(extra, 4000);
            const fromContact = pickBusinessEmail(extractEmails(contact.html), href);
            if (fromContact) {
              return {
                ok: true,
                found: { ...fromContact, source: "Business contact page" },
                foundAt,
                message: "",
              };
            }
          } catch {
            // Homepage had no email and the contact page failed — fall through.
          }
        }
      } catch {
        // Site unreachable — fall through to any listing email already on the row.
      }
    }

    if (data.existingEmail.includes("@")) {
      return {
        ok: true,
        found: {
          email: data.existingEmail,
          source: data.existingSource || "Existing listing",
          confidence: "MEDIUM",
        },
        foundAt,
        message: "",
      };
    }

    return { ok: true, found: null, foundAt, message: "No public email found" };
  });
