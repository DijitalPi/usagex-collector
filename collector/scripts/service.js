#!/usr/bin/env node
// Arka plan yoklayıcısı: poll.js'i 5 dakikada bir koşturan kullanıcı servisi.
// Hook'lar yalnız Claude Code bir tur bitirdiğinde çalışır; uzun bir görev
// sürerken, Claude Code boştayken ya da kullanıcı claude.ai'da çalışırken
// sunucuya hiç ölçüm gitmiyor ve eşik bildirimleri üretilemiyordu.
// macOS: launchd LaunchAgent. Linux: systemd kullanıcı zamanlayıcısı.
// Kurulamazsa bağlantı YİNE tamamlanır (hook'lar çalışmaya devam eder).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveNode } = require("../lib/runtime");

const LABEL = "com.dijitalpi.usagex.poll";
const UNIT = "usagex-poll";
const INTERVAL_S = 300;
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
// systemd: boşluklu yol tırnak ister; tırnak ve ters bölü kaçışlanır.
const unitArg = (s) => `"${String(s).replace(/[\\"]/g, "\\$&")}"`;

function definition({ platform = process.platform, home = os.homedir(), node = resolveNode({ home }),
  script = path.join(__dirname, "poll.js"), claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || "" } = {}) {
  if (platform === "darwin") {
    const env = claudeConfigDir
      ? `<key>EnvironmentVariables</key><dict><key>CLAUDE_CONFIG_DIR</key><string>${xml(claudeConfigDir)}</string></dict>` : "";
    return { kind: "launchd", files: [{
      file: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
      text: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array>${env}<key>RunAtLoad</key><true/><key>StartInterval</key><integer>${INTERVAL_S}</integer><key>ProcessType</key><string>Background</string></dict></plist>`,
    }] };
  }
  if (platform === "linux") {
    const dir = path.join(home, ".config", "systemd", "user");
    const env = claudeConfigDir ? `Environment=${unitArg(`CLAUDE_CONFIG_DIR=${claudeConfigDir}`)}\n` : "";
    return { kind: "systemd", files: [
      { file: path.join(dir, `${UNIT}.service`),
        text: `[Unit]\nDescription=UsagEX usage poller\n\n[Service]\nType=oneshot\n${env}ExecStart=${unitArg(node)} ${unitArg(script)}\n` },
      { file: path.join(dir, `${UNIT}.timer`),
        text: `[Unit]\nDescription=UsagEX usage poller timer\n\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=${INTERVAL_S}\n\n[Install]\nWantedBy=timers.target\n` },
    ] };
  }
  return null; // Windows: zamanlanmış görev yok, hook'lar çalışmaya devam eder
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", text, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

// Dönüş: { installed: boolean }. FIRLATMAZ: servis kurulamadı diye bağlantı
// başarısız sayılmamalı.
function install(options = {}) {
  try {
    const def = definition(options);
    if (!def) return { installed: false };
    const run = options.run || spawnSync;
    if (def.kind === "launchd") {
      const uid = options.uid ?? process.getuid();
      const { file, text } = def.files[0];
      run("launchctl", ["bootout", `gui/${uid}`, file], { stdio: "ignore" });
      writeAtomic(file, text);
      const r = run("launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: "ignore" });
      return { installed: r.status === 0 };
    }
    for (const { file, text } of def.files) writeAtomic(file, text);
    run("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const r = run("systemctl", ["--user", "enable", "--now", `${UNIT}.timer`], { stdio: "ignore" });
    return { installed: r.status === 0 };
  } catch { return { installed: false }; }
}

function uninstall(options = {}) {
  try {
    const def = definition(options);
    if (!def) return;
    const run = options.run || spawnSync;
    if (def.kind === "launchd") {
      const uid = options.uid ?? process.getuid();
      if (fs.existsSync(def.files[0].file)) run("launchctl", ["bootout", `gui/${uid}`, def.files[0].file], { stdio: "ignore" });
    } else if (def.files.some((f) => fs.existsSync(f.file))) {
      run("systemctl", ["--user", "disable", "--now", `${UNIT}.timer`], { stdio: "ignore" });
    }
    for (const { file } of def.files) fs.rmSync(file, { force: true });
    if (def.kind === "systemd") run("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } catch {}
}

if (require.main === module) {
  if (process.argv[2] === "uninstall") { uninstall(); console.log(JSON.stringify({ installed: false })); }
  else console.log(JSON.stringify(install()));
}

module.exports = { definition, install, uninstall, LABEL, UNIT, INTERVAL_S };
