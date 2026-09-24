const fs = require("fs");
const os = require("os");
const path = require("path");
const { withLock } = require("./file-lock");

// Claude Code'un kendi CLAUDE_CONFIG_DIR override'ını takip eder (testler de bunu kullanır)
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

const CONFIG_NAMES = ["usagex.json", "clmt.json"];

// Ham config: doğrulama YAPMAZ, yalnız dosyayı bulup okur. ping/disconnect gibi
// betikler "neden kullanılmıyor" diye açıklama basabilsin diye ayrıldı.
function readRawConfig(dir = claudeDir()) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    try {
      return { cfg: JSON.parse(fs.readFileSync(p, "utf8")), path: p };
    } catch {}
  }
  return null;
}

// Cihaz token'ı düz metin gitmesin: https zorunlu. Yerel geliştirme (localhost /
// 127.0.0.1 / ::1) hariç tutulur — orada trafik makineden çıkmıyor.
function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
function ingestUrlProblem(url) {
  if (typeof url !== "string" || !url) return "ingest_url yok";
  let u;
  try { u = new URL(url); } catch { return `ingest_url geçersiz bir URL: ${url}`; }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && isLocalHost(u.hostname)) return null;
  return `ingest_url https:// değil (${u.protocol}//${u.host}) — cihaz token'ı düz metin gider, gönderim reddedildi`;
}

// Config kullanılamıyorsa SEBEBİNİ döndürür, kullanılabiliyorsa null.
function configProblem(cfg) {
  if (!cfg) return "config dosyası yok ya da bozuk (~/.claude/usagex.json)";
  // auth_failed_at: sunucu 401/403 döndüğü için sender kendini kapattı (bkz. sender.js).
  // Bunu düz "enabled:false" diye raporlamak kullanıcıyı yanlış yere bakmaya
  // gönderiyordu — cihaz uygulamadan silinmiş olabilir, çözüm yeniden bağlanmak.
  if (cfg.enabled === false && cfg.auth_failed_at) {
    return `bağlantı sunucuda iptal edilmiş (${cfg.auth_failed_at}) — /usagex-connect ile yeniden bağlanın`;
  }
  if (cfg.enabled === false) return "config'te enabled:false";
  if (!cfg.device_token) return "device_token yok";
  return ingestUrlProblem(cfg.ingest_url);
}

// Cihaz token'ı sunucuda geçersiz (401/403): kendimizi kapat. Dosyayı SİLMİYORUZ —
// ingest_url ve gizlilik tercihi dursun, /usagex-connect tekrar bağlarken kullansın.
// Yazım atomik (tmp+rename): hook tam bu anda öldürülürse config yarım kalmasın.
function markAuthFailed(dir = claudeDir(), now = Date.now(), expectedToken) {
  return withLock(path.join(dir, "usagex.config.lock"), () => {
  const raw = readRawConfig(dir);
  if (!raw) return false;
  const cfg = raw.cfg || {};
  if (expectedToken && cfg.device_token !== expectedToken) return false;
  if (cfg.enabled === false && cfg.auth_failed_at) return false; // zaten işaretli
  cfg.enabled = false;
  cfg.auth_failed_at = new Date(now).toISOString();
  const tmp = `${raw.path}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, raw.path);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
  });
}

// ~/.claude/usagex.json — /usagex-connect (veya /usagex-setup) oluşturur.
// { enabled, ingest_url, device_token, send_project_names }
// Geriye uyumluluk: eski kurulumların clmt.json'ı da okunur (rebrand öncesi).
function loadConfig(dir = claudeDir()) {
  const raw = readRawConfig(dir);
  if (!raw || configProblem(raw.cfg)) return null;
  const cfg = raw.cfg;
  if (cfg.send_project_names === undefined) cfg.send_project_names = true;
  return cfg;
}

module.exports = {
  loadConfig, claudeDir, readRawConfig, configProblem, ingestUrlProblem, markAuthFailed,
};
