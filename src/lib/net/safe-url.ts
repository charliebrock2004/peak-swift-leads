/**
 * Which URLs the server may fetch on a prospect's behalf.
 *
 * Discovery fetches addresses that came from the outside world — a listing's
 * website field, a search result, a redirect a small business's host chose to
 * send. Any of those can point at `localhost`, a cloud metadata endpoint or a
 * private network, and a server that follows them is a proxy into places it
 * should never reach (SSRF). These rules decide, before any request and again
 * at every redirect, whether a destination is on the public internet.
 *
 * Pure — no DNS, no network — so every rule is unit-tested. The resolving,
 * redirect-following half is `safe-fetch.server.ts`.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

/** Is this IPv4 address anywhere other than the public internet? */
function privateIpv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return true; // unparseable is not trusted
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && p[2] === 0) return true;
  if (a === 192 && b === 0 && p[2] === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Is this IP (v4 or v6) anywhere other than the public internet? */
export function isPrivateAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (ipv4Parts(value)) return privateIpv4(value);
  if (!value.includes(":")) return true;
  if (value === "::" || value === "::1") return true;
  // IPv4-mapped / -compatible: judge the embedded v4 address.
  const mapped = value.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIpv4(mapped[1]!);
  const hexMapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return privateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (value.startsWith("64:ff9b:")) return true; // NAT64 can reach private v4
  if (value.startsWith("2001:db8:")) return true; // documentation
  return false;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];

/**
 * Why this URL must not be fetched, or null when it may be (subject to DNS).
 *
 * Only http(s) on the default or common web ports; no credentials in the URL;
 * no bare IPs that are private; no names that only resolve inside a network.
 */
export function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid web address";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `refused ${url.protocol} address`;
  if (url.username || url.password) return "refused an address with embedded credentials";
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) return `refused port ${url.port}`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "no host";
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "refused a private network name";
  }
  const looksLikeIp = Boolean(ipv4Parts(host)) || host.includes(":");
  if (looksLikeIp) return isPrivateAddress(host) ? "refused a private network address" : null;
  // Numeric forms browsers accept but people do not write: 2130706433, 0x7f.1
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) return "refused a numeric host";
  if (!host.includes(".")) return "refused a single-label host name";
  return null;
}
