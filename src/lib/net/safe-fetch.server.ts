/**
 * Fetch a public web page, and only a public web page. **Server-only.**
 *
 * Every destination — the first URL and each redirect hop — is checked with
 * `urlProblem` and then resolved, and every address it resolves to must be
 * public. Redirects are followed by hand (at most five) precisely so that a
 * public site cannot bounce the server into its own network.
 */
import { lookup } from "node:dns/promises";
import { isPrivateAddress, UnsafeUrlError, urlProblem } from "./safe-url.ts";

const resolved = new Map<string, { ok: boolean; at: number }>();
const DNS_CACHE_MS = 60_000;

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("refused a private network address");
    return;
  }
  const cached = resolved.get(host);
  if (cached && Date.now() - cached.at < DNS_CACHE_MS) {
    if (!cached.ok) throw new UnsafeUrlError("refused a host that resolves to a private network");
    return;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  const ok = addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  resolved.set(host, { ok, at: Date.now() });
  if (resolved.size > 500) resolved.clear();
  if (!ok) throw new UnsafeUrlError("refused a host that resolves to a private network");
}

/** Throws `UnsafeUrlError` unless `raw` is a public http(s) URL. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const problem = urlProblem(raw);
  if (problem) throw new UnsafeUrlError(problem);
  const url = new URL(raw);
  await assertPublicHost(url.hostname);
  return url;
}

export type SafeFetchInit = Omit<RequestInit, "redirect"> & { maxRedirects?: number };

/**
 * `fetch`, restricted to the public internet, following redirects manually.
 *
 * Resolves to the final response; `response.url` is not reliable after manual
 * redirects, so the final URL is returned alongside it.
 */
export async function safeFetch(raw: string, init: SafeFetchInit = {}): Promise<{ response: Response; finalUrl: string }> {
  const { maxRedirects = 5, ...rest } = init;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, { ...rest, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current };
      // Drain the redirect body so the connection can be reused.
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new UnsafeUrlError("too many redirects");
}
