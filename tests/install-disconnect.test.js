const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { disconnect, isUsagexHook } = require("../scripts/disconnect");

const ROOT = path.join(__dirname, "..");
const INSTALL = path.join(ROOT, "scripts", "install-hooks.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-inst-"));
}
function runInstall(claudeDir, args = []) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
  });
}
const settings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));

// disconnect artık sunucudaki cihaz kaydını silmek için ağa çıkıyor
// (POST /v1/devices/revoke). Testler ASLA gerçek ağa çıkmasın: her çağrıya
// sahte bir fetch veriliyor. Çağrılar `cagrilar` dizisinde toplanır.
function sahteFetch(yanit = { ok: true, status: 200 }) {
  const cagrilar = [];
  const impl = async (url, opts) => {
    cagrilar.push({ url, opts });
    if (typeof yanit === "function") return yanit(url, opts);
    return yanit;
  };
  impl.cagrilar = cagrilar;
  return impl;
}

// ── hook imzası (dizin bağımsız) ────────────────────────────────────────────
// Eskiden sabit ".usagex/collector/hooks" yolu aranıyordu: plugin olarak kurulunca
// eşleşmiyor, her kurulum ikinci bir kopya ekliyor, hook'lar ÇİFT çalışıyordu.

test("imza plugin yolunu da, eski standalone yolunu da tanır", () => {
  const tani = (cmd) => isUsagexHook({ hooks: [{ type: "command", command: cmd }] });
  assert.ok(tani('node "/Users/e/.claude/plugins/usagex/hooks/heartbeat.js"'), "plugin yolu");
  assert.ok(tani('node "/Users/e/.usagex/collector/hooks/heartbeat.js"'), "eski standalone yolu");
  assert.ok(tani('node "C:\\Users\\e\\.usagex\\collector\\hooks\\session-end.js"'), "Windows yolu");
  assert.ok(tani('node "/opt/UsagEX/hooks/heartbeat.js"'), "büyük harf");
  // yabancı hook'lara DOKUNULMAZ
  assert.ok(!tani('node "/home/e/kendi-scriptim/heartbeat.js"'), "usagex geçmiyor");
  assert.ok(!tani('node "/home/e/usagex/baska-sey.js"'), "hook dosyası değil");
  assert.ok(!isUsagexHook({}), "hooks alanı yok");
});

test("iki kez kurulum hook'u ÇİFTLEMEZ (yol değişse bile)", () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex-a/collector"]);
  runInstall(dir, ["/opt/usagex-b/collector"]);
  const s = settings(dir);
  for (const evt of ["SessionStart", "Stop", "SessionEnd"]) {
    assert.strictEqual(s.hooks[evt].length, 1, `${evt} tek giriş olmalı`);
    assert.match(s.hooks[evt][0].hooks[0].command, /usagex-b/, "yol güncellenmeli");
  }
});

test("kullanıcının kendi hook'ları KORUNUR", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    model: "opus",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node /home/e/benim-hookum.js" }] }] },
  }));
  runInstall(dir, ["/opt/usagex/collector"]);
  const s = settings(dir);
  assert.strictEqual(s.model, "opus", "diğer ayarlar korunmalı");
  assert.strictEqual(s.hooks.Stop.length, 2);
  assert.ok(s.hooks.Stop.some((g) => g.hooks[0].command.includes("benim-hookum")));
});

test("settings.json 0600 izinle yazılır (cihaz kurulumunun izi)", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  const mode = fs.statSync(path.join(dir, "settings.json")).mode & 0o777;
  assert.strictEqual(mode, 0o600, `beklenen 0600, gelen ${mode.toString(8)}`);
});

// ── cleanupPeriodDays: varsayılan DOKUNMA ───────────────────────────────────

test("varsayılanda cleanupPeriodDays YAZILMAZ, sadece bilgi verilir", () => {
  const dir = tmpDir();
  const r = runInstall(dir, ["/opt/usagex/collector"]);
  assert.strictEqual(settings(dir).cleanupPeriodDays, undefined);
  assert.match(r.stdout, /--keep-transcripts/, "seçenek kullanıcıya söylenmeli");
});

test("--keep-transcripts ile 3650 yazılır ve bildirilir", () => {
  const dir = tmpDir();
  const r = runInstall(dir, ["/opt/usagex/collector", "--keep-transcripts"]);
  assert.strictEqual(settings(dir).cleanupPeriodDays, 3650);
  assert.match(r.stdout, /10 yıl/);
});

test("kullanıcının kendi cleanupPeriodDays değeri --keep-transcripts ile bile EZİLMEZ", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 60 }));
  runInstall(dir, ["/opt/usagex/collector", "--keep-transcripts"]);
  assert.strictEqual(settings(dir).cleanupPeriodDays, 60);
});

// ── disconnect: install-hooks'un tersi ──────────────────────────────────────

test("disconnect: config enabled:false, artıklar silinir, hook'lar kalkar", async () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  fs.writeFileSync(path.join(dir, "usagex.json"), JSON.stringify({
    enabled: true, ingest_url: "https://x/ingest", device_token: "tok", send_project_names: false,
  }));
  for (const f of ["usagex-queue.jsonl", "usagex-queue.jsonl.blocked", "usagex-state.json", "usagex-usage-cache.json"]) {
    fs.writeFileSync(path.join(dir, f), "x");
  }

  await disconnect({ dir, log: () => {}, fetchImpl: sahteFetch() });

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "usagex.json"), "utf8"));
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.device_token, "tok", "token korunmalı — tekrar bağlanma kolay olsun");
  assert.strictEqual(cfg.send_project_names, false, "gizlilik tercihi korunmalı");

  for (const f of ["usagex-queue.jsonl", "usagex-queue.jsonl.blocked", "usagex-state.json", "usagex-usage-cache.json"]) {
    assert.strictEqual(fs.existsSync(path.join(dir, f)), false, `${f} silinmeliydi`);
  }
  assert.strictEqual(settings(dir).hooks, undefined, "usagex hook'ları kalkınca hooks boşalmalı");

  // loadConfig artık null döndürmeli → hiçbir hook veri göndermez
  assert.strictEqual(require("../lib/config").loadConfig(dir), null);
});

test("disconnect: kullanıcının kendi hook'una ve ayarlarına DOKUNMAZ", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    model: "opus",
    cleanupPeriodDays: 3650,
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node /home/e/benim.js" }] }] },
  }));
  runInstall(dir, ["/opt/usagex/collector"]);

  await disconnect({ dir, log: () => {}, fetchImpl: sahteFetch() });

  const s = settings(dir);
  assert.strictEqual(s.model, "opus");
  assert.strictEqual(s.cleanupPeriodDays, 3650, "transkript saklamaya dokunulmamalı");
  assert.strictEqual(s.hooks.Stop.length, 1);
  assert.match(s.hooks.Stop[0].hooks[0].command, /benim\.js/);
});

test("disconnect: hiç bağlanmamış makinede sessizce çalışır (throw yok)", async () => {
  const dir = tmpDir();
  const satirlar = [];
  assert.strictEqual(await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: sahteFetch() }), false);
  assert.ok(satirlar.some((s) => /bağlanmamış/.test(s)));
});

test("disconnect: eski clmt.json da devre dışı bırakılır", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "clmt.json"), JSON.stringify({ enabled: true, ingest_url: "https://x", device_token: "t" }));
  await disconnect({ dir, log: () => {}, fetchImpl: sahteFetch() });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "clmt.json"), "utf8")).enabled, false);
});

test("disconnect kullanıcıya sunucu tarafını ve veri saklamayı ANLATIR", async () => {
  const dir = tmpDir();
  const satirlar = [];
  await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: sahteFetch() });
  const metin = satirlar.join("\n");
  assert.match(metin, /Ayarlar/, "uygulamadan silme yolu söylenmeli");
  assert.match(metin, /hesabında KALIR/, "geçmiş istatistiklerin kaldığı söylenmeli");
  assert.match(metin, /usagex-connect/, "tekrar bağlanma yolu söylenmeli");
});

// ── BOZUK settings.json: asla üzerine yazma (bulgu 1) ───────────────────────
// Eskiden parse hatası `settings = {}` ile yutuluyordu: kullanıcının model /
// permissions / env / statusLine ayarları ve kendi hook'ları siliniyor, üstüne
// "✓ kuruldu" basılıyordu. JSONC yorumu ya da fazladan virgül yeterliydi.

const BOZUK = [
  ['yorum satırı (JSONC)', '{\n  // model tercihim\n  "model": "opus"\n}'],
  ['fazladan virgül', '{ "model": "opus", "env": { "A": "1" }, }'],
  ['yarım dosya (yazarken kesilmiş)', '{ "model": "opus", "hooks": {'],
];

for (const [ad, icerik] of BOZUK) {
  test(`bozuk settings.json (${ad}) → kurulum DURUR, dosya DEĞİŞMEZ`, () => {
    const dir = tmpDir();
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, icerik);

    const r = runInstall(dir, ["/opt/usagex/collector"]);

    assert.notStrictEqual(r.status, 0, "hata koduyla çıkmalı");
    assert.strictEqual(fs.readFileSync(p, "utf8"), icerik, "dosyaya DOKUNULMAMALI");
    assert.match(r.stderr, /geçerli JSON değil/);
    assert.doesNotMatch(r.stdout, /kuruldu/, "yalancı başarı mesajı basmamalı");
  });
}

test("settings.json JSON ama nesne değilse (dizi) kurulum DURUR", () => {
  const dir = tmpDir();
  const p = path.join(dir, "settings.json");
  fs.writeFileSync(p, '["neden dizi"]');
  const r = runInstall(dir, ["/opt/usagex/collector"]);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(p, "utf8"), '["neden dizi"]');
});

test("yazmadan önce settings.json.bak-<ts> yedeği alınır", () => {
  const dir = tmpDir();
  const once = JSON.stringify({ model: "opus", env: { A: "1" } });
  fs.writeFileSync(path.join(dir, "settings.json"), once);

  const r = runInstall(dir, ["/opt/usagex/collector"]);

  assert.strictEqual(r.status, 0, r.stderr);
  const yedekler = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.bak-"));
  assert.strictEqual(yedekler.length, 1, "tam bir yedek olmalı");
  assert.strictEqual(fs.readFileSync(path.join(dir, yedekler[0]), "utf8"), once);
  assert.match(r.stdout, /yedeği/);
  // ve yeni dosya gerçekten güncellendi
  assert.strictEqual(settings(dir).model, "opus");
  assert.ok(settings(dir).hooks.Stop);
});

test("settings.json hiç yokken yedek üretilmez (uydurma dosya bırakma)", () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes(".bak-")), []);
});

// ── hook komutu: node PATH varsayımı ve timeout (bulgu 12) ──────────────────

test("hook komutu KURULUM ANINDAKİ node yolunu tırnaklı kullanır", () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  const cmd = settings(dir).hooks.Stop[0].hooks[0].command;
  // PATH'te node olmayan kurulumlarda (nvm/asdf, launchd, GUI) hook sessizce
  // hiç çalışmıyordu; yol boşluk içerebilir → tırnak şart.
  assert.ok(cmd.startsWith(`"${process.execPath}"`), cmd);
  assert.ok(cmd.includes("heartbeat.js"));
});

test("hook girdisine timeout yazılır (yavaş diskte yarıda kesilmesin)", () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  for (const evt of ["SessionStart", "Stop", "SessionEnd"]) {
    assert.strictEqual(settings(dir).hooks[evt][0].hooks[0].timeout, 15, evt);
  }
});

test("kurulan hook kendi imzasına uyar (sonraki kurulum çiftlemesin)", () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  assert.ok(isUsagexHook(settings(dir).hooks.Stop[0]), "execPath'li komut da tanınmalı");
});

// ── disconnect: rebrand öncesi artıklar (bulgu 19) ──────────────────────────

test("disconnect clmt-* artıklarını ve inflight dosyalarını da siler", async () => {
  const dir = tmpDir();
  const hedefler = [
    "usagex-queue.jsonl", "usagex-state.json", "usagex-usage-cache.json",
    "usagex-subagent-cache.json",
    "clmt-queue.jsonl", "clmt-queue.jsonl.blocked", "clmt-state.json", "clmt-usage-cache.json",
    "usagex-queue.jsonl.inflight.4242",
  ];
  for (const f of hedefler) fs.writeFileSync(path.join(dir, f), "x");
  fs.writeFileSync(path.join(dir, "usagex.json"), JSON.stringify({ enabled: true, device_token: "t" }));

  await disconnect({ dir, log: () => {}, fetchImpl: sahteFetch() });

  for (const f of hedefler) {
    assert.strictEqual(fs.existsSync(path.join(dir, f)), false, `${f} silinmeliydi`);
  }
});

test("disconnect yabancı dosyalara dokunmaz", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "benim-notlarim.json"), "x");
  fs.writeFileSync(path.join(dir, "clmt.md"), "x");
  await disconnect({ dir, log: () => {}, fetchImpl: sahteFetch() });
  assert.ok(fs.existsSync(path.join(dir, "benim-notlarim.json")));
  assert.ok(fs.existsSync(path.join(dir, "clmt.md")));
});

// ── sunucudaki cihaz kaydını iptal (POST /v1/devices/revoke) ───────────────
// Eskiden collector sunucudaki kaydı hiç silemiyor, kullanıcıyı "uygulamadan
// da sil" diye ikinci bir işe gönderiyordu. Artık cihaz token'ıyla kimliklenen
// iptal ucu var; ağ hatası yerel temizliği ASLA durdurmaz.

const { revokeUrl } = require("../scripts/disconnect");

function bagli(dir, ingest_url = "https://usagex.example/ingest") {
  fs.writeFileSync(path.join(dir, "usagex.json"), JSON.stringify({
    enabled: true, ingest_url, device_token: "cihaz-tok", send_project_names: true,
  }));
}

test("revokeUrl ingest_url'in ORIGIN'ini kullanır (self-host bozulmasın)", () => {
  assert.strictEqual(revokeUrl("https://usagex.example/ingest"), "https://usagex.example/v1/devices/revoke");
  assert.strictEqual(revokeUrl("https://kendi.sunucum.dev:8443/alt/yol/ingest"), "https://kendi.sunucum.dev:8443/v1/devices/revoke");
  assert.strictEqual(revokeUrl("saçma"), null);
});

test("disconnect iptal ucunu cihaz token'ıyla, YEREL TEMİZLİKTEN ÖNCE çağırır", async () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  bagli(dir);
  fs.writeFileSync(path.join(dir, "usagex-queue.jsonl"), "x");

  const satirlar = [];
  // Sunucu yanıtı üretilirken config'in HÂLÂ dokunulmamış olduğunu doğruluyoruz:
  // iptal yerel temizlikten önce çalışmalı (token okunabilir, kuyruk duruyor).
  let anlikDurum = null;
  const f = sahteFetch(() => {
    anlikDurum = {
      enabled: JSON.parse(fs.readFileSync(path.join(dir, "usagex.json"), "utf8")).enabled,
      kuyrukVar: fs.existsSync(path.join(dir, "usagex-queue.jsonl")),
    };
    return { ok: true, status: 200 };
  });

  await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: f });

  assert.strictEqual(f.cagrilar.length, 1);
  const { url, opts } = f.cagrilar[0];
  assert.strictEqual(url, "https://usagex.example/v1/devices/revoke");
  assert.strictEqual(opts.method, "POST");
  assert.strictEqual(opts.headers.Authorization, "Bearer cihaz-tok");
  assert.strictEqual(opts.body, undefined, "gövde YOK");
  assert.ok(opts.signal, "5 sn timeout için abort sinyali olmalı");

  assert.deepStrictEqual(anlikDurum, { enabled: true, kuyrukVar: true }, "iptal ÖNCE koşmalı");

  const metin = satirlar.join("\n");
  assert.match(metin, /Sunucudaki cihaz kaydı silindi/);
  assert.doesNotMatch(metin, /Bağlı bilgisayarlar/, "silindiyse kullanıcıyı ikinci bir işe göndermemeli");

  // ve yerel temizlik yine tamamlandı
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "usagex.json"), "utf8")).enabled, false);
  assert.strictEqual(fs.existsSync(path.join(dir, "usagex-queue.jsonl")), false);
  assert.strictEqual(settings(dir).hooks, undefined);
});

test("iptal BAŞARISIZ olsa da yerel temizlik tamamlanır + uyarı basılır", async () => {
  const dir = tmpDir();
  runInstall(dir, ["/opt/usagex/collector"]);
  bagli(dir);
  fs.writeFileSync(path.join(dir, "usagex-state.json"), "x");

  const satirlar = [];
  const f = sahteFetch(() => { throw new Error("ECONNREFUSED"); });
  await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: f });

  const metin = satirlar.join("\n");
  assert.match(metin, /Sunucudaki kayıt silinemedi/);
  assert.match(metin, /ECONNREFUSED/, "sebep söylenmeli");
  assert.match(metin, /Ayarlar → Bağlı bilgisayarlar/, "elle silme yolu gösterilmeli");

  // asıl istek ("veri göndermeyi kes") her hâlükârda yerine getirilir
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "usagex.json"), "utf8")).enabled, false);
  assert.strictEqual(fs.existsSync(path.join(dir, "usagex-state.json")), false);
  assert.strictEqual(settings(dir).hooks, undefined);
});

test("401 = sunucuda zaten yok → başarı sayılır, uyarı basılmaz", async () => {
  const dir = tmpDir();
  bagli(dir);
  const satirlar = [];
  await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: sahteFetch({ ok: false, status: 401 }) });
  const metin = satirlar.join("\n");
  assert.match(metin, /kaydı zaten yoktu/);
  assert.doesNotMatch(metin, /silinemedi/);
  assert.doesNotMatch(metin, /Bağlı bilgisayarlar/);
});

test("500 geçici hata → uyarı basılır (kullanıcı elle silsin)", async () => {
  const dir = tmpDir();
  bagli(dir);
  const satirlar = [];
  await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: sahteFetch({ ok: false, status: 500 }) });
  assert.match(satirlar.join("\n"), /Sunucudaki kayıt silinemedi.*HTTP 500/s);
});

test("hiç bağlanmamış makinede ağa ÇIKILMAZ", async () => {
  const dir = tmpDir();
  const f = sahteFetch();
  await disconnect({ dir, log: () => {}, fetchImpl: f });
  assert.strictEqual(f.cagrilar.length, 0, "device_token yokken istek atılmamalı");
});

test("ingest_url https değilse token ağa ÇIKMAZ", async () => {
  const dir = tmpDir();
  bagli(dir, "http://kotu.example/ingest"); // düz metin — cihaz token'ı gitmemeli
  const satirlar = [];
  const f = sahteFetch();
  await disconnect({ dir, log: (m) => satirlar.push(m), fetchImpl: f });
  assert.strictEqual(f.cagrilar.length, 0);
  assert.match(satirlar.join("\n"), /Sunucudaki kayıt silinemedi/);
  // yerel temizlik yine yapıldı
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "usagex.json"), "utf8")).enabled, false);
});

test("localhost (yerel geliştirme) http ile iptal edilebilir", async () => {
  const dir = tmpDir();
  bagli(dir, "http://127.0.0.1:8080/ingest");
  const f = sahteFetch();
  await disconnect({ dir, log: () => {}, fetchImpl: f });
  assert.strictEqual(f.cagrilar.length, 1);
  assert.strictEqual(f.cagrilar[0].url, "http://127.0.0.1:8080/v1/devices/revoke");
});
