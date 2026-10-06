// Windows Görev Zamanlayıcı: konsol penceresi açmadan periyodik Node işi.
//
// Görev node.exe'yi doğrudan çalıştırsaydı her turda bir konsol penceresi açılıp
// kapanırdı (dakikada bir!). Bunun yerine görev wscript.exe'yi (pencere açmayan
// Windows Script Host) çağırır; wscript küçük bir JScript başlatıcıyı koşar, o da
// node'u GİZLİ pencereyle başlatır (Run(…, 0)) ve beklemeden çıkar. VBScript
// değil JScript: Microsoft VBScript'i kaldırıyor, WSH JScript'i kalıyor.
//
// Görev XML ile kaydedilir: schtasks'ın komut satırı seçenekleri "pilde de
// çalış" ve "aynı anda tek örnek" ayarlarını veremiyor (varsayılan: pilde
// çalışmaz). XML'de kullanıcı kimliği YOK: görev onu kaydeden kullanıcıya, yalnız
// oturum açıkken (InteractiveToken) ve en düşük yetkiyle çalışır; parola istenmez.
//
// NOT (modül biçimi): CommonJS — testler doğrudan require eder. Yol işlemleri
// çağıranın `path` modülüyle yapılır; bu dosya yalnız metin üretir ve schtasks'ı
// çağırır.
const fs = require("node:fs");
const path = require("node:path");

const FOLDER = "UsagEX";

// Sistem araçları tam yoldan (PATH'te aynı adlı başka bir program çalışmasın).
const system32 = (env = process.env) => `${env.SystemRoot || env.windir || "C:\\Windows"}\\System32`;
const schtasksExe = (env) => `${system32(env)}\\schtasks.exe`;
const wscriptExe = (env) => `${system32(env)}\\wscript.exe`;

// JScript dize sabiti, yalnız ASCII: WSH betik dosyasını sistem kod sayfasıyla
// okur (UTF-8 bilmez); "Çağrı" gibi bir kullanıcı adı \uXXXX kaçışıyla güvende.
function jsString(s) {
  return JSON.stringify(String(s)).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// Windows komut satırı argümanı (CommandLineToArgvW kuralı): boşluk ya da özel
// karakter varsa çift tırnak; kapanış tırnağından önceki ters bölüler ikilenir
// ("C:\dir\" kapanışı kaçış sanılmasın). Windows yollarında " olamaz.
function winArg(s) {
  s = String(s);
  if (s.includes('"')) throw new Error("quote in Windows argument");
  if (s !== "" && !/[\s&()^|<>%!,;=]/.test(s)) return s;
  return `"${s.replace(/(\\+)$/, "$1$1")}"`;
}

// Başlatıcı: node'u gizli pencereyle (0) başlatır, beklemeden (false) çıkar.
// Ortam değişkenleri `--env=AD=değer` argümanıyla gider (betik kendisi okur):
// JScript'te ortama atama (env("X") = …) yeni Windows betik motorunda
// sözdizimi hatası olabilir. Dosya yalnız ASCII (WSH UTF-8 okumaz).
function launcherScript({ node, script, args = [], env = {} }) {
  const envArgs = Object.entries(env).filter(([, v]) => v).map(([k, v]) => `--env=${k}=${v}`);
  const cmd = [winArg(node), winArg(script), ...args, ...envArgs].map((a, i) => (i < 2 ? a : winArg(a))).join(" ");
  return [
    "// UsagEX: starts a Node script without a console window (Task Scheduler).",
    'var shell = new ActiveXObject("WScript.Shell");',
    `shell.Run(${jsString(cmd)}, 0, false);`,
    "",
  ].join("\r\n");
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

// Görev tanımı (Task Scheduler 1.2 şeması, dışa aktarılan görevlerle aynı sıra).
// Başlangıç geçmişte: tekrar, kayıttan hemen sonra işlemeye başlar.
function taskXml({ name, description, intervalMinutes, launcher, env = process.env }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(description)}</Description>
    <URI>\\${FOLDER}\\${xml(name)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${intervalMinutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(wscriptExe(env))}</Command>
      <Arguments>//B //Nologo //E:JScript "${xml(launcher)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks /XML UTF-16 (BOM'lu) dosya ister; bildirimdeki kodlamayla aynı.
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf16le")]);

// Bir Windows servis tanımı: başlatıcı + görev XML'i ~/.usagex altında.
// `dir`: ~/.usagex; `id`: dosya ve görev adı kökü ("codex", "poll").
function definition({ dir, id, name, description, intervalMinutes, node, script, args = [], envVars = {}, env = process.env }) {
  const launcher = path.join(dir, `${id}-task.js`);
  const xmlFile = path.join(dir, `${id}-task.xml`);
  return {
    kind: "schtasks",
    task: `${FOLDER}\\${name}`,
    files: [
      { file: launcher, text: launcherScript({ node, script, args, env: envVars }) },
      { file: xmlFile, data: utf16(taskXml({ name, description, intervalMinutes, launcher, env })) },
    ],
    xmlFile,
  };
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", data, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

// Döner: kayıt başarılı mı. FIRLATMAZ.
function install(def, { run, env = process.env } = {}) {
  try {
    for (const f of def.files) writeAtomic(f.file, f.data ?? f.text);
    const r = run(schtasksExe(env), ["/Create", "/TN", def.task, "/XML", def.xmlFile, "/F"], { stdio: "ignore", windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

// Görev varsa siler, dosyaları kaldırır. Döner: bir şey kaldırıldı mı. FIRLATMAZ.
function uninstall(def, { run, env = process.env } = {}) {
  let removed = false;
  try {
    const q = run(schtasksExe(env), ["/Query", "/TN", def.task], { stdio: "ignore", windowsHide: true });
    if (q.status === 0) {
      run(schtasksExe(env), ["/Delete", "/TN", def.task, "/F"], { stdio: "ignore", windowsHide: true });
      removed = true;
    }
  } catch {}
  for (const { file } of def.files) {
    try { if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed = true; } } catch {}
  }
  return removed;
}

module.exports = { FOLDER, definition, install, uninstall, launcherScript, taskXml, jsString, winArg, utf16, schtasksExe, wscriptExe };
