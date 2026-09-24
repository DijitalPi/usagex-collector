#!/usr/bin/env node
// connect.js <kod> — telefonda üretilen 8 karakterli eşleştirme kodunu kullanarak
// bu cihazı kullanıcının hesabına bağlar, Claude Code hook'larını kurar ve geçmişi
// arka planda gönderir. Mesaj dili USAGEX_LANG (tr|en), Node yolu USAGEX_NODE.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { claudeDir, readRawConfig, ingestUrlProblem } = require("../lib/config");
const { machineLabel } = require("../lib/payload");
const { nodeVersionProblem, MIN_MAJOR } = require("../lib/node-version");
const { msg, lang, UserError } = require("../lib/i18n");
const { usagexHome, writeNodePath, checkWritable, commandLine, spawnDetached } = require("../lib/runtime");
const { readSettings, installHooks } = require("./install-hooks");

const { withLock } = require("../lib/file-lock");

function platformName() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

// Bu kurulumun KARARLI kimliği. Sunucu cihazları hostname ile tekilleştiriyordu:
// "MacBook-Pro" adlı iki ayrı makine (ya da aynı makinedeki iki kullanıcı hesabı)
// aynı cihaz kaydını ve token'ı paylaşıyordu. Hostname + kullanıcı adı + platform
// + ev dizini birleşimi bunları ayırır; hash olduğu için hiçbiri düz metin gitmez.
// Ayırıcı NUL: hiçbir bileşende geçemez, dolayısıyla farklı bileşen dizilimleri
// aynı karışıma düşemez ("ab"+"c" ile "a"+"bc" ayrı kimlikler).
function machineId() {
  let kullanici = "";
  try { kullanici = os.userInfo().username || ""; } catch {}
  const ham = [os.hostname(), kullanici, process.platform, os.homedir()].join("\u0000");
  return crypto.createHash("sha256").update(ham).digest("hex").slice(0, 16);
}

// Mevcut gizlilik tercihi: yeniden bağlanmada makine adının hash'lenip
// hash'lenmeyeceğini de bu belirler (proje adlarıyla aynı anahtar).
// readRawConfig ile okunur — yalnız usagex.json'a bakmak, rebrand ÖNCESİ
// kurulumlarda (yalnız clmt.json var) send_project_names:false tercihini
// sessizce sıfırlıyordu: kullanıcı kod girer girmez proje ve makine adları
// açık gitmeye başlıyordu (R15). Arama sırası config.js ile AYNI.
function mevcutTercih(dir = claudeDir()) {
  const raw = readRawConfig(dir);
  const eski = raw && raw.cfg;
  return !(eski && eski.send_project_names === false);
}

function saveConnection(dir, config) {
  return withLock(path.join(dir, "usagex.config.lock"), () => {
    const cfgPath = path.join(dir, "usagex.json"), queue = path.join(dir, "usagex-queue.jsonl");
    withLock(queue + ".lock", () => {
      // Legacy lines lack an owner. Archive before enabling the new connection.
      for (const name of fs.readdirSync(dir)) {
        if (name === "usagex-queue.jsonl" || /^usagex-queue\.jsonl\.\d+\.\d+\.jsonl$/.test(name)) {
          fs.renameSync(path.join(dir, name), path.join(dir, `${name}.quarantine-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`));
        }
      }
      for (const suffix of [".blocked", ".authfail"]) { try { fs.unlinkSync(queue + suffix); } catch (e) { if (e.code !== "ENOENT") throw e; } }
      fs.writeFileSync(queue + ".owner", crypto.createHash("sha256").update(`${config.ingest_url}\0${config.device_token}`).digest("hex"), { mode: 0o600 });
    });
    const tmp = `${cfgPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, cfgPath);
    fs.chmodSync(cfgPath, 0o600);
  });
}

// Eşleştirme isteği. HTTP kodları kullanıcının GERÇEKTEN yapacağı işe çevrilir.
// Döner: parse edilmiş gövde; sorun varsa UserError fırlatır.
async function claim(pairUrl, body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(pairUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new UserError("network_error");
  }
  if (!res.ok) {
    const key = { 400: "code_format", 401: "code_invalid", 404: "code_invalid", 409: "code_invalid", 410: "code_invalid", 429: "rate_limited" }[res.status];
    if (key) throw new UserError(key);
    throw new UserError(res.status >= 500 ? "server_busy" : "server_error", { status: res.status });
  }
  try {
    return await res.json();
  } catch {
    throw new UserError("bad_response");
  }
}

// Plugin olarak çalışıyorsak hook'ları plugin'in hooks.json'ı taşır; standalone
// hook yazmak plugin'i devre dışı bırakır ve güncellemede değişen önbellek
// yoluna bağlanırdı.
function runningAsPlugin(root, env = process.env, dir = claudeDir()) {
  if (env.CLAUDE_PLUGIN_ROOT) return true;
  const rel = path.relative(path.join(dir, "plugins"), root);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

const parseCode = (arg) => String(arg || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

// Akış: ön kontrol → kodu harca → kaydet → hook'lar → geçmiş (arka planda) → mesaj.
// Döner: çıkış kodu (0 başarı, 1 hata). Yan etkiler enjekte edilebilir (test).
async function connect(argCode, {
  env = process.env,
  home = os.homedir(),
  dir = claudeDir(),
  root = path.resolve(__dirname, ".."),
  fetchImpl = globalThis.fetch,
  spawnImpl,
  out = (s) => console.log(s),
  err = (s) => console.error(s),
  hooks,
} = {}) {
  const t = (key, vars) => msg(key, vars, lang(env));
  const fail = (e) => {
    if (e instanceof UserError) err(`✗ ${t(e.key, e.vars)}`);
    else err(`✗ ${t("unexpected", { reason: (e && e.message) || e })}`);
    return 1;
  };

  if (nodeVersionProblem()) return fail(new UserError("node_too_old", { version: process.versions.node, min: MIN_MAJOR }));
  const code = parseCode(argCode);
  if (!/^[A-Z0-9]{8}$/.test(code)) { err(t("usage_claude")); return 1; }

  // 1. Ön kontrol: kod HARCANMADAN önce. Burada düşen hiçbir şeyi değiştirmez.
  const installHooksToo = hooks ?? !runningAsPlugin(root, env, dir);
  const claudeVar = fs.existsSync(dir);
  const uxDir = usagexHome(home);
  try {
    if (installHooksToo) readSettings(path.join(dir, "settings.json"));
    const w = checkWritable(uxDir);
    if (w) throw new UserError("dir_not_writable", { dir: uxDir });
  } catch (e) {
    fail(e);
    err(t("code_unused"));
    return 1;
  }

  const existingUrl = env.USAGEX_SERVER_URL || readRawConfig(dir)?.cfg?.ingest_url || "https://usagex.dijitalpi.com/ingest";
  if (ingestUrlProblem(existingUrl)) return fail(new UserError("server_url_invalid"));
  const pairUrl = new URL("/v1/pairing/claim", existingUrl).href;

  // Yeniden bağlanma mevcut GİZLİLİK tercihini SIFIRLAMAZ (bkz. mevcutTercih).
  const send_project_names = mevcutTercih(dir);

  // 2. Kodu harca.
  let data;
  try {
    data = await claim(pairUrl, {
      code,
      platform: platformName(),
      machine: machineLabel(send_project_names),
      // Cihaz tekilleştirme anahtarı (bkz. machineId).
      machine_id: machineId(),
    }, fetchImpl);
  } catch (e) { return fail(e); }
  const device_token = data && data.device_token;
  if (typeof device_token !== "string" || !device_token) return fail(new UserError("bad_response"));
  // ingest_url yalnızca https olmalı — aksi halde cihaz token'ı düz metin gidebilir.
  let ingest_url = new URL("/ingest", pairUrl).href;
  if (typeof data.ingest_url === "string" && /^https:\/\//i.test(data.ingest_url)) ingest_url = data.ingest_url;

  // 3. Kaydet.
  try {
    fs.mkdirSync(dir, { recursive: true });
    saveConnection(dir, { enabled: true, ingest_url, device_token, send_project_names });
  } catch (e) { return fail(new UserError("save_failed", { reason: (e && e.code) || (e && e.message) || e })); }

  // 4. Hook'lar (süreç içinde). Plugin kurulumunda yalnız node-path yazılır.
  const node = env.USAGEX_NODE && path.isAbsolute(env.USAGEX_NODE) ? env.USAGEX_NODE : process.execPath;
  try {
    if (installHooksToo) installHooks({ dir: root, claudeDir: dir, env, home });
    else writeNodePath({ env, home });
  } catch (e) {
    if (e instanceof UserError) return fail(new UserError("hooks_failed", { reason: t(e.key, e.vars) }));
    return fail(new UserError("hooks_failed", { reason: (e && e.message) || e }));
  }

  // 5. Geçmiş: son 90 gün, ARKA PLANDA. Terminal kapansa da sürer; ilerleme
  // ~/.usagex/backfill.log'a yazılır. session_id upsert, tekrar çalışsa da güvenli.
  const backfill = path.join(root, "scripts", "backfill.js");
  const bf = spawnDetached(process.execPath, [backfill, "90"], {
    log: path.join(uxDir, "backfill.log"), env, spawnImpl,
  });

  // 6. Sonuç.
  if (!send_project_names) out(t("privacy_kept"));
  out(t("connected"));
  if (!bf.started) out(t("history_not_started", { cmd: commandLine([node, backfill, "90"]) }));
  if (!claudeVar) out(t("claude_missing"));
  out(t("disconnect_hint", { cmd: commandLine([node, path.join(root, "scripts", "disconnect.js")]) }));
  return 0;
}

// require() ile çekildiğinde (test) çalışmasın.
if (require.main === module) {
  connect(process.argv[2]).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`✗ ${msg("unexpected", { reason: (e && e.message) || e })}`);
    process.exitCode = 1;
  });
}

module.exports = { machineId, platformName, mevcutTercih, saveConnection, connect, claim, runningAsPlugin, parseCode };
