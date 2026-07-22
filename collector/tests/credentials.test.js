const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseToken, readTokenFromFile } = require("../lib/credentials");

test("parseToken geçerli credentials JSON'ından token çıkarır", () => {
  const raw = JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } });
  assert.strictEqual(parseToken(raw), "tok-123");
});

test("parseToken bozuk/eksik veride null döner", () => {
  assert.strictEqual(parseToken("not-json"), null);
  assert.strictEqual(parseToken("{}"), null);
  assert.strictEqual(parseToken(JSON.stringify({ claudeAiOauth: {} })), null);
});

test("readTokenFromFile dosya yoksa null döner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clmt-test-"));
  assert.strictEqual(readTokenFromFile(dir), null);
});

test("readTokenFromFile .credentials.json'dan okur", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clmt-test-"));
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } })
  );
  assert.strictEqual(readTokenFromFile(dir), "tok-abc");
});
