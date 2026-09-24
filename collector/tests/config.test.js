const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, configProblem, ingestUrlProblem, readRawConfig } = require("../lib/config");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-test-"));
}
function writeCfg(dir, cfg, name = "usagex.json") {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(cfg));
  return dir;
}
const TAM = {
  enabled: true,
  ingest_url: "https://usagex.dijitalpi.com/ingest",
  device_token: "tok-1",
};

test("geçerli config okunur, send_project_names varsayılan true", () => {
  const dir = writeCfg(tmpDir(), TAM);
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.device_token, "tok-1");
  assert.strictEqual(cfg.send_project_names, true);
});

test("send_project_names=false korunur (varsayılana ezilmez)", () => {
  const dir = writeCfg(tmpDir(), { ...TAM, send_project_names: false });
  assert.strictEqual(loadConfig(dir).send_project_names, false);
});

test("enabled:false → null", () => {
  const dir = writeCfg(tmpDir(), { ...TAM, enabled: false });
  assert.strictEqual(loadConfig(dir), null);
  assert.match(configProblem(readRawConfig(dir).cfg), /enabled:false/);
});

test("eksik alanlar → null ve sebebi söylenir", () => {
  const d1 = writeCfg(tmpDir(), { enabled: true, ingest_url: TAM.ingest_url });
  assert.strictEqual(loadConfig(d1), null);
  assert.match(configProblem(readRawConfig(d1).cfg), /device_token/);

  const d2 = writeCfg(tmpDir(), { enabled: true, device_token: "t" });
  assert.strictEqual(loadConfig(d2), null);
  assert.match(configProblem(readRawConfig(d2).cfg), /ingest_url/);

  assert.match(configProblem(null), /yok ya da bozuk/);
});

test("config dosyası hiç yoksa null", () => {
  assert.strictEqual(loadConfig(tmpDir()), null);
  assert.strictEqual(readRawConfig(tmpDir()), null);
});

test("bozuk JSON'da eski clmt.json'a düşer (geriye uyumluluk)", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usagex.json"), "{{{bozuk");
  writeCfg(dir, { ...TAM, device_token: "eski" }, "clmt.json");
  assert.strictEqual(loadConfig(dir).device_token, "eski");
});

// ── https zorlaması ─────────────────────────────────────────────────────────
// Cihaz token'ı Authorization header'ında gidiyor; http'de düz metin demek.

test("http:// uzak adres REDDEDİLİR (enabled gibi davranır)", () => {
  const dir = writeCfg(tmpDir(), { ...TAM, ingest_url: "http://usagex.dijitalpi.com/ingest" });
  assert.strictEqual(loadConfig(dir), null);
  assert.match(configProblem(readRawConfig(dir).cfg), /https:\/\/ değil/);
});

test("http://localhost ve 127.0.0.1 istisna (yerel geliştirme)", () => {
  assert.strictEqual(ingestUrlProblem("http://localhost:9999/ingest"), null);
  assert.strictEqual(ingestUrlProblem("http://127.0.0.1:8080/ingest"), null);
  const dir = writeCfg(tmpDir(), { ...TAM, ingest_url: "http://localhost:9999/ingest" });
  assert.ok(loadConfig(dir));
});

test("https her zaman geçerli, saçma URL sebebiyle birlikte reddedilir", () => {
  assert.strictEqual(ingestUrlProblem("https://example.com/ingest"), null);
  assert.match(ingestUrlProblem("bu-bir-url-degil"), /geçersiz bir URL/);
  assert.match(ingestUrlProblem(""), /ingest_url yok/);
  // ftp/file gibi şemalar da https değildir
  assert.match(ingestUrlProblem("ftp://example.com/x"), /https:\/\/ değil/);
});
