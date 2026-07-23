#!/usr/bin/env node
// Son N günün transcript'lerini toplu gönderir (varsayılan 90).
// API session_id ile upsert yaptığı için tekrar çalıştırmak güvenlidir.
const fs = require("fs");
const path = require("path");
const { loadConfig, claudeDir } = require("../lib/config");
const { summarizeTranscript } = require("../lib/transcript");
const { estimateCostUsd } = require("../lib/pricing");
const { sessionPayload } = require("../lib/payload");
const { sendPayload } = require("../lib/sender");

async function main() {
  let days = parseInt(process.argv[2], 10);
  if (!Number.isFinite(days) || days <= 0) days = 90;
  const config = loadConfig();
  if (!config) {
    console.error("Config bulunamadı ya da devre dışı: ~/.claude/usagex.json — önce /usagex-connect çalıştır.");
    process.exit(1);
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const projectsDir = path.join(claudeDir(), "projects");
  let sent = 0, queued = 0, skipped = 0;

  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch {
    console.error(`Transcript klasörü yok: ${projectsDir}`);
    process.exit(1);
  }

  for (const d of dirs) {
    const dirPath = path.join(projectsDir, d);
    let files = [];
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) { skipped++; continue; }
        const summary = summarizeTranscript(filePath);
        if (summary.message_count === 0) { skipped++; continue; }
        summary.project = path.basename(summary.cwd || "unknown");
        const payload = sessionPayload({
          session_id: path.basename(file, ".jsonl"),
          summary,
          est_cost_usd: estimateCostUsd(summary.models),
          plan_usage: null,
          config,
        });
        (await sendPayload(payload, config)) ? sent++ : queued++;
      } catch { skipped++; }
    }
  }
  console.log(`Gönderilen: ${sent} · Kuyruğa yazılan: ${queued} · Atlanan: ${skipped}`);
}

main().catch((e) => {
  console.error(`Beklenmeyen hata: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
