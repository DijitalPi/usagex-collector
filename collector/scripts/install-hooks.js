#!/usr/bin/env node
// Standalone kurulum: collector'ı Claude Code'a bağlar (~/.claude/settings.json'a
// SessionStart/Stop/SessionEnd hook'larını ekler). Mevcut ayarları KORUR (merge),
// usagex hook'u zaten varsa yolunu günceller (çift eklemez).
// Kullanım: node install-hooks.js <collector-dizini>
const fs = require("fs");
const path = require("path");
const os = require("os");

const dir = process.argv[2] || path.join(os.homedir(), ".usagex", "collector");
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const settingsPath = path.join(claudeDir, "settings.json");

const EVENTS = { SessionStart: "heartbeat.js", Stop: "heartbeat.js", SessionEnd: "session-end.js" };
const MARK = ".usagex/collector/hooks"; // bizim hook'ları tanımak için imza

function isUsagexHook(group) {
  return (group.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(MARK));
}

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (!settings || typeof settings !== "object") settings = {};
} catch { settings = {}; } // dosya yok/bozuk → sıfırdan (mevcut değilse zaten temiz)

settings.hooks = settings.hooks || {};
for (const [evt, file] of Object.entries(EVENTS)) {
  settings.hooks[evt] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
  // Eski usagex girişlerini temizle (yol değişmiş olabilir), sonra tazesini ekle
  settings.hooks[evt] = settings.hooks[evt].filter((g) => !isUsagexHook(g));
  settings.hooks[evt].push({
    hooks: [{ type: "command", command: `node "${path.join(dir, "hooks", file)}"` }],
  });
}

// Transkript saklama: Claude Code varsayılan ~30 günde eski oturumları SİLİYOR —
// raporların uzun geçmişi olsun diye saklamayı uzat (kullanıcı kendi değerini
// koyduysa DOKUNMA; istemezse settings.json'dan değiştirebilir).
let retentionMsg = "";
if (settings.cleanupPeriodDays == null) {
  settings.cleanupPeriodDays = 3650;
  retentionMsg = "\n✓ Transkript saklama 10 yıla çıkarıldı (cleanupPeriodDays) — raporlar artık uzun geçmiş biriktirir.";
}

fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(`✓ Claude Code hook'ları kuruldu (${settingsPath})${retentionMsg}`);
