#!/usr/bin/env node
// /usagex-connect <kod> — telefonda üretilen 8 karakterli eşleştirme kodunu kullanarak
// bu cihazı kullanıcının hesabına bağlar. Mac/Linux/Windows fark etmez.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { claudeDir, readRawConfig } = require("../lib/config");
const { machineLabel } = require("../lib/payload");
const { nodeVersionProblem } = require("../lib/node-version");

const PAIR_URL = "https://usagex.dijitalpi.com/v1/pairing/claim";

function platformName() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

// Bu kurulumun KARARLI kimliği. Sunucu cihazları hostname ile tekilleştiriyordu:
// "MacBook-Pro" adlı iki ayrı makine (ya da aynı makinedeki iki kullanıcı hesabı)
// aynı cihaz kaydını ve token'ı paylaşıyordu. Hostname + kullanıcı adı + platform
// + ev dizini birleşimi bunları ayırır; hash olduğu için hiçbiri düz metin gitmez.
// Ayırıcı NUL: hiçbir bileşende geçemez, dolayısıyla farklı bileşen dizilimleri
// aynı karışıma düşemez ("ab"+"c" ile "a"+"bc" ayrı kimlikler).
function machineId() {
  let kullanici = "";
  try { kullanici = os.userInfo().username || ""; } catch {}
  const ham = [os.hostname(), kullanici, process.platform, os.homedir()].join("\u0000");
  return crypto.createHash("sha256").update(ham).digest("hex").slice(0, 16);
}

// Mevcut gizlilik tercihi: yeniden bağlanmada makine adının hash'lenip
// hash'lenmeyeceğini de bu belirler (proje adlarıyla aynı anahtar).
// readRawConfig ile okunur — yalnız usagex.json'a bakmak, rebrand ÖNCESİ
// kurulumlarda (yalnız clmt.json var) send_project_names:false tercihini
// sessizce sıfırlıyordu: kullanıcı kod girer girmez proje ve makine adları
// açık gitmeye başlıyordu (R15). Arama sırası config.js ile AYNI.
function mevcutTercih(dir = claudeDir()) {
  const raw = readRawConfig(dir);
  const eski = raw && raw.cfg;
  return !(eski && eski.send_project_names === false);
}

async function main() {
  const sürümSorunu = nodeVersionProblem();
  if (sürümSorunu) {
    console.error(`✗ ${sürümSorunu}`);
    process.exit(1);
  }

  const code = (process.argv[2] || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    console.error("Kullanım: node connect.js <8-karakterli-kod>\nKodu UsagEX uygulamasında Ayarlar > Bilgisayar bağla'dan al.");
    process.exit(1);
  }

  const cfgPath = path.join(claudeDir(), "usagex.json");
  // Yeniden bağlanma mevcut GİZLİLİK tercihini SIFIRLIYORDU: proje adlarını
  // hash'lettiren kullanıcı, kod girer girmez adları açık göndermeye başlıyordu.
  // Tercih usagex.json'da da clmt.json'da da olabilir (bkz. mevcutTercih).
  const send_project_names = mevcutTercih(claudeDir());
  if (!send_project_names) {
    console.log("Not: mevcut ayardaki send_project_names=false korundu (proje ve bilgisayar adları hash'lenmeye devam edecek).");
  }

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    res = await fetch(PAIR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        platform: platformName(),
        machine: machineLabel(send_project_names),
        // Cihaz tekilleştirme anahtarı (bkz. machineId) — sunucu bunu tanımıyorsa
        // yok sayar ve eski hostname davranışına düşer.
        machine_id: machineId(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.error("Sunucuya ulaşılamadı:", e.message || e);
    process.exit(1);
  }

  // HTTP kodları kullanıcının GERÇEKTEN yapacağı işe çevrilir; "Sunucu hatası: 400"
  // kimseye ne yapacağını söylemiyordu.
  if (!res.ok) {
    const mesajlar = {
      400: "Kod biçimi geçersiz. 8 karakterli kodu uygulamadaki gibi yazın (harf/rakam).",
      401: "Kod geçersiz ya da süresi dolmuş. Uygulamadan yeni kod alın.",
      404: "Kod bulunamadı. Uygulamadan yeni kod alın.",
      409: "Bu kod başka bir bilgisayar tarafından kullanılmış. Uygulamadan yeni kod alın.",
      429: "Çok fazla deneme yapıldı. Bir dakika bekleyip tekrar deneyin.",
    };
    const varsayilan = res.status >= 500
      ? `Sunucu şu an yanıt veremiyor (${res.status}). Birazdan tekrar deneyin.`
      : `Sunucu hatası: ${res.status}`;
    console.error(mesajlar[res.status] || varsayilan);
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
  const config = {
    enabled: true,
    ingest_url,
    device_token,
    send_project_names,
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

// require() ile çekildiğinde (test) main çalışmasın — machineId gibi saf
// yardımcılar ağa çıkmadan doğrulanabilsin.
if (require.main === module) {
  main().catch((e) => {
    console.error("Beklenmeyen hata:", (e && e.message) || e);
    process.exit(1);
  });
}

module.exports = { machineId, platformName, mevcutTercih };
