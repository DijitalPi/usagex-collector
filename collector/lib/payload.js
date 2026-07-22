const os = require("os");
const crypto = require("crypto");

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
