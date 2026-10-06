#!/usr/bin/env node
// Separate user service: works with CLI and desktop rollouts, preserves notify
// and all existing Codex configuration. No prompt is passed to this process.
// macOS: LaunchAgent running collect.js --watch. Linux: systemd --user
// service + timer running one scan per minute. Windows: Task Scheduler task
// running one scan per minute without a console window (lib/win-task.js).
// Node comes from USAGEX_NODE / ~/.usagex/node-path (unresolved path,
// survives Node upgrades).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { codexDir } = require('./config');
const { resolveNode, usagexHome } = require('../lib/runtime');
const winTask = require('../lib/win-task');
const LABEL = 'com.dijitalpi.usagex.codex';
const UNIT = 'usagex-codex';
const INTERVAL_S = 60;
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// systemd: quoted argument, backslash and quote escaped, % doubled (specifier).
const unitArg = s => `"${String(s).replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

function definition({ platform = process.platform, home = os.homedir(), codexHome = codexDir(), node = resolveNode({ home }), script = path.join(__dirname, 'collect.js') } = {}) {
  if (platform === 'darwin') {
    const file = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const text = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>--watch</string></array><key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>${xml(codexHome)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>ProcessType</key><string>Background</string></dict></plist>`;
    return { kind: 'launchd', file, text, files: [{ file, text }] };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    return { kind: 'systemd', files: [
      { file: path.join(dir, `${UNIT}.service`),
        text: `[Unit]\nDescription=UsagEX Codex usage scan\n\n[Service]\nType=oneshot\nEnvironment=${unitArg(`CODEX_HOME=${codexHome}`)}\nExecStart=${unitArg(node)} ${unitArg(script)}\n` },
      { file: path.join(dir, `${UNIT}.timer`),
        text: `[Unit]\nDescription=UsagEX Codex usage scan timer\n\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=${INTERVAL_S}\n\n[Install]\nWantedBy=timers.target\n` },
    ] };
  }
  if (platform === 'win32') {
    return winTask.definition({ dir: usagexHome(home), id: 'codex', name: 'Codex', description: 'UsagEX: Codex usage scan',
      intervalMinutes: INTERVAL_S / 60, node, script, envVars: { CODEX_HOME: codexHome } });
  }
  return null;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// systemctl --user works only with a user session bus (not in every container/SSH).
function systemdAvailable(run = spawnSync) {
  try { return run('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

// Returns { installed, kind, command }. `command` is the manual fallback.
// Never throws: a missing service must not fail an otherwise good connection.
function install(options = {}) {
  const node = options.node || resolveNode({ home: options.home });
  const command = [node, options.script || path.join(__dirname, 'collect.js'), '--watch'];
  try {
    const def = definition({ ...options, node });
    if (!def) return { installed: false, kind: null, command };
    const run = options.run || spawnSync;
    if (def.kind === 'schtasks') return { installed: winTask.install(def, { run }), kind: 'schtasks', command };
    if (def.kind === 'launchd') {
      const uid = options.uid ?? process.getuid();
      run('launchctl', ['bootout', `gui/${uid}`, def.file], { stdio: 'ignore' });
      writeAtomic(def.file, def.text);
      const r = run('launchctl', ['bootstrap', `gui/${uid}`, def.file], { stdio: 'ignore' });
      return { installed: r.status === 0, kind: 'launchd', command };
    }
    if (!systemdAvailable(run)) return { installed: false, kind: 'systemd-unavailable', command };
    for (const { file, text } of def.files) writeAtomic(file, text);
    const reload = run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const r = reload.status === 0 ? run('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`], { stdio: 'ignore' }) : reload;
    return { installed: r.status === 0, kind: 'systemd', command };
  } catch { return { installed: false, kind: null, command }; }
}

// Returns true when something was removed.
function uninstall(options = {}) {
  try {
    const def = definition(options);
    if (def && def.kind === 'schtasks') return winTask.uninstall(def, { run: options.run || spawnSync });
    if (!def || !def.files.some(f => fs.existsSync(f.file))) return false;
    const run = options.run || spawnSync;
    if (def.kind === 'launchd') run('launchctl', ['bootout', `gui/${options.uid ?? process.getuid()}`, def.file], { stdio: 'ignore' });
    else run('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`], { stdio: 'ignore' });
    for (const { file } of def.files) fs.rmSync(file, { force: true });
    if (def.kind === 'systemd') run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

if (require.main === module) {
  const { msg } = require('../lib/i18n');
  const { commandLine } = require('../lib/runtime');
  const r = install();
  if (r.installed) console.log(msg('service_installed'));
  else { console.log(msg(r.kind === 'launchd' || r.kind === 'schtasks' ? 'codex_service_failed' : 'codex_manual', { cmd: commandLine(r.command) })); process.exitCode = 1; }
}
module.exports = { definition, install, uninstall, systemdAvailable, LABEL, UNIT, INTERVAL_S };
