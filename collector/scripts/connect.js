#!/usr/bin/env node
// /usagex-connect <kod> — telefonda üretilen 8 karakterli eşleştirme kodunu kullanarak
// bu cihazı kullanıcının hesabına bağlar. Mac/Linux/Windows fark etmez.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { claudeDir } = require("../lib/config");

const PAIR_URL = "https://usagex.dijitalpi.com/v1/pairing/claim";

function platformName() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

async function main() {
  const code = (process.argv[2] || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    console.error("Kullanım: node connect.js <8-karakterli-kod>\nKodu UsagEX uygulamasında Ayarlar > Bilgisayar bağla'dan al.");
    process.exit(1);
  }

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    res = await fetch(PAIR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, platform: platformName(), machine: os.hostname() }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.error("Sunucuya ulaşılamadı:", e.message || e);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(res.status === 401
      ? "Kod geçersiz ya da süresi dolmuş. Uygulamadan yeni kod al."
      : `Sunucu hatası: ${res.status}`);
    process.exit(1);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    console.error("Sunucu beklenmeyen bir yanıt döndü (JSON değil). Tekrar dene.");
    process.exit(1);
  }
  const device_token = data && data.device_token;
  if (typeof device_token !== "string" || !device_token) {
    console.error("Sunucu yanıtında cihaz token'ı yok. Eşleştirme tamamlanmadı.");
    process.exit(1);
  }
  // ingest_url yalnızca https olmalı — aksi halde cihaz token'ı düz metin gidebilir.
  let ingest_url = "https://usagex.dijitalpi.com/ingest";
  if (typeof data.ingest_url === "string" && /^https:\/\//i.test(data.ingest_url)) {
    ingest_url = data.ingest_url;
  }
  const cfgPath = path.join(claudeDir(), "usagex.json");
  const config = {
    enabled: true,
    ingest_url,
    device_token,
    send_project_names: true,
  };
  // Sadece-sahip (0600) — cihaz token'ı gizli, diğer yerel kullanıcılar okuyamaz
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch {} // mevcut dosya varsa da sıkılaştır
  console.log(`✔ Cihaz bağlandı → ${cfgPath}`);
  console.log("Bundan sonra her Claude Code oturumu limit ve kullanım verini gönderecek.");

  // Rapor ilk günden dolu gelsin: son 90 günün transcript'lerini hemen gönder.
  // (Claude Code eski transkriptleri ~30 günde temizler; 90 istemek zarar vermez,
  //  ne varsa onu gönderir. session_id upsert — tekrar çalışsa da güvenli.)
  console.log("Geçmiş 90 günün oturumları gönderiliyor…");
  try {
    const { spawnSync } = require("child_process");
    spawnSync(process.execPath, [path.join(__dirname, "backfill.js"), "90"], {
      stdio: "inherit", timeout: 5 * 60 * 1000,
    });
  } catch {}

  console.log("Test için: node \"" + path.join(__dirname, "ping.js") + "\"");
}

main().catch((e) => {
  console.error("Beklenmeyen hata:", (e && e.message) || e);
  process.exit(1);
});
