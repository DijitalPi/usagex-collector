#!/usr/bin/env node
// SessionStart + Stop hook — oturumu ASLA bloklamaz: her hata yolu sessizce exit 0.
// Stop her asistan cevabında tetiklenir. İKİ KATMANLI throttle (state.js):
//   · plan_usage yüzde snapshot'ı  → KÜRESEL 2 dk (heartbeatDue) — 429 sonrası 60 dk boyunca 5 dk
//   · transcript/oturum özeti      → session_id BAZLI 5 dk (sessionDue)
// Eskiden ikisi de küresel throttle'a bağlıydı: aynı anda üç oturum açıksa yalnız
// birinin özeti gidiyor, diğer ikisi 5 dk boyunca hiç raporlanmıyordu.
// Snapshot yolu 5 dk'dan 2 dk'ya indirildi: eşik bildirimleri (%80/%90) yüzde
// tazelenene kadar bekliyordu, en kötü durumda gecikme 5 dk + cache yaşıydı.
// Oturum ÖZETİ 5 dk kalır — o pahalı yol (transkript okuma + büyük gövde) ve
// bildirim gecikmesiyle ilgisi yok.
const path = require("path");
const { loadConfig } = require("../lib/config");
const {
  heartbeatDue, markHeartbeatSent, sessionDue, markSessionSent,
} = require("../lib/state");
const { getPlanUsage, recently429, CACHE_TTL_MS } = require("../lib/oauth-usage");
const { snapshotPayload, sessionPayload } = require("../lib/payload");
const { summarizeTranscript } = require("../lib/transcript");
const { sendPayload } = require("../lib/sender");

// Oturum aktifken plan_usage cache tazelik penceresi (state.js heartbeat throttle'ı ile hizalı).
const AKTIF_TTL_MS = 2 * 60 * 1000;

// UYARLANABİLİR TEMPO: 2 dk'lık hızlı tempo bazı kurulumlarda 429'u besliyor
// (back-off bitiyor, 2 dk sonra tekrar soruluyor, yine 429). Son 60 dk içinde
// 429 görüldüyse hem cache TTL'i hem de KÜRESEL heartbeat aralığı 5 dk'ya döner;
// pencere dolunca kendiliğinden 2 dk'ya iner. Damga oauth-usage cache'inde
// (last_429_at) durur — hook'lar ayrı süreçler, tek durum kaynağı o dosya.
// Okuma hook'u ASLA düşürmemeli: dosya bozuksa/modül eskiyse hızlı tempoda kal.
function yavasTempo() {
  try { return recently429(); } catch { return false; }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

async function main() {
  const config = loadConfig();
  if (!config) return;

  // stdin ARTIK throttle'dan önce okunuyor: oturum bazlı throttle için session_id lazım.
  let input = {};
  try { input = JSON.parse(await readStdin()); } catch {}
  const event = input.hook_event_name === "SessionStart" ? "session-start" : "stop";

  const session_id = input.transcript_path
    ? (input.session_id || path.basename(input.transcript_path, ".jsonl"))
    : null;
  // PEEK: throttle penceresini yalnız SORUYORUZ. Damga (mark*Sent) payload
  // gerçekten teslim edildikten sonra basılır — eskiden slot iş yapılmadan
  // yanıyor ve yeni oturumun ilk 5 dakikası hiç raporlanmıyordu.
  const oturumSirasi = !!input.transcript_path && sessionDue(session_id);
  // 429 penceresindeyken küresel snapshot aralığı da 5 dk sayılır: yalnız TTL'i
  // uzatmak yetmez, hook 2 dk'da bir yine "sıra bende" deyip ağa çıkmayı denerdi.
  const yavas = yavasTempo();
  const ttlMs = yavas ? Math.max(AKTIF_TTL_MS, CACHE_TTL_MS) : AKTIF_TTL_MS;
  const snapshotSirasi = heartbeatDue(yavas ? { intervalMs: ttlMs } : {});
  if (!oturumSirasi && !snapshotSirasi) return;

  // plan_usage yalnız KÜRESEL pencere açıkken istenir: üç paralel oturum aynı
  // anda kapanınca sunucuya üç ayrı snapshot yazılıyordu (aynı yüzde, üç satır).
  // Back-off penceresinden dönen bayat değer (stale) sunucuya TAZE damgayla
  // yazılmasın: eşik/reset bildirimleri ve NOW ekranı saatler eski yüzdeye
  // "canlı" muamelesi yapardı. Bayatı yalnız yerel kullanım için taşırız.
  // ttlMs: oturum aktif (Stop/SessionStart hook'u geldi) → 2 dk'lık tazelik
  // penceresi (son 60 dk'da 429 görüldüyse 5 dk). Varsayılan 5 dk'lık cache eşik
  // geçişini bir tur geciktiriyordu.
  // Uç yine korunuyor: 60 sn'den taze okumada getPlanUsage zaten ağa çıkmaz,
  // 429 back-off penceresi de aynen geçerli.
  const ham = snapshotSirasi ? await getPlanUsage({ ttlMs }) : null;
  const plan_usage = ham && !ham.stale ? ham : null;

  // CANLI SAYAÇ: transcript elimizdeyse yüzdeyle birlikte oturumun O ANKİ token
  // özetini de gönder — "bugün" rakamı oturum kapanana kadar donuk kalmasın
  // (kullanıcı saatlerce süren oturumda app'te eski sayı görüyordu). Sunucu
  // upsert'i idempotent: aynı oturum/gün satırı güncellenir, çifte sayım olmaz.
  if (oturumSirasi) {
    try {
      const summary = await summarizeTranscript(input.transcript_path);
      // payload null: oturumda hiç Claude modeli yok (yalnız yerel model) — gönderme.
      const payload = summary.deduplicated_messages || summary.message_count > 0 || Object.keys(summary.models).length > 0
        ? sessionPayload({ session_id, summary: withProject(summary, input), plan_usage, config })
        : null;
      if (payload) {
        payload.source = event; // plan_snapshots.source izi (heartbeat mi, kapanış mı)
        const sonuc = await sendPayload(payload, config);
        // COMMIT: "teslim edildi" = gönderildi ya da kuyruğa yazıldı. Yalnız 200'e
        // bağlasaydık çevrimdışı makinede her Stop hook'u aynı oturumun yeni bir
        // kopyasını kuyruğa yığardı.
        // Ama KALICI DÜŞÜRME (dropped: 400/413/415…) ya da auth_failed teslim
        // DEĞİLDİR: orada damgalamak oturumu 5 dk boyunca sessizce kaybettiriyordu.
        if (sonuc && (sonuc.status === "sent" || sonuc.status === "queued")) {
          markSessionSent(session_id);
          if (plan_usage) markHeartbeatSent();
        }
        return;
      } else if (summary.message_count > 0) { markSessionSent(session_id); }
    } catch {} // transcript okunamadı — aşağıdaki yüzde-yalnız yola düş
  }

  if (!snapshotSirasi) return;
  if (!plan_usage) return; // endpoint kırık/token yok/bayat — sessizce geç
  const sonuc = await sendPayload(snapshotPayload(plan_usage, { source: event }), config);
  // Aynı kural: düşürülen snapshot küresel pencereyi yakmasın (R23).
  if (sonuc && (sonuc.status === "sent" || sonuc.status === "queued")) markHeartbeatSent();
}

// Proje adı: transkriptin cwd'si, yoksa hook'un cwd'si. İkisi de yoksa BOŞ
// bırakılır — "unknown" göndermek sunucudaki doğru adı eziyordu (bulgu 21).
function withProject(summary, input) {
  const cwd = summary.cwd || input.cwd;
  summary.project = cwd ? path.basename(cwd) : "";
  return summary;
}

main().catch(() => {}).finally(() => process.exit(0));
