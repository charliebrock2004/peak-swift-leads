/**
 * Whether the connected mailbox is a sensible sender for cold outreach.
 *
 * A consumer address (gmail.com and friends) works, and is allowed — but its
 * reputation is shared with the owner's personal mail, it cannot be covered by
 * the business's own SPF/DKIM/DMARC, and it reads as less established to a
 * business owner. A Google Workspace mailbox on the business's own domain is
 * the recommendation; nothing here blocks sending.
 */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "aol.com",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "talktalk.net",
]);

export type SenderAdvice = { kind: "domain" | "consumer" | "unknown"; domain: string; advice: string };

export function senderAdvice(email: string): SenderAdvice {
  const domain = (email.split("@")[1] ?? "").trim().toLowerCase();
  if (!domain) return { kind: "unknown", domain: "", advice: "" };
  if (CONSUMER_DOMAINS.has(domain)) {
    return {
      kind: "consumer",
      domain,
      advice: `You're sending from a personal ${domain} address. It works, but a mailbox on your own domain (Google Workspace) looks more established to a business owner, keeps outreach off your personal reputation, and can be protected with SPF, DKIM and DMARC. Keep volume low until then.`,
    };
  }
  return {
    kind: "domain",
    domain,
    advice: `Sending from your own domain (${domain}). Make sure SPF, DKIM and DMARC are set up for it in Google Workspace.`,
  };
}
