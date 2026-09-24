const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  shouldHeartbeat, shouldSendSession, statePath, readState,
  HEARTBEAT_MIN_INTERVAL_MS, SESSION_MIN_INTERVAL_MS, SESSION_TTL_MS,
} = require("../lib/state");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clmt-test-"));
}

test("ilk çağrıda true döner ve zamanı yazar", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  const state = JSON.parse(fs.readFileSync(statePath(dir), "utf8"));
  assert.strictEqual(state.last_heartbeat_at, t);
});

test("throttle penceresi içinde false döner", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  t += HEARTBEAT_MIN_INTERVAL_MS - 60 * 1000; // pencerenin 1 dk içi
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), false);
});

test("pencere dolunca tekrar true döner", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  t += HEARTBEAT_MIN_INTERVAL_MS + 60 * 1000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
});

test("bozuk state dosyası sıfırdan başlatır", () => {
  const dir = tmpDir();
  fs.writeFileSync(statePath(dir), "not-json{{{");
  assert.strictEqual(shouldHeartbeat({ dir, now: () => 5 }), true);
});

test("state yazımı atomik: geçici .tmp dosyası ARDINDA bırakılmaz", () => {
  const dir = tmpDir();
  shouldHeartbeat({ dir, now: () => 1 });
  shouldSendSession("s1", { dir, now: () => 1 });
  const artik = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepStrictEqual(artik, []);
  // ve dosya geçerli JSON
  assert.strictEqual(typeof readState(dir).last_heartbeat_at, "number");
});

// ── oturum bazlı throttle ───────────────────────────────────────────────────
// Küresel throttle, aynı anda açık birden çok oturumdan yalnız birinin özetinin
// gitmesine yol açıyordu. Artık her session_id kendi 5 dk'lık penceresine sahip.

test("farklı oturumlar birbirinin penceresini TÜKETMEZ", () => {
  const dir = tmpDir();
  const t = 1_000_000;
  assert.strictEqual(shouldSendSession("a", { dir, now: () => t }), true);
  assert.strictEqual(shouldSendSession("b", { dir, now: () => t }), true, "b, a yüzünden susmamalı");
  assert.strictEqual(shouldSendSession("c", { dir, now: () => t }), true);
});

test("aynı oturum pencere içinde ikinci kez göndermez, pencere dolunca gönderir", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  assert.strictEqual(shouldSendSession("a", { dir, now: () => t }), true);
  t += SESSION_MIN_INTERVAL_MS - 1000;
  assert.strictEqual(shouldSendSession("a", { dir, now: () => t }), false);
  t += 2000;
  assert.strictEqual(shouldSendSession("a", { dir, now: () => t }), true);
});

test("oturum ve küresel throttle birbirinden BAĞIMSIZ", () => {
  const dir = tmpDir();
  const t = 1_000_000;
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), true);
  // küresel pencere kapandı ama oturum özeti yine de gidebilmeli
  assert.strictEqual(shouldHeartbeat({ dir, now: () => t }), false);
  assert.strictEqual(shouldSendSession("a", { dir, now: () => t }), true);
});

test("session_id yoksa false (küresel throttle'a bırakılır)", () => {
  const dir = tmpDir();
  assert.strictEqual(shouldSendSession(null, { dir }), false);
  assert.strictEqual(shouldSendSession("", { dir }), false);
  assert.strictEqual(shouldSendSession(undefined, { dir }), false);
});

test("24 saatten eski oturum kayıtları süpürülür (state şişmesin)", () => {
  const dir = tmpDir();
  const t0 = 1_000_000_000;
  shouldSendSession("eski", { dir, now: () => t0 });
  assert.ok(readState(dir).sessions.eski);

  const t1 = t0 + SESSION_TTL_MS + 1000;
  shouldSendSession("yeni", { dir, now: () => t1 });
  const sessions = readState(dir).sessions;
  assert.strictEqual(sessions.eski, undefined, "24 saatten eski kayıt gitmeli");
  assert.strictEqual(sessions.yeni, t1);
});

test("shouldHeartbeat de eski oturum kayıtlarını süpürür", () => {
  const dir = tmpDir();
  const t0 = 2_000_000_000;
  shouldSendSession("eski", { dir, now: () => t0 });
  shouldHeartbeat({ dir, now: () => t0 + SESSION_TTL_MS + 1 });
  assert.strictEqual(readState(dir).sessions.eski, undefined);
});

assert.ok(HEARTBEAT_MIN_INTERVAL_MS > 0);

// ── peek / commit (bulgu 7) ─────────────────────────────────────────────────
// Eski check-and-set slotu İŞ YAPILMADAN ÖNCE tüketiyordu: yeni oturumda
// transcript henüz boşken oturum slotu yanıyor ve ilk 5 dakika hiç özet
// gitmiyordu; limit ucu back-off'taysa heartbeat slotu boşa yanıyordu.

const {
  heartbeatDue, markHeartbeatSent, sessionDue, markSessionSent,
} = require("../lib/state");

test("heartbeatDue yalnız OKUR — damga basmaz", () => {
  const dir = tmpDir();
  const t = 1_000_000;
  assert.strictEqual(heartbeatDue({ dir, now: () => t }), true);
  assert.strictEqual(heartbeatDue({ dir, now: () => t }), true, "sorgu slotu tüketmemeli");
  assert.strictEqual(readState(dir).last_heartbeat_at, undefined, "state dosyası yazılmamalı");
});

test("markHeartbeatSent damgayı basar ve pencereyi kapatır", () => {
  const dir = tmpDir();
  let t = 1_000_000;
  markHeartbeatSent({ dir, now: () => t });
  assert.strictEqual(heartbeatDue({ dir, now: () => t }), false);
  t += HEARTBEAT_MIN_INTERVAL_MS + 1;
  assert.strictEqual(heartbeatDue({ dir, now: () => t }), true);
});

test("sessionDue yalnız OKUR — damga basmaz", () => {
  const dir = tmpDir();
  const t = 1_000_000;
  assert.strictEqual(sessionDue("a", { dir, now: () => t }), true);
  assert.strictEqual(sessionDue("a", { dir, now: () => t }), true);
  assert.deepStrictEqual(readState(dir).sessions, undefined);
});

test("markSessionSent yalnız o oturumun penceresini kapatır", () => {
  const dir = tmpDir();
  const t = 1_000_000;
  markSessionSent("a", { dir, now: () => t });
  assert.strictEqual(sessionDue("a", { dir, now: () => t }), false);
  assert.strictEqual(sessionDue("b", { dir, now: () => t }), true);
});

test("markSessionSent session_id yoksa sessizce hiçbir şey yapmaz", () => {
  const dir = tmpDir();
  markSessionSent(null, { dir, now: () => 1 });
  markSessionSent("", { dir, now: () => 1 });
  assert.deepStrictEqual(readState(dir), {});
});

test("markSessionSent eski oturum damgalarını süpürür", () => {
  const dir = tmpDir();
  const t0 = 3_000_000_000;
  markSessionSent("eski", { dir, now: () => t0 });
  markSessionSent("yeni", { dir, now: () => t0 + SESSION_TTL_MS + 1 });
  assert.strictEqual(readState(dir).sessions.eski, undefined);
});

// ── S11: snapshot penceresi 2 dk, oturum özeti 5 dk ─────────────────────────
// Eşik bildirimleri geç kalıyordu: yüzde snapshot'ı 5 dk'da bir gidiyor, üstüne
// oauth cache'i de 5 dk taze sayıyordu. Snapshot yolu 2 dk'ya indirildi;
// oturum özeti (pahalı yol) 5 dk'da bırakıldı.

test("heartbeat penceresi 2 dk, oturum penceresi 5 dk", () => {
  assert.strictEqual(HEARTBEAT_MIN_INTERVAL_MS, 2 * 60 * 1000);
  assert.strictEqual(SESSION_MIN_INTERVAL_MS, 5 * 60 * 1000);
  assert.ok(HEARTBEAT_MIN_INTERVAL_MS < SESSION_MIN_INTERVAL_MS);
});

test("snapshot 2 dk sonra yeniden sıraya girer, oturum özeti hâlâ beklemede", () => {
  const dir = tmpDir();
  const t0 = 4_000_000_000;
  markHeartbeatSent({ dir, now: () => t0 });
  markSessionSent("a", { dir, now: () => t0 });

  const t1 = t0 + 2 * 60 * 1000 + 1; // 2 dk + 1 ms
  assert.strictEqual(heartbeatDue({ dir, now: () => t1 }), true, "yüzde snapshot'ı 2 dk'da açılmalı");
  assert.strictEqual(sessionDue("a", { dir, now: () => t1 }), false, "oturum özeti 5 dk beklemeli");

  const t2 = t0 + 5 * 60 * 1000 + 1;
  assert.strictEqual(sessionDue("a", { dir, now: () => t2 }), true);
});

test("intervalMs parametresi varsayılanı ezebilir (çağıran pencereyi seçer)", () => {
  const dir = tmpDir();
  const t0 = 5_000_000_000;
  markHeartbeatSent({ dir, now: () => t0 });
  assert.strictEqual(heartbeatDue({ dir, now: () => t0 + 60_000 }), false);
  assert.strictEqual(heartbeatDue({ dir, now: () => t0 + 60_000, intervalMs: 30_000 }), true);
});
