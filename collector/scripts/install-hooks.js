#!/usr/bin/env node
// Standalone kurulum: collector'ı Claude Code'a bağlar (~/.claude/settings.json'a
// SessionStart/Stop/SessionEnd hook'larını ekler). Mevcut ayarları KORUR (merge),
// usagex hook'u zaten varsa yolunu günceller (çift eklemez).
// Kullanım: node install-hooks.js <collector-dizini> [--keep-transcripts]
// connect.js aynı işi installHooks() ile süreç içinde yapar.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { nodeVersionProblem, MIN_MAJOR } = require("../lib/node-version");
const { msg, UserError } = require("../lib/i18n");
const { writeNodePath, shQuote } = require("../lib/runtime");

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
      /(?:usagex|clmt)/i.test(h.command) &&
      HOOK_FILES.some((f) => h.command.includes(f))
  );
}

// settings.json OKUMA — burada "bozuksa sıfırdan başla" YAPILMAZ.
// Eski davranış veri kaybettiriyordu: JSONC yorumu ya da fazladan virgül içeren
// bir settings.json parse edilemeyince `settings = {}` ile boş sayılıyor, ÜZERİNE
// yazılıyor ve kullanıcının model/permissions/env/statusLine ayarları ile kendi
// hook'ları siliniyordu. Artık yalnız DOSYA YOK durumunda sıfırdan başlıyoruz;
// parse hatasında hiçbir şey yazmadan çıkıyoruz.
// Döner: { settings, raw } ya da UserError fırlatır. connect.js bunu kodu
// harcamadan ÖNCE (preflight) de çağırır.
function readSettings(settingsPath) {
  let raw = null;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    if (e && e.code !== "ENOENT") throw new UserError("settings_unreadable", { file: settingsPath, reason: e.code || e.message });
  }
  if (raw === null) return { settings: {}, raw: null };
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new UserError("settings_invalid", { file: settingsPath });
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new UserError("settings_not_object", { file: settingsPath });
  }
  return { settings, raw };
}

// Windows'ta Claude Code hook'u Git Bash ile çalıştırır; Git Bash kurulu
// değilse PowerShell ile (code.claude.com/docs/en/hooks-guide, "Git Bash on
// Windows, or PowerShell when Git Bash isn't installed"). Git Bash yolu
// CLAUDE_CODE_GIT_BASH_PATH ile de verilebilir (ortam ya da settings.json env).
function gitBashAvailable({ env = process.env, settings = {}, exists = fs.existsSync } = {}) {
  const adaylar = [env.CLAUDE_CODE_GIT_BASH_PATH, settings && settings.env && settings.env.CLAUDE_CODE_GIT_BASH_PATH];
  for (const kok of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")]) {
    if (kok) adaylar.push(path.win32.join(kok, "Git", "bin", "bash.exe"));
  }
  // PATH'teki git.exe (Git\cmd, Git\bin ya da Git\mingw64\bin) → Git\bin\bash.exe
  for (const d of String(env.PATH || env.Path || "").split(";").filter(Boolean)) {
    if (!exists(path.win32.join(d, "git.exe"))) continue;
    const ust = path.win32.dirname(d);
    adaylar.push(path.win32.join(ust, "bin", "bash.exe"), path.win32.join(path.win32.dirname(ust), "bin", "bash.exe"));
  }
  return adaylar.some((p) => typeof p === "string" && p && exists(p));
}

// Hook komutu.
// macOS/Linux: `sh "<dizin>/scripts/run-hook.sh" heartbeat.js`. run-hook.sh
// Node'u her çalışmada bulur (USAGEX_NODE, ~/.usagex/node-path, PATH, bilinen
// yerler); Homebrew/nvm ile Node güncellenince hook'lar sessizce ölmez.
// WINDOWS: yollar ileri bölüyle (Git Bash ters bölüyü kaçış sayar). Yolda boşluk
// ya da kabuk karakteri yoksa TIRNAKSIZ: bu biçim Git Bash'te de PowerShell'de
// de çalışır. Boşluk varsa ("C:/Users/Ada Lovelace/…") tek biçim ikisine birden
// uymaz: Git Bash varsa çift tırnak, yoksa PowerShell çağrı işleci (& '…').
// Eski `cmd /c ""C:\…""` biçimi Git Bash'te ters bölüleri yutuyordu.
const WIN_PLAIN = /^[\p{L}\p{N}_.:\/+-]+$/u;
function hookCommand({ dir, file, nodePath = process.execPath, platform = process.platform, gitBash }) {
  if (platform === "win32") {
    const fwd = (p) => String(p).replace(/\\/g, "/");
    const node = fwd(nodePath), script = fwd(path.win32.join(dir, "hooks", file));
    if (WIN_PLAIN.test(node) && WIN_PLAIN.test(script)) return `${node} ${script}`;
    // Git Bash çift tırnağında $ ve ` açılır: kaçışlanır.
    const bq = (p) => `"${p.replace(/[$`"]/g, "\\$&")}"`;
    if (gitBash ?? gitBashAvailable()) return `${bq(node)} ${bq(script)}`;
    const ps = (p) => `'${p.replace(/'/g, "''")}'`;
    return `& ${ps(node)} ${ps(script)}`;
  }
  return `sh ${shQuote(path.join(dir, "scripts", "run-hook.sh"))} ${file}`;
}

function mergeHooks(settings, opts) {
  // Standalone and marketplace hooks must not both own the same event.
  for (const key of Object.keys(settings.enabledPlugins || {})) {
    if (/^(usagex|clmt)@/i.test(key)) settings.enabledPlugins[key] = false;
  }
  settings.hooks = settings.hooks || {};
  for (const [evt, file] of Object.entries(EVENTS)) {
    settings.hooks[evt] = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
    // Eski usagex girişlerini temizle (yol değişmiş olabilir), sonra tazesini ekle
    settings.hooks[evt] = settings.hooks[evt]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isUsagexHook({ hooks: [h] })) }))
      .filter((g) => g.hooks.length);
    settings.hooks[evt].push({
      // timeout: hooks.json ile aynı bütçe (yavaş diskte yarıda kesilmesin).
      hooks: [{ type: "command", command: hookCommand({ ...opts, file }), timeout: 15 }],
    });
  }
  return settings;
}

// Süreç içi kurulum. Hata durumunda UserError fırlatır, settings.json'a
// dokunmaz. Döner: { settingsPath, backup, retention: "set"|"hint"|null, dirWarning }
function installHooks({
  dir,
  claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  keepTranscripts = false,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  nodePath,
} = {}) {
  const settingsPath = path.join(claudeDir, "settings.json");
  const { settings, raw } = readSettings(settingsPath);
  // Windows'ta hook doğrudan node'u çağırır; diğerlerinde run-hook.sh node-path'i okur.
  const node = writeNodePath({ env, home });
  const gitBash = platform === "win32" ? gitBashAvailable({ env, settings }) : undefined;
  mergeHooks(settings, { dir, platform, nodePath: nodePath || node, gitBash });

  // Transkript saklama: VARSAYILAN DOKUNMAMAK (disk + gizlilik). İsteyen
  // `--keep-transcripts` ile açar.
  let retention = null;
  if (settings.cleanupPeriodDays == null) {
    if (keepTranscripts) { settings.cleanupPeriodDays = 3650; retention = "set"; }
    else retention = "hint";
  }

  fs.mkdirSync(claudeDir, { recursive: true });

  // YEDEK: mevcut settings.json'ın aynısı, yazmadan hemen önce.
  let backup = null;
  if (raw !== null) {
    backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.writeFileSync(backup, raw, { mode: 0o600 });
    } catch (e) {
      throw new UserError("backup_failed", { reason: (e && e.code) || String(e) });
    }
  }

  // Atomik yazım (tmp + rename). 0600: diğer yerel kullanıcılar okumasın.
  const tmpPath = `${settingsPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new UserError("settings_write_failed", { file: settingsPath, reason: (e && e.message) || String(e) });
  }
  try { fs.chmodSync(settingsPath, 0o600); } catch {}
  return { settingsPath, backup, retention, dirWarning: !String(dir).toLowerCase().includes("usagex") };
}

function main() {
  // Sürüm kontrolü EN BAŞTA: hook'ları kurup sonra her oturumda sessizce
  // çökmelerini izlemektense burada bir kez söyleyelim.
  if (nodeVersionProblem()) {
    console.error(`✗ ${msg("node_too_old", { version: process.versions.node, min: MIN_MAJOR })}`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) || path.join(os.homedir(), ".usagex", "collector");
  let r;
  try {
    r = installHooks({ dir, keepTranscripts: args.includes("--keep-transcripts") });
  } catch (e) {
    console.error(`✗ ${e instanceof UserError ? msg(e.key, e.vars) : (e && e.message) || e}`);
    process.exit(1);
  }
  if (r.dirWarning) console.warn(msg("dir_signature_warning", { dir }));
  const lines = [msg("hooks_installed", { file: r.settingsPath })];
  if (r.backup) lines.push(msg("hooks_backup", { file: r.backup }));
  if (r.retention === "set") lines.push(msg("retention_set"));
  if (r.retention === "hint") lines.push(msg("retention_hint"));
  console.log(lines.join("\n"));
}

if (require.main === module) main();

module.exports = { installHooks, readSettings, hookCommand, gitBashAvailable, isUsagexHook, EVENTS };
