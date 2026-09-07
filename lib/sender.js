const fs = require("fs");
const path = require("path");
const { claudeDir, markAuthFailed } = require("./config");

const TIMEOUT_MS = 3000;
const MAX_FLUSH = 10;          // tek hook çalışmasında en fazla bu kadar kuyruk elemanı denenir
const FLUSH_BUDGET_MS = 5000;  // toplam süre bütçesi: dolunca kalan kuyrukta bırakılır
// Sunucu 429 verirse bir süre HİÇ denemeyiz: hook her cevapta çalıştığı için
// rate-limit penceresinde her seferinde 3 sn'lik timeout'a girmek oturumu yavaşlatıyordu.
const DEFAULT_BLOCK_MS = 60 * 1000;
const MAX_BLOCK_MS = 60 * 60 * 1000;
// Sahibi ölmüş .inflight dosyası bu süreden eskiyse içindekiler kuyruğa geri alınır.
// Flush bütçesi 5 sn, hook timeout'u 15 sn — 10 dk fazlasıyla güvenli.
const INFLIGHT_STALE_MS = 10 * 60 * 1000;

// 4xx SINIFLANDIRMASI. Eskiden 400/401/403 de "geçici" sayılıyordu:
//   · 401'de sonsuz yeniden deneme (her Stop'ta 3 sn timeout — oturum yavaşlıyordu)
//   · 400'de zehirli paket kuyruğun BAŞINDA kalıp arkasındaki her şeyi kilitliyordu
// 415: sunucu Content-Type'ı reddediyor (ör. gövde tipi değişti) — tekrar denemek
// aynı sonucu verir, kuyruğu tıkamasın.
const DROP_STATUS = new Set([400, 404, 413, 415, 422]); // payload kalıcı olarak kabul edilmez → düş
const AUTH_STATUS = new Set([401, 403]);           // cihaz token'ı iptal → kendini kapat
// Tek bir 401/403 ARTIK kapatmıyor: kurumsal proxy/WAF, otel wifi portalı ya da
// Traefik'in kendi hatası da 403 döndürebiliyor ve collector'ı kalıcı olarak
// susturuyordu. Kapatmak için İKİ koşul birden: yanıt gövdesi sunucunun JSON
// hata biçiminde ({"error": …}) VE arka arkaya iki kez gelmiş olması.
const AUTH_FAIL_LIMIT = 2;
// Tek writeSync ile yazılabilecek üst sınır (R19). Bunu aşan tampon ayrı bir
// dosyaya gider; işletim sistemi büyük yazımı bölebiliyor ve iki süreç aynı anda
// eklerken satırlar iç içe geçiyordu.
const ATOMIC_APPEND_LIMIT = 64 * 1024;
// Windows'ta antivirüs/arama indeksleyici kuyruğu kısa süre açık tutup rename'i
// EBUSY/EPERM ile düşürebiliyor; sessizce vazgeçmek kuyruğun HİÇ boşalmaması demekti.
const RENAME_RETRY = 3;
const RENAME_RETRY_MS = 100;

// Tek satır uyarı, süreç başına BİR KEZ. Hook'lar sessiz çalışır; kullanıcıyı
// aynı hatayla her cevapta boğmak istemiyoruz.
const basilan = new Set();
function uyarBirKez(mesaj) {
  if (basilan.has(mesaj)) return;
  basilan.add(mesaj);
  try { process.stderr.write(mesaj + "\n"); } catch {}
}
// Tek süreçte birden çok senaryo çalıştıran testler için.
function resetNotices() { basilan.clear(); }

function defaultQueuePath() {
  return path.join(claudeDir(), "usagex-queue.jsonl");
}
// 429 damgası kuyruğun yanında durur (ayrı state dosyasına bağımlılık yok).
function blockPath(queuePath) {
  return `${queuePath}.blocked`;
}

function readBlockedUntil(queuePath) {
  try {
    const v = Number(fs.readFileSync(blockPath(queuePath), "utf8"));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
function writeBlockedUntil(queuePath, until) {
  try { fs.writeFileSync(blockPath(queuePath), String(until), { mode: 0o600 }); } catch {}
}
function clearBlocked(queuePath) {
  try { fs.unlinkSync(blockPath(queuePath)); } catch {}
}

// Ardışık 401/403 sayacı — 429 damgasıyla aynı yerde, kuyruğun yanında durur
// (ayrı state dosyasına bağımlılık yok, testte de aynı geçici dizinde kalır).
function authFailPath(queuePath) {
  return `${queuePath}.authfail`;
}
function readAuthFails(queuePath) {
  try {
    const v = Number(fs.readFileSync(authFailPath(queuePath), "utf8"));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch {
    return 0;
  }
}
function writeAuthFails(queuePath, n) {
  try { fs.writeFileSync(authFailPath(queuePath), String(n), { mode: 0o600 }); } catch {}
}
function clearAuthFails(queuePath) {
  try { fs.unlinkSync(authFailPath(queuePath)); } catch {}
}

// { ok, status, body } döner — 429'u ayırt edebilmek için sadece boolean yetmiyor,
// 401/403'te de gövde lazım (sunucunun kendi hatası mı, ara katmanınki mi).
async function post(payload, config, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.ingest_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.device_token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const out = { ok: !!res.ok, status: res.status || 0, headers: res.headers, body: "" };
    // Gövdeyi YALNIZ 401/403'te okuyoruz: tek yeri authKarar, başka yolda maliyeti boşuna.
    if (!out.ok && AUTH_STATUS.has(out.status) && res && typeof res.text === "function") {
      try { out.body = String(await res.text()).slice(0, 4096); } catch {}
    }
    return out;
  } catch {
    return { ok: false, status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

// Sunucu 429 dediyse retry-after kadar (yoksa 60 sn) hiç deneme.
function noteRateLimit(res, queuePath, now) {
  if (res.status !== 429) return false;
  const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
  const bekle = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_BLOCK_MS) : DEFAULT_BLOCK_MS;
  writeBlockedUntil(queuePath, now + bekle);
  return true;
}

// Tek deneme, kuyruğa YAZMADAN — kurulum doğrulaması (ping) için.
async function postOnce(payload, config, { fetchImpl = fetch } = {}) {
  return (await post(payload, config, fetchImpl)).ok;
}

// ── kuyruk dosyası: atomik ekleme + kilitli boşaltma ────────────────────────
// Eskiden hem ekleme hem boşaltma "tüm dosyayı baştan yaz" idi. İki somut hata:
//   · hook 15 sn timeout'unda tam yazarken öldürülünce dosya YARIM kalıyordu;
//   · paralel oturum B'nin eklediği satır, A'nın flush sonundaki unlink/yeniden
//     yazımıyla siliniyordu.
// Ekleme artık O_APPEND (tek çağrıda atomik), boşaltma ise dosyayı rename ile
// kendine kilitleyip oradan okuyor.
// appendFileSync "tek çağrı" gibi görünse de büyük tamponu birden çok write'a
// bölebiliyor: iki oturum aynı anda çok KB'lik satır eklerken satırlar iç içe
// geçip her ikisini de bozuyordu. Artık O_APPEND + TEK writeSync: çekirdek bu
// yazımı bölmediği sürece (pratikte ≤ 64 KB) atomiktir.
function appendChunk(queuePath, buf) {
  let fd;
  try {
    fd = fs.openSync(queuePath, "a", 0o600);
    fs.writeSync(fd, buf, 0, buf.length);
  } catch {
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// 64 KB'ı aşan tampon tek writeSync ile güvenle yazılamaz → ayrı dosyaya alınır.
// Ad kalıbı `<kuyruk>.<pid>.<ts>.jsonl`; flush bunları da toplar (takeOverflow).
function writeOverflow(queuePath, buf) {
  const p = `${queuePath}.${process.pid}.${Date.now()}.jsonl`;
  try { fs.writeFileSync(p, buf, { mode: 0o600, flag: "a" }); } catch {}
}

// Satırları ≤ 64 KB'lik gruplara böler; tek başına sınırı aşan satır kendi
// grubunda kalır (o grup taşma dosyasına gider).
function chunkLines(lines) {
  const out = [];
  let grup = [];
  let boyut = 0;
  for (const l of lines) {
    const n = Buffer.byteLength(l, "utf8") + 1;
    if (grup.length && boyut + n > ATOMIC_APPEND_LIMIT) { out.push(grup); grup = []; boyut = 0; }
    grup.push(l);
    boyut += n;
  }
  if (grup.length) out.push(grup);
  return out;
}

function appendLines(queuePath, lines) {
  if (!lines.length) return;
  for (const grup of chunkLines(lines)) {
    const buf = Buffer.from(grup.join("\n") + "\n", "utf8");
    if (buf.length > ATOMIC_APPEND_LIMIT) { writeOverflow(queuePath, buf); continue; }
    appendChunk(queuePath, buf);
  }
}
function readQueueLines(p) {
  try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean); } catch { return []; }
}
function writeQueueAtomic(queuePath, lines) {
  const tmp = `${queuePath}.${process.pid}.tmp`;
  try {
    if (lines.length === 0) { try { fs.unlinkSync(queuePath); } catch {} return; }
    fs.writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, queuePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Aynı oturumun ESKİ kopyaları yenisini kapsamaz — yenisi eskisini kapsar
// (özet kümülatif, days dizisi tüm günleri taşır). Eskiden hepsi kuyrukta
// birikiyor, flush sırasında eskisi EN SON yazılıp sunucudaki satırı geri
// alıyordu: kullanıcı "bugün azaldı" diyordu. Her (kind, session_id) için
// yalnız SON kayıt kalır; snapshot'lar zaman serisidir, onlara dokunulmaz.
function dropSuperseded(lines) {
  const cozulmus = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const sonIndeks = new Map();
  cozulmus.forEach((p, i) => {
    if (p && p.kind === "session" && p.session_id) sonIndeks.set(`session\u0000${p.session_id}`, i);
  });
  return lines.filter((_, i) => {
    const p = cozulmus[i];
    if (!p || p.kind !== "session" || !p.session_id) return true;
    return sonIndeks.get(`session\u0000${p.session_id}`) === i;
  });
}

// Cihaz token'ı sunucuda geçersiz: bir daha denemenin anlamı yok, kullanıcı
// cihazı uygulamadan silmiş ya da hesap kapanmış olabilir. Kendimizi kapatıyoruz
// (config enabled:false + auth_failed_at) ve kuyruğu siliyoruz — aksi halde
// kuyruk sonsuza kadar büyür ve her Stop hook'u 3 sn timeout'a girer.
function handleAuthFailure(queuePath) {
  try { markAuthFailed(path.dirname(queuePath)); } catch {}
  try { fs.unlinkSync(queuePath); } catch {}
  clearBlocked(queuePath);
  clearAuthFails(queuePath);
  uyarBirKez(
    "UsagEX: bağlantı sunucuda iptal edilmiş; yeniden bağlanmak için /usagex-connect"
  );
}

// Gövde SUNUCUNUN hata biçiminde mi? Ara katman (proxy/WAF/captive portal) 403'ü
// HTML ya da boş gelir; sunucu ise {"error": "..."} döner. Ayrım önemli: yanlış
// tarafa düşmek ya collector'ı haksız yere kalıcı kapatır ya da iptal edilmiş bir
// cihazı sonsuza kadar denetir.
function sunucuHatasiMi(body) {
  if (typeof body !== "string" || !body.trim()) return false;
  try {
    const j = JSON.parse(body);
    return !!j && typeof j === "object" && !Array.isArray(j) && "error" in j;
  } catch {
    return false;
  }
}

// 401/403 kararı → "kapat" | "gecici".
// "kapat" yalnız sunucunun JSON hata gövdesi VE arka arkaya AUTH_FAIL_LIMIT kez
// geldiğinde. Diğer her durumda geçici: payload kuyrukta kalır, 60 sn ağa çıkılmaz.
function authKarar(res, queuePath, now) {
  if (!sunucuHatasiMi(res.body)) {
    writeBlockedUntil(queuePath, now + DEFAULT_BLOCK_MS);
    return "gecici";
  }
  const n = readAuthFails(queuePath) + 1;
  writeAuthFails(queuePath, n);
  if (n >= AUTH_FAIL_LIMIT) return "kapat";
  writeBlockedUntil(queuePath, now + DEFAULT_BLOCK_MS);
  return "gecici";
}

function noteDrop(status) {
  uyarBirKez(`UsagEX: sunucu paketi kabul etmedi (HTTP ${status}) — bu kayıt atlandı.`);
}

// Sahibi ölmüş .inflight dosyalarını kuyruğa geri al. Hook 15 sn'de öldürülebilir;
// tam o anda boşaltılan satırlar aksi halde diskte öksüz kalırdı.
function recoverInflight(queuePath, now) {
  const dir = path.dirname(queuePath);
  const onek = path.basename(queuePath) + ".inflight.";
  let adlar = [];
  try { adlar = fs.readdirSync(dir); } catch { return; }
  for (const ad of adlar) {
    if (!ad.startsWith(onek)) continue;
    const p = path.join(dir, ad);
    try {
      if (now() - fs.statSync(p).mtimeMs < INFLIGHT_STALE_MS) continue; // sahibi hâlâ çalışıyor olabilir
      appendLines(queuePath, readQueueLines(p));
      fs.unlinkSync(p);
    } catch {}
  }
}

// Taşma dosyalarını (R19) topla ve sil. Silinemeyeni bu turda HİÇ okumamış say:
// aksi halde paralel bir flush aynı satırları ikinci kez gönderebilirdi.
function takeOverflow(queuePath) {
  const dir = path.dirname(queuePath);
  const base = path.basename(queuePath);
  const kalip = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.\\d+\\.jsonl$`);
  let adlar = [];
  try { adlar = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const ad of adlar.filter((a) => kalip.test(a)).sort()) {
    const p = path.join(dir, ad);
    const satirlar = readQueueLines(p);
    try { fs.unlinkSync(p); } catch { continue; }
    out.push(...satirlar);
  }
  return out;
}

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

// rename EBUSY/EPERM'de 100 ms arayla 3 deneme (Windows: antivirüs/indeksleyici
// dosyayı kısa süre tutar). Diğer hatalarda (ENOENT = kuyruk yok) hemen döner.
async function renameRetry(from, to) {
  for (let i = 1; i <= RENAME_RETRY; i++) {
    try {
      fs.renameSync(from, to);
      return { ok: true };
    } catch (e) {
      const kod = e && e.code;
      if (kod !== "EBUSY" && kod !== "EPERM") return { ok: false, err: e };
      if (i === RENAME_RETRY) return { ok: false, err: e };
      await bekle(RENAME_RETRY_MS);
    }
  }
  return { ok: false };
}

// Kuyruktaki bekleyenleri sırayla dener; ilk GEÇİCİ hatada durur (sıra korunur),
// kalıcı 4xx'i düşürür. İki fren: en fazla MAX_FLUSH eleman ve en fazla
// FLUSH_BUDGET_MS süre — bir hook'un yüzlerce elemanlık kuyruğu boşaltmaya
// çalışıp oturumu bekletmesi engellenir.
// Döner: { authFailed } — çağıran (sendPayload) kapanmış bir bağlantıya yeni
// payload yazmasın diye.
async function flushQueue(config, { fetchImpl = fetch, queuePath, now = Date.now } = {}) {
  try {
    if (!queuePath) queuePath = defaultQueuePath();
  } catch {
    return { authFailed: false };
  }
  if (now() < readBlockedUntil(queuePath)) return { authFailed: false }; // 429 penceresi
  recoverInflight(queuePath, now);

  // Dosyayı önce KENDİMİZE kilitle: rename atomik, pid'li ad çakışmayı önler.
  // Paralel oturum aynı satırları ikinci kez göndermez ve bizim temizliğimiz
  // onun bu arada eklediği satırı silmez.
  const inflight = `${queuePath}.inflight.${process.pid}`;
  const rn = await renameRetry(queuePath, inflight);
  const kilitli = rn.ok;
  if (!rn.ok) {
    const kod = rn.err && rn.err.code;
    if (kod === "EBUSY" || kod === "EPERM") {
      uyarBirKez(
        `UsagEX: kuyruk dosyası başka bir süreç tarafından kilitli (${kod}) — bu tur atlandı, sonraki turda yeniden denenecek.`
      );
    }
  }

  // Taşma dosyaları da bu turun malzemesi (R19): kuyruk kilitliyse bile toplanır.
  const ham = (kilitli ? readQueueLines(inflight) : []).concat(takeOverflow(queuePath));
  if (!ham.length) {
    if (kilitli) { try { fs.unlinkSync(inflight); } catch {} }
    return { authFailed: false };
  }
  const lines = dropSuperseded(ham);
  const deadline = now() + FLUSH_BUDGET_MS;
  const remaining = [...lines];
  let authFailed = false;

  for (const line of lines.slice(0, MAX_FLUSH)) {
    if (now() >= deadline) break; // bütçe doldu — kalanı kuyrukta bırak
    let payload;
    try { payload = JSON.parse(line); } catch { remaining.shift(); continue; }
    const res = await post(payload, config, fetchImpl);
    if (res.ok) { remaining.shift(); clearAuthFails(queuePath); continue; }
    if (AUTH_STATUS.has(res.status)) {
      // Tek 401/403 kapatmaz (R18): ara katman hatası olabilir. "gecici" ise
      // satır kuyrukta kalır ve 60 sn ağa çıkılmaz.
      if (authKarar(res, queuePath, now()) === "kapat") { authFailed = true; }
      break;
    }
    if (DROP_STATUS.has(res.status)) { remaining.shift(); noteDrop(res.status); continue; }
    noteRateLimit(res, queuePath, now());
    break;
  }

  if (authFailed) {
    try { fs.unlinkSync(inflight); } catch {}
    handleAuthFailure(queuePath); // kuyruğu da siler
    return { authFailed: true };
  }
  // SIRA: ÖNCE kalanı kuyruğa geri ekle, SONRA inflight'ı sil. Tersi (eski
  // davranış) iki işlem arasında süreç ölürse satırları tamamen kaybediyordu.
  // Bu arada başka bir süreç yeni satır eklemiş olabilir; append onu korur,
  // ardından sıkıştırma eskiyeni ayıklar.
  if (remaining.length) {
    appendLines(queuePath, remaining);
    compactQueue(queuePath);
  }
  if (kilitli) { try { fs.unlinkSync(inflight); } catch {} }
  return { authFailed: false };
}

const MAX_QUEUE_SIZE = 500; // kind BAŞINA saklanacak maksimum eleman sayısı

// Kırpma kind bazlı: uzun bir çevrimdışı dönemde 5 dk'da bir düşen snapshot'lar
// kuyruğu doldurup oturum özetlerini (asıl değerli veri) dışarı itiyordu.
// Her kind kendi 500'lük penceresini korur; genel sıra bozulmaz.
function trimByKind(lines, maxPerKind = MAX_QUEUE_SIZE) {
  const seen = new Map(); // kind -> kaç tane kaldı (sondan başa sayarak)
  const keep = new Array(lines.length).fill(false);
  for (let i = lines.length - 1; i >= 0; i--) {
    let kind = "unknown";
    try { kind = JSON.parse(lines[i]).kind || "unknown"; } catch {}
    const n = (seen.get(kind) || 0) + 1;
    seen.set(kind, n);
    if (n <= maxPerKind) keep[i] = true;
  }
  return lines.filter((_, i) => keep[i]);
}

// Kuyruğu sıkıştır: eskiyen oturum kopyalarını at, kind başına 500'e kırp.
// Yalnız gerçekten değişiklik varsa dosyayı yeniden yazar (yarış penceresi dar
// kalsın diye — ekleme yolu zaten atomik append).
function compactQueue(queuePath) {
  const lines = readQueueLines(queuePath);
  if (!lines.length) return;
  const sikistirilmis = trimByKind(dropSuperseded(lines));
  if (sikistirilmis.length !== lines.length) writeQueueAtomic(queuePath, sikistirilmis);
}

// { status } döner. Asla throw etmez.
//   sent        → sunucu 2xx verdi
//   queued      → kuyruğa yazıldı, sonra denenecek (ağ/5xx/429/geçici 401-403)
//   dropped     → sunucu KALICI olarak kabul etmedi (400/404/413/415/422)
//   auth_failed → cihaz sunucuda iptal, collector kendini kapattı
// Ayrım şart: çağıran "teslim edildi" damgasını (state.js) yalnız sent/queued'da
// basmalı — dropped'da damgalamak oturumu sessizce kaybettiriyordu (R23).
async function sendPayload(payload, config, { fetchImpl = fetch, queuePath, now = Date.now } = {}) {
  try {
    if (!queuePath) queuePath = defaultQueuePath();
  } catch {
    return { status: "dropped" };
  }
  if (now() < readBlockedUntil(queuePath)) {
    appendLines(queuePath, [JSON.stringify(payload)]);
    compactQueue(queuePath);
    return { status: "queued" };
  }

  // SIRA ÖNEMLİ: önce kuyruk, sonra yeni payload. Tersi (eski davranış) aynı
  // (kullanıcı, oturum, gün) satırını sunucuda ESKİ değere geri döndürüyordu:
  // yeni özet gidiyor, hemen ardından flush eski özeti üstüne yazıyordu.
  const { authFailed } = await flushQueue(config, { fetchImpl, queuePath, now });
  if (authFailed) return { status: "auth_failed" }; // iptal — yeni payload'ı kuyruğa da yazma

  // Flush 429 ya da geçici 401/403 damgası bırakmış olabilir; öyleyse ağa çıkma.
  if (now() < readBlockedUntil(queuePath)) {
    appendLines(queuePath, [JSON.stringify(payload)]);
    compactQueue(queuePath);
    return { status: "queued" };
  }

  const res = await post(payload, config, fetchImpl);
  if (res.ok) {
    clearBlocked(queuePath);
    clearAuthFails(queuePath);
    return { status: "sent" };
  }
  if (AUTH_STATUS.has(res.status)) {
    // Tek 401/403 kapatmaz (R18); "gecici" ise aşağıdaki kuyruk yoluna düşer.
    if (authKarar(res, queuePath, now()) === "kapat") {
      handleAuthFailure(queuePath);
      return { status: "auth_failed" };
    }
  } else if (DROP_STATUS.has(res.status)) {
    noteDrop(res.status);
    return { status: "dropped" };
  } else {
    noteRateLimit(res, queuePath, now());
  }

  // 0600 — kuyruk makine/proje/oturum/token sayımları içerir, diğer yerel
  // kullanıcılar okumasın. (appendLines mode'u yalnız dosya YOKKEN uygular.)
  appendLines(queuePath, [JSON.stringify(payload)]);
  compactQueue(queuePath);
  return { status: "queued" };
}

module.exports = {
  sendPayload, flushQueue, postOnce, defaultQueuePath, trimByKind, dropSuperseded,
  resetNotices, MAX_QUEUE_SIZE, MAX_FLUSH, FLUSH_BUDGET_MS, DROP_STATUS, AUTH_STATUS,
  AUTH_FAIL_LIMIT, ATOMIC_APPEND_LIMIT, RENAME_RETRY,
};
