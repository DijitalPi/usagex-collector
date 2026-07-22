const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./config");
const { getAccessToken } = require("./credentials");

// UNDOCUMENTED endpoint — Anthropic her an değiştirebilir. Bu modül kırılırsa
// payload plan_usage=null ile devam eder; transcript bazlı veri akışı etkilenmez.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 5 * 60 * 1000; // heartbeat throttle'ı ile hizalı
const TIMEOUT_MS = 3000;

function pct(win) {
  if (!win || typeof win.utilization !== "number") return null;
  return Math.min(100, Math.max(0, Math.round(win.utilization)));
}

async function getPlanUsage({ dir, fetchImpl = fetch, now = Date.now } = {}) {
  try {
    if (!dir) dir = claudeDir();
  } catch {
    return null;
  }
  const cachePath = path.join(dir, "usagex-usage-cache.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // fetched_at <= now: saat geri alınırsa (skew) gelecekteki damga bayat cache'i
    // sonsuza dek taze göstermesin.
    const age = now() - cached.fetched_at;
    if (age >= 0 && age < CACHE_TTL_MS) return cached.plan_usage;
  } catch {}

  const token = getAccessToken(dir);
  if (!token) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          // Bu header şart — yanlış UA agresif rate-limit bucket'ına düşer (429)
          "User-Agent": "claude-code/2.0.0",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = await res.json();
    let plan_usage = {
      session_pct: pct(data.five_hour),
      week_pct: pct(data.seven_day),
      session_resets_at: (data.five_hour && data.five_hour.resets_at) || null,
      week_resets_at: (data.seven_day && data.seven_day.resets_at) || null,
    };
    // Format değişmiş/boş cevap: null'a düş. null da cache'lenir — 5 dk back-off korunur (CACHE_TTL_MS).
    if (plan_usage.session_pct === null && plan_usage.week_pct === null) plan_usage = null;
    try {
      fs.writeFileSync(cachePath, JSON.stringify({ fetched_at: now(), plan_usage }), { mode: 0o600 });
    } catch {}
    return plan_usage;
  } catch {
    return null;
  }
}

module.exports = { getPlanUsage };
