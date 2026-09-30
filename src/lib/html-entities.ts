/**
 * Decoding HTML character references — the way a browser would.
 *
 * Email discovery and website verification both read raw HTML, and small
 * business sites routinely encode the very things they are looking for:
 * WordPress's `antispambot()` writes `info@example.co.uk` as a random mix of
 * `&#105;`, `&#x6e;` and plain letters, and page builders write "Smith & Sons"
 * as `Smith &amp; Sons`.
 *
 * Decoding only part of that is worse than decoding none of it. The discovery
 * code once turned `&#64;` into "@" but left `&#105;` alone, so
 * `&#105;&#110;fo&#64;smithjoinery.co.uk` was read as `fo@smithjoinery.co.uk`
 * — a confident, on-domain, wrong address. Every reference is decoded here, so
 * what the code reads is exactly what a person sees on the page.
 *
 * Pure and dependency-free.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  commat: "@",
  period: ".",
  hyphen: "-",
  dash: "-",
  lowbar: "_",
  plus: "+",
  percnt: "%",
  colon: ":",
  sol: "/",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  pound: "£",
  eacute: "é",
};

function fromCodePoint(code: number): string {
  // Out of range, a surrogate half, or a control character a browser would
  // replace: never let a malformed reference inject something unexpected.
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  if (code >= 0xd800 && code <= 0xdfff) return "";
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
  return String.fromCodePoint(code);
}

/**
 * Replace every numeric (`&#64;`, `&#x40;`) and common named (`&amp;`,
 * `&commat;`) character reference with the character it stands for.
 *
 * The trailing semicolon is optional for numeric references, as it is in
 * browsers — `&#64` followed by a letter still renders "@". Unknown named
 * references are left exactly as written rather than guessed at.
 *
 * `preserveMarkup` is for decoding a whole HTML document before scanning it:
 * references to `<`, `>`, `"` and `'` are left encoded there, so text a page
 * *displays* (a code sample showing `&lt;script&gt;`) can never turn into markup
 * that changes how the rest of the page is parsed.
 */
export function decodeHtmlEntities(text: string, options: { preserveMarkup?: boolean } = {}): string {
  if (!text || !text.includes("&")) return text;
  const markup = new Set(["<", ">", '"', "'"]);
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      const char = fromCodePoint(code);
      if (!char) return whole;
      if (options.preserveMarkup && markup.has(char)) return whole;
      return char;
    }
    const named = NAMED[ref.toLowerCase()];
    // A named reference needs its semicolon; "&ampersand" in prose is not one.
    if (named === undefined || !whole.endsWith(";")) return whole;
    if (options.preserveMarkup && markup.has(named)) return whole;
    return named;
  });
}
