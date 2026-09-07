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
const path = require("path");
const { claudeDir, readRawConfig, ingestUrlProblem } = require("../lib/config");

const REVOKE_TIMEOUT_MS = 5000;
const REVOKE_UYARI =
  "✗ Sunucudaki kayıt silinemedi — uygulamanın Ayarlar ekranından silin.";

const CONFIG_NAMES = ["usagex.json", "clmt.json"];
// install-hooks.js ile AYNI imza — orada değişirse burada da değişmeli.
const HOOK_FILES = ["heartbeat.js", "session-end.js"];
const EVENTS = ["SessionStart", "Stop", "SessionEnd"];

function isUsagexHook(group) {
  return ((group && group.hooks) || []).some(
    (h) =>
      typeof h.command === "string" &&
      h.command.toLowerCase().includes("usagex") &&
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
    log(`${REVOKE_UYARI} (${sorun || "ingest_url çözümlenemedi"})`);
    return "hata";
  }

  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) {
    log(`${REVOKE_UYARI} (bu Node sürümünde fetch yok — Node 18+ gerekir)`);
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
      log("✓ Sunucudaki cihaz kaydı silindi.");
      return "silindi";
    }
    if (res && res.status === 401) {
      log("· Sunucuda bu bilgisayarın kaydı zaten yoktu.");
      return "zaten-yok";
    }
    log(`${REVOKE_UYARI} (HTTP ${(res && res.status) || "?"})`);
    return "hata";
  } catch (e) {
    // Ağ yok / timeout / DNS — kullanıcı çevrimdışıyken de bağlantıyı kesebilmeli.
    log(`${REVOKE_UYARI} (${(e && e.message) || e})`);
    return "hata";
  } finally {
    clearTimeout(timer);
  }
}

// enabled:false — dosyayı SİLMİYORUZ ki tekrar bağlanınca token/tercihler dursun.
function disableConfigs(dir, log) {
  let bulundu = false;
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    bulundu = true;
    cfg.enabled = false;
    try {
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      log(`✓ ${p} → enabled:false`);
    } catch (e) {
      log(`✗ ${p} yazılamadı: ${(e && e.message) || e}`);
    }
  }
  if (!bulundu) log("· Config dosyası zaten yok — bağlanmamış görünüyor.");
  return bulundu;
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
      log(`✓ silindi: ${p}`);
      n++;
    } catch {} // yoksa sorun değil
  }
  // Yarıda kalmış flush dosyaları (<kuyruk>.inflight.<pid>) da gitsin.
  try {
    for (const ad of fs.readdirSync(dir)) {
      if (!/^(usagex|clmt)-queue\.jsonl\.inflight\./.test(ad)) continue;
      try { fs.unlinkSync(path.join(dir, ad)); log(`✓ silindi: ${path.join(dir, ad)}`); n++; } catch {}
    }
  } catch {}
  if (n === 0) log("· Silinecek kuyruk/state/cache dosyası yoktu.");
}

function removeHooks(dir, log) {
  const p = path.join(dir, "settings.json");
  let settings;
  try { settings = JSON.parse(fs.readFileSync(p, "utf8")); } catch {
    log("· settings.json yok/bozuk — hook temizliği atlandı.");
    return;
  }
  if (!settings || typeof settings !== "object" || !settings.hooks) {
    log("· settings.json'da hook yok.");
    return;
  }
  let kaldirilan = 0;
  for (const evt of EVENTS) {
    if (!Array.isArray(settings.hooks[evt])) continue;
    const once = settings.hooks[evt].length;
    settings.hooks[evt] = settings.hooks[evt].filter((g) => !isUsagexHook(g));
    kaldirilan += once - settings.hooks[evt].length;
    if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (kaldirilan === 0) {
    log("· settings.json'da usagex hook'u bulunmadı.");
    return;
  }
  try {
    fs.writeFileSync(p, JSON.stringify(settings, null, 2), { mode: 0o600 });
    log(`✓ ${kaldirilan} usagex hook'u kaldırıldı (${p})`);
  } catch (e) {
    log(`✗ ${p} yazılamadı: ${(e && e.message) || e}`);
  }
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
  log("Bilgisayar bağlantısı kesildi. Bundan sonra hiçbir veri gönderilmeyecek.");
  if (sunucu === "hata") {
    // Yalnız GERÇEKTEN silinemediyse kullanıcıyı ek bir işe yönlendir.
    log("Sunucudaki cihaz kaydı silinemedi. Elle silmek için:");
    log("  UsagEX uygulaması → Ayarlar → Bağlı bilgisayarlar → bu bilgisayarı sil.");
  }
  log("Geçmiş oturum istatistiklerin hesabında KALIR; tamamını silmek için");
  log("  uygulamada Ayarlar → Hesap → Hesabı sil.");
  log("Tekrar bağlanmak için: /usagex-connect <8-karakterli-kod>");
  return vardi;
}

if (require.main === module) {
  disconnect().catch((e) => {
    console.error(`Beklenmeyen hata: ${(e && e.message) || e}`);
    process.exit(1);
  });
}

module.exports = { disconnect, isUsagexHook, revokeUrl };
