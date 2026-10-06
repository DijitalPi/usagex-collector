// Windows desteği: hook komutu (Git Bash ve PowerShell), Git Bash algılama,
// Görev Zamanlayıcı görevi (XML + gizli başlatıcı), Codex ve Claude servisleri,
// PowerShell komut gösterimi ve rename yeniden denemesi.
// Testler macOS/Linux'ta da koşar: Windows davranışı `platform: "win32"` ile
// seçilir, schtasks çağrıları sahte `run` ile yakalanır. Bash ve (varsa) pwsh
// ile üretilen komut gerçekten çalıştırılır.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-win-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const which = (cmd) => {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const PWSH = process.env.USAGEX_TEST_PWSH || which("pwsh");

// ── hook komutu ──────────────────────────────────────────────────────────
test("Windows hook: boşluksuz yol tırnaksız ve ileri bölülü (Türkçe karakter dahil)", () => {
  const { hookCommand } = require("../scripts/install-hooks");
  const cmd = hookCommand({ dir: "C:\\Users\\Çağrı\\.usagex\\collector", file: "heartbeat.js", platform: "win32",
    nodePath: "C:\\Users\\Çağrı\\.usagex\\node\\node.exe", gitBash: false });
  assert.equal(cmd, "C:/Users/Çağrı/.usagex/node/node.exe C:/Users/Çağrı/.usagex/collector/hooks/heartbeat.js");
  assert.doesNotMatch(cmd, /\\/);
});

test("Windows hook: boşluklu yol Git Bash'te çift tırnak, $ ve ` kaçışlı; bash tek argüman görür", () => {
  const { hookCommand } = require("../scripts/install-hooks");
  const cmd = hookCommand({ dir: "C:\\Users\\Ada $L`x\\.usagex\\collector", file: "session-end.js", platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe", gitBash: true });
  assert.equal(cmd, '"C:/Program Files/nodejs/node.exe" "C:/Users/Ada \\$L\\`x/.usagex/collector/hooks/session-end.js"');
  // Gerçek bash: ilk kelimeyi printf ile değiştir, argümanları say.
  const r = spawnSync("bash", ["-c", cmd.replace(/^"[^"]*"/, "printf '%s|'")], { encoding: "utf8" });
  assert.equal(r.stdout, "C:/Users/Ada $L`x/.usagex/collector/hooks/session-end.js|");
});

test("Windows hook: Git Bash yoksa PowerShell çağrı işleci, tek tırnak kaçışlı", { skip: !PWSH && "pwsh yok" }, (t) => {
  const { hookCommand } = require("../scripts/install-hooks");
  const cmd = hookCommand({ dir: "C:\\Users\\O'Neil Ada\\.usagex\\collector", file: "heartbeat.js", platform: "win32",
    nodePath: "C:\\Users\\O'Neil Ada\\.usagex\\node\\node.exe", gitBash: false });
  assert.equal(cmd, "& 'C:/Users/O''Neil Ada/.usagex/node/node.exe' 'C:/Users/O''Neil Ada/.usagex/collector/hooks/heartbeat.js'");
  // PowerShell gerçekten ayrıştırıp çağırır: node yerine echo koy.
  const echo = cmd.replace(/^& '[^']*(?:''[^']*)*'/, "& '/bin/echo'");
  const r = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", echo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "C:/Users/O'Neil Ada/.usagex/collector/hooks/heartbeat.js");
});

test("Windows hook: tırnaksız biçim PowerShell'de de komut olarak çalışır", { skip: !PWSH && "pwsh yok" }, () => {
  const r = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", "/bin/echo C:/Users/Çağrı/.usagex/collector/hooks/heartbeat.js"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "C:/Users/Çağrı/.usagex/collector/hooks/heartbeat.js");
});

test("Git Bash algılama: ayar, ortam, Program Files ve PATH'teki git", () => {
  const { gitBashAvailable } = require("../scripts/install-hooks");
  const var_ = (list) => (p) => list.includes(p);
  assert.equal(gitBashAvailable({ env: {}, exists: var_([]) }), false);
  assert.equal(gitBashAvailable({ env: { CLAUDE_CODE_GIT_BASH_PATH: "D:\\Git\\bin\\bash.exe" }, exists: var_(["D:\\Git\\bin\\bash.exe"]) }), true);
  assert.equal(gitBashAvailable({ env: {}, settings: { env: { CLAUDE_CODE_GIT_BASH_PATH: "E:\\g\\bash.exe" } }, exists: var_(["E:\\g\\bash.exe"]) }), true);
  assert.equal(gitBashAvailable({ env: { ProgramFiles: "C:\\Program Files" }, exists: var_(["C:\\Program Files\\Git\\bin\\bash.exe"]) }), true);
  assert.equal(gitBashAvailable({ env: { PATH: "C:\\Windows;D:\\Tools\\Git\\cmd" },
    exists: var_(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"]) }), true);
  assert.equal(gitBashAvailable({ env: { PATH: "D:\\G\\mingw64\\bin" }, exists: var_(["D:\\G\\mingw64\\bin\\git.exe", "D:\\G\\bin\\bash.exe"]) }), true);
});

test("installHooks win32: settings.json'a tırnaksız, ileri bölülü komut yazar; imzası tanınır", (t) => {
  const dir = tmp(t);
  const { installHooks, isUsagexHook } = require("../scripts/install-hooks");
  const claudeDir = path.join(dir, ".claude");
  installHooks({ dir: "C:\\Users\\ada\\.usagex\\collector", claudeDir, platform: "win32", home: dir,
    env: { USAGEX_NODE: "C:\\Users\\ada\\.usagex\\node\\node.exe" }, nodePath: "C:\\Users\\ada\\.usagex\\node\\node.exe" });
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  const cmd = settings.hooks.Stop[0].hooks[0].command;
  assert.equal(cmd, "C:/Users/ada/.usagex/node/node.exe C:/Users/ada/.usagex/collector/hooks/heartbeat.js");
  assert.ok(isUsagexHook(settings.hooks.Stop[0]));
});

// ── Görev Zamanlayıcı ────────────────────────────────────────────────────
test("win-task: başlatıcı yalnız ASCII, node'u gizli pencereyle başlatır, ortamı argümanla verir", () => {
  const { launcherScript } = require("../lib/win-task");
  const js = launcherScript({ node: "C:\\Users\\Çağrı Y\\.usagex\\node\\node.exe", script: "C:\\Users\\Çağrı Y\\.usagex\\collector\\codex\\collect.js",
    env: { CODEX_HOME: "C:\\Users\\Çağrı Y\\.codex\\", EMPTY: "" } });
  assert.match(js, /^[\x00-\x7f]*$/, "WSH betiği ASCII olmalı");
  assert.match(js, /new ActiveXObject\("WScript\.Shell"\)/);
  assert.doesNotMatch(js, /Environment|EMPTY/, "ortama atama yok");
  assert.match(js, /shell\.Run\(".*", 0, false\);/, "pencere stili 0 (gizli), beklemeden");
  // JScript sözdizimi JS ile uyumlu: ayrıştırılabilir ve komut dizesi doğru çözülür.
  let ran = null;
  new Function("ActiveXObject", js)(function () { return { Run: (c, w, b) => { ran = [c, w, b]; } }; });
  assert.deepEqual(ran, ['"C:\\Users\\Çağrı Y\\.usagex\\node\\node.exe" "C:\\Users\\Çağrı Y\\.usagex\\collector\\codex\\collect.js" "--env=CODEX_HOME=C:\\Users\\Çağrı Y\\.codex\\\\"', 0, false]);
});

test("win-task: winArg Windows komut satırı kuralı (sondaki ters bölü ikilenir)", () => {
  const { winArg } = require("../lib/win-task");
  assert.equal(winArg("C:\\a\\node.exe"), "C:\\a\\node.exe");
  assert.equal(winArg("C:\\a b\\"), '"C:\\a b\\\\"');
  assert.equal(winArg("x=y"), '"x=y"');
  assert.equal(winArg(""), '""');
  assert.throws(() => winArg('a"b'));
});

test("--env argümanı ortama yazılır (yalnız bilinen adlar), betikler en başta çağırır", () => {
  const { applyEnvArgs } = require("../lib/task-env");
  const env = applyEnvArgs(["--env=CODEX_HOME=C:\\c x\\", "--env=PATH=bad", "--env=CLAUDE_CONFIG_DIR=D:\\cc", "--once"], {});
  assert.deepEqual(env, { CODEX_HOME: "C:\\c x\\", CLAUDE_CONFIG_DIR: "D:\\cc" });
  for (const f of ["codex/collect.js", "scripts/poll.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const call = src.search(/require\(["']\.\.\/lib\/task-env["']\)\.applyEnvArgs\(\)/);
    const firstOther = src.search(/require\(["'](?!\.\.\/lib\/task-env)/);
    assert.ok(call >= 0 && call < firstOther, `${f}: ortam diğer modüllerden önce`);
  }
});

test("win-task: görev XML'i pilde çalışır, tek örnek, wscript tam yolu, UTF-16 BOM", () => {
  const { taskXml, utf16, FOLDER } = require("../lib/win-task");
  const xml = taskXml({ name: "Codex", description: "UsagEX: Codex <scan>", intervalMinutes: 1, launcher: "C:\\U\\a&b\\.usagex\\codex-task.js", env: { SystemRoot: "C:\\Windows" } });
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.doesNotMatch(xml, /<UserId>/, "kullanıcı kimliği yok: kaydedenin adına");
  assert.match(xml, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.match(xml, /<Arguments>\/\/B \/\/Nologo \/\/E:JScript "C:\\U\\a&amp;b\\\.usagex\\codex-task\.js"<\/Arguments>/);
  assert.match(xml, /<Description>UsagEX: Codex &lt;scan&gt;<\/Description>/);
  assert.match(xml, new RegExp(`<URI>\\\\${FOLDER}\\\\Codex</URI>`));
  const buf = utf16(xml);
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(buf.subarray(2).toString("utf16le"), /\r\n<Task version="1\.2"/);
});

test("Codex servisi win32: görev XML ile kaydedilir, kaldırılırken silinir", (t) => {
  const home = tmp(t);
  const { definition, install, uninstall } = require("../codex/service");
  const opts = { platform: "win32", home, codexHome: "C:\\Users\\ada\\.codex", node: "C:\\n\\node.exe", script: "C:\\c\\collect.js" };
  const def = definition(opts);
  assert.equal(def.kind, "schtasks");
  assert.equal(def.task, "UsagEX\\Codex");
  assert.deepEqual(def.files.map((f) => path.basename(f.file)), ["codex-task.js", "codex-task.xml"]);
  assert.ok(def.files.every((f) => f.file.startsWith(path.join(home, ".usagex"))));

  const calls = [];
  let exists = false;
  const run = (cmd, args) => {
    calls.push([path.win32.basename(cmd), ...args].join(" "));
    if (args[0] === "/Create") exists = true;
    if (args[0] === "/Delete") exists = false;
    return { status: args[0] === "/Query" ? (exists ? 0 : 1) : 0 };
  };
  const r = install({ ...opts, run });
  assert.deepEqual(r, { installed: true, kind: "schtasks", command: [opts.node, opts.script, "--watch"] });
  assert.deepEqual(calls, [`schtasks.exe /Create /TN UsagEX\\Codex /XML ${def.xmlFile} /F`]);
  assert.ok(def.files.every((f) => fs.existsSync(f.file)));
  assert.match(fs.readFileSync(def.files[0].file, "utf8"), /--env=CODEX_HOME=/);

  calls.length = 0;
  assert.equal(uninstall({ ...opts, run }), true);
  assert.deepEqual(calls, ["schtasks.exe /Query /TN UsagEX\\Codex", "schtasks.exe /Delete /TN UsagEX\\Codex /F"]);
  assert.equal(def.files.some((f) => fs.existsSync(f.file)), false);
  assert.equal(uninstall({ ...opts, run }), false, "ikinci kez: kaldırılacak bir şey yok");
});

test("Codex servisi win32: kayıt başarısızsa bağlantı yine tamamlanır, komut PowerShell biçiminde önerilir", (t) => {
  const home = tmp(t);
  const { install } = require("../codex/service");
  const r = install({ platform: "win32", home, codexHome: "C:\\x", node: "C:\\n b\\node.exe", script: "C:\\c\\collect.js", run: () => ({ status: 1 }) });
  assert.equal(r.installed, false);
  assert.equal(r.kind, "schtasks");
  const { commandLine } = require("../lib/runtime");
  assert.equal(commandLine(r.command, "win32"), "& 'C:\\n b\\node.exe' 'C:\\c\\collect.js' --watch");
});

test("Claude yoklayıcı servisi win32: 5 dakikalık görev, CLAUDE_CONFIG_DIR başlatıcıya geçer", (t) => {
  const home = tmp(t);
  const { definition, install, uninstall } = require("../scripts/service");
  const opts = { platform: "win32", home, node: "C:\\n\\node.exe", script: "C:\\c\\poll.js", claudeConfigDir: "D:\\cc" };
  const def = definition(opts);
  assert.equal(def.task, "UsagEX\\Poll");
  assert.match(def.files[0].text, /--env=CLAUDE_CONFIG_DIR=D:\\\\cc/);
  assert.match(def.files[1].data.subarray(2).toString("utf16le"), /<Interval>PT5M<\/Interval>/);
  const calls = [];
  const run = (cmd, args) => { calls.push(args[0]); return { status: 0 }; };
  assert.deepEqual(install({ ...opts, run }), { installed: true });
  uninstall({ ...opts, run });
  assert.deepEqual(calls, ["/Create", "/Query", "/Delete"]);
  assert.equal(def.files.some((f) => fs.existsSync(f.file)), false);
});

// ── kullanıcıya gösterilen komutlar ──────────────────────────────────────
test("runtime win32: kaldırma komutu PowerShell betiği, elle komut & '…' biçiminde", () => {
  const { uninstallCommand, commandLine } = require("../lib/runtime");
  const home = path.join(os.tmpdir(), "u");
  const root = path.join(home, ".usagex", "collector");
  assert.equal(uninstallCommand({ root, home, server: "https://usagex.dijitalpi.com/ingest", platform: "win32" }), "irm https://usagex.dijitalpi.com/kaldir.ps1 | iex");
  assert.equal(uninstallCommand({ root, home, server: "https://usagex.dijitalpi.com", lang: "en", platform: "win32" }), "irm https://usagex.dijitalpi.com/uninstall.ps1 | iex");
  assert.equal(uninstallCommand({ root, home, server: "https://usagex.dijitalpi.com", platform: "linux" }), "curl -fsSL https://usagex.dijitalpi.com/kaldir | sh");
  assert.equal(commandLine(["C:\\Users\\O'Neil\\node.exe", "C:\\c\\backfill.js", "90"], "win32"), "& 'C:\\Users\\O''Neil\\node.exe' 'C:\\c\\backfill.js' 90");
});

test("runtime win32: PowerShell komutu gerçekten çalışır", { skip: !PWSH && "pwsh yok" }, () => {
  const { commandLine } = require("../lib/runtime");
  const r = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", commandLine(["/bin/echo", "/tmp/a b/x.js", "--once"], "win32")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "/tmp/a b/x.js --once");
});

// ── rename yeniden denemesi ───────────────────────────────────────────────
test("win-fs: Windows'ta EPERM/EBUSY yeniden denenir, başka hata ve sistemler olduğu gibi", () => {
  const { apply } = require("../lib/win-fs");
  let n = 0;
  const fake = { renameSync() { n++; if (n < 4) { const e = new Error("locked"); e.code = n % 2 ? "EPERM" : "EBUSY"; throw e; } return "ok"; } };
  apply(fake, { platform: "win32", sleep: () => {} });
  assert.equal(fake.renameSync("a", "b"), "ok");
  assert.equal(n, 4);
  const missing = { renameSync() { const e = new Error("x"); e.code = "ENOENT"; throw e; } };
  apply(missing, { platform: "win32", sleep: () => {} });
  assert.throws(() => missing.renameSync("a", "b"), { code: "ENOENT" });
  let tries = 0;
  const stuck = { renameSync() { tries++; const e = new Error("x"); e.code = "EPERM"; throw e; } };
  apply(stuck, { platform: "win32", sleep: () => {} });
  assert.throws(() => stuck.renameSync("a", "b"), { code: "EPERM" });
  assert.equal(tries, 9, "en fazla 9 deneme");
  const mac = { renameSync: () => 1 };
  apply(mac, { platform: "darwin" });
  assert.equal(mac.renameSync.__usagexRetry, undefined);
});
