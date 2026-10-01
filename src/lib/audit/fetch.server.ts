/**
 * Fetching a prospect's website for an audit. **Server-only.**
 *
 * Every address — the first and each redirect hop — must be on the public
 * internet (`assertPublicUrl`), exactly as for email discovery, because these
 * addresses come from listings and search results, never from anyone trusted.
 * Unlike `safeFetch`, the hops are recorded, the time is measured and the body
 * is capped, because the audit reports all three.
 */
import { assertPublicUrl } from "../net/safe-fetch.server.ts";

const USER_AGENT = "Mozilla/5.0 (compatible; PeakSwiftAudit/1.0; +https://peak-swift-leads.vercel.app)";
const MAX_HTML_BYTES = 1_500_000;

export type PageFetch =
  | { ok: true; status: number; finalUrl: string; redirects: string[]; html: string; bytes: number; responseMs: number; contentType: string }
  | { ok: false; error: string; redirects: string[]; responseMs: number; status: number; finalUrl: string };

async function readCapped(response: Response, cap: number): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    bytes += value.byteLength;
    if (bytes <= cap) chunks.push(value);
    if (bytes > cap) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const joined = new Uint8Array(Math.min(bytes, cap));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.max(0, joined.length - offset)), offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(joined), bytes };
}

export async function fetchForAudit(raw: string, options: { timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<PageFetch> {
  const started = Date.now();
  const redirects: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let current = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    for (let hop = 0; hop <= 6; hop += 1) {
      await assertPublicUrl(current);
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-GB,en;q=0.8" },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        await response.body?.cancel().catch(() => undefined);
        const next = new URL(response.headers.get("location")!, current).toString();
        redirects.push(next);
        current = next;
        continue;
      }
      const responseMs = Date.now() - started;
      const contentType = response.headers.get("content-type") ?? "";
      const textual = !contentType || /html|xml|text|json/i.test(contentType);
      const { text, bytes } = textual ? await readCapped(response, options.maxBytes ?? MAX_HTML_BYTES) : { text: "", bytes: 0 };
      return { ok: true, status: response.status, finalUrl: current, redirects, html: text, bytes, responseMs, contentType };
    }
    return { ok: false, error: "Too many redirects.", redirects, responseMs: Date.now() - started, status: 0, finalUrl: current };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    const message = aborted
      ? "It did not respond in time."
      : error instanceof Error && /private|refused/i.test(error.message)
        ? "The address points somewhere that is not a public website."
        : error instanceof Error && /ENOTFOUND|getaddrinfo/i.test(`${error.message} ${(error as { code?: string }).code ?? ""}`)
          ? "The domain does not resolve (no DNS record)."
          : error instanceof Error && /certificate|SSL|TLS/i.test(error.message)
            ? "Its security certificate is invalid."
            : "It could not be reached.";
    return { ok: false, error: message, redirects, responseMs: Date.now() - started, status: 0, finalUrl: current };
  } finally {
    clearTimeout(timer);
  }
}

/** robots.txt: present, and does it shut out every crawler? */
export async function fetchRobots(origin: string): Promise<{ found: boolean; disallowAll: boolean; sitemaps: string[] }> {
  const page = await fetchForAudit(`${origin}/robots.txt`, { timeoutMs: 6_000, maxBytes: 64_000, accept: "text/plain,*/*;q=0.5" });
  if (!page.ok || page.status !== 200 || /<html/i.test(page.html.slice(0, 500)) || !/user-agent/i.test(page.html)) {
    return { found: false, disallowAll: false, sitemaps: [] };
  }
  let inStar = false;
  let disallowAll = false;
  for (const line of page.html.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    const [field = "", ...rest] = clean.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(field.trim())) inStar = value === "*";
    else if (inStar && /^disallow$/i.test(field.trim()) && value === "/") disallowAll = true;
  }
  const sitemaps = [...page.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]!).slice(0, 3);
  return { found: true, disallowAll, sitemaps };
}

export async function fetchSitemapExists(origin: string, declared: string[]): Promise<boolean> {
  for (const url of [...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`].slice(0, 3)) {
    const page = await fetchForAudit(url, { timeoutMs: 6_000, maxBytes: 200_000, accept: "application/xml,text/xml,*/*;q=0.5" });
    if (page.ok && page.status === 200 && /<(urlset|sitemapindex)\b/i.test(page.html)) return true;
  }
  return false;
}

/**
 * Status of a few internal links. Only clear breakage counts: 401/403/405/429
 * often mean "no robots" rather than "broken", so they are not reported.
 */
export async function checkLinks(urls: readonly string[]): Promise<{ checked: number; broken: { url: string; status: number }[] }> {
  const broken: { url: string; status: number }[] = [];
  let checked = 0;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift()!;
      const page = await fetchForAudit(url, { timeoutMs: 8_000, maxBytes: 1 });
      if (!page.ok) continue;
      checked += 1;
      if ((page.status >= 400 && ![401, 403, 405, 429].includes(page.status)) || page.status >= 500) broken.push({ url, status: page.status });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { checked, broken };
}
