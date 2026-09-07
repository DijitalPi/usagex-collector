const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  sendPayload, flushQueue, postOnce, trimByKind,
  MAX_QUEUE_SIZE, MAX_FLUSH, FLUSH_BUDGET_MS,
} = require("../lib/sender");

function tmpQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-test-"));
  return path.join(dir, "queue.jsonl");
}
const CONFIG = { ingest_url: "https://example.invalid/ingest", device_token: "test" };
const readQueue = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const okRes = () => ({ ok: true, status: 200 });
// 429 + retry-after (saniye)
const tooMany = (retryAfter) => ({
  ok: false, status: 429,
  headers: { get: (h) => (h.toLowerCase() === "retry-after" ? String(retryAfter) : null) },
});

test("sendPayload sunucu kapalıyken kuyruk boyutunu MAX_QUEUE_SIZE ile sınırlar", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clmt-test-"));
  const queuePath = path.join(tmpDir, "queue.jsonl");

  const failingFetch = async () => ({ ok: false });
  const config = { ingest_url: "http://localhost:9999/ingest", device_token: "test" };

  // MAX_QUEUE_SIZE + 20 adet payload gönder
  const total = MAX_QUEUE_SIZE + 20;
  for (let i = 0; i < total; i++) {
    await sendPayload({ item: i }, config, { fetchImpl: failingFetch, queuePath });
  }

  const lines = fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, MAX_QUEUE_SIZE);

  // En son eklenen ögelerin korunduğunu (FIFO) doğrula
  const firstSaved = JSON.parse(lines[0]);
  const lastSaved = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(firstSaved.item, 20); // 0-19 arası kırpıldı
  assert.strictEqual(lastSaved.item, total - 1);

  // Temizlik
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── kind bazlı kırpma ───────────────────────────────────────────────────────
// Uzun çevrimdışı dönemde 5 dk'da bir düşen snapshot'lar kuyruğu doldurup asıl
// değerli veriyi (oturum özetleri) dışarı itiyordu. Her kind kendi 500'ünü korur.

test("trimByKind her kind için ayrı 500'lük pencere tutar", () => {
  const lines = [];
  for (let i = 0; i < 700; i++) lines.push(JSON.stringify({ kind: "snapshot", i }));
  for (let i = 0; i < 3; i++) lines.push(JSON.stringify({ kind: "session", i }));
  const out = trimByKind(lines).map((l) => JSON.parse(l));
  assert.strictEqual(out.filter((o) => o.kind === "snapshot").length, MAX_QUEUE_SIZE);
  assert.strictEqual(out.filter((o) => o.kind === "session").length, 3, "oturumlar hayatta kalmalı");
  // en YENİ snapshot'lar korunur, sıra bozulmaz
  assert.strictEqual(out.find((o) => o.kind === "snapshot").i, 200);
});

test("sendPayload kuyrukta oturum özetlerini snapshot seline kurban etmez", async () => {
  const queuePath = tmpQueue();
  const fail = async () => ({ ok: false, status: 0 });
  await sendPayload({ kind: "session", session_id: "kiymetli" }, CONFIG, { fetchImpl: fail, queuePath });
  for (let i = 0; i < MAX_QUEUE_SIZE + 50; i++) {
    await sendPayload({ kind: "snapshot", i }, CONFIG, { fetchImpl: fail, queuePath });
  }
  const q = readQueue(queuePath);
  assert.strictEqual(q.filter((p) => p.kind === "session").length, 1);
  assert.strictEqual(q.filter((p) => p.kind === "snapshot").length, MAX_QUEUE_SIZE);
});

// ── flushQueue: sıra, ilk hatada durma, süre bütçesi ────────────────────────

test("flushQueue sırayı korur ve tamamı gidince kuyruğu siler", async () => {
  const queuePath = tmpQueue();
  fs.writeFileSync(queuePath, [1, 2, 3].map((i) => JSON.stringify({ i })).join("\n") + "\n");
  const gonderilen = [];
  const spy = async (_u, o) => { gonderilen.push(JSON.parse(o.body).i); return okRes(); };

  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });

  assert.deepStrictEqual(gonderilen, [1, 2, 3]);
  assert.strictEqual(fs.existsSync(queuePath), false);
});

test("flushQueue ilk hatada DURUR, kalanı sırayla kuyrukta bırakır", async () => {
  const queuePath = tmpQueue();
  fs.writeFileSync(queuePath, [1, 2, 3, 4].map((i) => JSON.stringify({ i })).join("\n") + "\n");
  let n = 0;
  const spy = async () => (++n <= 2 ? okRes() : { ok: false, status: 500 });

  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });

  assert.strictEqual(n, 3, "3. denemede durmalı, 4.'ye geçmemeli");
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.i), [3, 4]);
});

test("flushQueue tek turda en fazla MAX_FLUSH eleman dener", async () => {
  const queuePath = tmpQueue();
  const lines = [];
  for (let i = 0; i < MAX_FLUSH + 7; i++) lines.push(JSON.stringify({ i }));
  fs.writeFileSync(queuePath, lines.join("\n") + "\n");
  let n = 0;
  const spy = async () => { n++; return okRes(); };

  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });

  assert.strictEqual(n, MAX_FLUSH);
  assert.strictEqual(readQueue(queuePath).length, 7);
});

test("flushQueue süre bütçesi dolunca kalanı kuyrukta bırakır", async () => {
  const queuePath = tmpQueue();
  const lines = [];
  for (let i = 0; i < MAX_FLUSH; i++) lines.push(JSON.stringify({ i }));
  fs.writeFileSync(queuePath, lines.join("\n") + "\n");
  // Sahte saat: her now() çağrısı 2 sn ilerletir → 5 sn'lik bütçe hızla dolar.
  let t = 0;
  const now = () => (t += 2000);
  let n = 0;
  const spy = async () => { n++; return okRes(); };

  await flushQueue(CONFIG, { fetchImpl: spy, queuePath, now });

  assert.ok(n > 0 && n < MAX_FLUSH, `bütçe erken durdurmalı (gönderilen: ${n})`);
  assert.strictEqual(readQueue(queuePath).length, MAX_FLUSH - n, "kalan kuyrukta durmalı");
});

test("flushQueue bozuk satırı atar, iyi olanı gönderir", async () => {
  const queuePath = tmpQueue();
  fs.writeFileSync(queuePath, "{{{bozuk\n" + JSON.stringify({ i: 9 }) + "\n");
  const gonderilen = [];
  const spy = async (_u, o) => { gonderilen.push(JSON.parse(o.body).i); return okRes(); };

  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });

  assert.deepStrictEqual(gonderilen, [9]);
  assert.strictEqual(fs.existsSync(queuePath), false);
});

// ── 429 dalı ────────────────────────────────────────────────────────────────
// Sunucu ingest'te rate limit uyguluyor. 429'da her hook'ta yeniden denemek
// 3 sn'lik timeout'a girip oturumu bekletiyordu; pencere boyunca hiç deneme.

test("429: payload kuyruğa yazılır ve pencere boyunca ağa ÇIKILMAZ", async () => {
  const queuePath = tmpQueue();
  let n = 0;
  const spy = async () => { n++; return tooMany(120); };
  let t = 1_000_000;

  const ok = await sendPayload({ kind: "snapshot", i: 1 }, CONFIG, {
    fetchImpl: spy, queuePath, now: () => t,
  });
  assert.strictEqual(ok.status, "queued");
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.i), [1]);

  // 60 sn sonra (retry-after 120 sn) — hâlâ pencere içinde: istek YOK, sadece kuyruk
  t += 60_000;
  await sendPayload({ kind: "snapshot", i: 2 }, CONFIG, { fetchImpl: spy, queuePath, now: () => t });
  assert.strictEqual(n, 1, "pencere içinde yeni istek atılmamalı");
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.i), [1, 2]);

  // pencere bitince yeniden dener ve başarıda damga temizlenir
  t += 61_000;
  const spy2 = async () => { n++; return okRes(); };
  const ok2 = await sendPayload({ kind: "snapshot", i: 3 }, CONFIG, {
    fetchImpl: spy2, queuePath, now: () => t,
  });
  assert.strictEqual(ok2.status, "sent");
  assert.strictEqual(fs.existsSync(queuePath), false, "başarılı gönderimde kuyruk boşalmalı");
});

test("429 retry-after yoksa varsayılan 60 sn pencere uygulanır", async () => {
  const queuePath = tmpQueue();
  let n = 0;
  const spy = async () => { n++; return { ok: false, status: 429, headers: { get: () => null } }; };
  let t = 5_000_000;

  await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl: spy, queuePath, now: () => t });
  t += 30_000;
  await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl: spy, queuePath, now: () => t });
  assert.strictEqual(n, 1, "30 sn sonra hâlâ pencere içinde");
  t += 31_000;
  await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl: spy, queuePath, now: () => t });
  assert.strictEqual(n, 2, "61 sn sonra tekrar denenmeli");
});

test("postOnce kuyruğa YAZMAZ (backfill ön kontrolü)", async () => {
  const queuePath = tmpQueue();
  assert.strictEqual(await postOnce({ kind: "snapshot" }, CONFIG, { fetchImpl: async () => okRes() }), true);
  assert.strictEqual(await postOnce({ kind: "snapshot" }, CONFIG, { fetchImpl: async () => ({ ok: false, status: 0 }) }), false);
  assert.strictEqual(fs.existsSync(queuePath), false);
});

test("ağ hatası (fetch throw) sessizce kuyruğa yazar, çökmez", async () => {
  const queuePath = tmpQueue();
  const spy = async () => { throw new Error("ECONNREFUSED"); };
  assert.strictEqual((await sendPayload({ kind: "session" }, CONFIG, { fetchImpl: spy, queuePath })).status, "queued");
  assert.strictEqual(readQueue(queuePath).length, 1);
});

// SIRA: önce KUYRUK, sonra yeni payload. Tersi (eski davranış) sunucudaki
// (kullanıcı, oturum, gün) satırını eski değere geri döndürüyordu — kullanıcı
// "bugünkü rakam azaldı" diyordu.
test("başarılı gönderimde ÖNCE kuyruk, SONRA yeni payload gider", async () => {
  const queuePath = tmpQueue();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "session", i: 0 }) + "\n");
  const gonderilen = [];
  const spy = async (_u, o) => { gonderilen.push(JSON.parse(o.body).i); return okRes(); };

  await sendPayload({ kind: "snapshot", i: 1 }, CONFIG, { fetchImpl: spy, queuePath });

  assert.deepStrictEqual(gonderilen, [0, 1], "eski kuyruk yeninin ÜSTÜNE yazmamalı");
  assert.strictEqual(fs.existsSync(queuePath), false);
});

assert.ok(FLUSH_BUDGET_MS > 0 && MAX_FLUSH > 0); // sözleşme: ikisi de dışa açık
