/**
 * Building the raw message Gmail sends.
 *
 * Pure, so the exact bytes handed to the API can be unit-tested. The Gmail
 * `messages.send` endpoint takes one field — `raw` — holding a base64url
 * RFC 2822 message, so getting this right is the whole difference between an
 * email arriving and an email arriving broken.
 *
 * Two things here are security, not formatting:
 *
 * - **Header values are stripped of CR and LF.** A newline in a subject or a
 *   recipient is header injection: it would let anything that reaches those
 *   fields add a `Bcc:` of its own.
 * - **Anything non-ASCII in a header is encoded** (RFC 2047). A raw "£" in a
 *   subject is not legal in a header and mangles the line.
 */

/** Base64 for the header/body encodings, without depending on Node's Buffer. */
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64OfText(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/** Gmail wants base64url: `+/` swapped for `-_`, and no padding. */
export function base64Url(text: string): string {
  return base64OfText(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Wrap base64 at 76 characters, as a MIME body must be. */
function wrap(value: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines.join("\r\n");
}

/**
 * A header value that cannot break out of its header.
 *
 * Newlines are removed outright rather than escaped: there is no legitimate
 * reason for one in a subject or an address, so dropping them is safe and
 * leaves nothing to get subtly wrong.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoded-word, used only when the value is not plain ASCII. */
export function encodeHeader(value: string): string {
  const clean = sanitizeHeaderValue(value);
  // eslint-disable-next-line no-control-regex -- deliberate: detecting non-ASCII
  if (!/[^\x00-\x7F]/.test(clean)) return clean;
  return `=?UTF-8?B?${base64OfText(clean)}?=`;
}

/** `Name <address>`, with the display name encoded if it needs to be. */
export function formatAddress(email: string, name = ""): string {
  const address = sanitizeHeaderValue(email);
  if (!name.trim()) return address;
  return `${encodeHeader(name)} <${address}>`;
}

export type MessageInput = {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  /** Plain text. HTML is deliberately not offered — a cold email needs none. */
  body: string;
  /** Set for a follow-up so it threads under the original. */
  inReplyTo?: string;
  references?: string;
  replyTo?: string;
};

/**
 * The complete RFC 2822 message.
 *
 * Plain text only, base64 encoded, so a body containing accents, long lines or
 * a stray "." at the start of a line cannot corrupt the message.
 */
export function buildMimeMessage(input: MessageInput): string {
  const headers: string[] = [
    `To: ${formatAddress(input.to)}`,
    `From: ${formatAddress(input.from, input.fromName)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (input.replyTo) headers.push(`Reply-To: ${formatAddress(input.replyTo)}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${sanitizeHeaderValue(input.references)}`);

  const body = wrap(base64OfText(input.body.replace(/\r?\n/g, "\r\n")));
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** The `raw` value for `users.messages.send`. */
export function buildRawMessage(input: MessageInput): string {
  return base64Url(buildMimeMessage(input));
}

/** Decode Gmail's base64url (message bodies come back in it). */
export function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  if (typeof Buffer !== "undefined") return Buffer.from(withPadding, "base64").toString("utf8");
  const binary = atob(withPadding);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
