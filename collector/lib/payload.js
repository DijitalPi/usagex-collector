const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Claude Code'un GERÇEK ilk kullanım tarihi (~/.claude.json bunu transkriptler
// silinse bile hatırlar) — sunucudaki "tecrübe" metriği ilk transkript değil
// gerçek başlangıçtan saysın. Okunamazsa null (opsiyonel alan).
let _firstUsed;
function claudeFirstUsedAt() {
  if (_firstUsed !== undefined) return _firstUsed;
  _firstUsed = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const cands = [j.claudeCodeFirstTokenDate, j.firstStartTime]
      .map((v) => (v ? Date.parse(v) : NaN))
      .filter((t) => Number.isFinite(t) && t > Date.parse("2020-01-01") && t <= Date.now());
    if (cands.length) _firstUsed = new Date(Math.min(...cands)).toISOString();
  } catch {}
  return _firstUsed;
}

// send_project_names=false iken proje adı geri döndürülemez kısa hash'e çevrilir
// (klasör adları müşteri/proje ismi içerebilir — veri minimizasyonu).
function projectLabel(name, sendPlain) {
  if (!name) return "unknown";
  if (sendPlain) return name;
  return "p-" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
}

// Not: snapshot'ta machine YOK — sunucu plan_snapshots'a yazmıyor (cihaz zaten
// token'dan çözülüyor); hostname'i boşuna göndermek veri minimizasyonuna aykırı.
function snapshotPayload(plan_usage, { source }) {
  return {
    schema_version: 1,
    kind: "snapshot",
    source, // 'session-start' | 'stop' | 'session-end' | 'ping' | 'poller'
    plan_usage,
    claude_first_used_at: claudeFirstUsedAt(),
  };
}

// CLMT sadece Claude limitlerini izler — Claude Code üzerinden başka sağlayıcılarla
// (ollama/qwen/gemma vb.) yapılan oturumlar limiti etkilemez, veri olarak da gönderilmez.
function filterClaudeModels(models) {
  const out = {};
  for (const [name, usage] of Object.entries(models || {})) {
    if (name.toLowerCase().includes("claude")) out[name] = usage;
  }
  return out;
}

function sessionPayload({ session_id, summary, est_cost_usd, plan_usage, config }) {
  return {
    schema_version: 1,
    kind: "session",
    machine: os.hostname(),
    source: "session-end",
    session_id,
    project: projectLabel(summary.project, config.send_project_names),
    started_at: summary.started_at,
    ended_at: summary.ended_at,
    message_count: summary.message_count,
    models: filterClaudeModels(summary.models),
    est_cost_usd,
    plan_usage,
  };
}

module.exports = { snapshotPayload, sessionPayload, projectLabel, filterClaudeModels };
