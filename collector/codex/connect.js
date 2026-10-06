#!/usr/bin/env node
// codex/connect.js <kod>: ön kontrol → kodu harca → kaydet → otomatik
// güncelleme (macOS LaunchAgent / Linux systemd --user / Windows Görev
// Zamanlayıcı) → ilk tarama arka
// planda → kısa mesaj. Dil USAGEX_LANG (tr|en), Node yolu USAGEX_NODE.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexDir, dataDir } = require('./config');
const { ingestUrlProblem } = require('../lib/config');
const { machineId, platformName, saveConnection, claim, parseCode } = require('../scripts/connect');
const { machineLabel } = require('../lib/payload');
const { nodeVersionProblem, MIN_MAJOR } = require('../lib/node-version');
const { msg, lang, UserError } = require('../lib/i18n');
const { usagexHome, writeNodePath, checkWritable, commandLine, spawnDetached, uninstallCommand } = require('../lib/runtime');
const service = require('./service');

// Kodu harcar ve bağlantıyı kaydeder. Sorun varsa UserError fırlatır (dosya yazılmaz).
async function connect(code, { dir = dataDir(), serverUrl = process.env.USAGEX_SERVER_URL || 'https://usagex.dijitalpi.com', fetchImpl = fetch } = {}) {
  code = parseCode(code);
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new UserError('usage_codex');
  if (ingestUrlProblem(serverUrl)) throw new UserError('server_url_invalid');
  const origin = new URL(serverUrl).origin;
  const data = await claim(`${origin}/v1/pairing/claim`, { code, provider: 'codex', platform: platformName(), machine: machineLabel(false), machine_id: machineId() }, (url, init) => fetchImpl(url, { ...init, redirect: 'error' }));
  if (!data || data.provider !== 'codex') throw new UserError('wrong_provider');
  if (typeof data.device_token !== 'string' || !data.device_token || data.device_token.length > 256) throw new UserError('bad_response');
  let ingest;
  try { ingest = new URL(data.ingest_url || '/ingest', origin); } catch { throw new UserError('bad_response'); }
  if (ingest.origin !== origin || ingestUrlProblem(ingest.href)) throw new UserError('redirect_refused');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  saveConnection(dir, { enabled: true, provider: 'codex', consent_version: 1, history_days: 90, send_project_names: false, ingest_url: ingest.href, device_token: data.device_token });
  return { connected: true };
}

// Tam akış. Döner: çıkış kodu (0 başarı, 1 hata). Yan etkiler enjekte edilebilir.
async function main(argCode, {
  env = process.env,
  home = os.homedir(),
  codexHome = codexDir(),
  dir = dataDir(),
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  spawnImpl,
  installService = service.install,
  root = path.resolve(__dirname, '..'),
  out = s => console.log(s),
  err = s => console.error(s),
} = {}) {
  const t = (key, vars) => msg(key, vars, lang(env));
  const fail = e => {
    err(`✗ ${e instanceof UserError ? t(e.key, e.vars) : t('unexpected', { reason: (e && e.message) || e })}`);
    return 1;
  };
  if (nodeVersionProblem()) return fail(new UserError('node_too_old', { version: process.versions.node, min: MIN_MAJOR }));
  if (!/^[A-Z0-9]{8}$/.test(parseCode(argCode))) { err(t('usage_codex')); return 1; }

  // Ön kontrol: kod harcanmadan önce.
  const codexVar = fs.existsSync(codexHome);
  const uxDir = usagexHome(home);
  for (const d of [uxDir, dir]) {
    if (checkWritable(d)) { fail(new UserError('dir_not_writable', { dir: d })); err(t('code_unused')); return 1; }
  }

  try {
    await connect(argCode, { dir, serverUrl: env.USAGEX_SERVER_URL || 'https://usagex.dijitalpi.com', fetchImpl });
  } catch (e) { return fail(e); }

  let node;
  try { node = writeNodePath({ env, home }); } catch { node = process.execPath; }
  const collect = path.join(__dirname, 'collect.js');
  const svc = installService({ platform, home, codexHome, node, script: collect });

  // İlk tarama arka planda (90 günlük geçmiş); terminal kapansa da sürer.
  const first = spawnDetached(process.execPath, [collect, '--once'], {
    log: path.join(uxDir, 'codex-collect.log'), env: { ...env, CODEX_HOME: codexHome }, spawnImpl,
  });

  out(t('codex_connected'));
  out(t('codex_privacy'));
  if (!svc.installed) {
    const cmd = commandLine(svc.command || [node, collect, '--watch']);
    out(t(svc.kind === 'launchd' || svc.kind === 'systemd' || svc.kind === 'schtasks' ? 'codex_service_failed' : 'codex_manual', { cmd }));
  }
  if (!first.started) out(t('history_not_started', { cmd: commandLine([node, collect, '--once']) }));
  if (!codexVar) out(t('codex_missing'));
  // Codex'e yeniden başlatma notu yok: collector oturum dosyalarını dakikada bir
  // okur, açık Codex pencereleri de kapsanır (Claude'daki hook sorunu burada yok).
  const uninstall = uninstallCommand({ root, home, server: env.USAGEX_SERVER_URL || 'https://usagex.dijitalpi.com', lang: lang(env) });
  if (uninstall) out(t('uninstall_hint', { cmd: uninstall }));
  else out(t('disconnect_hint', { cmd: commandLine([node, path.join(__dirname, 'disconnect.js')]) }));
  return 0;
}

if (require.main === module) {
  main(process.argv[2]).then(code => { process.exitCode = code; }, e => {
    console.error(`✗ ${msg('unexpected', { reason: (e && e.message) || e })}`);
    process.exitCode = 1;
  });
}
module.exports = { connect, main };
