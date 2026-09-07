#!/usr/bin/env node
// SessionEnd hook — oturumu ASLA bloklamaz: her hata yolu sessizce exit 0.
const path = require("path");
const { loadConfig } = require("../lib/config");
const { summarizeTranscript } = require("../lib/transcript");
const { getPlanUsage } = require("../lib/oauth-usage");
// Back-off'tan dönen bayat yüzde (stale) sunucuya taze snapshot olarak gitmesin
const dropStale = (u) => (u && u.stale ? null : u);
const { snapshotPayload, sessionPayload } = require("../lib/payload");
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

  // stdin bozuk gelirse (kısa okuma, kırpılmış JSON) main() throw ediyor ve
  // .catch(() => {}) yüzünden oturum SESSİZCE raporlanmadan kapanıyordu.
  // Artık en azından limit yüzdesi gönderilir — transkript kaybını telafi eder.
  let input = null;
  try { input = JSON.parse(await readStdin()); } catch {}
  if (!input || typeof input !== "object") input = {};

  // force: oturumun SON yüzdesi taze olsun — cache'li değer eşik geçişini
  // gizlerse sunucu onu ancak kullanıcı app'i açınca öğreniyordu
  const plan_usage = dropStale(await getPlanUsage({ force: true }));

  if (!input.transcript_path) {
    if (plan_usage) await sendPayload(snapshotPayload(plan_usage, { source: "session-end" }), config);
    return;
  }

  const summary = await summarizeTranscript(input.transcript_path);
  if (summary.message_count === 0 && Object.keys(summary.models).length === 0) return;
  // "unknown" YAZMA: sunucudaki upsert hook'un yazdığı doğru adı eziyordu (bulgu 21).
  const cwd = summary.cwd || input.cwd;
  summary.project = cwd ? path.basename(cwd) : "";

  const payload = sessionPayload({
    session_id: input.session_id || path.basename(input.transcript_path, ".jsonl"),
    summary,
    plan_usage,
    config,
  });
  // null: oturumda hiç Claude modeli yok (yalnız yerel model) — oturum satırı
  // gitmez ama elimizdeki taze yüzde yine de değerli.
  if (!payload) {
    if (plan_usage) await sendPayload(snapshotPayload(plan_usage, { source: "session-end" }), config);
    return;
  }

  await sendPayload(payload, config);
}

main().catch(() => {}).finally(() => process.exit(0));
