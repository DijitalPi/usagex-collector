#!/usr/bin/env node
// SessionStart + Stop hook — oturumu ASLA bloklamaz: her hata yolu sessizce exit 0.
// Stop her asistan cevabında tetiklenir. İKİ KATMANLI throttle (state.js):
//   · plan_usage yüzde snapshot'ı  → KÜRESEL 5 dk (shouldHeartbeat)
//   · transcript/oturum özeti      → session_id BAZLI 5 dk (shouldSendSession)
// Eskiden ikisi de küresel throttle'a bağlıydı: aynı anda üç oturum açıksa yalnız
// birinin özeti gidiyor, diğer ikisi 5 dk boyunca hiç raporlanmıyordu.
const path = require("path");
const { loadConfig } = require("../lib/config");
const {
  heartbeatDue, markHeartbeatSent, sessionDue, markSessionSent,
} = require("../lib/state");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload, sessionPayload } = require("../lib/payload");
const { summarizeTranscript } = require("../lib/transcript");
const { sendPayload } = require("../lib/sender");

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
  const snapshotSirasi = heartbeatDue();
  if (!oturumSirasi && !snapshotSirasi) return;

  // plan_usage yalnız KÜRESEL pencere açıkken istenir: üç paralel oturum aynı
  // anda kapanınca sunucuya üç ayrı snapshot yazılıyordu (aynı yüzde, üç satır).
  // Back-off penceresinden dönen bayat değer (stale) sunucuya TAZE damgayla
  // yazılmasın: eşik/reset bildirimleri ve NOW ekranı saatler eski yüzdeye
  // "canlı" muamelesi yapardı. Bayatı yalnız yerel kullanım için taşırız.
  const ham = snapshotSirasi ? await getPlanUsage() : null;
  const plan_usage = ham && !ham.stale ? ham : null;

  // CANLI SAYAÇ: transcript elimizdeyse yüzdeyle birlikte oturumun O ANKİ token
  // özetini de gönder — "bugün" rakamı oturum kapanana kadar donuk kalmasın
  // (kullanıcı saatlerce süren oturumda app'te eski sayı görüyordu). Sunucu
  // upsert'i idempotent: aynı oturum/gün satırı güncellenir, çifte sayım olmaz.
  if (oturumSirasi) {
    try {
      const summary = await summarizeTranscript(input.transcript_path);
      // payload null: oturumda hiç Claude modeli yok (yalnız yerel model) — gönderme.
      const payload = summary.message_count > 0 || Object.keys(summary.models).length > 0
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
      }
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
