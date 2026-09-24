const { withLock } = require("./file-lock");
const fs = require("fs");
const path = require("path");
const { claudeDir } = require("./config");

// Throttle durumu: ~/.claude/usagex-state.json
//   last_heartbeat_at        → KÜRESEL: plan_usage yüzde snapshot'ı (tüm oturumlar ortak)
//   sessions: { [id]: ts }   → OTURUM BAZLI: transcript/oturum özeti
// İkisi ayrı: paralel açılmış üç oturumdan yalnız birinin özeti gitsin diye küresel
// throttle kullanılıyordu; diğer ikisi 5 dk boyunca hiç rapor edilmiyordu.
// Snapshot penceresi 5 dk'dan 2 dk'ya indirildi: eşik bildirimleri (%80/%90)
// yüzde tazelenene kadar bekliyor, kullanıcı limiti geçtiğini geç öğreniyordu.
// Yalnız SNAPSHOT yolu kısaldı — oturum özeti 5 dk'da kalır: o yol pahalı
// (transkript okuma + büyük gövde) ve bildirim gecikmesiyle ilgisi yok.
// Uç dövülmüyor: oauth-usage.js'te 60 sn'lik alt sınır ve 429 back-off duruyor.
// 2 dk yalnız VARSAYILAN: çağıran intervalMs ile ezebilir. hooks/heartbeat.js,
// son 60 dk içinde 429 görülmüşse burayı 5 dk'ya çeker (uyarlanabilir tempo).
const HEARTBEAT_MIN_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 saatten eski oturum kaydı süpürülür

function statePath(dir = claudeDir()) {
  return path.join(dir, "usagex-state.json");
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), "utf8")) || {};
  } catch {
    return {};
  }
}

// Atomik yazım: geçici dosyaya yaz + rename. Doğrudan writeFileSync'te hook tam o
// anda öldürülürse (oturum kapanışı) yarım JSON kalıyor ve throttle sıfırlanıyordu.
function writeState(state, dir) {
  const p = statePath(dir);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// 24 saatten eski oturum damgalarını at (state dosyası sonsuza kadar şişmesin).
function pruneSessions(sessions, now) {
  const out = {};
  for (const [id, ts] of Object.entries(sessions || {})) {
    if (typeof ts === "number" && now - ts < SESSION_TTL_MS) out[id] = ts;
  }
  return out;
}

// ── peek / commit ───────────────────────────────────────────────────────────
// Eskiden throttle tek adımda "sor ve damgala"ydı (check-and-set). Sorun: damga
// İŞ YAPILMADAN ÖNCE yanıyordu —
//   · yeni oturumda transcript henüz boşken oturum slotu tükeniyor, ilk 5 dakika
//     boyunca hiç özet gitmiyordu;
//   · limit ucu back-off'taysa (stale) heartbeat slotu yanıyor, taze yüzde
//     geldiğinde de 5 dk daha bekleniyordu.
// Artık iki parça: *Due() yalnız OKUR, mark*Sent() gönderimden SONRA damgalar.
// Damgayı "sunucu 200 döndü"ye değil "payload teslim edildi"ye bağlıyoruz:
// kuyruğa yazmak da kalıcı teslimdir, aksi halde çevrimdışı bir makinede her
// Stop hook'u aynı oturumun yeni bir kopyasını kuyruğa yığardı.
function heartbeatDue({ dir, now = Date.now, intervalMs = HEARTBEAT_MIN_INTERVAL_MS } = {}) {
  const last = readState(dir).last_heartbeat_at;
  // last yoksa/bozuksa "hiç gönderilmedi" say — her zaman gönder
  return !(typeof last === "number" && now() - last < intervalMs);
}

function markHeartbeatSent({ dir, now = Date.now } = {}) {
  return withLock(`${statePath(dir)}.lock`, () => {
  const state = readState(dir);
  const t = now();
  state.last_heartbeat_at = t;
  state.sessions = pruneSessions(state.sessions, t);
  writeState(state, dir);
  });
}

// Oturum başına aynı ikili. session_id yoksa throttle uygulanamaz — o durumda
// küresel throttle'a bırakmak için false döner.
function sessionDue(sessionId, { dir, now = Date.now, intervalMs = SESSION_MIN_INTERVAL_MS } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const last = (readState(dir).sessions || {})[sessionId];
  return !(typeof last === "number" && now() - last < intervalMs);
}

function markSessionSent(sessionId, { dir, now = Date.now } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return;
  return withLock(`${statePath(dir)}.lock`, () => {
  const state = readState(dir);
  const t = now();
  const sessions = pruneSessions(state.sessions, t);
  sessions[sessionId] = t;
  state.sessions = sessions;
  writeState(state, dir);
  });
}

// Geriye uyumlu tek adımlık sarmalayıcılar (eski çağrı yerleri ve testler).
function shouldHeartbeat(opts = {}) {
  if (!heartbeatDue(opts)) return false;
  markHeartbeatSent(opts);
  return true;
}
function shouldSendSession(sessionId, opts = {}) {
  if (!sessionDue(sessionId, opts)) return false;
  markSessionSent(sessionId, opts);
  return true;
}

module.exports = {
  heartbeatDue,
  markHeartbeatSent,
  sessionDue,
  markSessionSent,
  shouldHeartbeat,
  shouldSendSession,
  readState,
  writeState,
  statePath,
  HEARTBEAT_MIN_INTERVAL_MS,
  SESSION_MIN_INTERVAL_MS,
  SESSION_TTL_MS,
};
