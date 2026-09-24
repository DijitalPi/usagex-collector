#!/usr/bin/env node
// Son N günün transcript'lerini toplu gönderir (varsayılan 90).
// API session_id ile upsert yaptığı için tekrar çalıştırmak güvenlidir.
//
// KUYRUĞA YAZMAZ. Ölçülen sorun: 4428 oturumluk bir çalıştırmada sunucunun
// hız sınırı (600/dk/IP) devreye girince "Gönderilen 598 · Kuyruğa yazılan 3813"
// çıktı; kuyruk kind başına 500'e kırpıldığı için eski günler kayboldu, kalanlar
// da Stop hook'larıyla 10'ar 10'ar aylarca akacaktı. Artık 429'da BEKLENİR ve
// aynı payload yeniden denenir (lib/sender.js:postDirect).
//
// Kullanım:  node scripts/backfill.js [gün] [--drain]
//   --drain : önce mevcut kuyruğu aynı hız kontrolüyle boşaltır (eski
//             çalıştırmalardan kalan backfill kayıtları için).
const fs = require("fs");
const path = require("path");
const { loadConfig, claudeDir, readRawConfig, configProblem } = require("../lib/config");
const { summarizeTranscript } = require("../lib/transcript");
const { sessionPayload, snapshotPayload } = require("../lib/payload");
const { postDirect, postOnce, drainQueue } = require("../lib/sender");

const SAAT_MS = 60 * 60 * 1000;
const ILERLEME_ADIMI = 50; // her bu kadar kayıtta bir stderr'e "312/4428"

// Ctrl-C: kuyruğa hiçbir şey yazılmadığı için yarıda kesmek güvenlidir —
// gönderilenler sunucuda, gönderilmeyenler bir sonraki çalıştırmada gider.
// İkinci Ctrl-C beklemeyi de keser.
let iptalIstendi = false;
function iptal() { return iptalIstendi; }
function iptalDinle() {
  process.on("SIGINT", () => {
    if (iptalIstendi) process.exit(130);
    iptalIstendi = true;
    yaz("\nDurduruluyor… (bir sonraki çalıştırma kaldığı yerden devam eder)");
  });
}

function yaz(mesaj) {
  try { process.stderr.write(mesaj + "\n"); } catch {}
}

// --drain seçicisi: kuyrukta backfill imzalı kayıt VARSA yalnız onlar boşaltılır.
// Yoksa yalnız OTURUM kayıtlarının 1 saatten eskileri: taze kayıtlar açık bir
// oturuma ait olabilir (hook'ların işi), snapshot'lar ise zaman serisidir —
// eskimiş yüzdeyi sunucuya taşımanın değeri yok.
function drainSecici() {
  let isaretliVar = null;
  return (p, tumu) => {
    if (isaretliVar === null) isaretliVar = tumu.some((x) => x && x.source === "backfill");
    if (isaretliVar) return p.source === "backfill";
    if (p.kind !== "session") return false;
    const t = Date.parse(p.ended_at || p.started_at || "");
    return !Number.isFinite(t) || Date.now() - t > SAAT_MS;
  };
}

// projects/ altındaki .jsonl'leri gezer, mtime cutoff'tan eski olanları eler.
// main()'den ayrıldı ki cutoff davranışı testten geçirilebilsin.
function listTranscripts(projectsDir, cutoff) {
  const files = [];
  let tooOld = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return { files, tooOld }; }
  for (const d of dirs) {
    const dirPath = path.join(projectsDir, d);
    let names = [];
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
      names = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }
    for (const name of names) {
      const filePath = path.join(dirPath, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) { tooOld++; continue; }
        files.push(filePath);
      } catch { tooOld++; }
    }
  }
  return { files, tooOld };
}

async function main() {
  const args = process.argv.slice(2);
  const drainIstendi = args.includes("--drain");
  let days = parseInt(args.find((a) => !a.startsWith("-")), 10);
  if (!Number.isFinite(days) || days <= 0) days = 90;
  iptalDinle();
  const config = loadConfig();
  if (!config) {
    const raw = readRawConfig();
    console.error(`Config kullanılamıyor — ${configProblem(raw && raw.cfg)}. Önce /usagex-connect çalıştır.`);
    process.exit(1);
  }

  // TEK PING: sunucu ulaşılamazsa yüzlerce oturum sessizce kuyruğa yazılıyor,
  // kullanıcı "gönderildi" sanıyordu. Önce bir kez dene (kuyruğa YAZMADAN).
  if (!(await postOnce(snapshotPayload(null, { source: "ping" }), config))) {
    console.error(
      `Sunucuya ulaşılamadı: ${config.ingest_url}\n` +
      "Backfill başlatılmadı (aksi halde tüm oturumlar kuyruğa yığılırdı).\n" +
      "Ağ bağlantını ve token'ı kontrol edip tekrar dene: node scripts/ping.js"
    );
    process.exit(1);
  }

  // --drain: eski çalıştırmalardan kuyrukta kalan kayıtları önce boşalt.
  // Aynı hız kontrolü (429'da bekle) geçerli; kuyruğa geri yazmak yalnız iş
  // yarıda kalırsa olur, o zaman da hiçbir kayıt kaybolmaz.
  if (drainIstendi) {
    yaz("Kuyruk boşaltılıyor (--drain)…");
    const d = await drainQueue(config, {
      secici: drainSecici(),
      iptal,
      ilerleme: (n, toplam) => { if (n % ILERLEME_ADIMI === 0) yaz(`kuyruk ${n}/${toplam}`); },
    });
    console.log(
      `Kuyruk: gönderilen ${d.sent} · reddedilen ${d.dropped} · kuyrukta kalan ${d.kalan}` +
      (d.status === "ok" || d.status === "empty" ? "" : ` (durdu: ${d.status})`)
    );
    if (d.status === "auth_failed") process.exit(1);
    if (iptalIstendi) return;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const projectsDir = path.join(claudeDir(), "projects");
  let sent = 0, skipped = 0, reddedilen = 0;

  if (!fs.existsSync(projectsDir)) {
    console.error(`Transcript klasörü yok: ${projectsDir}`);
    process.exit(1);
  }
  const { files, tooOld } = listTranscripts(projectsDir, cutoff);
  skipped += tooOld;

  const toplam = files.length;
  let islenen = 0;
  let durduran = null;
  let kalan = 0; // erken duruşta GÖNDERİLMEMİŞ kayıt sayısı (o anki kayıt dahil)

  for (const filePath of files) {
    if (iptalIstendi) { durduran = "cancelled"; kalan = toplam - islenen; break; }
    // İlerleme: uzun sürüyor, kullanıcı ekrana bakıp donmuş mu diye merak ediyor.
    // stdout ÖZET içindir (betikler onu okur), ilerleme stderr'e yazılır.
    if (++islenen % ILERLEME_ADIMI === 0) yaz(`${islenen}/${toplam}`);
    try {
      // cacheDir:null → alt-ajan önbelleği KAPALI. Backfill her dosyayı bir kez
      // okuyor; önbellek hiçbir okumadan tasarruf ettirmez, buna karşılık her
      // transkriptte tüm önbelleği okuyup yazmak yüzlerce dosyada işi ağırlaştırır.
      const summary = await summarizeTranscript(filePath, { cacheDir: null, ownershipDir: claudeDir() });
      if (!summary.deduplicated_messages && summary.message_count === 0 && Object.keys(summary.models).length === 0) { skipped++; continue; }
      // cwd okunamadıysa proje adı BOŞ gider, "unknown" DEĞİL: sunucudaki upsert
      // "unknown"ı gerçek bir ad sanıp hook'un yazdığı doğru adı eziyordu (bulgu 21).
      summary.project = summary.cwd ? path.basename(summary.cwd) : "";
      const payload = sessionPayload({
        session_id: path.basename(filePath, ".jsonl"),
        summary,
        plan_usage: null,
        config,
      });
      // null: oturumda hiç Claude modeli yok (yerel model) — gönderilecek veri yok.
      if (!payload) { skipped++; continue; }
      // İmza: sonraki bir --drain bu kayıtları tanısın (sunucu session kind'ında
      // `source` alanını okumuyor, yalnız snapshot'ta kullanıyor — zararsız).
      payload.source = "backfill";
      const sonuc = await postDirect(payload, config, { iptal });
      const durum = (sonuc && sonuc.status) || "failed";
      if (durum === "sent") sent++;
      else if (durum === "dropped") { reddedilen++; }
      // rate_limited | failed | budget | auth_failed | cancelled: bu kayıt da
      // gönderilemedi, kalan sayısına DAHİL (kullanıcı "kaç kaldı"yı doğru görsün).
      else { durduran = durum; kalan = toplam - islenen + 1; break; }
    } catch { skipped++; }
  }

  console.log(
    `Gönderilen: ${sent} · Atlanan: ${skipped} · Reddedilen: ${reddedilen}` +
    (durduran ? ` · Kalan: ${Math.max(0, kalan)}` : "")
  );
  if (durduran) console.error(DURMA_MESAJI[durduran] || `Durdu: ${durduran}`);
  if (durduran && durduran !== "cancelled") process.exit(1);
}

// Erken duruşun sebebini kullanıcıya TEK cümlede söyle — "kalan 3800" satırının
// yanında "neden" yoksa kullanıcı komutu boşuna tekrar tekrar çalıştırıyor.
const DURMA_MESAJI = {
  rate_limited:
    "Sunucu hız sınırı geçmedi (5 deneme boyunca 429). Birkaç dakika sonra aynı komutu tekrar çalıştır — kalanlar gönderilir.",
  // Kota sunucudaki MAX_ROWS_PER_DEVICE_DAY (server/api/server.js) — istemci bu
  // sayıyı uçtan öğrenemiyor, o yüzden ELDE tutuluyor: sunucuda değişirse burası
  // da değişmeli. (Eskiden 2000 yazıyordu, gerçek sınır 10.000.)
  budget:
    "Sunucunun GÜNLÜK satır kotası doldu (cihaz başına 10.000 oturum-gün). Yarın aynı komutu tekrar çalıştır; kalanlar gönderilir.",
  failed:
    "Sunucuya ulaşılamadı (5xx/ağ). Bağlantıyı kontrol edip aynı komutu tekrar çalıştır.",
  auth_failed:
    "Bağlantı sunucuda iptal edilmiş — /usagex-connect ile yeniden bağlan.",
  cancelled:
    "Kullanıcı durdurdu. Aynı komut kaldığı yerden devam eder (gönderilenler sunucuda upsert edildi).",
};

// require() ile çekildiğinde (test) main çalışmasın.
if (require.main === module) {
  main().catch((e) => {
    console.error(`Beklenmeyen hata: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}

module.exports = { listTranscripts, DURMA_MESAJI };
