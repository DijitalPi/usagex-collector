const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./config");

// Heartbeat throttle durumu: ~/.claude/usagex-state.json
const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000;

function statePath(dir = claudeDir()) {
  return path.join(dir, "usagex-state.json");
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), "utf8")) || {};
  } catch {
    return {};
  }
}

// Throttle penceresi dolduysa true döner ve zamanı İLERİ ALIR (check-and-set tek adım —
// Stop hook'u her cevapta tetiklendiği için yarışta çift gönderim burada engellenir).
function shouldHeartbeat({ dir, now = Date.now, intervalMs = HEARTBEAT_MIN_INTERVAL_MS } = {}) {
  const state = readState(dir);
  const last = state.last_heartbeat_at;
  // last yoksa/bozuksa "hiç gönderilmedi" say — her zaman gönder
  if (typeof last === "number" && now() - last < intervalMs) return false;
  state.last_heartbeat_at = now();
  try {
    fs.writeFileSync(statePath(dir), JSON.stringify(state), { mode: 0o600 });
  } catch {}
  return true;
}

module.exports = { shouldHeartbeat, readState, statePath, HEARTBEAT_MIN_INTERVAL_MS };
