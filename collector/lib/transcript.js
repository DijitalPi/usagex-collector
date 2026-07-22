const fs = require("fs");

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
}

// lines: JSONL satır dizisi. Bozuk/eksik satırlar sessizce atlanır.
function summarizeLines(lines) {
  const models = {};
  const seenIds = new Set();
  let message_count = 0;
  let started_at = null;
  let ended_at = null;
  let cwd = null;

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== "object") continue;

    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (typeof e.timestamp === "string") {
      if (!started_at) started_at = e.timestamp;
      ended_at = e.timestamp;
    }

    if (e.type === "user") { message_count++; continue; }
    if (e.type !== "assistant") continue;

    const msg = e.message;
    const id = msg && msg.id;
    // Aynı message.id birden çok satırda görünür (content block başına satır) — bir kez say
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    message_count++;

    if (!msg || !msg.usage) continue;
    const model = msg.model || "unknown";
    if (!models[model]) models[model] = emptyUsage();
    const u = msg.usage;
    models[model].input_tokens += u.input_tokens || 0;
    models[model].output_tokens += u.output_tokens || 0;
    models[model].cache_creation_tokens += u.cache_creation_input_tokens || 0;
    models[model].cache_read_tokens += u.cache_read_input_tokens || 0;
  }

  return { models, message_count, started_at, ended_at, cwd };
}

function summarizeTranscript(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    // Dosya yok/okunamıyor — sessizce boş özet döndür (hook bunu message_count===0 ile atlar)
    return { models: {}, message_count: 0, started_at: null, ended_at: null, cwd: null };
  }
  return summarizeLines(text.split("\n").filter((l) => l.trim() !== ""));
}

module.exports = { summarizeTranscript, summarizeLines };
