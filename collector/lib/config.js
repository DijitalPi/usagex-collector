const fs = require("fs");
const os = require("os");
const path = require("path");

// Claude Code'un kendi CLAUDE_CONFIG_DIR override'ını takip eder (testler de bunu kullanır)
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// ~/.claude/usagex.json — /usagex-connect (veya /usagex-setup) oluşturur.
// { enabled, ingest_url, device_token, send_project_names }
// Geriye uyumluluk: eski kurulumların clmt.json'ı da okunur (rebrand öncesi).
function loadConfig(dir = claudeDir()) {
  for (const name of ["usagex.json", "clmt.json"]) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const cfg = JSON.parse(raw);
      if (!cfg || cfg.enabled === false) return null;
      if (!cfg.ingest_url || !cfg.device_token) return null;
      if (cfg.send_project_names === undefined) cfg.send_project_names = true;
      return cfg;
    } catch {}
  }
  return null;
}

module.exports = { loadConfig, claudeDir };
