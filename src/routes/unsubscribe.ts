import { createFileRoute } from "@tanstack/react-router";

/**
 * The unsubscribe link in every outreach email.
 *
 * Public by design — the person clicking it has no account — so it trusts only
 * the signed token, which names one account, one address and one email.
 *
 * GET shows a page with a button and changes nothing: corporate mail scanners
 * open links to check them, and an opt-out triggered by a scanner would be
 * wrong. POST does the work, and is also what a mail client's own
 * "Unsubscribe" button sends (RFC 8058 one-click).
 *
 * Server-only modules are imported inside the handlers, as `api/auth/$.ts`
 * explains, so none of them reach the browser bundle.
 */

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f7f5;color:#1c1c1a;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}main{max-width:440px;background:#fff;border-radius:14px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:#444}button{font:inherit;background:#1c1c1a;color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;width:100%}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function tokenFrom(request: Request): Promise<string> {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("t") ?? "";
  if (fromQuery || request.method !== "POST") return fromQuery;
  const form = await request.formData().catch(() => null);
  const value = form?.get("t");
  return typeof value === "string" ? value : "";
}

export const Route = createFileRoute("/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { verifyUnsubscribe } = await import("@/lib/crypto/secrets.server");
        const token = await tokenFrom(request);
        const verified = verifyUnsubscribe(token);
        if (!verified.ok) {
          return page("Link not recognised", `<h1>This link isn't valid</h1><p>It may have been cut short when it was copied. Reply to the email with “stop” and you won't hear from us again.</p>`, 400);
        }
        return page(
          "Unsubscribe",
          `<h1>Stop these emails?</h1><p>${escape(verified.claim.email)} won't be contacted by email again.</p><form method="post" action="/unsubscribe"><input type="hidden" name="t" value="${escape(token)}"><button type="submit">Unsubscribe</button></form>`,
        );
      },
      POST: async ({ request }) => {
        const { verifyUnsubscribe } = await import("@/lib/crypto/secrets.server");
        const token = await tokenFrom(request);
        const verified = verifyUnsubscribe(token);
        if (!verified.ok) {
          return page("Link not recognised", `<h1>This link isn't valid</h1><p>Reply to the email with “stop” and you won't hear from us again.</p>`, 400);
        }
        const { getSql } = await import("@/lib/db");
        const store = await import("@/lib/outreach/store.server");
        const { log } = await import("@/lib/log.server");
        try {
          const sql = await getSql();
          const result = await store.unsubscribeByLink(sql, verified.claim.userId, verified.claim);
          await store.recordActivity(sql, verified.claim.userId, {
            id: crypto.randomUUID(),
            type: "UNSUBSCRIBED",
            leadName: result.businessName,
            result: verified.claim.email,
            reason: "Unsubscribe link",
          });
          log.info("unsubscribe", { userId: verified.claim.userId, emailId: verified.claim.emailId, repeat: result.alreadySuppressed });
          return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${escape(verified.claim.email)} won't receive any more emails from us. Sorry to have bothered you.</p>`);
        } catch (error) {
          log.error("unsubscribe_failed", { userId: verified.claim.userId, error });
          return page("Something went wrong", `<h1>That didn't work</h1><p>Please try again, or reply to the email with “stop” — replies are read by a person.</p>`, 500);
        }
      },
    },
  },
});
