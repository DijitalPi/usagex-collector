#!/usr/bin/env node
// launchd/systemd poller — hook'lardan bağımsız, periyodik taze limit gönderir.
// Hook heartbeat'iyle aynı throttle state'ini paylaşır; çift gönderim olmaz.
// Windows Görev Zamanlayıcı ortamı --env=AD=değer ile verir (lib/task-env.js).
require("../lib/task-env").applyEnvArgs();
const { loadConfig } = require("../lib/config");
const { heartbeatDue, markHeartbeatSent } = require("../lib/state");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload } = require("../lib/payload");
const { sendPayload } = require("../lib/sender");

async function main() {
  const config = loadConfig();
  if (!config) return;
  // 4 dk: launchd'nin 5 dk'lık zamanlama sapmasında turların atlanmaması için
  if (!heartbeatDue({ intervalMs: 4 * 60 * 1000 })) return;
  const plan_usage = await getPlanUsage();
  // Damga GÖNDERİMDEN SONRA: veri gelmediyse slotu yakmak, taze veri geldiğinde
  // 4 dakika daha beklemek demekti (bulgu 7).
  if (!plan_usage || plan_usage.stale) return;
  const sonuc = await sendPayload(snapshotPayload(plan_usage, { source: "poller" }), config);
  // Damga yalnız TESLİM edilende: kalıcı düşürmede (dropped) pencereyi yakmak,
  // sunucu paketi kabul etmezken 4 dk daha susmak demekti (R23).
  if (sonuc && (sonuc.status === "sent" || sonuc.status === "queued")) markHeartbeatSent();
}

main().catch(() => {}).finally(() => process.exit(0));
