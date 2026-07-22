#!/usr/bin/env node
// launchd/systemd poller — hook'lardan bağımsız, periyodik taze limit gönderir.
// Hook heartbeat'iyle aynı throttle state'ini paylaşır; çift gönderim olmaz.
const { loadConfig } = require("../lib/config");
const { shouldHeartbeat } = require("../lib/state");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload } = require("../lib/payload");
const { sendPayload } = require("../lib/sender");

async function main() {
  const config = loadConfig();
  if (!config) return;
  // 4 dk: launchd'nin 5 dk'lık zamanlama sapmasında turların atlanmaması için
  if (!shouldHeartbeat({ intervalMs: 4 * 60 * 1000 })) return;
  const plan_usage = await getPlanUsage();
  if (!plan_usage) return;
  await sendPayload(snapshotPayload(plan_usage, { source: "poller" }), config);
}

main().catch(() => {}).finally(() => process.exit(0));
