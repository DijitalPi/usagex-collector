const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  postDirect, drainQueue, resetNotices,
  DIRECT_429_TRIES, DIRECT_ERR_TRIES, DIRECT_ERR_WAIT_MS, DEFAULT_BLOCK_MS,
} = require("../lib/sender");

// ── postDirect / drainQueue: toplu iş yolu ──────────────────────────────────
// Ölçülen sorun: `backfill.js 90` → "Gönderilen 598 · Kuyruğa yazılan 3813".
// Sunucunun ingest hız sınırı (600/dk/IP) 429 döndürünce sendPayload payload'ı
// KUYRUĞA yazıyordu; kuyruk kind başına 500'e kırpıldığı için eski günler
// kayboluyor, kalanlar da Stop hook'larıyla 10'ar 10'ar aylarca akıyordu.
// Toplu iş artık kuyruğa hiç dokunmaz: 429'da bekler, aynı payload'ı yineler.

function tmpQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-direct-"));
  return path.join(dir, "queue.jsonl");
}
const CONFIG = { ingest_url: "https://example.invalid/ingest", device_token: "t" };
const PAYLOAD = { schema_version: 1, kind: "session", session_id: "s1" };

// Sahte saat + sahte uyku: gerçek beklemeden 429/5xx geri çekilmesi ölçülür.
function sahteSaat(t0 = 1_000_000_000) {
  let t = t0;
  const beklemeler = [];
  return {
    now: () => t,
    sleep: async (ms) => { beklemeler.push(ms); t += ms; },
    beklemeler,
  };
}

// Sıradaki yanıtları döndüren sahte fetch (dizi biterse sonuncusu tekrarlanır).
function fetchSirasi(...yanitlar) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const y = yanitlar[Math.min(calls.length - 1, yanitlar.length - 1)];
    if (typeof y === "function") return y();
    return y;
  };
  impl.calls = calls;
  return impl;
}

const ok200 = () => ({ ok: true, status: 200 });
const hata = (status, body = "") => ({
  ok: false, status,
  headers: { get: () => null },
  text: async () => body,
});
const tooMany = (retryAfterSn, body = '{"error":"rate limited"}') => ({
  ok: false, status: 429,
  headers: { get: (h) => (h.toLowerCase() === "retry-after" ? (retryAfterSn == null ? null : String(retryAfterSn)) : null) },
  text: async () => body,
});
const agHatasi = () => { throw new Error("network down"); };

const kuyrukVarMi = (p) => fs.existsSync(p);
const kuyrukSatirlari = (p) => {
  try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
};

test("429 → Retry-After kadar BEKLER ve aynı payload'ı yeniden dener", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(tooMany(246), ok200());

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "sent");
  assert.strictEqual(r.tries, 2, "aynı payload ikinci kez denenmeli");
  assert.deepStrictEqual(saat.beklemeler, [246_000], "Retry-After'a saygı");
  assert.strictEqual(kuyrukVarMi(queuePath), false, "KUYRUĞA YAZILMAMALI");
});

test("429 + Retry-After yoksa 60 sn beklenir", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(tooMany(null), ok200());

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "sent");
  assert.deepStrictEqual(saat.beklemeler, [DEFAULT_BLOCK_MS]);
});

test("429 ısrar ederse 5 denemeden sonra rate_limited — kuyruğa YAZILMAZ", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(tooMany(null));

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "rate_limited");
  assert.strictEqual(r.tries, DIRECT_429_TRIES, "en fazla 5 deneme");
  assert.strictEqual(saat.beklemeler.length, DIRECT_429_TRIES - 1, "son denemeden sonra boşuna beklenmez");
  assert.strictEqual(kuyrukVarMi(queuePath), false);
});

test("429 'daily row budget exceeded': beklemek çözmez → tek denemede budget", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(tooMany(null, '{"error":"daily row budget exceeded"}'));

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "budget");
  assert.strictEqual(r.tries, 1, "günlük kota için 5 kez 60 sn beklemek boşuna");
  assert.deepStrictEqual(saat.beklemeler, []);
  assert.strictEqual(kuyrukVarMi(queuePath), false);
});

for (const status of [400, 404, 413, 415, 422]) {
  test(`kalıcı ${status}: tek denemede dropped (atlanır, sayılır) — kuyruk yok`, async () => {
    resetNotices();
    const queuePath = tmpQueue();
    const saat = sahteSaat();
    const spy = fetchSirasi(hata(status));

    const r = await postDirect(PAYLOAD, CONFIG, {
      fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
    });

    assert.strictEqual(r.status, "dropped");
    assert.strictEqual(r.tries, 1, "kalıcı hata yeniden denenmez");
    assert.deepStrictEqual(saat.beklemeler, []);
    assert.strictEqual(kuyrukVarMi(queuePath), false);
  });
}

test("5xx: 10 sn arayla 3 deneme, sonra failed — kuyruğa YAZILMAZ", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(hata(503));

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.tries, DIRECT_ERR_TRIES);
  assert.deepStrictEqual(saat.beklemeler, [DIRECT_ERR_WAIT_MS, DIRECT_ERR_WAIT_MS]);
  assert.strictEqual(kuyrukVarMi(queuePath), false);
});

test("5xx sonra düzelirse gönderilir", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(hata(500), ok200());

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "sent");
  assert.strictEqual(r.tries, 2);
});

test("ağ hatası/timeout da 3 denemeye tabidir", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(agHatasi);

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "failed");
  assert.strictEqual(spy.calls.length, DIRECT_ERR_TRIES);
  assert.strictEqual(kuyrukVarMi(queuePath), false);
});

test("açık 429 penceresine (blocked) saygı: önce bekler, sonra gönderir", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  // Hook'lardan kalan damga: 90 sn daha ağa çıkılmamalı
  fs.writeFileSync(`${queuePath}.blocked`, String(saat.now() + 90_000));
  const spy = fetchSirasi(ok200());

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.deepStrictEqual(saat.beklemeler, [90_000], "pencere dolana kadar beklenmeli");
  assert.strictEqual(spy.calls.length, 1, "pencere içinde istek atılmamalı");
  assert.strictEqual(r.status, "sent");
  assert.strictEqual(fs.existsSync(`${queuePath}.blocked`), false, "başarılı gönderimde damga silinir");
});

test("retry:false tek deneme yapar (ping benzeri kullanım)", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(tooMany(null));

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep, retry: false,
  });

  assert.strictEqual(r.status, "rate_limited");
  assert.strictEqual(spy.calls.length, 1);
  assert.deepStrictEqual(saat.beklemeler, []);
});

test("iptal (Ctrl-C) beklemeden döner ve kuyruğa yazmaz", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(ok200());

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep, iptal: () => true,
  });

  assert.strictEqual(r.status, "cancelled");
  assert.strictEqual(spy.calls.length, 0);
  assert.strictEqual(kuyrukVarMi(queuePath), false);
});

test("ara katman 401'i (JSON olmayan gövde) collector'ı KAPATMAZ", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  const spy = fetchSirasi(hata(401, "<html>proxy login</html>"));

  const r = await postDirect(PAYLOAD, CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.status, "failed", "geçici sayılır, auth_failed DEĞİL");
  assert.strictEqual(kuyrukVarMi(queuePath), false);
});

// ── drainQueue ──────────────────────────────────────────────────────────────

function kuyrukYaz(queuePath, kayitlar) {
  fs.writeFileSync(queuePath, kayitlar.map((k) => JSON.stringify(k)).join("\n") + "\n");
}

test("drainQueue seçilen kayıtları gönderir, seçilmeyenleri kuyrukta BIRAKIR", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  kuyrukYaz(queuePath, [
    { schema_version: 1, kind: "session", session_id: "a", source: "backfill" },
    { schema_version: 1, kind: "session", session_id: "b", source: "stop" },
    { schema_version: 1, kind: "session", session_id: "c", source: "backfill" },
  ]);
  const spy = fetchSirasi(ok200());

  const r = await drainQueue(CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
    secici: (p) => p.source === "backfill",
  });

  assert.strictEqual(r.sent, 2);
  assert.strictEqual(r.status, "ok");
  const kalan = kuyrukSatirlari(queuePath);
  assert.deepStrictEqual(kalan.map((p) => p.session_id), ["b"], "taze kayıt hook'un işi, kalmalı");
});

test("drainQueue 429'da durur ve gönderilmeyenleri kuyruğa GERİ yazar (kayıp yok)", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  kuyrukYaz(queuePath, [
    { schema_version: 1, kind: "session", session_id: "a" },
    { schema_version: 1, kind: "session", session_id: "b" },
    { schema_version: 1, kind: "session", session_id: "c" },
  ]);
  // İlk kayıt geçer, sonrakiler hep 429 → 5 deneme sonra rate_limited
  let n = 0;
  const spy = async () => (++n === 1 ? ok200() : tooMany(null));

  const r = await drainQueue(CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
  });

  assert.strictEqual(r.sent, 1);
  assert.strictEqual(r.status, "rate_limited");
  assert.strictEqual(r.kalan, 2);
  assert.deepStrictEqual(
    kuyrukSatirlari(queuePath).map((p) => p.session_id), ["b", "c"],
    "gönderilemeyenler kuyrukta kalmalı"
  );
});

test("drainQueue kalıcı 4xx'i atlar ve devam eder", async () => {
  resetNotices();
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  kuyrukYaz(queuePath, [
    { schema_version: 1, kind: "session", session_id: "a" },
    { schema_version: 1, kind: "session", session_id: "b" },
  ]);
  const spy = fetchSirasi(hata(400), ok200());

  const r = await drainQueue(CONFIG, { fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep });

  assert.strictEqual(r.dropped, 1);
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(kuyrukVarMi(queuePath), false, "kuyruk tamamen boşalmalı");
});

test("drainQueue boş/olmayan kuyrukta sessizce döner", async () => {
  const queuePath = tmpQueue();
  const spy = fetchSirasi(ok200());
  const r = await drainQueue(CONFIG, { fetchImpl: spy, queuePath });
  assert.strictEqual(r.status, "empty");
  assert.strictEqual(spy.calls.length, 0);
});

test("drainQueue ilerlemeyi bildirir", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  kuyrukYaz(queuePath, [1, 2, 3].map((i) => ({ schema_version: 1, kind: "session", session_id: `s${i}` })));
  const spy = fetchSirasi(ok200());
  const adimlar = [];

  await drainQueue(CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
    ilerleme: (n, toplam) => adimlar.push(`${n}/${toplam}`),
  });

  assert.deepStrictEqual(adimlar, ["1/3", "2/3", "3/3"]);
});

test("drainQueue iptal edilince kalanlar kuyrukta durur", async () => {
  const queuePath = tmpQueue();
  const saat = sahteSaat();
  kuyrukYaz(queuePath, [1, 2, 3].map((i) => ({ schema_version: 1, kind: "session", session_id: `s${i}` })));
  let gonderilen = 0;
  const spy = async () => { gonderilen++; return ok200(); };

  const r = await drainQueue(CONFIG, {
    fetchImpl: spy, queuePath, now: saat.now, sleep: saat.sleep,
    iptal: () => gonderilen >= 1, // ilk gönderimden sonra Ctrl-C
  });

  assert.strictEqual(r.sent, 1);
  assert.strictEqual(r.status, "cancelled");
  assert.deepStrictEqual(kuyrukSatirlari(queuePath).map((p) => p.session_id), ["s2", "s3"]);
});
