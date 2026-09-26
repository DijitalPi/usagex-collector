// Aşama 2 kurulum akışı: ön kontrol → kod → kayıt → hook/servis → arka plan
// geçmişi → yerelleştirilmiş mesaj. Her test geçici HOME / CLAUDE_CONFIG_DIR /
// CODEX_HOME ve 127.0.0.1'de sahte bir sunucu kullanır; gerçek ev dizinine,
// gerçek LaunchAgent'lara ve üretim sunucusuna ASLA dokunulmaz.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync, spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const { connect } = require("../scripts/connect");
const { disconnect } = require("../scripts/disconnect");
const { msg, lang } = require("../lib/i18n");

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-flow-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const claude = path.join(home, ".claude");
  fs.mkdirSync(claude, { recursive: true });
  // Kurulum kökü "usagex" içermeli (hook imzası); betikler stub'lanan spawn'a gider.
  const root = path.join(base, "srv", ".usagex", "collector");
  return { base, home, claude, root };
}

// Sahte eşleştirme sunucusu. `status` ve `body` isteğe göre ayarlanır.
async function fakeServer(t, { status = 200, body = { device_token: "tok-123" } } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: data });
      if (req.url === "/v1/pairing/claim") {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(typeof body === "function" ? body() : body));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests };
}

function stubSpawn() {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    // Hiç bitmeyen bir çocuk: connect onu BEKLERSE test zaman aşımına düşer.
    return { unref() { calls.at(-1).unref = true; }, on() {} };
  };
  impl.calls = calls;
  return impl;
}

function capture() {
  const out = [], err = [];
  return { out, err, o: (s) => out.push(s), e: (s) => err.push(s) };
}

async function runConnect(t, box, server, { lang: l = "tr", code = "ABCD2345", extraEnv = {}, spawnImpl = stubSpawn() } = {}) {
  const c = capture();
  const env = { USAGEX_SERVER_URL: `${server.url}/ingest`, USAGEX_LANG: l, USAGEX_NODE: "/opt/usagex node/bin/node", ...extraEnv };
  const exit = await connect(code, {
    env, home: box.home, dir: box.claude, root: box.root, spawnImpl, out: c.o, err: c.e, fetchImpl: fetch,
  });
  return { exit, ...c, spawnImpl };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

test("i18n: USAGEX_LANG en/en-US İngilizce, diğer her şey Türkçe", () => {
  assert.equal(lang({ USAGEX_LANG: "en" }), "en");
  assert.equal(lang({ USAGEX_LANG: "en-US" }), "en");
  assert.equal(lang({ USAGEX_LANG: "tr" }), "tr");
  assert.equal(lang({ USAGEX_LANG: "de" }), "tr");
  assert.equal(lang({}), "tr");
  assert.match(msg("disconnect_hint", { cmd: "X" }, "en"), /X$/);
});

test("i18n: tr ve en aynı anahtarları taşır, Türkçede uzun tire yok", () => {
  const { MESSAGES } = require("../lib/i18n");
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.tr).sort());
  for (const l of ["tr", "en"]) {
    for (const [k, v] of Object.entries(MESSAGES[l])) assert.doesNotMatch(v, /—/, `${l}.${k}`);
  }
});

// Uygulamadaki yerler GERÇEK adlarıyla yazılır: "Ayarlar > Bilgisayar bağla" ya da
// "Bağlı bilgisayarlar" diye bir yer yok; bölümün adı "Bilgisayarlar".
test("i18n: uygulamadaki yerler gerçek adlarıyla; yanlış yazılan kod da aynı mesajı alır", () => {
  const { MESSAGES } = require("../lib/i18n");
  const all = (l) => Object.values(MESSAGES[l]).join("\n");
  assert.doesNotMatch(all("tr"), /Bilgisayar bağla|Bağlı bilgisayarlar|Hesabı sil|Ayarlar >/);
  assert.doesNotMatch(all("en"), /Connect computer|Connected computers|Settings >/);
  for (const k of ["usage_claude", "revoke_manual"]) assert.match(MESSAGES.tr[k], /Ayarlar → Bilgisayarlar/, k);
  for (const k of ["usage_codex", "wrong_provider"]) assert.match(MESSAGES.tr[k], /Codex → Ayarlar → Bilgisayarlar/, k);
  assert.match(MESSAGES.tr.history_kept, /Ayarlar → Hesap → UsagEX hesabını sil/);
  assert.equal(MESSAGES.tr.code_invalid, "Bu kod çalışmadı: yanlış yazılmış, süresi dolmuş ya da kullanılmış olabilir. UsagEX uygulamasından yeni kod alın.");
  assert.match(MESSAGES.en.code_invalid, /mistyped, expired or already used/);
});

test("ön kontrol: bozuk settings.json → kod HARCANMAZ, hiçbir şey değişmez", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  const settingsPath = path.join(box.claude, "settings.json");
  fs.writeFileSync(settingsPath, '{ "model": "opus", }');
  const r = await runConnect(t, box, server);
  assert.equal(r.exit, 1);
  assert.equal(server.requests.length, 0, "sunucuya istek gitmemeli");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), '{ "model": "opus", }');
  assert.equal(fs.existsSync(path.join(box.claude, "usagex.json")), false);
  assert.equal(r.spawnImpl.calls.length, 0);
  const text = r.err.join("\n");
  assert.match(text, /settings\.json geçerli JSON değil/);
  assert.match(text, /Kodunuz kullanılmadı/);
});

test("ön kontrol: ~/.usagex yazılamıyorsa kod harcanmaz", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  fs.writeFileSync(path.join(box.home, ".usagex"), "dosya, klasör değil");
  const r = await runConnect(t, box, server, { lang: "en" });
  assert.equal(r.exit, 1);
  assert.equal(server.requests.length, 0);
  assert.match(r.err.join("\n"), /Cannot write to .*\.usagex/);
});

test("başarılı bağlantı: kayıt, run-hook.sh hook'ları, node-path, arka plan geçmişi, Türkçe mesaj", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  fs.writeFileSync(path.join(box.claude, "settings.json"), JSON.stringify({ model: "opus" }));
  const r = await runConnect(t, box, server);
  assert.equal(r.exit, 0, r.err.join("\n"));
  assert.equal(server.requests.length, 1);

  const cfg = readJson(path.join(box.claude, "usagex.json"));
  assert.equal(cfg.device_token, "tok-123");
  assert.equal(cfg.ingest_url, `${server.url}/ingest`);

  const s = readJson(path.join(box.claude, "settings.json"));
  assert.equal(s.model, "opus");
  const hook = path.join(box.root, "scripts", "run-hook.sh");
  assert.equal(s.hooks.Stop[0].hooks[0].command, `sh "${hook}" heartbeat.js`);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, `sh "${hook}" heartbeat.js`);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, `sh "${hook}" session-end.js`);

  assert.equal(fs.readFileSync(path.join(box.home, ".usagex", "node-path"), "utf8"), "/opt/usagex node/bin/node\n");

  // Geçmiş ayrık (detached) başlatıldı, çıktısı log dosyasına gidiyor, beklenmedi.
  assert.equal(r.spawnImpl.calls.length, 1);
  const call = r.spawnImpl.calls[0];
  assert.deepEqual(call.args, [path.join(box.root, "scripts", "backfill.js"), "90"]);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.stdio[0], "ignore");
  assert.equal(typeof call.opts.stdio[1], "number");
  assert.equal(call.unref, true);
  assert.ok(fs.existsSync(path.join(box.home, ".usagex", "backfill.log")));

  const text = r.out.join("\n");
  assert.match(text, /✓ Bilgisayarınız bağlandı\. Bu pencereyi kapatabilirsiniz\. Geçmiş kullanımınız birkaç dakika içinde telefonda görünür\./);
  assert.match(text, /Bağlantıyı kesmek isterseniz: "\/opt\/usagex node\/bin\/node" ".*scripts\/disconnect\.js"/);
  // Jargon yok: JSON, gönderim sayaçları, ping ipucu basılmaz.
  assert.doesNotMatch(text, /[{}]|Gönderilen|Atlanan|ping\.js/);
  assert.deepEqual(r.err, []);
});

test("başarılı bağlantı İngilizce; Claude Code yoksa bilgi notu", async (t) => {
  const box = sandbox(t);
  fs.rmSync(box.claude, { recursive: true });
  const server = await fakeServer(t);
  const r = await runConnect(t, box, server, { lang: "en" });
  assert.equal(r.exit, 0, r.err.join("\n"));
  const text = r.out.join("\n");
  assert.match(text, /✓ Your computer is connected\. You can close this window\./);
  assert.match(text, /Claude Code is not installed on this computer yet/);
  assert.match(text, /To disconnect later, run:/);
  assert.doesNotMatch(text, /Bilgisayarınız/);
  // Hook'lar yine yazıldı: Claude Code kurulunca veri akar.
  assert.ok(readJson(path.join(box.claude, "settings.json")).hooks.Stop);
});

// Hook'lar Claude Code açılırken okunur: kurulumdan önce açılmış pencereler veri
// göndermez. /join kurulumu (~/.usagex/collector) tek komutla kaldırılır.
test("tek satır kurulumu: açık pencereleri yeniden başlatma notu ve kaldırma komutu (TR/EN)", async (t) => {
  for (const [l, restart, hint, route] of [
    ["tr", "Açık Claude Code pencerelerini kapatıp yeniden açın.", "UsagEX'i bu bilgisayardan kaldırmak isterseniz: ", "kaldir"],
    ["en", "Close and reopen any open Claude Code windows.", "To remove UsagEX from this computer later, run: ", "uninstall"],
  ]) {
    const box = sandbox(t);
    box.root = path.join(box.home, ".usagex", "collector");
    const server = await fakeServer(t);
    const r = await runConnect(t, box, server, { lang: l });
    assert.equal(r.exit, 0, r.err.join("\n"));
    const at = (s) => r.out.indexOf(s);
    assert.ok(at(restart) > at(msg("connected", {}, l)), "not bağlantı mesajının hemen ardından");
    assert.equal(r.out.at(-1), `${hint}curl -fsSL ${server.url}/${route} | sh`, "sunucu adresi bağlantıdan gelir");
    assert.ok(!r.out.join("\n").includes("disconnect.js"));
  }
});

test("yeniden başlatma notu: Claude Code yoksa ya da plugin olarak kuruluysa basılmaz", async (t) => {
  const restart = msg("restart_claude", {}, "tr");
  const box = sandbox(t);
  fs.rmSync(box.claude, { recursive: true });
  let r = await runConnect(t, box, await fakeServer(t));
  assert.equal(r.exit, 0);
  assert.ok(!r.out.includes(restart), "Claude Code yok: claude_missing yeterli");
  const plug = sandbox(t);
  r = await runConnect(t, plug, await fakeServer(t), { extraEnv: { CLAUDE_PLUGIN_ROOT: plug.root } });
  assert.equal(r.exit, 0);
  assert.ok(!r.out.includes(restart));
});

test("uninstallCommand: yalnız ~/.usagex/collector kurulumunda, bağlantının sunucusuyla", () => {
  const { uninstallCommand } = require("../lib/runtime");
  const home = "/home/u";
  const root = "/home/u/.usagex/collector";
  assert.equal(uninstallCommand({ root, home, server: "https://usagex.dijitalpi.com/ingest" }), "curl -fsSL https://usagex.dijitalpi.com/kaldir | sh");
  assert.equal(uninstallCommand({ root, home, server: "https://usagex.dijitalpi.com", lang: "en" }), "curl -fsSL https://usagex.dijitalpi.com/uninstall | sh");
  assert.equal(uninstallCommand({ root: "/home/u/.claude/plugins/usagex", home, server: "https://x.test" }), null, "plugin");
  assert.equal(uninstallCommand({ root, home, server: "not a url" }), null);
  assert.equal(uninstallCommand({ root, home, server: "file:///etc" }), null);
});

for (const [status, key] of [[401, "code_invalid"], [410, "code_invalid"], [409, "code_invalid"], [429, "rate_limited"]]) {
  test(`sunucu ${status} → yerelleştirilmiş tek satır, hiçbir şey yazılmaz`, async (t) => {
    const box = sandbox(t);
    const server = await fakeServer(t, { status, body: { error: "x" } });
    for (const l of ["tr", "en"]) {
      const r = await runConnect(t, box, server, { lang: l });
      assert.equal(r.exit, 1);
      assert.deepEqual(r.err, [`✗ ${msg(key, {}, l)}`]);
    }
    assert.equal(fs.existsSync(path.join(box.claude, "usagex.json")), false);
    assert.equal(fs.existsSync(path.join(box.claude, "settings.json")), false);
  });
}

test("sunucuya ulaşılamazsa ağ mesajı", async (t) => {
  const box = sandbox(t);
  const c = capture();
  const exit = await connect("ABCD2345", {
    env: { USAGEX_SERVER_URL: "http://127.0.0.1:9/ingest", USAGEX_LANG: "tr" }, home: box.home, dir: box.claude, root: box.root,
    spawnImpl: stubSpawn(), out: c.o, err: c.e, fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(exit, 1);
  assert.match(c.err.join("\n"), /Sunucuya ulaşılamadı/);
});

test("geçersiz kod biçimi → kullanım mesajı, ağa çıkılmaz", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  const r = await runConnect(t, box, server, { code: "ABC" });
  assert.equal(r.exit, 1);
  assert.equal(server.requests.length, 0);
  assert.match(r.err.join("\n"), /8 karakterli kod/);
});

test("plugin olarak çalışırken standalone hook yazılmaz, node-path yazılır", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  const r = await runConnect(t, box, server, { extraEnv: { CLAUDE_PLUGIN_ROOT: box.root } });
  assert.equal(r.exit, 0, r.err.join("\n"));
  assert.equal(fs.existsSync(path.join(box.claude, "settings.json")), false);
  assert.ok(fs.existsSync(path.join(box.home, ".usagex", "node-path")));
});

test("geçmiş başlatılamazsa bağlantı yine başarılı, elle komut gösterilir", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  const r = await runConnect(t, box, server, { spawnImpl: () => { throw new Error("EAGAIN"); } });
  assert.equal(r.exit, 0);
  assert.match(r.out.join("\n"), /Geçmiş kullanım gönderimi başlatılamadı.*backfill\.js" 90/);
});

test("connect sonrası disconnect: hook'lar kalkar, token silinir, sunucu kaydı iptal edilir", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  fs.writeFileSync(path.join(box.claude, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/benim.js" }] }] } }));
  assert.equal((await runConnect(t, box, server)).exit, 0);
  const lines = [];
  await disconnect({ dir: box.claude, log: (m) => lines.push(m) });
  const s = readJson(path.join(box.claude, "settings.json"));
  assert.deepEqual(s.hooks, { Stop: [{ hooks: [{ type: "command", command: "node /x/benim.js" }] }] });
  const cfg = readJson(path.join(box.claude, "usagex.json"));
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.device_token, undefined);
  assert.ok(server.requests.some((q) => q.url === "/v1/devices/revoke"));
  const text = lines.join("\n");
  assert.match(text, /UsagEX, Claude Code ayarlarından kaldırıldı/);
  assert.match(text, /Bağlantı kesildi/);
  assert.doesNotMatch(text, /[{}]/);
});

test("CLI: connect.js sahte sunucuyla hemen çıkar, geçmiş log dosyasına yazılır", async (t) => {
  const box = sandbox(t);
  const server = await fakeServer(t);
  // Kurulum dizini gerçek collector; betiği ayrı süreçte koştur.
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "connect.js"), "abcd-2345"], {
    env: {
      PATH: process.env.PATH, HOME: box.home, USERPROFILE: box.home, CLAUDE_CONFIG_DIR: box.claude,
      USAGEX_SERVER_URL: `${server.url}/ingest`, USAGEX_LANG: "en", USAGEX_NODE: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const started = Date.now();
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, stderr);
  assert.ok(Date.now() - started < 10000, "connect geçmişi beklememeli");
  assert.match(stdout, /Your computer is connected/);
  assert.equal(stderr, "");
  assert.ok(fs.existsSync(path.join(box.home, ".usagex", "backfill.log")));
  assert.equal(fs.readFileSync(path.join(box.home, ".usagex", "node-path"), "utf8"), process.execPath + "\n");
  assert.match(readJson(path.join(box.claude, "settings.json")).hooks.Stop[0].hooks[0].command, /^sh ".*run-hook\.sh" heartbeat\.js$/);
});

test("CLI: install-hooks'un kurduğu komut run-hook.sh ile gerçekten çalışır", (t) => {
  const box = sandbox(t);
  // run-hook.sh kök dizini kendi konumundan bulur; heartbeat yerine bir stub koy.
  const root = path.join(box.base, "usagex app", "collector");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts", "run-hook.sh"), path.join(root, "scripts", "run-hook.sh"));
  fs.writeFileSync(path.join(root, "hooks", "heartbeat.js"), "process.stdout.write('hook-ran')");
  const { hookCommand } = require("../scripts/install-hooks");
  fs.mkdirSync(path.join(box.home, ".usagex"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".usagex", "node-path"), process.execPath + "\n");
  const r = spawnSync("sh", ["-c", hookCommand({ dir: root, file: "heartbeat.js", platform: "darwin" })], {
    encoding: "utf8", env: { HOME: box.home, PATH: "/usr/bin:/bin" },
  });
  assert.equal(r.stdout, "hook-ran", r.stderr);
});

// ── Codex ────────────────────────────────────────────────────────────────

function codexBox(t) {
  const box = sandbox(t);
  const codexHome = path.join(box.home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  return { ...box, codexHome, dir: path.join(codexHome, "usagex") };
}

async function runCodex(t, box, server, { l = "tr", platform = "darwin", installService, spawnImpl = stubSpawn(), body } = {}) {
  const { main } = require("../codex/connect");
  const c = capture();
  const services = [];
  const exit = await main("ABCD2345", {
    env: { USAGEX_SERVER_URL: server.url, USAGEX_LANG: l, USAGEX_NODE: "/opt/usagex/node/bin/node" },
    home: box.home, codexHome: box.codexHome, dir: box.dir, platform, fetchImpl: fetch, spawnImpl,
    installService: installService || ((o) => { services.push(o); return { installed: true, kind: "launchd", command: [o.node, o.script, "--watch"] }; }),
    out: c.o, err: c.e,
  });
  return { exit, ...c, services, spawnImpl };
}

test("Codex connect: servis USAGEX_NODE ile kurulur, ilk tarama ayrık başlar, JSON basılmaz", async (t) => {
  const box = codexBox(t);
  const server = await fakeServer(t, { body: { provider: "codex", device_token: "cx-1" } });
  const r = await runCodex(t, box, server);
  assert.equal(r.exit, 0, r.err.join("\n"));
  assert.equal(r.services.length, 1);
  assert.equal(r.services[0].node, "/opt/usagex/node/bin/node");
  assert.equal(r.services[0].codexHome, box.codexHome);
  assert.equal(readJson(path.join(box.dir, "usagex.json")).device_token, "cx-1");
  const call = r.spawnImpl.calls[0];
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.env.CODEX_HOME, box.codexHome);
  assert.match(call.args[0], /codex[\\/]collect\.js$/);
  assert.ok(fs.existsSync(path.join(box.home, ".usagex", "codex-collect.log")));
  const text = r.out.join("\n");
  assert.match(text, /✓ Codex bağlandı/);
  assert.doesNotMatch(text, /[{}]/);
});

test("Codex connect: /join kurulumunda kaldırma komutu; yeniden başlatma notu yok (oturum dosyaları okunur)", async (t) => {
  const box = codexBox(t);
  const server = await fakeServer(t, { body: { provider: "codex", device_token: "cx-1" } });
  const { main } = require("../codex/connect");
  const c = capture();
  const exit = await main("ABCD2345", {
    env: { USAGEX_SERVER_URL: server.url, USAGEX_LANG: "en", USAGEX_NODE: "/opt/usagex/node/bin/node" },
    home: box.home, codexHome: box.codexHome, dir: box.dir, platform: "darwin", fetchImpl: fetch, spawnImpl: stubSpawn(),
    installService: (o) => ({ installed: true, kind: "launchd", command: [o.node, o.script, "--watch"] }),
    root: path.join(box.home, ".usagex", "collector"), out: c.o, err: c.e,
  });
  assert.equal(exit, 0, c.err.join("\n"));
  assert.equal(c.out.at(-1), `To remove UsagEX from this computer later, run: curl -fsSL ${server.url}/uninstall | sh`);
  assert.ok(!c.out.some((s) => /Claude Code windows|reopen/.test(s)));
});

test("Codex connect: Linux'ta systemd yoksa tek satırlık yerelleştirilmiş not", async (t) => {
  const box = codexBox(t);
  const server = await fakeServer(t, { body: { provider: "codex", device_token: "cx-1" } });
  const { install } = require("../codex/service");
  const r = await runCodex(t, box, server, {
    l: "en", platform: "linux",
    installService: (o) => install({ ...o, run: () => ({ status: 1 }) }),
  });
  assert.equal(r.exit, 0);
  const note = r.out.find((s) => /Automatic updates are not available/.test(s));
  assert.ok(note, r.out.join("\n"));
  assert.match(note, /"\/opt\/usagex\/node\/bin\/node" ".*collect\.js" --watch$/);
  assert.doesNotMatch(note, /\n/);
});

test("Codex connect: Claude kodu ve süresi dolmuş kod yerelleştirilir", async (t) => {
  const box = codexBox(t);
  const wrong = await fakeServer(t, { body: { provider: "claude", device_token: "x" } });
  let r = await runCodex(t, box, wrong);
  assert.equal(r.exit, 1);
  assert.match(r.err.join("\n"), /Bu kod Codex için değil/);
  const expired = await fakeServer(t, { status: 410, body: {} });
  r = await runCodex(t, box, expired, { l: "en" });
  assert.equal(r.exit, 1);
  assert.match(r.err.join("\n"), /mistyped, expired or already used/);
  assert.equal(fs.existsSync(path.join(box.dir, "usagex.json")), false);
});

test("Codex service: LaunchAgent USAGEX_NODE yolunu kullanır", (t) => {
  const box = codexBox(t);
  const { definition } = require("../codex/service");
  const prev = process.env.USAGEX_NODE;
  process.env.USAGEX_NODE = "/opt/usagex/node/bin/node";
  t.after(() => { if (prev === undefined) delete process.env.USAGEX_NODE; else process.env.USAGEX_NODE = prev; });
  const def = definition({ platform: "darwin", home: box.home, codexHome: box.codexHome });
  assert.match(def.text, /<string>\/opt\/usagex\/node\/bin\/node<\/string>/);
  assert.doesNotMatch(def.text, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Codex service: Linux systemd service + timer metni ve kurulum komutları", (t) => {
  const box = codexBox(t);
  const { definition, install, uninstall } = require("../codex/service");
  const opts = { platform: "linux", home: box.home, codexHome: "/home/a b/.codex", node: "/home/a b/.usagex/node/bin/node", script: "/c/collect.js" };
  const def = definition(opts);
  const [svc, timer] = def.files;
  assert.equal(svc.file, path.join(box.home, ".config", "systemd", "user", "usagex-codex.service"));
  assert.equal(svc.text, '[Unit]\nDescription=UsagEX Codex usage scan\n\n[Service]\nType=oneshot\nEnvironment="CODEX_HOME=/home/a b/.codex"\nExecStart="/home/a b/.usagex/node/bin/node" "/c/collect.js"\n');
  assert.equal(timer.file, path.join(box.home, ".config", "systemd", "user", "usagex-codex.timer"));
  assert.match(timer.text, /OnUnitActiveSec=60/);
  assert.match(timer.text, /WantedBy=timers\.target/);

  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0 }; };
  const r = install({ ...opts, run });
  assert.deepEqual(r, { installed: true, kind: "systemd", command: [opts.node, opts.script, "--watch"] });
  assert.deepEqual(calls, ["systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable --now usagex-codex.timer"]);
  assert.ok(fs.existsSync(svc.file) && fs.existsSync(timer.file));

  calls.length = 0;
  assert.equal(uninstall({ ...opts, run }), true);
  assert.deepEqual(calls, ["systemctl --user disable --now usagex-codex.timer", "systemctl --user daemon-reload"]);
  assert.equal(fs.existsSync(svc.file) || fs.existsSync(timer.file), false);
});

test("Codex disconnect: servis kaldırılır, config ve durum silinir, mesaj yerelleştirilir", async (t) => {
  const box = codexBox(t);
  const { disconnect: codexDisconnect } = require("../codex/disconnect");
  const { install, uninstall } = require("../codex/service");
  const opts = { platform: "darwin", home: box.home, codexHome: box.codexHome, node: "/n", uid: 501, run: () => ({ status: 0 }) };
  install(opts);
  fs.mkdirSync(box.dir, { recursive: true });
  fs.writeFileSync(path.join(box.dir, "usagex.json"), JSON.stringify({ provider: "codex", consent_version: 1, enabled: true, device_token: "cx", ingest_url: "http://127.0.0.1:9/ingest" }));
  fs.writeFileSync(path.join(box.dir, "state.json"), "{}");
  const lines = [];
  const r = await codexDisconnect({ dir: box.dir, stop: () => uninstall(opts), log: (m) => lines.push(m), fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.stopped, true);
  assert.equal(fs.existsSync(path.join(box.home, "Library", "LaunchAgents", "com.dijitalpi.usagex.codex.plist")), false);
  assert.equal(fs.existsSync(path.join(box.dir, "state.json")), false);
  assert.equal(readJson(path.join(box.dir, "usagex.json")).device_token, undefined);
  const text = lines.join("\n");
  assert.match(text, /Otomatik güncelleme durduruldu/);
  assert.match(text, /Codex bağlantısı kesildi/);
  assert.doesNotMatch(text, /[{}]/);
});
