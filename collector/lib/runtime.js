// Kurulum ortamı yardımcıları: hangi Node yorumlayıcısı kullanılacak,
// ~/.usagex/node-path, arka plan işleri ve kabuk tırnaklama.
require("./win-fs"); // Windows: dosya kilidinde rename yeniden dener
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const usagexHome = (home = os.homedir()) => path.join(home, ".usagex");

// Kurulum betiği USAGEX_NODE'u, Homebrew/nvm sürüm klasörüne ÇÖZÜLMEMİŞ yolla
// verir (Node güncellemesinde de geçerli kalsın). Yoksa kayıtlı node-path,
// o da yoksa şu an çalışan yorumlayıcı.
function resolveNode({ env = process.env, home = os.homedir() } = {}) {
  if (env.USAGEX_NODE && path.isAbsolute(env.USAGEX_NODE)) return env.USAGEX_NODE;
  try {
    const saved = fs.readFileSync(path.join(usagexHome(home), "node-path"), "utf8").split(/\r?\n/)[0].trim();
    if (saved && path.isAbsolute(saved) && fs.existsSync(saved)) return saved;
  } catch {}
  return process.execPath;
}

// run-hook.sh ve servisler bu dosyayı okur. Yalnız USAGEX_NODE ya da çalışan
// yorumlayıcı yazılır (kayıtlı dosyanın kendisini yeniden yazmak anlamsız).
function writeNodePath({ env = process.env, home = os.homedir() } = {}) {
  const node = env.USAGEX_NODE && path.isAbsolute(env.USAGEX_NODE) ? env.USAGEX_NODE : process.execPath;
  const dir = usagexHome(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "node-path");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, node + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return node;
}

// Tek satırlık kurulumun (/join → ~/.usagex/collector) kaldırma komutu. Sunucu
// adresi bağlantının kendisinden gelir (self-host kurulum kendi sunucusunu
// gösterir). Plugin ya da geliştirme kopyasında null: onlar kendi disconnect
// betiğini kullanır, ~/.usagex'i silmek onları kaldırmaz.
// Windows'ta aynı iş PowerShell betiğiyle: irm …/kaldir.ps1 | iex.
function uninstallCommand({ root, home = os.homedir(), server, lang = "tr", platform = process.platform } = {}) {
  if (!root || path.resolve(root) !== path.join(usagexHome(home), "collector")) return null;
  let origin;
  try { origin = new URL(server).origin; } catch { return null; }
  if (!/^https?:\/\//.test(origin)) return null;
  const route = lang === "en" ? "uninstall" : "kaldir";
  if (platform === "win32") return `irm ${origin}/${route}.ps1 | iex`;
  return `curl -fsSL ${origin}/${route} | sh`;
}

// ~/.usagex yazılabilir mi? Kod harcanmadan önce sorulur.
function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    return (e && e.code) || String(e);
  }
}

// POSIX kabuk argümanı. Güvenli karakterlerden oluşan yol çift tırnakla
// (okunaklı, boşluk sorun değil); $ ` \ " ! içeren yol tek tırnakla.
function shQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_\/.,:@%+=~ -]*$/.test(s)) return `"${s}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Kullanıcıya gösterilecek komut satırı: node ve betik tırnaklı.
// Windows'ta kullanıcı PowerShell'dedir: tırnaklı yol çağrı işleciyle (& '…')
// çalışır; tek tırnak içinde $ ve ` açılmaz.
function commandLine(parts, platform = process.platform) {
  if (platform === "win32") {
    const ps = (p) => `'${String(p).replace(/'/g, "''")}'`;
    return "& " + parts.map((p, i) => (i === 0 || p.includes("/") || p.includes("\\") || /\s/.test(p) ? ps(p) : p)).join(" ");
  }
  return parts.map((p, i) => (i === 0 || p.includes("/") || p.includes("\\") || /\s/.test(p) ? shQuote(p) : p)).join(" ");
}

// Terminal kapansa da süren arka plan işi. Çıktı log dosyasına eklenir.
// spawnImpl testte değiştirilir; dönüş: { started, log }.
function spawnDetached(node, args, { log, env = process.env, spawnImpl = spawn } = {}) {
  let fd;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    fd = fs.openSync(log, "a", 0o600);
    const child = spawnImpl(node, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
      windowsHide: true,
    });
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return { started: true, log };
  } catch {
    return { started: false, log };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

module.exports = { usagexHome, resolveNode, writeNodePath, checkWritable, shQuote, commandLine, spawnDetached, uninstallCommand };
