#!/usr/bin/env node
// Son N günün transcript'lerini toplu gönderir (varsayılan 90).
// API session_id ile upsert yaptığı için tekrar çalıştırmak güvenlidir.
const fs = require("fs");
const path = require("path");
const { loadConfig, claudeDir, readRawConfig, configProblem } = require("../lib/config");
const { summarizeTranscript } = require("../lib/transcript");
const { sessionPayload, snapshotPayload } = require("../lib/payload");
const { sendPayload, postOnce } = require("../lib/sender");

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
  let days = parseInt(process.argv[2], 10);
  if (!Number.isFinite(days) || days <= 0) days = 90;
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

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const projectsDir = path.join(claudeDir(), "projects");
  let sent = 0, queued = 0, skipped = 0;

  if (!fs.existsSync(projectsDir)) {
    console.error(`Transcript klasörü yok: ${projectsDir}`);
    process.exit(1);
  }
  const { files, tooOld } = listTranscripts(projectsDir, cutoff);
  skipped += tooOld;

  for (const filePath of files) {
    try {
      // cacheDir:null → alt-ajan önbelleği KAPALI. Backfill her dosyayı bir kez
      // okuyor; önbellek hiçbir okumadan tasarruf ettirmez, buna karşılık her
      // transkriptte tüm önbelleği okuyup yazmak yüzlerce dosyada işi ağırlaştırır.
      const summary = await summarizeTranscript(filePath, { cacheDir: null });
      if (summary.message_count === 0 && Object.keys(summary.models).length === 0) { skipped++; continue; }
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
      // sendPayload artık { status } döndürüyor (R23): dropped/auth_failed
      // "kuyruğa yazıldı" DEĞİL — atlanan sayılır, yoksa rapor yanıltıcı olur.
      const sonuc = await sendPayload(payload, config);
      const durum = (sonuc && sonuc.status) || "dropped";
      if (durum === "sent") sent++;
      else if (durum === "queued") queued++;
      else skipped++;
    } catch { skipped++; }
  }
  console.log(`Gönderilen: ${sent} · Kuyruğa yazılan: ${queued} · Atlanan: ${skipped}`);
}

// require() ile çekildiğinde (test) main çalışmasın.
if (require.main === module) {
  main().catch((e) => {
    console.error(`Beklenmeyen hata: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}

module.exports = { listTranscripts };
