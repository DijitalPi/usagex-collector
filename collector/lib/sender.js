const { acquire, withLock, alive } = require("./file-lock");
const crypto = require("node:crypto");
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
      body: JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "_usagex_queue_owner"))),
      signal: controller.signal,
    });
    const out = { ok: !!res.ok, status: res.status || 0, headers: res.headers, body: "" };
    // Gövdeyi YALNIZ 401/403 ve 429'da okuyoruz. 401/403: authKarar ara katman
    // hatasını ayırt etsin. 429: sunucunun iki farklı 429'u var — "rate limited"
    // (beklemek ÇÖZER) ve "daily row budget exceeded" (günlük kota, beklemek
    // ÇÖZMEZ; toplu iş 5 kez 60 sn bekleyip yine duvara toslardı).
    if (!out.ok && (AUTH_STATUS.has(out.status) || out.status === 429)
        && res && typeof res.text === "function") {
      try { out.body = String(await res.text()).slice(0, 4096); } catch {}
    }
    return out;
  } catch {
    return { ok: false, status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

// Retry-After (saniye) → ms. Yoksa/bozuksa 60 sn; absürt değerde tavan.
// UsagEX sunucusu ingest 429'unda bu başlığı GÖNDERMİYOR — varsayılan geçerli.
function retryAfterMs(res) {
  const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_BLOCK_MS) : DEFAULT_BLOCK_MS;
}

// Sunucu 429 dediyse retry-after kadar (yoksa 60 sn) hiç deneme.
function noteRateLimit(res, queuePath, now) {
  if (res.status !== 429) return false;
  writeBlockedUntil(queuePath, now + retryAfterMs(res));
  return true;
}

// 429 gövdesi "günlük satır kotası" mı? (Sunucu: {"error":"daily row budget
// exceeded"}.) Bu 429 gün dönene kadar geçmez — beklemek/yeniden denemek boşuna.
function kotaAsimiMi(body) {
  if (typeof body !== "string" || !body) return false;
  try {
    const j = JSON.parse(body);
    return !!j && typeof j.error === "string" && /budget/i.test(j.error);
  } catch {
    return false;
  }
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
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset);
      if (!written) throw new Error("Queue write did not advance");
      offset += written;
    }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// 64 KB'ı aşan tampon tek writeSync ile güvenle yazılamaz → ayrı dosyaya alınır.
// Ad kalıbı `<kuyruk>.<pid>.<ts>.jsonl`; flush bunları da toplar (takeOverflow).
function writeOverflow(queuePath, buf) {
  const p = `${queuePath}.${process.pid}.${Date.now()}${crypto.randomInt(100000, 999999)}.jsonl`;
  fs.writeFileSync(p + ".tmp", buf, { mode: 0o600, flag: "wx" });
  fs.renameSync(p + ".tmp", p);
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

function appendLinesUnlocked(queuePath, lines) {
  if (!lines.length) return;
  for (const grup of chunkLines(lines)) {
    const buf = Buffer.from(grup.join("\n") + "\n", "utf8");
    if (buf.length > ATOMIC_APPEND_LIMIT) { writeOverflow(queuePath, buf); continue; }
    appendChunk(queuePath, buf);
  }
}
function appendLines(queuePath, lines) {
  if (!lines.length) return;
  try { return withLock(`${queuePath}.lock`, () => appendLinesUnlocked(queuePath, lines)); }
  catch { writeOverflow(queuePath, Buffer.from(lines.join("\n") + "\n")); }
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
    if (p && p.kind === "session" && p.session_id) {
      const key = `session\u0000${p._usagex_queue_owner || ""}\u0000${p.session_id}`;
      const old = sonIndeks.get(key);
      const rank = (x) => [Date.parse(x.generated_at || x.queued_at || x.measured_at || x.ended_at || "") || 0,
        Number(x.message_count) || 0, Number(x.output_tokens) || 0];
      const a = rank(p), b = old == null ? [-1, -1, -1] : rank(cozulmus[old]);
      const diff = a.findIndex((v, n) => v !== b[n]);
      if (diff < 0 || a[diff] > b[diff]) sonIndeks.set(key, i);
    }
  });
  return lines.filter((_, i) => {
    const p = cozulmus[i];
    if (!p || p.kind !== "session" || !p.session_id) return true;
    return sonIndeks.get(`session\u0000${p._usagex_queue_owner || ""}\u0000${p.session_id}`) === i;
  });
}

// Cihaz token'ı sunucuda geçersiz: bir daha denemenin anlamı yok, kullanıcı
// cihazı uygulamadan silmiş ya da hesap kapanmış olabilir. Kendimizi kapatıyoruz
// (config enabled:false + auth_failed_at) ve kuyruğu siliyoruz — aksi halde
// kuyruk sonsuza kadar büyür ve her Stop hook'u 3 sn timeout'a girer.
function handleAuthFailure(queuePath, config) {
  try { markAuthFailed(path.dirname(queuePath), Date.now(), config?.device_token); } catch {}
  // Quarantine pending figures for explicit reconnection; never delete them on auth errors.
  writeBlockedUntil(queuePath, Date.now() + MAX_BLOCK_MS);
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
      const pid = Number(ad.slice(onek.length).split(".")[0]);
      if (alive(pid) || now() - fs.statSync(p).mtimeMs < INFLIGHT_STALE_MS) continue; // sahibi hâlâ çalışıyor olabilir
      appendLines(queuePath, readQueueLines(p));
      fs.unlinkSync(p);
    } catch {}
  }
}

// Taşma dosyalarını (R19) topla ve sil. Silinemeyeni bu turda HİÇ okumamış say:
// aksi halde paralel bir flush aynı satırları ikinci kez gönderebilirdi.
function takeOverflow(queuePath, inflight) {
  const dir = path.dirname(queuePath);
  const base = path.basename(queuePath);
  const kalip = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.\\d+\\.jsonl$`);
  let adlar = [];
  try { adlar = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const ad of adlar.filter((a) => kalip.test(a)).sort()) {
    const p = path.join(dir, ad);
    const satirlar = readQueueLines(p);
    // Preserve a durable copy until delivery/requeue finishes, including if the process dies.
    if (satirlar.length) appendChunk(inflight, Buffer.from(satirlar.join("\n") + "\n"));
    try { fs.unlinkSync(p); } catch {}
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
      withLock(`${from}.lock`, () => fs.renameSync(from, to));
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
async function flushQueueUnlocked(config, { fetchImpl = fetch, queuePath, now = Date.now } = {}) {
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
  const ham = (kilitli ? readQueueLines(inflight) : []).concat(takeOverflow(queuePath, inflight));
  if (!ham.length) {
    try { fs.unlinkSync(inflight); } catch {}
    return { authFailed: false };
  }
  const lines = dropSuperseded(ownedQueueLines(ham, config, queuePath));
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
    appendLines(queuePath, remaining);
    try { fs.unlinkSync(inflight); } catch {}
    handleAuthFailure(queuePath, config);
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
  try { fs.unlinkSync(inflight); } catch {}
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
  try {
    withLock(`${queuePath}.lock`, () => {
      const lines = readQueueLines(queuePath);
      const compacted = trimByKind(dropSuperseded(lines));
      if (compacted.length !== lines.length) writeQueueAtomic(queuePath, compacted);
    });
  } catch {} // Keep the original queue; a later pass can compact it.
}

// { status } döner. Asla throw etmez.
//   sent        → sunucu 2xx verdi
//   queued      → kuyruğa yazıldı, sonra denenecek (ağ/5xx/429/geçici 401-403)
//   dropped     → sunucu KALICI olarak kabul etmedi (400/404/413/415/422)
//   auth_failed → cihaz sunucuda iptal, collector kendini kapattı
// Ayrım şart: çağıran "teslim edildi" damgasını (state.js) yalnız sent/queued'da
// basmalı — dropped'da damgalamak oturumu sessizce kaybettiriyordu (R23).
async function sendPayloadUnlocked(payload, config, { fetchImpl = fetch, queuePath, now = Date.now } = {}) {
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
  const { authFailed } = await flushQueueUnlocked(config, { fetchImpl, queuePath, now });
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
    if (payload.kind === "session") {
      try { withLock(`${queuePath}.lock`, () => {
        const lines = readQueueLines(queuePath);
        const marker = JSON.stringify(payload);
        const kept = dropSuperseded([...lines, marker]).filter((line) => line !== marker);
        if (kept.length !== lines.length) writeQueueAtomic(queuePath, kept);
      }); } catch {}
    }
    return { status: "sent" };
  }
  if (AUTH_STATUS.has(res.status)) {
    // Tek 401/403 kapatmaz (R18); "gecici" ise aşağıdaki kuyruk yoluna düşer.
    if (authKarar(res, queuePath, now()) === "kapat") {
      appendLines(queuePath, [JSON.stringify(payload)]);
      handleAuthFailure(queuePath, config);
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


// ── DOĞRUDAN GÖNDERİM (toplu iş: backfill / drain) — KUYRUĞA YAZMAZ ─────────
// ÖLÇÜLEN SORUN: `backfill.js 90` → "Gönderilen 598 · Kuyruğa yazılan 3813".
// Sunucunun ingest hız sınırı 600/dk/IP; sınıra çarpınca sendPayload her 429'da
// payload'ı KUYRUĞA yazıyordu. Kuyruk kind başına 500'e kırpıldığı için eski
// günler sessizce kayboluyor, hayatta kalanlar da Stop hook'larıyla (tur başına
// en fazla 10 eleman) aylarca damla damla akıyordu.
// Toplu iş artık kuyruğa hiç dokunmaz: 429'da Retry-After (yoksa 60 sn) kadar
// BEKLER ve AYNI payload'ı yeniden dener. Böylece hız sınırı veriyi kaybettiren
// bir olay olmaktan çıkıp sadece işi yavaşlatan bir olaya döner.
const DIRECT_429_TRIES = 5;             // 429: aynı payload için en fazla bu kadar deneme
const DIRECT_ERR_TRIES = 3;             // 5xx / ağ hatası: en fazla bu kadar deneme
const DIRECT_ERR_WAIT_MS = 10 * 1000;   // 5xx / ağ hatasında bekleme

// Tek payload'ı kuyruksuz gönderir. Döner: { status, tries }
//   sent         → 2xx
//   dropped      → kalıcı 4xx (400/404/413/415/422) — atlanır, sayılır
//   budget       → 429 ama "daily row budget exceeded": gün dönmeden geçmez
//   rate_limited → 429 denemeleri tükendi (kuyruğa YAZILMADI, çağıran karar verir)
//   failed       → 5xx/ağ denemeleri tükendi
//   auth_failed  → cihaz sunucuda iptal, collector kendini kapattı
//   cancelled    → çağıran iptal etti (Ctrl-C)
// Kuyruğun 429 damgasına (blocked) SAYGI duyar: pencere açıksa süresi kadar
// bekler — hook'lar ve toplu iş aynı freni paylaşsın diye.
async function postDirect(payload, config, opts = {}) {
  const {
    fetchImpl = fetch, now = Date.now, sleep = bekle, retry = true, iptal = () => false,
  } = opts;
  let queuePath = opts.queuePath;
  try { if (!queuePath) queuePath = defaultQueuePath(); } catch { queuePath = null; }

  const max429 = retry ? DIRECT_429_TRIES : 1;
  const maxErr = retry ? DIRECT_ERR_TRIES : 1;
  let n429 = 0, nErr = 0, tries = 0;

  for (;;) {
    if (iptal()) return { status: "cancelled", tries };
    // Açık 429 penceresi: ağa çıkmadan bekle (üstüne gitmek pencereyi uzatır).
    const engelli = queuePath ? readBlockedUntil(queuePath) : 0;
    const kalan = engelli - now();
    if (kalan > 0) {
      // Bu bekleme "başarısız deneme" değil, açık pencereye saygı — bu yüzden
      // sınır `>` ile: 429 bütçesini tüketmesin ama sonsuz döngü de kurmasın.
      if (!retry || ++n429 > max429) return { status: "rate_limited", tries };
      await sleep(Math.min(kalan, MAX_BLOCK_MS));
      if (iptal()) return { status: "cancelled", tries };
    }

    tries++;
    const res = await post(payload, config, fetchImpl);

    if (res.ok) {
      if (queuePath) { clearBlocked(queuePath); clearAuthFails(queuePath); }
      return { status: "sent", tries };
    }
    if (res.status === 429) {
      // Günlük satır kotası: beklemek çözmez, çağıran işi durdurmalı.
      if (kotaAsimiMi(res.body)) return { status: "budget", tries };
      const sure = retryAfterMs(res);
      if (queuePath) writeBlockedUntil(queuePath, now() + sure);
      if (!retry || ++n429 >= max429) return { status: "rate_limited", tries };
      await sleep(sure);
      continue;
    }
    if (AUTH_STATUS.has(res.status)) {
      // Tek 401/403 kapatmaz (R18): ara katman hatası olabilir → geçici say.
      if (queuePath && authKarar(res, queuePath, now()) === "kapat") {
        handleAuthFailure(queuePath, config);
        return { status: "auth_failed", tries };
      }
      if (!retry || ++nErr >= maxErr) return { status: "failed", tries };
      await sleep(DIRECT_ERR_WAIT_MS);
      continue;
    }
    if (DROP_STATUS.has(res.status)) { noteDrop(res.status); return { status: "dropped", tries }; }
    // 5xx ya da ağ hatası (status 0)
    if (!retry || ++nErr >= maxErr) return { status: "failed", tries };
    await sleep(DIRECT_ERR_WAIT_MS);
  }
}

// Kuyruğu doğrudan gönderimle boşaltır (backfill --drain). flushQueue'dan farkı:
// eleman/süre bütçesi YOK ve 429'da kuyruğa geri yazıp damlamak yerine beklenir.
// `secici(payload, tumu)` hangi kayıtların bu turda gönderileceğini seçer;
// seçilmeyenler kuyrukta AYNEN kalır (taze kayıtlar hook'ların işi).
// Yarıda kalırsa (429/5xx/iptal) gönderilmemişler kuyruğa geri yazılır — hiçbir
// kayıt kaybolmaz. Döner: { sent, dropped, kalan, status }
async function drainQueueUnlocked(config, opts = {}) {
  const {
    fetchImpl = fetch, now = Date.now, sleep = bekle,
    secici = () => true, ilerleme = () => {}, iptal = () => false,
  } = opts;
  let queuePath = opts.queuePath;
  try { if (!queuePath) queuePath = defaultQueuePath(); } catch {
    return { sent: 0, dropped: 0, kalan: 0, toplam: 0, status: "no-queue" };
  }

  recoverInflight(queuePath, now);
  const inflight = `${queuePath}.inflight.${process.pid}`;
  const rn = await renameRetry(queuePath, inflight);
  const kilitli = rn.ok;
  const ham = (kilitli ? readQueueLines(inflight) : []).concat(takeOverflow(queuePath, inflight));
  const bitir = (sonuc) => {
    try { fs.unlinkSync(inflight); } catch {}
    return sonuc;
  };
  if (!ham.length) return bitir({ sent: 0, dropped: 0, kalan: 0, toplam: 0, status: "empty" });

  const lines = dropSuperseded(ownedQueueLines(ham, config, queuePath));
  const cozulmus = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const sira = [];
  const geri = []; // kuyrukta kalacaklar (seçilmeyenler + gönderilemeyenler)
  lines.forEach((l, i) => {
    if (cozulmus[i] && secici(cozulmus[i], cozulmus)) sira.push({ line: l, payload: cozulmus[i] });
    else geri.push(l);
  });

  let sent = 0, dropped = 0, status = "ok";
  for (let i = 0; i < sira.length; i++) {
    const r = await postDirect(sira[i].payload, config, { fetchImpl, queuePath, now, sleep, iptal });
    if (r.status === "sent") { sent++; ilerleme(i + 1, sira.length); continue; }
    if (r.status === "dropped") { dropped++; ilerleme(i + 1, sira.length); continue; }
    if (r.status === "auth_failed") {
      // Preserve all pending records after revocation for explicit recovery.
      geri.push(...sira.slice(i).map((entry) => entry.line));
      appendLines(queuePath, geri);
      return bitir({ sent, dropped, kalan: geri.length, toplam: sira.length, status: "auth_failed" });
    }
    // rate_limited | failed | budget | cancelled → bu ve kalanlar kuyrukta kalır
    status = r.status;
    for (let j = i; j < sira.length; j++) geri.push(sira[j].line);
    break;
  }

  if (geri.length) { appendLines(queuePath, geri); compactQueue(queuePath); }
  return bitir({ sent, dropped, kalan: geri.length, toplam: sira.length, status });
}

// Queue ownership is local metadata and never sent to the API. Re-pairing
// cannot upload a previous account's retained queue to the new account.
function queueOwner(config) {
  return crypto.createHash("sha256").update(`${config.ingest_url}\0${config.device_token}`).digest("hex");
}
function ownedQueueLines(lines, config, queuePath) {
  const owner = queueOwner(config), strict = fs.existsSync(`${queuePath}.owner`);
  const accepted = [], quarantined = [];
  for (const line of lines) {
    let payload; try { payload = JSON.parse(line); } catch { continue; }
    if (payload._usagex_queue_owner === owner || (!strict && !payload._usagex_queue_owner)) accepted.push(line);
    else quarantined.push(line);
  }
  if (quarantined.length) {
    withLock(`${queuePath}.quarantine.lock`, () => appendChunk(`${queuePath}.quarantine`, Buffer.from(quarantined.join("\n") + "\n")));
    uyarBirKez("UsagEX: önceki bağlantının bekleyen verileri yerelde ayrıldı; yeni hesaba gönderilmedi.");
  }
  return accepted;
}

// Serialize network delivery too: an older in-flight summary must never finish
// after a newer one from a parallel hook. Queue appends use a separate short lock.
async function sendPayload(payload, config, opts = {}) {
  const queuePath = opts.queuePath || defaultQueuePath();
  const stamped = { ...payload, _usagex_queue_owner: queueOwner(config), queued_at: payload.queued_at || new Date((opts.now || Date.now)()).toISOString() };
  const release = acquire(`${queuePath}.send-lock`);
  if (!release) { appendLines(queuePath, [JSON.stringify(stamped)]); return { status: "queued" }; }
  try { return await sendPayloadUnlocked(stamped, config, { ...opts, queuePath }); }
  finally { release(); }
}
async function flushQueue(config, opts = {}) {
  const queuePath = opts.queuePath || defaultQueuePath();
  const release = acquire(`${queuePath}.send-lock`);
  if (!release) return { authFailed: false, busy: true };
  try { return await flushQueueUnlocked(config, { ...opts, queuePath }); }
  finally { release(); }
}
async function drainQueue(config, opts = {}) {
  const queuePath = opts.queuePath || defaultQueuePath();
  const release = acquire(`${queuePath}.send-lock`);
  if (!release) return { sent: 0, dropped: 0, status: "busy" };
  try { return await drainQueueUnlocked(config, { ...opts, queuePath }); }
  finally { release(); }
}

module.exports = {
  sendPayload, flushQueue, postOnce, postDirect, drainQueue, defaultQueuePath, trimByKind, dropSuperseded,
  resetNotices, MAX_QUEUE_SIZE, MAX_FLUSH, FLUSH_BUDGET_MS, DROP_STATUS, AUTH_STATUS,
  AUTH_FAIL_LIMIT, ATOMIC_APPEND_LIMIT, RENAME_RETRY,
  DIRECT_429_TRIES, DIRECT_ERR_TRIES, DIRECT_ERR_WAIT_MS, DEFAULT_BLOCK_MS,
};
