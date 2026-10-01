/**
 * Email verification, at the one point it earns its cost: just before an email
 * becomes send-ready. Discovered addresses are not verified in bulk.
 *
 * The provider is configuration, not code:
 *
 *   EMAIL_VERIFIER=dns          (default) — free: does the domain accept mail?
 *   EMAIL_VERIFIER=zerobounce   + EMAIL_VERIFIER_API_KEY
 *   EMAIL_VERIFIER=neverbounce  + EMAIL_VERIFIER_API_KEY
 *
 * Results are valid | invalid | risky | catch_all | unknown. Only "invalid"
 * refuses an email (eligibility.ts → "undeliverable"); a catch-all is never
 * treated as valid — it is shown as "cannot be confirmed" — and a verifier
 * that is down or out of credit returns "unknown", never "valid".
 */
import type { VerificationResult } from "./email.ts";

export type Verification = { result: VerificationResult; detail: string; provider: string };
export type EmailVerifier = { name: string; verify: (email: string) => Promise<Verification> };

const TIMEOUT_MS = 8_000;

function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

/** Free and keyless: an address on a domain that cannot receive mail is undeliverable. */
export function dnsVerifier(resolver?: { resolveMx: (domain: string) => Promise<{ exchange: string }[]>; resolve4: (domain: string) => Promise<string[]> }): EmailVerifier {
  return {
    name: "dns",
    verify: async (email) => {
      const domain = domainOf(email);
      if (!domain) return { result: "invalid", detail: "No domain in the address", provider: "dns" };
      const dns = resolver ?? (await import("node:dns/promises"));
      const gone = (error: unknown) => /ENOTFOUND|ENODATA|NXDOMAIN/i.test(String((error as { code?: string })?.code ?? error));
      try {
        const mx = await dns.resolveMx(domain);
        if (mx.some((record) => record.exchange && record.exchange !== ".")) {
          return { result: "unknown", detail: `${domain} accepts mail; the mailbox itself is not checked`, provider: "dns" };
        }
        return { result: "invalid", detail: `${domain} publishes a null MX: it accepts no mail`, provider: "dns" };
      } catch (error) {
        if (!gone(error)) return { result: "unknown", detail: "DNS lookup failed — not checked", provider: "dns" };
        // No MX: mail falls back to the A record, if there is one.
        try {
          const a = await dns.resolve4(domain);
          return a.length ? { result: "unknown", detail: `${domain} has no MX record; mail may still be accepted`, provider: "dns" } : { result: "invalid", detail: `${domain} cannot receive mail`, provider: "dns" };
        } catch (inner) {
          return gone(inner) ? { result: "invalid", detail: `${domain} does not exist`, provider: "dns" } : { result: "unknown", detail: "DNS lookup failed — not checked", provider: "dns" };
        }
      }
    },
  };
}

async function getJson(url: string, fetcher: typeof fetch): Promise<Record<string, unknown> | null> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

export function zeroBounceVerifier(key: string, fetcher: typeof fetch = fetch): EmailVerifier {
  return {
    name: "zerobounce",
    verify: async (email) => {
      const body = await getJson(`https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&ip_address=`, fetcher);
      const status = String(body?.status ?? "").toLowerCase();
      const map: Record<string, VerificationResult> = { valid: "valid", invalid: "invalid", "catch-all": "catch_all", spamtrap: "risky", abuse: "risky", do_not_mail: "risky", unknown: "unknown" };
      return { result: map[status] ?? "unknown", detail: status ? `ZeroBounce: ${status}${body?.sub_status ? ` (${String(body.sub_status)})` : ""}` : "ZeroBounce did not answer", provider: "zerobounce" };
    },
  };
}

export function neverBounceVerifier(key: string, fetcher: typeof fetch = fetch): EmailVerifier {
  return {
    name: "neverbounce",
    verify: async (email) => {
      const body = await getJson(`https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`, fetcher);
      const status = String(body?.result ?? "").toLowerCase();
      const map: Record<string, VerificationResult> = { valid: "valid", invalid: "invalid", disposable: "risky", catchall: "catch_all", unknown: "unknown" };
      return { result: map[status] ?? "unknown", detail: status ? `NeverBounce: ${status}` : "NeverBounce did not answer", provider: "neverbounce" };
    },
  };
}

/** The verifier this deployment is configured for. A paid one without a key falls back to DNS. */
export function configuredVerifier(env: Record<string, string | undefined> = process.env): EmailVerifier {
  const name = (env.EMAIL_VERIFIER ?? "dns").trim().toLowerCase();
  const key = env.EMAIL_VERIFIER_API_KEY?.trim() ?? "";
  if (name === "zerobounce" && key) return zeroBounceVerifier(key);
  if (name === "neverbounce" && key) return neverBounceVerifier(key);
  return dnsVerifier();
}

/** Re-verify an address after this long. */
export const VERIFICATION_FRESH_DAYS = 30;
/** Paid verifications one account may make per day. DNS checks are free. */
export const VERIFICATIONS_PER_DAY = 200;
