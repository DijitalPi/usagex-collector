#!/usr/bin/env node
// SessionEnd hook — oturumu ASLA bloklamaz: her hata yolu sessizce exit 0.
const path = require("path");
const { loadConfig } = require("../lib/config");
const { summarizeTranscript } = require("../lib/transcript");
const { estimateCostUsd } = require("../lib/pricing");
const { getPlanUsage } = require("../lib/oauth-usage");
const { sessionPayload } = require("../lib/payload");
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

  const input = JSON.parse(await readStdin());
  if (!input.transcript_path) return;

  const summary = summarizeTranscript(input.transcript_path);
  if (summary.message_count === 0) return;
  summary.project = path.basename(summary.cwd || input.cwd || "unknown");

  const payload = sessionPayload({
    session_id: input.session_id || path.basename(input.transcript_path, ".jsonl"),
    summary,
    est_cost_usd: estimateCostUsd(summary.models),
    plan_usage: await getPlanUsage(),
    config,
  });

  await sendPayload(payload, config);
}

main().catch(() => {}).finally(() => process.exit(0));
