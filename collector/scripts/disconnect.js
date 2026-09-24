#!/usr/bin/env node
// /usagex-disconnect — bu bilgisayarın bağlantısını kes. install-hooks.js'in tersi.
// Yaptıkları (SIRA ÖNEMLİ):
//   1. sunucudaki cihaz kaydını sil (POST /v1/devices/revoke, cihaz token'ıyla)
//   2. usagex.json (ve eski clmt.json) içinde enabled:false
//   3. kuyruk / throttle state / limit cache dosyalarını sil
//   4. settings.json'daki usagex hook'larını kaldır
// (1) neden ÖNCE: iptal isteği cihaz token'ıyla kimliklenir; yerel temizlik önce
// koşarsa token'ı hâlâ okuyabilirdik ama kullanıcıya "yerel temizlik bitti, ağ
// kısmı hâlâ sürüyor" gibi yarım bir durum göstermek gerekirdi. Ayrıca ağ hatası
// yerel temizliği ASLA durdurmaz: kullanıcının asıl isteği "veri göndermeyi kes".
const fs = require("fs");
const { withLock } = require("../lib/file-lock");
const path = require("path");
const { claudeDir, readRawConfig, ingestUrlProblem } = require("../lib/config");
const { msg } = require("../lib/i18n");

const REVOKE_TIMEOUT_MS = 5000;
const REVOKE_UYARI = (reason) => msg("revoke_failed", { reason });

const CONFIG_NAMES = ["usagex.json", "clmt.json"];
// install-hooks.js ile AYNI imza — orada değişirse burada da değişmeli.
const HOOK_FILES = ["heartbeat.js", "session-end.js"];
const EVENTS = ["SessionStart", "Stop", "SessionEnd"];

function isUsagexHook(group) {
  return ((group && group.hooks) || []).some(
    (h) =>
      typeof h.command === "string" &&
      /(?:usagex|clmt)/i.test(h.command) &&
      HOOK_FILES.some((f) => h.command.includes(f))
  );
}

// İptal ucu ingest_url ile AYNI sunucuda: self-host kurulumda iptal de oraya
// gitmeli, sabit dijitalpi.com adresine değil.
function revokeUrl(ingestUrl) {
  try {
    return `${new URL(ingestUrl).origin}/v1/devices/revoke`;
  } catch {
    return null;
  }
}

// POST /v1/devices/revoke — gövde yok, kimlik `Authorization: Bearer <device_token>`.
// 200 → silindi · 401 → sunucuda zaten yok (ikisi de başarı sayılır).
// Döner: "silindi" | "zaten-yok" | "atlandi" | "hata"
async function revokeDevice({ dir, log, fetchImpl }) {
  const raw = readRawConfig(dir);
  const cfg = raw && raw.cfg;
  if (!cfg || !cfg.device_token) return "atlandi"; // hiç bağlanmamış — söylenecek bir şey yok

  // Token'ı düz metin göndermeyelim: ingest ile aynı https kuralı.
  const sorun = ingestUrlProblem(cfg.ingest_url);
  const url = sorun ? null : revokeUrl(cfg.ingest_url);
  if (!url) {
    log(REVOKE_UYARI(sorun || "ingest_url"));
    return "hata";
  }

  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) {
    log(REVOKE_UYARI("Node 18+"));
    return "hata";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  try {
    const res = await f(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.device_token}` },
      signal: controller.signal,
    });
    if (res && res.ok) {
      log(msg("revoke_ok"));
      return "silindi";
    }
    if (res && res.status === 401) {
      log(msg("revoke_gone"));
      return "zaten-yok";
    }
    log(REVOKE_UYARI(`HTTP ${(res && res.status) || "?"}`));
    return "hata";
  } catch (e) {
    // Ağ yok / timeout / DNS — kullanıcı çevrimdışıyken de bağlantıyı kesebilmeli.
    log(REVOKE_UYARI((e && e.message) || e));
    return "hata";
  } finally {
    clearTimeout(timer);
  }
}

// Disable atomically and remove the device credential, preserving privacy preferences.
function disableConfigs(dir, log) {
  return withLock(path.join(dir, "usagex.config.lock"), () => {
  let bulundu = false, yazildi = false;
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    bulundu = true;
    cfg.enabled = false;
    delete cfg.device_token;
    try {
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
      yazildi = true;
    } catch (e) {
      log(msg("config_write_failed", { file: p, reason: (e && e.message) || e }));
    }
  }
  if (!bulundu) log(msg("not_connected"));
  else if (yazildi) log(msg("config_disabled"));
  return bulundu;
  });
}

function removeStateFiles(dir, log) {
  const hedefler = [
    "usagex-queue.jsonl",
    "usagex-queue.jsonl.blocked",
    "usagex-state.json",
    "usagex-usage-cache.json",
    "usagex-subagent-cache.json",
    // Rebrand ÖNCESİ (CLMT) artıkları: bağlantı kesilince bunlar diskte kalıyor,
    // kuyruk dosyası da eski oturum/proje adlarını taşımaya devam ediyordu.
    "clmt-queue.jsonl",
    "clmt-queue.jsonl.blocked",
    "clmt-state.json",
    "clmt-usage-cache.json",
  ];
  let n = 0;
  for (const name of hedefler) {
    const p = path.join(dir, name);
    try {
      fs.unlinkSync(p);
      n++;
    } catch {} // yoksa sorun değil
  }
  // Yarıda kalmış flush dosyaları (<kuyruk>.inflight.<pid>) da gitsin.
  try {
    for (const ad of fs.readdirSync(dir)) {
      if (!/^(usagex|clmt)-(queue\.jsonl|state\.json|usage-cache\.json|subagent-cache\.json)(\.|$)/.test(ad) && !/^(usagex|clmt)\.json\.bak-/.test(ad)) continue;
      try { fs.rmSync(path.join(dir, ad), { recursive: true, force: true }); n++; } catch {}
    }
  } catch {}
  try { fs.rmSync(path.join(dir, "usagex-message-owners"), { recursive: true, force: true }); } catch {}
  if (n > 0) log(msg("local_data_removed"));
}

function removeHooks(dir, log) {
  const p = path.join(dir, "settings.json");
  let settings;
  try { settings = JSON.parse(fs.readFileSync(p, "utf8")); } catch {
    return 0;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return 0;
  settings.hooks ||= {};
  let kaldirilan = 0;
  for (const key of Object.keys(settings.enabledPlugins || {})) {
    if (/^(usagex|clmt)@/i.test(key) && settings.enabledPlugins[key]) { settings.enabledPlugins[key] = false; kaldirilan++; }
  }
  for (const evt of EVENTS) {
    if (!Array.isArray(settings.hooks[evt])) continue;
    const once = settings.hooks[evt].length;
    settings.hooks[evt] = settings.hooks[evt].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isUsagexHook({ hooks: [h] })) })).filter(g => g.hooks.length);
    kaldirilan += once - settings.hooks[evt].length;
    if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (kaldirilan === 0) return 0;
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    log(msg("hooks_removed"));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    log(msg("config_write_failed", { file: p, reason: (e && e.message) || e }));
    return 0;
  }
  return kaldirilan;
  // cleanupPeriodDays'e DOKUNMUYORUZ: kullanıcının transkriptlerini silmek bizim
  // işimiz değil. Eski değerine dönmek isteyen settings.json'dan kendisi değiştirir.
}

// ASENKRON: sunucudaki kaydı silmek için ağa çıkıyoruz. Ağ başarısız olsa bile
// yerel temizlik yapılır ve dönüş değeri (config var mıydı) değişmez.
async function disconnect({ dir = claudeDir(), log = console.log, fetchImpl } = {}) {
  const sunucu = await revokeDevice({ dir, log, fetchImpl });
  const vardi = disableConfigs(dir, log);
  removeStateFiles(dir, log);
  removeHooks(dir, log);
  log("");
  log(msg("disconnected"));
  // Yalnız GERÇEKTEN silinemediyse kullanıcıyı ek bir işe yönlendir.
  if (sunucu === "hata") log(msg("revoke_manual"));
  log(msg("history_kept"));
  log(msg("reconnect"));
  return vardi;
}

if (require.main === module) {
  // Varsa arka plan yoklayıcısını da kaldır (scripts/service.js). Yalnız CLI'da:
  // testler gerçek LaunchAgent'lara dokunmasın.
  try { require("./service").uninstall(); } catch {}
  disconnect().catch((e) => {
    console.error(`✗ ${msg("unexpected", { reason: (e && e.message) || e })}`);
    process.exit(1);
  });
}

module.exports = { disconnect, isUsagexHook, revokeUrl, revokeDevice, disableConfigs, removeStateFiles };
