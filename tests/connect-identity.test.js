const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { machineId, platformName, mevcutTercih } = require("../scripts/connect");
const { machineLabel, projectLabel } = require("../lib/payload");
const { nodeVersionProblem, MIN_MAJOR } = require("../lib/node-version");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-conn-"));
}

// ── machine_id: cihaz tekilleştirme anahtarı (C13) ─────────────────────────
// Sunucu cihazları hostname ile tekilleştiriyordu: aynı adı taşıyan iki makine
// (ya da aynı makinedeki iki kullanıcı hesabı) aynı device_token'ı paylaşıyordu.

test("machineId 16 hex karakter ve deterministik", () => {
  const a = machineId();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.strictEqual(a, machineId(), "aynı makinede aynı değer");
});

test("machineId hostname'i DÜZ METİN içermez", () => {
  const id = machineId();
  assert.ok(!id.includes(os.hostname()));
  assert.ok(!id.includes(os.homedir()));
});

test("machineId bileşenleri gerçekten karışıma giriyor (hostname tek başına değil)", () => {
  // Aynı hostname + farklı kullanıcı/ev dizini → FARKLI kimlik olmalı.
  // Ayırıcı NUL (kaynakta \u0000 kaçışıyla yazılı) — hiçbir bileşende geçemez,
  // yani "ab"+"c" ile "a"+"bc" aynı kimliğe düşemez.
  const karma = (host, kullanici, platform, home) =>
    crypto.createHash("sha256")
      .update([host, kullanici, platform, home].join("\u0000"))
      .digest("hex").slice(0, 16);
  assert.notStrictEqual(
    karma("MacBook-Pro", "ayse", "darwin", "/Users/ayse"),
    karma("MacBook-Pro", "mehmet", "darwin", "/Users/mehmet"),
    "aynı adlı makinede iki kullanıcı ayrılmalı"
  );
  // ve gerçek üretim aynı formülü kullanıyor
  let kullanici = "";
  try { kullanici = os.userInfo().username || ""; } catch {}
  assert.strictEqual(machineId(), karma(os.hostname(), kullanici, process.platform, os.homedir()));
});

test("platformName üç bilinen değerden birini döner", () => {
  assert.ok(["darwin", "win32", "linux"].includes(platformName()));
});

// ── gizlilik tercihi yeniden bağlanmada korunur (bulgu 13) ────────────────

test("mevcutTercih send_project_names=false'u korur", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usagex.json"), JSON.stringify({ send_project_names: false }));
  assert.strictEqual(mevcutTercih(dir), false);
});

test("mevcutTercih dosya yok/bozukken varsayılan true", () => {
  assert.strictEqual(mevcutTercih(tmpDir()), true);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usagex.json"), "{{{");
  assert.strictEqual(mevcutTercih(dir), true);
});

// R15: rebrand ÖNCESİ kurulumda dosya adı clmt.json. Yalnız usagex.json'a bakmak
// bu kullanıcıların gizlilik tercihini yeniden bağlanmada sessizce sıfırlıyordu.
test("mevcutTercih clmt.json'daki send_project_names=false'u da korur", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "clmt.json"), JSON.stringify({
    enabled: true, device_token: "t", send_project_names: false,
  }));
  assert.strictEqual(mevcutTercih(dir), false, "clmt.json tercihi kaybolmamalı");
});

test("mevcutTercih arama sırası config.js ile aynı: usagex.json clmt.json'ı yener", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "usagex.json"), JSON.stringify({ send_project_names: true }));
  fs.writeFileSync(path.join(dir, "clmt.json"), JSON.stringify({ send_project_names: false }));
  assert.strictEqual(mevcutTercih(dir), true);
});

test("machineLabel gizlilik kapalıyken 'pc-<hash6>', açıkken gerçek ad", () => {
  assert.strictEqual(machineLabel(true, "Ayse-MacBook"), "Ayse-MacBook");
  const gizli = machineLabel(false, "Ayse-MacBook");
  assert.match(gizli, /^pc-[0-9a-f]{6}$/);
  assert.ok(!gizli.includes("Ayse"));
  // deterministik: aynı makine hep aynı etiket (sunucuda satır çoğalmasın)
  assert.strictEqual(gizli, machineLabel(false, "Ayse-MacBook"));
});

test("projectLabel ad bilinmiyorsa BOŞ döner ('unknown' değil)", () => {
  // "unknown" sunucudaki upsert'te gerçek bir ad sayılıp hook'un yazdığı
  // doğru proje adını eziyordu (bulgu 21).
  assert.strictEqual(projectLabel("", true), "");
  assert.strictEqual(projectLabel(null, false), "");
  assert.strictEqual(projectLabel(undefined, true), "");
});

// ── Node sürüm kapısı (bulgu 12) ──────────────────────────────────────────

test("nodeVersionProblem eski Node'da açıklayıcı metin döner", () => {
  const m = nodeVersionProblem("16.20.2");
  assert.match(m, /16\.20\.2/);
  assert.match(m, new RegExp(`Node ${MIN_MAJOR}`));
});

test("nodeVersionProblem 18 ve üstünde null", () => {
  for (const v of ["18.0.0", "20.11.1", "22.4.0", "26.5.0"]) {
    assert.strictEqual(nodeVersionProblem(v), null, v);
  }
});

test("nodeVersionProblem okunamayan sürümde ENGELLEMEZ", () => {
  assert.strictEqual(nodeVersionProblem("bilinmiyor"), null);
});

test("çalışan Node bu projenin taban gereksinimini karşılıyor", () => {
  assert.strictEqual(nodeVersionProblem(), null);
  const engines = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).engines;
  assert.strictEqual(engines.node, `>=${MIN_MAJOR}`);
});
