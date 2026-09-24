#!/usr/bin/env node
// Codex bağlantısını keser: otomatik güncellemeyi (LaunchAgent / systemd
// --user) kaldırır, sunucudaki cihaz kaydını siler, yerel config ve kuyruğu temizler.
const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('./config');
const { acquire } = require('../lib/file-lock');
const { msg, UserError } = require('../lib/i18n');
const { revokeDevice, disableConfigs, removeStateFiles } = require('../scripts/disconnect');
const { uninstall } = require('./service');

async function disconnect({ dir = dataDir(), stop = uninstall, fetchImpl, log = console.log } = {}) {
  const stopped = stop();
  if (stopped) log(msg('service_removed'));
  if (!fs.existsSync(dir)) { log(msg('not_connected')); return { disconnected: true, stopped: !!stopped }; }
  const release = acquire(path.join(dir, 'collect.lock'));
  if (!release) throw new UserError('codex_scan_busy');
  try {
    const revoked = await revokeDevice({ dir, log, fetchImpl });
    disableConfigs(dir, log);
    removeStateFiles(dir, log);
    fs.rmSync(path.join(dir, 'state.json'), { force: true });
    log('');
    log(msg('codex_disconnected'));
    if (revoked === 'hata') log(msg('revoke_manual'));
    return { disconnected: true, stopped: !!stopped, revoked };
  } finally { release(); }
}
if (require.main === module) {
  disconnect().catch(e => {
    console.error(`✗ ${e instanceof UserError ? msg(e.key, e.vars) : msg('unexpected', { reason: (e && e.message) || e })}`);
    process.exitCode = 1;
  });
}
module.exports = { disconnect };
