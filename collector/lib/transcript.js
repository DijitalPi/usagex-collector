const fs = require("fs");
const path = require("path");

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
}

// Yerel takvim günü (PC'nin saat dilimi) — "bugün ne harcadım" sezgisiyle aynı.
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// lines: JSONL satır dizisi. Bozuk/eksik satırlar sessizce atlanır.
// Dönen `days`: gün bazlı döküm — çok gün açık kalan oturumun token'ları
// bittiği güne yığılmasın, her satır KENDİ gününe yazılsın diye.
function summarizeLines(lines) {
  const models = {};
  const seenIds = new Set();
  const days = {}; // 'YYYY-MM-DD' -> { models, message_count, started_at, ended_at }
  let message_count = 0;
  let started_at = null;
  let ended_at = null;
  let startT = Infinity;
  let endT = -Infinity;
  let cwd = null;

  const dayBucket = (ts, t) => {
    const day = ts ? localDay(ts) : null;
    if (!day) return null;
    let b = days[day];
    if (!b) b = days[day] = { models: {}, message_count: 0, started_at: ts, ended_at: ts, _s: t, _e: t };
    if (t < b._s) { b._s = t; b.started_at = ts; }
    if (t > b._e) { b._e = t; b.ended_at = ts; }
    return b;
  };

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== "object") continue;

    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    const ts = typeof e.timestamp === "string" ? e.timestamp : null;
    const t = ts ? Date.parse(ts) : NaN;
    // min/max ile karşılaştır: alt-ajan satırları ana dosyanın ARKASINA eklenir,
    // "ilk gördüğüm = başlangıç" varsayımı orada bozulur.
    if (Number.isFinite(t)) {
      if (t < startT) { startT = t; started_at = ts; }
      if (t > endT) { endT = t; ended_at = ts; }
    }

    if (e.type === "user") {
      message_count++;
      const b = Number.isFinite(t) ? dayBucket(ts, t) : null;
      if (b) b.message_count++;
      continue;
    }
    if (e.type !== "assistant") continue;

    const msg = e.message;
    const id = msg && msg.id;
    // Aynı message.id birden çok satırda görünür (content block başına satır) — bir kez say
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    message_count++;
    const b = Number.isFinite(t) ? dayBucket(ts, t) : null;
    if (b) b.message_count++;

    if (!msg || !msg.usage) continue;
    const model = msg.model || "unknown";
    const u = msg.usage;
    const add = (bag) => {
      if (!bag[model]) bag[model] = emptyUsage();
      bag[model].input_tokens += u.input_tokens || 0;
      bag[model].output_tokens += u.output_tokens || 0;
      bag[model].cache_creation_tokens += u.cache_creation_input_tokens || 0;
      bag[model].cache_read_tokens += u.cache_read_input_tokens || 0;
    };
    add(models);
    if (b) add(b.models);
  }

  for (const b of Object.values(days)) { delete b._s; delete b._e; }
  return { models, message_count, started_at, ended_at, cwd, days };
}

function readLines(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  return text.split("\n").filter((l) => l.trim() !== "");
}

// Alt-ajan transkriptleri: <klasör>/<oturum-id>/subagents/*.jsonl
// Bunlar da limiti GERÇEKTEN tüketir — sayılmamaları raporu eksik gösterir.
// Ana oturuma dahil edilir (gün dökümü timestamp'lerinden doğru güne düşer).
function subagentLines(filePath) {
  const dir = path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"), "subagents");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  const out = [];
  for (const f of files) {
    const l = readLines(path.join(dir, f));
    if (l) out.push(...l);
  }
  return out;
}

function summarizeTranscript(filePath) {
  const main = readLines(filePath);
  if (!main) {
    // Dosya yok/okunamıyor — sessizce boş özet döndür (hook bunu message_count===0 ile atlar)
    return { models: {}, message_count: 0, started_at: null, ended_at: null, cwd: null, days: {} };
  }
  return summarizeLines(main.concat(subagentLines(filePath)));
}

module.exports = { summarizeTranscript, summarizeLines };
