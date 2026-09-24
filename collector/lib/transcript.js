const { messageOwner } = require("./message-owners");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { claudeDir } = require("./config");

function emptyUsage() {
  return {
    input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
    // Cache YAZMA fiyatı TTL'e bağlı (5 dk = 1.25x, 1 sa = 2x). Transkript bu dökümü
    // usage.cache_creation altında veriyor; ayrı taşınmazsa hepsi ucuz tarifeyle
    // fiyatlanıp maliyet düşük çıkıyor. cache_creation_tokens TOPLAM olarak kalır —
    // sunucu (sumModels) onu okuyor, bozulmamalı.
    cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0,
  };
}

const USAGE_KEYS = Object.keys(emptyUsage());

// İki usage sözlüğünü TOPLAYARAK birleştirir (bag[model] += u).
function addUsage(bag, model, u) {
  if (!u || typeof u !== "object") return;
  if (!bag[model]) bag[model] = emptyUsage();
  for (const k of USAGE_KEYS) bag[model][k] += u[k] || 0;
}

// Yerel takvim günü (PC'nin saat dilimi) — "bugün ne harcadım" sezgisiyle aynı.
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// O günün UTC'ye göre offset'i, DAKİKA cinsinden ve doğu POZİTİF (İstanbul: +180).
// getTimezoneOffset() ters işaretli döner. Gün bazlı hesaplanır çünkü yaz saati
// uygulayan yerlerde offset yıl içinde değişir. `day` alanı bundan bağımsız —
// sunucu uyumu için aynen kalıyor.
function tzOffsetMinutes(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return -d.getTimezoneOffset();
}

// Satırları TEK TEK yutan biriktirici. Stream ile beslenebilsin diye ayrıldı:
// eskiden transcript'in tamamı belleğe okunuyordu (uzun oturumlarda on MB'lar).
function createAccumulator({ ownsMessage = () => true } = {}) {
  const models = {};
  const seenIds = new Map();
  const days = {}; // 'YYYY-MM-DD' -> { models, message_count, started_at, ended_at }
  let message_count = 0;
  let tool_result_count = 0;
  let started_at = null;
  let ended_at = null;
  let startT = Infinity;
  let endT = -Infinity;
  let cwd = null;
  let foreignMessages = false;
  let trackCostState = true;
  let costState = null; // son görülen `cost-state` satırı (Claude Code'un kendi defteri)

  const dayBucket = (ts, t) => {
    const day = ts ? localDay(ts) : null;
    if (!day) return null;
    let b = days[day];
    if (!b) {
      b = days[day] = {
        models: {}, message_count: 0, started_at: ts, ended_at: ts,
        tz_offset_minutes: tzOffsetMinutes(ts), _s: t, _e: t,
      };
    }
    if (t < b._s) { b._s = t; b.started_at = ts; b.tz_offset_minutes = tzOffsetMinutes(ts); }
    if (t > b._e) { b._e = t; b.ended_at = ts; }
    return b;
  };

  function addLine(line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || typeof e !== "object") return;

    // Claude Code'un KENDİ maliyet defteri. Zaman damgası taşımaz, gün dökümüne
    // girmez; yalnız en SONUNCUSU saklanır (kümülatiftir, üsttekiler eskimiştir).
    if (e.type === "cost-state") {
      if (trackCostState && Number.isFinite(e.totalCostUSD) && e.totalCostUSD >= 0) costState = e;
      return;
    }

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
      // "user" satırlarının çoğu kullanıcının YAZDIĞI mesaj DEĞİL:
      //   · araç sonucu (toolUseResult / content[0].type === "tool_result")
      //   · sistem notu (isMeta — kanca çıktısı, komut hatırlatması, uyarı)
      // Bu makinedeki transkriptlerde ölçüldü: 14.532 user satırının 13.468'i
      // araç sonucu, 210'u isMeta, yalnız 854'ü gerçek istem. Hepsini saymak
      // "mesaj sayısı"nı ~17 kat şişiriyor ve rapordaki sohbet sayısını anlamsız
      // kılıyordu. Araç sonuçları ayrı sayaçta taşınır (bilgi kaybolmasın).
      const c = e.message && e.message.content;
      if (e.toolUseResult !== undefined || (Array.isArray(c) && c[0] && c[0].type === "tool_result")) {
        tool_result_count++;
        return;
      }
      if (e.isMeta) return;
      message_count++;
      const b = Number.isFinite(t) ? dayBucket(ts, t) : null;
      if (b) b.message_count++;
      return;
    }
    if (e.type !== "assistant") return;

    const msg = e.message;
    const id = msg && msg.id;
    // Repeated content blocks share an ID. Later blocks may carry a larger
    // cumulative output count: add only the increase, on the original day.
    const previous = id ? seenIds.get(id) : null;
    if (!previous && id && !ownsMessage(String(id))) {
      foreignMessages = true;
      if (Number.isFinite(t)) dayBucket(ts, t);
      return;
    }
    const b = previous ? previous.bucket : Number.isFinite(t) ? dayBucket(ts, t) : null;
    if (!previous) {
      message_count++;
      if (b) b.message_count++;
    }
    const model = previous?.model && previous.model !== "unknown" ? previous.model : msg?.model || "unknown";
    const record = previous || { model, bucket: b, usage: emptyUsage() };
    record.model = model;
    if (id) seenIds.set(id, record);
    if (!msg?.usage) return;
    const u = msg.usage;
    const count = v => Number.isSafeInteger(v) && v >= 0 ? v : 0;
    const next = {
      input_tokens: count(u.input_tokens), output_tokens: count(u.output_tokens),
      cache_creation_tokens: count(u.cache_creation_input_tokens),
      cache_read_tokens: count(u.cache_read_input_tokens),
      cache_creation_5m_tokens: count(u.cache_creation?.ephemeral_5m_input_tokens),
      cache_creation_1h_tokens: count(u.cache_creation?.ephemeral_1h_input_tokens),
    };
    const delta = emptyUsage();
    for (const key of USAGE_KEYS) {
      delta[key] = Math.max(0, next[key] - record.usage[key]);
      record.usage[key] += delta[key];
    }
    addUsage(models, model, delta);
    if (b) addUsage(b.models, model, delta);
  }

  // Başka bir dosyanın hazır ÖZETİNİ içeri al (satırları değil). Alt-ajan
  // dosyaları önbellekten geldiğinde elimizde satır kalmaz; birleştirme mantığı
  // iki yere kopyalanmasın diye tek noktada duruyor.
  function addSummary(sum) {
    if (!sum || typeof sum !== "object") return;
    message_count += sum.message_count || 0;
    tool_result_count += sum.tool_result_count || 0;
    if (!cwd && typeof sum.cwd === "string") cwd = sum.cwd;

    const genislet = (ts) => {
      const t = ts ? Date.parse(ts) : NaN;
      if (!Number.isFinite(t)) return;
      if (t < startT) { startT = t; started_at = ts; }
      if (t > endT) { endT = t; ended_at = ts; }
    };
    genislet(sum.started_at);
    genislet(sum.ended_at);

    for (const [m, u] of Object.entries(sum.models || {})) addUsage(models, m, u);

    for (const [day, d] of Object.entries(sum.days || {})) {
      if (!d || typeof d !== "object") continue;
      let b = days[day];
      if (!b) {
        b = days[day] = {
          models: {}, message_count: 0,
          started_at: d.started_at, ended_at: d.ended_at,
          tz_offset_minutes: d.tz_offset_minutes ?? null,
          _s: Infinity, _e: -Infinity,
        };
      }
      b.message_count += d.message_count || 0;
      const s = Date.parse(d.started_at);
      if (Number.isFinite(s) && s < b._s) {
        b._s = s; b.started_at = d.started_at;
        if (d.tz_offset_minutes != null) b.tz_offset_minutes = d.tz_offset_minutes;
      }
      const e2 = Date.parse(d.ended_at);
      if (Number.isFinite(e2) && e2 > b._e) { b._e = e2; b.ended_at = d.ended_at; }
      for (const [m, u] of Object.entries(d.models || {})) addUsage(b.models, m, u);
    }
  }

  // The ledger has no per-message timestamps. Keep token totals derived from
  // timestamped usage so session totals and daily rows describe the same data.
  // Use ledger counters only to detect an incomplete reported cost.
  const COST_STATE_MAP = {
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheCreationInputTokens: "cache_creation_tokens",
    cacheReadInputTokens: "cache_read_tokens",
  };
  function finish() {
    const ledger = costState?.modelUsage;
    const coversUsage = ledger && Object.keys(ledger).length ? Object.entries(models).every(([model, usage]) =>
      Object.entries(COST_STATE_MAP).every(([source, key]) =>
        Number.isFinite(ledger[model]?.[source]) && ledger[model][source] >= usage[key])) : null;
    for (const b of Object.values(days)) { delete b._s; delete b._e; }
    return {
      models, message_count, tool_result_count, started_at, ended_at, cwd, days,
      cost_state_covers_usage: coversUsage,
      ...(foreignMessages ? { deduplicated_messages: true } : {}),
      // Claude Code'un bildirdiği GERÇEK toplam maliyet (varsa). payload.js bunu
      // otorite alır; yoksa null kalır ve tahmin kullanılır.
      claude_reported_cost_usd: costState && !foreignMessages ? costState.totalCostUSD : null,
      has_unknown_model_cost: costState ? !!costState.hasUnknownModelCost : null,
    };
  }

  return { addLine, addSummary, finish, ignoreCostState: () => { trackCostState = false; } };
}

// lines: JSONL satır dizisi. Bozuk/eksik satırlar sessizce atlanır.
// Dönen `days`: gün bazlı döküm — çok gün açık kalan oturumun token'ları
// bittiği güne yığılmasın, her satır KENDİ gününe yazılsın diye.
function summarizeLines(lines) {
  const acc = createAccumulator();
  for (const line of lines) acc.addLine(line);
  return acc.finish();
}

// Dosyayı satır satır akıtır (fs.createReadStream + readline). Dosya yok/okunamıyorsa
// false döner — çağıran "hiç okuyamadım"ı boş dosyadan ayırabilsin diye.
function streamInto(filePath, acc) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch {
      return resolve(false);
    }
    let ok = true;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // Stream hatasında readline kendiliğinden kapanmayabilir — elle kapat, yoksa
    // promise asılı kalır ve hook 15 sn'lik timeout'a girer.
    stream.on("error", () => { ok = false; rl.close(); });
    rl.on("line", (line) => {
      try { if (line.trim() !== "") acc.addLine(line); }
      catch (error) { ok = false; stream.destroy(); rl.close(); reject(error); }
    });
    rl.on("error", () => { ok = false; });
    rl.on("close", () => resolve(ok));
  });
}

// ── Alt-ajan transkriptleri ─────────────────────────────────────────────────
// <klasör>/<oturum-id>/subagents/**.jsonl — bunlar da limiti GERÇEKTEN tüketir.
// Eskiden yalnız TEK seviye taranıyordu; gerçek kurulumda dosyaların bir kısmı
// subagents/workflows/<wf-id>/ altında duruyor (ölçüldü) ve tamamen kaçıyordu.
// Artık özyinelemeli, ama üç frenle: derinlik, dosya sayısı ve toplam boyut.
// Fren yoksa Stop hook'u her cevapta yüzlerce MB okumaya kalkıp oturumu bekletir.
const SUB_MAX_DEPTH = 3;                    // subagents/workflows/<wf>/x.jsonl = 2, pay var
const SUB_MAX_FILES = 200;
const SUB_MAX_BYTES = 50 * 1024 * 1024;
const SUB_CACHE_NAME = "usagex-subagent-cache.json";
// Önbellek her Stop hook'unda baştan okunuyor: sınır ne kadar büyükse ayrıştırma
// maliyeti o kadar artar. 500 girdi ≈ 300 KB ≈ birkaç ms — makul bir tavan.
const SUB_CACHE_MAX_ENTRIES = 500;

// Deterministik SIRA (ada göre): tavana takılan bir oturumda aynı dosya kümesi
// seçilsin — aksi halde ardışık iki gönderimde toplamlar zıplar ve sunucudaki
// upsert değeri ileri geri oynatır.
function listSubagentFiles(dir) {
  const out = [];
  let toplam = 0;
  const gez = (d, derinlik) => {
    if (derinlik > SUB_MAX_DEPTH || out.length >= SUB_MAX_FILES) return;
    let girisler = [];
    try { girisler = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    girisler.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of girisler) {
      if (out.length >= SUB_MAX_FILES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { gez(p, derinlik + 1); continue; }
      if (!e.name.endsWith(".jsonl")) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (toplam + st.size > SUB_MAX_BYTES) return; // boyut tavanı: kalanı atla
      toplam += st.size;
      out.push({ path: p, size: st.size, mtime: st.mtimeMs });
    }
  };
  gez(dir, 0);
  return out;
}

function subCachePath(dir) {
  return path.join(dir, SUB_CACHE_NAME);
}
function readSubCache(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(subCachePath(dir), "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}
// En son görülen SUB_CACHE_MAX_ENTRIES girdiyi tut — önbellek sonsuza kadar şişmesin.
function pruneSubCache(cache) {
  const girdiler = Object.entries(cache);
  if (girdiler.length <= SUB_CACHE_MAX_ENTRIES) return cache;
  girdiler.sort((a, b) => (b[1].seen_at || 0) - (a[1].seen_at || 0));
  return Object.fromEntries(girdiler.slice(0, SUB_CACHE_MAX_ENTRIES));
}
function writeSubCache(dir, cache) {
  const p = subCachePath(dir);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(pruneSubCache(cache)), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Değişmeyen alt-ajan dosyasını HER Stop hook'unda baştan ayrıştırmak boşuna iş:
// dosya kapandıktan sonra bir daha değişmiyor. (size, mtime) aynıysa önbellekteki
// özet kullanılır; oturum uzadıkça hook maliyeti sabit kalır.
async function addSubagents(filePath, acc, cacheDir) {
  const dir = path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"), "subagents");
  const files = listSubagentFiles(dir);
  if (files.length === 0) return;

  acc.ignoreCostState();
  const cache = cacheDir ? readSubCache(cacheDir) : {};
  const updates = {};
  for (const file of files) {
    const hit = cache[file.path];
    if (hit?.version === 2 && hit.size === file.size && hit.mtime === file.mtime && Array.isArray(hit.records)) {
      for (const record of hit.records) acc.addLine(record);
      continue;
    }
    // Cache only counters, IDs and timestamps. Prompts, code and tool output
    // never enter this cache. Replaying IDs preserves cross-file deduplication.
    const records = []; let bytes = 0;
    await streamInto(file.path, { addLine(line) {
      acc.addLine(line);
      let e; try { e = JSON.parse(line); } catch { return; }
      if (!e || typeof e !== "object" || e.type === "cost-state") return;
      const safe = { type: e.type, timestamp: e.timestamp, cwd: e.cwd };
      if (e.type === "assistant") {
        const u = e.message?.usage;
        safe.message = { id: e.message?.id, model: e.message?.model };
        if (u) {
          safe.message.usage = Object.fromEntries(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].map(k => [k, Number(u[k]) || 0]));
          safe.message.usage.cache_creation = {
            ephemeral_5m_input_tokens: Number(u.cache_creation?.ephemeral_5m_input_tokens) || 0,
            ephemeral_1h_input_tokens: Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0,
          };
        }
      } else if (e.type === "user") {
        safe.isMeta = !!e.isMeta;
        if (e.toolUseResult !== undefined || e.message?.content?.[0]?.type === "tool_result") safe.toolUseResult = true;
      }
      const record = JSON.stringify(safe); bytes += Buffer.byteLength(record);
      if (bytes <= 1024 * 1024) records.push(record);
    } });
    if (bytes <= 1024 * 1024) updates[file.path] = { version: 2, size: file.size, mtime: file.mtime, seen_at: Date.now(), records };
  }
  if (cacheDir && Object.keys(updates).length) {
    try { require("./file-lock").withLock(subCachePath(cacheDir) + ".lock", () => {
      const merged = Object.entries({ ...readSubCache(cacheDir), ...updates }).sort((a, b) => b[1].seen_at - a[1].seen_at);
      let bytes = 0;
      writeSubCache(cacheDir, Object.fromEntries(merged.filter(([, value]) => (bytes += Buffer.byteLength(JSON.stringify(value))) <= 8 * 1024 * 1024)));
    }); } catch { /* Cache failure does not invalidate the streamed counters. */ }
  }

}

const EMPTY = () => ({
  models: {}, message_count: 0, tool_result_count: 0,
  started_at: null, ended_at: null, cwd: null, days: {},
  claude_reported_cost_usd: null, has_unknown_model_cost: null,
});

// ASENKRON: hook'lar zaten async. Transcript artık belleğe komple okunmuyor.
// cacheDir: alt-ajan özet önbelleğinin yazılacağı dizin (varsayılan ~/.claude).
// null verilirse önbellek tamamen kapanır (testler ve backfill için).
async function summarizeTranscript(filePath, { cacheDir, ownershipDir = cacheDir } = {}) {
  let claimsDir = ownershipDir;
  if (claimsDir === undefined) {
    const root = claudeDir();
    claimsDir = path.resolve(filePath).startsWith(path.join(root, "projects") + path.sep) ? root : null;
  }
  const ownsMessage = claimsDir ? messageOwner(claimsDir, path.resolve(filePath)) : undefined;
  const acc = createAccumulator({ ownsMessage });
  // Dosya yok/okunamıyor — sessizce boş özet döndür (hook bunu message_count===0 ile atlar)
  if (!(await streamInto(filePath, acc))) return EMPTY();
  let dir = cacheDir;
  if (dir === undefined) {
    try { dir = claudeDir(); } catch { dir = null; }
  }
  await addSubagents(filePath, acc, dir || null);
  return acc.finish();
}

module.exports = {
  summarizeTranscript, summarizeLines, createAccumulator, tzOffsetMinutes,
  listSubagentFiles, SUB_MAX_FILES, SUB_MAX_DEPTH, SUB_CACHE_NAME,
};
