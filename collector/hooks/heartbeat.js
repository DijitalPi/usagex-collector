#!/usr/bin/env node
// SessionStart + Stop hook — oturumu ASLA bloklamaz: her hata yolu sessizce exit 0.
// Stop her asistan cevabında tetiklenir; shouldHeartbeat 5 dk'lık throttle uygular (state.js HEARTBEAT_MIN_INTERVAL_MS).
const { loadConfig } = require("../lib/config");
const { shouldHeartbeat } = require("../lib/state");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload } = require("../lib/payload");
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

  const plan_usage = await getPlanUsage();
  if (!plan_usage) return; // endpoint kırık/token yok — sessizce geç, transcript yolu etkilenmez

  let event = "stop";
  try {
    const input = JSON.parse(await readStdin());
    if (input.hook_event_name === "SessionStart") event = "session-start";
  } catch {}
  await sendPayload(snapshotPayload(plan_usage, { source: event }), config);
}

main().catch(() => {}).finally(() => process.exit(0));
