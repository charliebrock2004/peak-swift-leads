import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPrivateAddress, urlProblem } from "./safe-url.ts";

describe("which addresses the server may fetch", () => {
  it("refuses loopback, private, link-local and metadata addresses", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost:8080/",
      "http://10.0.0.5/",
      "http://172.16.1.1/",
      "http://192.168.1.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0.0.0.0/",
      "http://printer.local/",
      "http://db.internal/",
      "http://2130706433/",
      "http://intranet/",
    ]) {
      assert.ok(urlProblem(url), `should refuse ${url}`);
    }
  });

  it("refuses non-web schemes, credentials and odd ports", () => {
    assert.ok(urlProblem("file:///etc/passwd"));
    assert.ok(urlProblem("ftp://example.com/"));
    assert.ok(urlProblem("https://user:pass@example.com/"));
    assert.ok(urlProblem("https://example.com:6379/"));
  });

  it("allows ordinary public websites", () => {
    for (const url of ["https://strathearnjoinery.co.uk/contact", "http://www.example.com:8080/", "https://93.184.216.34/"]) {
      assert.equal(urlProblem(url), null, url);
    }
  });

  it("classifies IPs", () => {
    assert.equal(isPrivateAddress("8.8.8.8"), false);
    assert.equal(isPrivateAddress("100.64.0.1"), true);
    assert.equal(isPrivateAddress("2606:4700::1111"), false);
    assert.equal(isPrivateAddress("fe80::1"), true);
    assert.equal(isPrivateAddress("::ffff:a9fe:a9fe"), true, "mapped metadata address");
  });
});
