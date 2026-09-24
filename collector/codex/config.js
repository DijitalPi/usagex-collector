const os = require('node:os');
const path = require('node:path');
const common = require('../lib/config');

const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const dataDir = () => path.join(codexDir(), 'usagex');
function loadConfig(dir = dataDir()) {
  const cfg = common.loadConfig(dir);
  return cfg?.provider === 'codex' && cfg.consent_version === 1 ? cfg : null;
}
module.exports = { codexDir, dataDir, loadConfig };
