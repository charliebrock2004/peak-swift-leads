import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeHtmlEntities } from "./html-entities.ts";
import { extractCandidates } from "./email-discovery.ts";
import { pageText } from "./website-discovery.ts";

describe("decoding character references", () => {
  it("decodes decimal, hex and named references", () => {
    assert.equal(decodeHtmlEntities("&#105;nfo&#64;x.co.uk"), "info@x.co.uk");
    assert.equal(decodeHtmlEntities("&#x73;ales&#x40;x&#x2e;co.uk"), "sales@x.co.uk");
    assert.equal(decodeHtmlEntities("Smith &amp; Sons"), "Smith & Sons");
    assert.equal(decodeHtmlEntities("hello&commat;x&period;com"), "hello@x.com");
  });

  it("accepts a numeric reference without its semicolon, as browsers do", () => {
    assert.equal(decodeHtmlEntities("info&#64x.co.uk"), "info@x.co.uk");
  });

  it("leaves unknown or unterminated named references alone", () => {
    assert.equal(decodeHtmlEntities("&notareal; &ampersand"), "&notareal; &ampersand");
  });

  it("refuses references that are out of range or control characters", () => {
    assert.equal(decodeHtmlEntities("a&#0;b"), "a&#0;b");
    assert.equal(decodeHtmlEntities("a&#xD800;b"), "a&#xD800;b");
    assert.equal(decodeHtmlEntities("a&#1114112;b"), "a&#1114112;b");
  });

  it("keeps markup characters encoded when asked to preserve markup", () => {
    assert.equal(
      decodeHtmlEntities("&lt;script&gt; &#60;b&#62; &quot;x&quot; &#64;", { preserveMarkup: true }),
      "&lt;script&gt; &#60;b&#62; &quot;x&quot; @",
    );
  });
});

describe("email extraction reads encoded addresses exactly", () => {
  const page = `<footer>
    <a href="mailto:&#105;&#110;fo&#64;smithjoinery.co.uk">&#105;&#110;fo&#64;smithjoinery.co.uk</a>
    <p>Sales: &#x73;ales&#x40;smithjoinery&#x2e;co.uk</p>
  </footer>`;

  it("never truncates a partly-encoded address into a different one (regression)", () => {
    const found = extractCandidates(page, "https://smithjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE").map(
      (candidate) => candidate.email,
    );
    assert.ok(!found.includes("fo@smithjoinery.co.uk"), `wrong address produced: ${found.join(", ")}`);
    assert.deepEqual(found.sort(), ["info@smithjoinery.co.uk", "sales@smithjoinery.co.uk"]);
  });

  it("records an encoded mailto as a mailto, the strongest evidence", () => {
    const [first] = extractCandidates(page, "https://smithjoinery.co.uk/contact", "OFFICIAL_CONTACT_PAGE");
    assert.equal(first?.email, "info@smithjoinery.co.uk");
    assert.equal(first?.method, "MAILTO_LINK");
  });

  it("does not let displayed code samples become markup", () => {
    const html = `<p>&lt;script&gt;</p><p>office@smithjoinery.co.uk</p><p>&lt;/script&gt;</p>`;
    const found = extractCandidates(html, "https://smithjoinery.co.uk/", "OFFICIAL_WEBSITE").map((c) => c.email);
    assert.deepEqual(found, ["office@smithjoinery.co.uk"]);
  });
});

describe("page text used for identity checks", () => {
  it("reads encoded business names as the names they are", () => {
    const text = pageText("<h1>O&#8217;Brien &amp; Sons Joinery</h1><p>Call&nbsp;01738&#160;123456</p>");
    assert.equal(text, "O’Brien & Sons Joinery Call 01738 123456");
  });
});
