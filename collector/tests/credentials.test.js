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

// ── expiresAt: süresi dolmuş token "yok" sayılır (bulgu 11) ────────────────
// Dosya kaynağı Keychain'e tercih ediliyordu; aylar önceki bir .credentials.json
// kopyası duruyorsa Keychain'deki TAZE token hiç denenmiyor ve limit ucu sonsuza
// dek 401 dönüyordu.

const os2 = require("os");
const path2 = require("path");
const fs2 = require("fs");
const {
  parseToken: pt, readTokenFromFile: dosyadanOku, getAccessToken, tokenSource,
} = require("../lib/credentials");

const ŞİMDİ = 1_800_000_000_000;
const creds = (token, expiresAt) =>
  JSON.stringify({ claudeAiOauth: expiresAt === undefined ? { accessToken: token } : { accessToken: token, expiresAt } });

test("parseToken: expiresAt gelecekteyse token döner", () => {
  assert.strictEqual(pt(creds("tok", ŞİMDİ + 60_000), ŞİMDİ), "tok");
});

test("parseToken: expiresAt geçmişse null (ölü token 'var' sayılmasın)", () => {
  assert.strictEqual(pt(creds("tok", ŞİMDİ - 1), ŞİMDİ), null);
});

test("parseToken: expiresAt yoksa eski davranış (token döner)", () => {
  assert.strictEqual(pt(creds("tok"), ŞİMDİ), "tok");
});

test("parseToken: accessToken boş/eksikse null", () => {
  assert.strictEqual(pt(JSON.stringify({ claudeAiOauth: { accessToken: "" } }), ŞİMDİ), null);
  assert.strictEqual(pt(JSON.stringify({ claudeAiOauth: {} }), ŞİMDİ), null);
  assert.strictEqual(pt("bozuk{{{", ŞİMDİ), null);
});

test("getAccessToken süresi dolmuş DOSYA kaynağını atlar", () => {
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "usagex-cred-"));
  fs2.writeFileSync(path2.join(dir, ".credentials.json"), creds("bayat", ŞİMDİ - 1));
  assert.strictEqual(dosyadanOku(dir, ŞİMDİ), null);
  // macOS'ta bir sonraki kaynak Keychain; deterministik olsun diye platformu değiştir
  const orj = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    assert.strictEqual(getAccessToken(dir, ŞİMDİ), null, "bayat dosya token'ı kullanılmamalı");
    assert.strictEqual(tokenSource(dir, ŞİMDİ), "süresi dolmuş", "ping bunu 'yok' diye raporlamamalı");
  } finally {
    Object.defineProperty(process, "platform", { value: orj, configurable: true });
  }
});

test("tokenSource geçerli dosya token'ında 'dosya' der", () => {
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "usagex-cred-"));
  fs2.writeFileSync(path2.join(dir, ".credentials.json"), creds("taze", ŞİMDİ + 3_600_000));
  assert.strictEqual(tokenSource(dir, ŞİMDİ), "dosya");
});
