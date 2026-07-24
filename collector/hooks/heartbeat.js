#!/usr/bin/env node
// SessionStart + Stop hook — oturumu ASLA bloklamaz: her hata yolu sessizce exit 0.
// Stop her asistan cevabında tetiklenir; shouldHeartbeat 5 dk'lık throttle uygular (state.js HEARTBEAT_MIN_INTERVAL_MS).
const path = require("path");
const { loadConfig } = require("../lib/config");
const { shouldHeartbeat } = require("../lib/state");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload, sessionPayload } = require("../lib/payload");
const { summarizeTranscript } = require("../lib/transcript");
const { estimateCostUsd } = require("../lib/pricing");
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
  if (!shouldHeartbeat()) return;

  let input = {};
  try { input = JSON.parse(await readStdin()); } catch {}
  const event = input.hook_event_name === "SessionStart" ? "session-start" : "stop";

  const plan_usage = await getPlanUsage();

  // CANLI SAYAÇ: transcript elimizdeyse yüzdeyle birlikte oturumun O ANKİ token
  // özetini de gönder — "bugün" rakamı oturum kapanana kadar donuk kalmasın
  // (kullanıcı saatlerce süren oturumda app'te eski sayı görüyordu). Sunucu
  // upsert'i idempotent: aynı oturum/gün satırı güncellenir, çifte sayım olmaz.
  if (input.transcript_path) {
    try {
      const summary = summarizeTranscript(input.transcript_path);
      if (summary.message_count > 0) {
        summary.project = path.basename(summary.cwd || input.cwd || "unknown");
        const payload = sessionPayload({
          session_id: input.session_id || path.basename(input.transcript_path, ".jsonl"),
          summary,
          est_cost_usd: estimateCostUsd(summary.models),
          plan_usage,
          config,
        });
        payload.source = event; // plan_snapshots.source izi (heartbeat mi, kapanış mı)
        await sendPayload(payload, config);
        return;
      }
    } catch {} // transcript okunamadı — aşağıdaki yüzde-yalnız yola düş
  }

  if (!plan_usage) return; // endpoint kırık/token yok — sessizce geç, transcript yolu etkilenmez
  await sendPayload(snapshotPayload(plan_usage, { source: event }), config);
}

main().catch(() => {}).finally(() => process.exit(0));
