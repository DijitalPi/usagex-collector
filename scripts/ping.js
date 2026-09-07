#!/usr/bin/env node
// Kurulum doğrulama: config'i okur, backend'e test snapshot'ı gönderir.
// Hook'ların aksine sonucu stdout'a BASAR (kullanıcıya geri bildirim için).
const { loadConfig, readRawConfig, configProblem, claudeDir } = require("../lib/config");
const { tokenSource } = require("../lib/credentials");
const { getPlanUsage } = require("../lib/oauth-usage");
const { snapshotPayload } = require("../lib/payload");
const { sendPayload } = require("../lib/sender");

async function main() {
  const config = loadConfig();
  if (!config) {
    // Sebebi AÇIKÇA söyle: "yok, eksik veya enabled=false" üçlüsü kullanıcıyı
    // hangi şıkkın geçerli olduğunu tahmin etmeye zorluyordu (özellikle https kuralı).
    const raw = readRawConfig();
    const cfg = raw && raw.cfg;
    console.error(`HATA: config kullanılamıyor — ${configProblem(cfg)}`);
    console.error(`Dosya: ${raw ? raw.path : `${claudeDir()}/usagex.json (yok)`}`);
    // 401/403 sonrası sender kendini kapatmışsa suç ayarlarda değil: cihaz
    // sunucuda silinmiş olabilir. Kullanıcı doğru yere baksın.
    if (cfg && cfg.auth_failed_at) {
      console.error(
        "Bu bilgisayarın bağlantısı sunucu tarafından reddedildi (cihaz silinmiş ya da hesap kapanmış olabilir)."
      );
    }
    console.error("Düzeltmek için: /usagex-connect <8-karakterli-kod>");
    process.exit(1);
  }
  console.log(`Config: ${readRawConfig().path} → ${config.ingest_url}`);
  const kaynak = tokenSource(claudeDir());
  console.log(`Token kaynağı: ${kaynak}`);
  if (kaynak === "süresi dolmuş") {
    console.error(
      "UYARI: Claude oturum token'ının süresi dolmuş — limit yüzdeleri alınamaz.\n" +
      "Yeniden giriş gerekli: Claude Code'da `claude /login` çalıştırın."
    );
  }
  const plan_usage = await getPlanUsage();
  if (!plan_usage) {
    console.error(
      "UYARI: limit verisi alınamadı (token bulunamadı veya endpoint yanıt vermedi).\n" +
      "Claude Code'da giriş yaptığından emin ol. Test yine de boş snapshot ile deneniyor."
    );
  }
  // sendPayload artık { status } döndürüyor (R23): "sent" dışındaki her şey hata.
  const sonuc = await sendPayload(snapshotPayload(plan_usage, { source: "ping" }), config);
  if (sonuc && sonuc.status === "sent") {
    const bayat = plan_usage && plan_usage.stale ? " [cache — uç geçici erişilemez]" : "";
    console.log("OK: backend'e ulaşıldı" + (plan_usage ? ` (oturum %${plan_usage.session_pct}, hafta %${plan_usage.week_pct})${bayat}` : ""));
  } else {
    // sendPayload 401/403'te config'i kapatır; o durumda kuyruk YOK, mesaj başka.
    const sonrakiCfg = readRawConfig();
    if (sonrakiCfg && sonrakiCfg.cfg && sonrakiCfg.cfg.auth_failed_at) {
      console.error(
        "HATA: sunucu bu cihazı tanımıyor (401/403). Bağlantı devre dışı bırakıldı.\n" +
        "Yeniden bağlanmak için: /usagex-connect <8-karakterli-kod>"
      );
    } else if (sonuc && sonuc.status === "dropped") {
      // 400/413/415/422: ulaşıldı ama paket reddedildi — ağ sorunu değil, sürüm/biçim sorunu.
      console.error("HATA: sunucuya ulaşıldı ama paketi kabul etmedi. Collector sürümünü güncelle.");
    } else {
      console.error("HATA: backend'e ulaşılamadı — payload kuyruğa yazıldı. URL/token'ı kontrol et.");
    }
    process.exit(1);
  }
}

// Beklenmeyen hata da anlaşılır bir mesajla düşsün — çıplak stack trace basmasın.
main().catch((e) => {
  console.error(`HATA: beklenmeyen hata — ${(e && e.message) || e}`);
  process.exit(1);
});
