#!/usr/bin/env node
// Kurulum doğrulama: config'i okur, backend'e test snapshot'ı gönderir.
// Hook'ların aksine sonucu stdout'a BASAR (kullanıcıya geri bildirim için).
const { loadConfig } = require("../lib/config");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload } = require("../lib/payload");
const { sendPayload } = require("../lib/sender");

async function main() {
  const config = loadConfig();
  if (!config) {
    console.error("HATA: ~/.claude/usagex.json (ya da eski clmt.json) yok, eksik veya enabled=false");
    process.exit(1);
  }
  const plan_usage = await getPlanUsage();
  if (!plan_usage) {
    console.error(
      "UYARI: limit verisi alınamadı (token bulunamadı veya endpoint yanıt vermedi).\n" +
      "Claude Code'da giriş yaptığından emin ol. Test yine de boş snapshot ile deneniyor."
    );
  }
  const ok = await sendPayload(snapshotPayload(plan_usage, { source: "ping" }), config);
  if (ok) {
    console.log("OK: backend'e ulaşıldı" + (plan_usage ? ` (oturum %${plan_usage.session_pct}, hafta %${plan_usage.week_pct})` : ""));
  } else {
    console.error("HATA: backend'e ulaşılamadı — payload kuyruğa yazıldı. URL/token'ı kontrol et.");
    process.exit(1);
  }
}

main();
