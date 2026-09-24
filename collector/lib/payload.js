const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { estimateCostUsd, PRICING_VERSION } = require("./pricing");

// Claude Code'un GERÇEK ilk kullanım tarihi (~/.claude.json bunu transkriptler
// silinse bile hatırlar) — sunucudaki "tecrübe" metriği ilk transkript değil
// gerçek başlangıçtan saysın. Okunamazsa null (opsiyonel alan).
// CLAUDE_CONFIG_DIR ayarlıysa .claude.json ONUN içindedir (config.js:claudeDir ile
// aynı mantık). Yoksa ev dizininde: ~/.claude.json (~/.claude/ ALTINDA değil).
function claudeJsonPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

const _firstUsedCache = new Map(); // yol -> değer (env test içinde değişebiliyor)
function claudeFirstUsedAt() {
  const p = claudeJsonPath();
  if (_firstUsedCache.has(p)) return _firstUsedCache.get(p);
  let out = null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const cands = [j.claudeCodeFirstTokenDate, j.firstStartTime]
      .map((v) => (v ? Date.parse(v) : NaN))
      .filter((t) => Number.isFinite(t) && t > Date.parse("2020-01-01") && t <= Date.now());
    if (cands.length) out = new Date(Math.min(...cands)).toISOString();
  } catch {}
  _firstUsedCache.set(p, out);
  return out;
}

// send_project_names=false iken proje adı geri döndürülemez kısa hash'e çevrilir
// (klasör adları müşteri/proje ismi içerebilir — veri minimizasyonu).
// Ad BİLİNMİYORSA boş dizge döner, "unknown" DEĞİL: backfill cwd'yi okuyamadığında
// "unknown" gönderiyor ve sunucudaki upsert hook'un yazdığı DOĞRU adı eziyordu.
// Boş değeri sunucu "dokunma" olarak yorumlar (bkz. SERVER2 notu).
function projectLabel(name, sendPlain) {
  if (!name) return "";
  if (sendPlain) return name;
  return "p-" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
}

// Bilgisayar adı da kişisel veri: "MacBook Pro — Ahmet Yılmaz" gibi adlar yaygın.
// send_project_names=false diyen kullanıcı proje adlarını sakladığını sanırken
// hostname'i açık gönderiyorduk. Aynı tercih makine adını da kapsar.
function machineLabel(sendPlain, host = os.hostname()) {
  if (!host) return "";
  if (sendPlain) return host;
  return "pc-" + crypto.createHash("sha256").update(host).digest("hex").slice(0, 6);
}

// Maliyeti 6 ondalıkla taşı — sente yuvarlamak gün dökümünü siliyordu ($0.004 → $0.00).
const round6 = (n) => n == null ? null : Math.round(n * 1e6) / 1e6;

// days[] ÜST SINIRI (R16). Aylarca açık kalan ya da çok eski bir transkriptten
// üretilen oturum yüzlerce gün taşıyabiliyor; gövde /ingest tavanını aşınca
// sunucu 413 döndürüyor, collector 413'ü KALICI sayıp oturumu tamamen düşürüyordu.
// İki kademe: önce gün SAYISI, sonra gerçek gövde boyutu.
const MAX_DAYS = 400;
// Sunucu /ingest tavanı 1 MB; 900 KB pay bırakır (başlık + sunucu tarafı fark).
const MAX_BODY_BYTES = 900 * 1024;

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

// null döner: gönderilecek Claude verisi YOK (yalnız ollama/qwen gibi yerel
// modellerle çalışılmış oturum). Eskiden models:{} ile boş satır gidiyor,
// sunucuda "0 token" oturumlar birikiyordu.
function sessionPayload({ session_id, summary, plan_usage, config }) {
  const models = filterClaudeModels(summary.models);
  if (Object.keys(models).length === 0 && !summary.deduplicated_messages) return null;

  // Gün bazlı döküm: sunucu token'ları oturumun bittiği güne değil, GERÇEKLEŞTİĞİ
  // güne yazar (günlerce açık kalan oturum tek günün raporunu şişirmesin).
  // Üst düzey toplam alanlar eski sunucularla geriye uyumluluk için kalır.
  let days = Object.entries(summary.days || {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, d]) => {
      const dayModels = filterClaudeModels(d.models);
      return {
        day,
        // PC'nin o GÜNKÜ UTC offset'i (dakika, doğu pozitif). `day` aynen kalıyor —
        // sunucu bunu otorite kabul ediyor, sözleşme bozulmasın. Offset ek bilgi:
        // sunucu gerekirse günü UTC'ye çevirebilsin diye. (Sunucu henüz kullanmıyor.)
        tz_offset_minutes: d.tz_offset_minutes ?? null,
        started_at: d.started_at,
        ended_at: d.ended_at,
        message_count: d.message_count,
        models: dayModels,
        est_cost_usd: estimateCostUsd(dayModels),
      };
    })
    // Claude modeli olmayan günler tamamen elenir (yukarıdaki oturum kuralıyla aynı).
    .filter((d) => Object.keys(d.models).length > 0 || summary.deduplicated_messages);

  // Üst düzey maliyet artık gün dökümüyle AYNI (filtrelenmiş) sözlükten geliyor:
  // eskiden üst düzey filtresiz, günler filtreliydi ve ikisi tutmuyordu.
  let est_cost_usd = round6(estimateCostUsd(models));

  // cost-state OTORİTE: Claude Code'un kendi defteri varsa toplam maliyet odur.
  // Gün kırılımını cost-state vermediği için günleri kendi tahminimizin ORANIYLA
  // ölçekliyoruz — günlerin toplamı otoriter toplama eşit kalsın.
  // DİKKAT: Number(null) === 0. `claude_reported_cost_usd` yoksa (eski özet,
  // cost-state içermeyen transkript) tip kontrolü yapılmazsa maliyet SIFIRLANIR.
  const ham = summary.claude_reported_cost_usd;
  const reported =
    typeof ham === "number" && Number.isFinite(ham) && ham > 0 ? ham : null;
  if (reported !== null && summary.has_unknown_model_cost !== true && summary.cost_state_covers_usage !== false) {
    est_cost_usd = round6(reported);
    const allKnown = days.every(d => d.est_cost_usd != null);
    const tahminToplam = days.reduce((s, d) => s + (d.est_cost_usd || 0), 0);
    if (allKnown && tahminToplam > 0) {
      let cumulative = 0, allocated = 0;
      for (const d of days) {
        cumulative += d.est_cost_usd;
        const target = Math.round(est_cost_usd * 1e6 * cumulative / tahminToplam);
        d.est_cost_usd = (target - allocated) / 1e6;
        allocated = target;
      }
    } else if (days.length === 1) {
      // Only a single day can receive the total without inventing a date split.
      days[0].est_cost_usd = est_cost_usd;
    } else {
      for (const d of days) d.est_cost_usd = null;
    }
  }
  // Allocate over the complete history before retaining the newest days.
  if (days.length > MAX_DAYS) days = days.slice(-MAX_DAYS);

  const payload = {
    schema_version: 1,
    kind: "session",
    generated_at: new Date().toISOString(),
    machine: machineLabel(config.send_project_names),
    source: "session-end",
    session_id,
    project: projectLabel(summary.project, config.send_project_names),
    started_at: summary.started_at,
    ended_at: summary.ended_at,
    message_count: summary.message_count,
    // Araç sonucu satırları message_count'tan ayrıldı; sayı yine de bilgi taşıyor.
    tool_result_count: summary.tool_result_count ?? null,
    models,
    est_cost_usd,
    // Bu satırdaki maliyetleri üreten fiyat kuşağı (lib/pricing.js:PRICING_VERSION).
    // Sunucu böylece eski tarifeyle yazılmış kayıtları ayırt edebilir ve tarife
    // değişince hangi kayıtların yeniden fiyatlanması gerektiğini bilir.
    // cost-state OTORİTE olsa bile alan DOLU gider: gün kırılımı yine bizim
    // tahminimizin oranıyla ölçekleniyor, yani kuşak o satırda da etkili.
    pricing_version: PRICING_VERSION,
    // Claude Code'un bildirdiği toplam (varsa) — sunucu tahminle karşılaştırabilsin.
    claude_reported_cost_usd: reported !== null ? round6(reported) : null,
    has_unknown_model_cost: summary.has_unknown_model_cost === true || est_cost_usd == null,
    plan_usage,
    days,
  };

  // 2. kademe: gerçek gövde boyutu. Tek bir gün bile çok modelli olabildiği için
  // sayı tavanı tek başına yetmiyor. Eşiği geçerken günleri YARIYA indiririz
  // (en yeniler kalır) — üst düzey toplamlar (est_cost_usd, models) DOKUNULMADAN
  // kalır, yani oturumun toplamı doğru gider, yalnız gün kırılımı kısalır.
  while (days.length > 1 && Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_BODY_BYTES) {
    days = days.slice(-Math.ceil(days.length / 2));
    payload.days = days;
  }
  return payload;
}

module.exports = {
  snapshotPayload, sessionPayload, projectLabel, machineLabel, filterClaudeModels,
  MAX_DAYS, MAX_BODY_BYTES,
};
