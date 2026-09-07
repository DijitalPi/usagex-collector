#!/usr/bin/env node
// Standalone kurulum: collector'ı Claude Code'a bağlar (~/.claude/settings.json'a
// SessionStart/Stop/SessionEnd hook'larını ekler). Mevcut ayarları KORUR (merge),
// usagex hook'u zaten varsa yolunu günceller (çift eklemez).
// Kullanım: node install-hooks.js <collector-dizini> [--keep-transcripts]
const fs = require("fs");
const path = require("path");
const os = require("os");
const { nodeVersionProblem } = require("../lib/node-version");

// Sürüm kontrolü EN BAŞTA: hook'ları kurup sonra her oturumda sessizce
// çökmelerini izlemektense burada bir kez söyleyelim.
const sürümSorunu = nodeVersionProblem();
if (sürümSorunu) {
  console.error(`✗ ${sürümSorunu}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const keepTranscripts = args.includes("--keep-transcripts");
const dir = args.find((a) => !a.startsWith("--")) || path.join(os.homedir(), ".usagex", "collector");
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const settingsPath = path.join(claudeDir, "settings.json");

const EVENTS = { SessionStart: "heartbeat.js", Stop: "heartbeat.js", SessionEnd: "session-end.js" };
const HOOK_FILES = ["heartbeat.js", "session-end.js"];

// Kendi hook'umuzu tanıma imzası DİZİN BAĞIMSIZ: "usagex" + hook dosya adı.
// Eskiden sabit ".usagex/collector/hooks" yolu aranıyordu; plugin olarak kurulunca
// (~/.claude/plugins/usagex/hooks/…) hiç eşleşmiyor, her kurulumda ikinci bir kopya
// ekleniyor ve hook'lar çift çalışıyordu. Eski yol da bu imzaya uyar (geriye uyumlu).
function isUsagexHook(group) {
  return (group.hooks || []).some(
    (h) =>
      typeof h.command === "string" &&
      h.command.toLowerCase().includes("usagex") &&
      HOOK_FILES.some((f) => h.command.includes(f))
  );
}

// settings.json OKUMA — burada "bozuksa sıfırdan başla" YAPILMAZ.
// Eski davranış veri kaybettiriyordu: JSONC yorumu ya da fazladan virgül içeren
// (Claude Code'un kendisi de kabul eder) bir settings.json parse edilemeyince
// `settings = {}` ile boş sayılıyor, ÜZERİNE yazılıyor ve kullanıcının
// model/permissions/env/statusLine ayarları ile kendi hook'ları siliniyordu —
// üstüne "✓ kuruldu" basılıyordu. Artık yalnız DOSYA YOK durumunda sıfırdan
// başlıyoruz; parse hatasında hiçbir şey yazmadan çıkıyoruz.
let settings = {};
let mevcutHam = null;
try {
  mevcutHam = fs.readFileSync(settingsPath, "utf8");
} catch (e) {
  if (e && e.code !== "ENOENT") {
    console.error(
      `✗ ${settingsPath} okunamadı (${e.code || e.message}). Kurulum yapılmadı — ` +
      "dosya izinlerini kontrol edip tekrar deneyin."
    );
    process.exit(1);
  }
}
if (mevcutHam !== null) {
  try {
    settings = JSON.parse(mevcutHam);
  } catch (e) {
    console.error(
      `✗ ${settingsPath} geçerli JSON değil: ${(e && e.message) || e}\n` +
      "  Kurulum DURDURULDU — üzerine yazsaydık mevcut ayarlarınız (model, permissions,\n" +
      "  env, statusLine, kendi hook'larınız) silinirdi.\n" +
      "  Dosyayı düzeltip (yorum satırı ve fazladan virgül JSON'da geçersizdir) tekrar çalıştırın."
    );
    process.exit(1);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    console.error(
      `✗ ${settingsPath} bir JSON nesnesi değil. Kurulum DURDURULDU (üzerine yazılmadı).`
    );
    process.exit(1);
  }
}

// Hook komutu. Yol boşluk içerebilir → her iki parça da tırnaklı.
// WINDOWS: cmd.exe, komut satırı tırnakla BAŞLIYORSA ilk ve son tırnağı kırpar;
// `"C:\...\node.exe" "C:\...\heartbeat.js"` böylece
// `C:\...\node.exe" "C:\...\heartbeat.js` haline gelip "komut bulunamadı" ile
// düşebiliyordu. Belgelenmiş çözüm, tamamını `cmd /c "…"` içine almak: dıştaki
// çift tırnak kırpılır, içerideki iki tırnaklı yol sağlam kalır.
function hookCommand(nodePath, scriptPath) {
  const düz = `"${nodePath}" "${scriptPath}"`;
  return process.platform === "win32" ? `cmd /c "${düz}"` : düz;
}

settings.hooks = settings.hooks || {};
for (const [evt, file] of Object.entries(EVENTS)) {
  settings.hooks[evt] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
  // Eski usagex girişlerini temizle (yol değişmiş olabilir), sonra tazesini ekle
  settings.hooks[evt] = settings.hooks[evt].filter((g) => !isUsagexHook(g));
  settings.hooks[evt].push({
    // `node` yerine KURULUM ANINDAKİ yorumlayıcının tam yolu: PATH'te node
    // olmayan kurulumlar (nvm/asdf/volta, launchd, GUI'den açılan Claude Code)
    // hook'u sessizce hiç çalıştıramıyordu. Yol boşluk içerebilir → tırnaklı.
    hooks: [{
      type: "command",
      command: hookCommand(process.execPath, path.join(dir, "hooks", file)),
      // hooks.json ile aynı bütçe — timeout yazılmazsa Claude Code'un varsayılanı
      // sürüme göre değişiyor ve yavaş diskte hook yarıda kesilebiliyordu.
      timeout: 15,
    }],
  });
}

// Transkript saklama: Claude Code varsayılan ~30 günde eski oturumları SİLİYOR.
// VARSAYILAN artık DOKUNMAMAK: kullanıcının diskindeki tüm konuşma geçmişini 10 yıl
// tutmaya zorlamak sessizce alınacak bir karar değil (disk + gizlilik).
// İsteyen `--keep-transcripts` ile açar.
let retentionMsg = "";
if (settings.cleanupPeriodDays == null) {
  if (keepTranscripts) {
    settings.cleanupPeriodDays = 3650;
    retentionMsg = "\n✓ Transkript saklama 10 yıla çıkarıldı (cleanupPeriodDays=3650) — raporlar uzun geçmiş biriktirir.";
  } else {
    retentionMsg =
      "\nℹ Claude Code eski transkriptleri ~30 günde siler; UsagEX raporu bundan eskisini gösteremez." +
      "\n  Saklamayı 10 yıla çıkarmak için: node install-hooks.js <dizin> --keep-transcripts" +
      "\n  (settings.json'daki cleanupPeriodDays'e DOKUNULMADI.)";
  }
}

if (!dir.toLowerCase().includes("usagex")) {
  console.warn(
    `⚠ Kurulum dizininde 'usagex' geçmiyor (${dir}) — hook'u tanıma imzası bu dizgiye dayanıyor.` +
    "\n  Sonraki kurulum eski girişi temizleyemeyebilir; dizini 'usagex' içeren bir yola taşı."
  );
}

fs.mkdirSync(claudeDir, { recursive: true });

// YEDEK: mevcut settings.json'ın aynısı, yazmadan hemen önce. Parse başarılı olsa
// bile birleştirmede beklenmeyen bir şey olursa kullanıcının geri dönecek bir
// kopyası olsun — bu dosya kişinin tüm Claude Code yapılandırmasını taşıyor.
let yedekMsg = "";
if (mevcutHam !== null) {
  const yedek = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.writeFileSync(yedek, mevcutHam, { mode: 0o600 });
    yedekMsg = `\nℹ Önceki ayarların yedeği: ${yedek}`;
  } catch (e) {
    console.error(
      `✗ Yedek alınamadı (${(e && e.code) || e}). Kurulum DURDURULDU — ` +
      "yedeksiz üzerine yazmıyoruz."
    );
    process.exit(1);
  }
}

// Atomik yazım (tmp + rename): yazarken kesilirse settings.json yarım kalmasın.
// 0600: settings.json artık cihaz kurulumunun izini taşıyor, diğer yerel kullanıcılar okumasın.
const tmpPath = `${settingsPath}.${process.pid}.tmp`;
try {
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, settingsPath);
} catch (e) {
  try { fs.unlinkSync(tmpPath); } catch {}
  console.error(`✗ ${settingsPath} yazılamadı: ${(e && e.message) || e}`);
  process.exit(1);
}
try { fs.chmodSync(settingsPath, 0o600); } catch {} // dosya zaten varsa da sıkılaştır
console.log(`✓ Claude Code hook'ları kuruldu (${settingsPath})${yedekMsg}${retentionMsg}`);
