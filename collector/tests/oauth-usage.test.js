const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getPlanUsage } = require("../lib/oauth-usage");

const CACHE_FILE = "usagex-usage-cache.json";
const TTL_MS = 5 * 60 * 1000; // oauth-usage.js CACHE_TTL_MS ile hizalı

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clmt-test-"));
}

// getAccessToken(dir) bu dosyayı dir'den okur (bkz. lib/credentials.js)
function writeCreds(dir, token = "tok-test") {
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token } })
  );
}

function writeCache(dir, fetched_at, plan_usage) {
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({ fetched_at, plan_usage }));
}

function readCache(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), "utf8"));
}

// fetch spy: her çağrıyı kaydeder; response fonksiyon ise onu çağırır (hata/reject simülasyonu)
function fetchSpy(response) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return typeof response === "function" ? response(url, opts) : response;
  };
  impl.calls = calls;
  return impl;
}

// fetch Response benzeri: { ok, json() }
const okJson = (body) => ({ ok: true, json: async () => body });

test("taze cache varken fetch çağrılmaz, cache'teki değer döner", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 12, week_pct: 34, session_resets_at: null, week_resets_at: null };
  writeCache(dir, now, cached); // age = 0 → taze
  const spy = fetchSpy(okJson({ five_hour: { utilization: 99 }, seven_day: { utilization: 99 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.deepStrictEqual(res, cached);
  assert.strictEqual(spy.calls.length, 0); // taze cache → ağ yok
});

test("force:true taze cache varken bile fetch eder, yeni değeri döner ve cache'i günceller", async () => {
  const dir = tmpDir();
  writeCreds(dir, "tok-xyz");
  const now = 2_000_000_000;
  writeCache(dir, now, { session_pct: 12, week_pct: 34, session_resets_at: null, week_resets_at: null });
  const spy = fetchSpy(okJson({
    five_hour: { utilization: 55, resets_at: "R5" },
    seven_day: { utilization: 66, resets_at: "R7" },
  }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.strictEqual(spy.calls.length, 1); // taze cache atlandı
  assert.deepStrictEqual(res, {
    session_pct: 55, week_pct: 66, session_resets_at: "R5", week_resets_at: "R7",
  });
  // credential dosyasından okunan token Bearer olarak gitmeli
  assert.strictEqual(spy.calls[0].opts.headers.Authorization, "Bearer tok-xyz");
  // cache taze değerle güncellendi
  const cache = readCache(dir);
  assert.strictEqual(cache.fetched_at, now);
  assert.deepStrictEqual(cache.plan_usage, res);
});

test("cache TTL (5 dk) dolunca fetch eder", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const fetchedAt = 5_000_000_000;
  writeCache(dir, fetchedAt, { session_pct: 1, week_pct: 2, session_resets_at: null, week_resets_at: null });
  const now = fetchedAt + TTL_MS; // tam sınır: age === TTL → bayat (age < TTL değil)
  const spy = fetchSpy(okJson({ five_hour: { utilization: 70 }, seven_day: { utilization: 80 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(res.session_pct, 70);
  assert.strictEqual(res.week_pct, 80);
});

test("saat geri alınmış (cache fetched_at gelecekte) → bayat sayılır, fetch eder (skew koruması)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 3_000_000_000;
  // gelecekteki damga: age = now - fetched_at < 0 → taze sayılmamalı
  writeCache(dir, now + 60_000, { session_pct: 9, week_pct: 9, session_resets_at: null, week_resets_at: null });
  const spy = fetchSpy(okJson({ five_hour: { utilization: 20 }, seven_day: { utilization: 30 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(res.session_pct, 20);
});

test("fetch başarısız/timeout → null döner, çökmez, cache yazılmaz", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 4_000_000_000;
  const spy = fetchSpy(() => Promise.reject(new Error("network timeout/abort")));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(res, null);
  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(fs.existsSync(path.join(dir, CACHE_FILE)), false); // hata yolunda cache yok
});

test("endpoint formatı değişmiş (utilization alanları yok) → null döner ve null da cache'lenir (5 dk back-off)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 6_000_000_000;
  const spy = fetchSpy(okJson({ some_new_shape: { foo: 1 } })); // five_hour/seven_day yok

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(res, null);
  assert.strictEqual(spy.calls.length, 1);
  const cache = readCache(dir);
  assert.strictEqual(cache.plan_usage, null); // null da cache'lendi
  assert.strictEqual(cache.fetched_at, now);

  // aynı pencere içinde ikinci çağrı: taze null cache → fetch YOK (back-off korunur)
  const res2 = await getPlanUsage({ dir, fetchImpl: spy, now: () => now + 1000 });
  assert.strictEqual(res2, null);
  assert.strictEqual(spy.calls.length, 1); // hâlâ 1 — tekrar istek atılmadı
});

test("pct kelepçesi: utilization 150 → 100, -5 → 0 (ve yuvarlama)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 7_000_000_000;
  const spy = fetchSpy(okJson({ five_hour: { utilization: 150 }, seven_day: { utilization: -5 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
  assert.strictEqual(res.session_pct, 100); // üst kelepçe
  assert.strictEqual(res.week_pct, 0); // alt kelepçe

  // yuvarlama: 42.4 → 42, 42.6 → 43 (force ile taze cache atlanır)
  const spy2 = fetchSpy(okJson({ five_hour: { utilization: 42.4 }, seven_day: { utilization: 42.6 } }));
  const res2 = await getPlanUsage({ dir, fetchImpl: spy2, now: () => now, force: true });
  assert.strictEqual(res2.session_pct, 42);
  assert.strictEqual(res2.week_pct, 43);
});

test("credential yoksa null döner, fetch hiç çağrılmaz", async () => {
  const dir = tmpDir(); // .credentials.json YAZILMADI
  const now = 8_000_000_000;
  const spy = fetchSpy(okJson({ five_hour: { utilization: 50 }, seven_day: { utilization: 50 } }));

  // macOS'ta getAccessToken keychain'e düşer; deterministik olması için platform'u
  // geçici olarak non-darwin yap (readTokenFromKeychain erken null döner).
  const origPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
    assert.strictEqual(res, null);
    assert.strictEqual(spy.calls.length, 0); // token yok → ağ yok
  } finally {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  }
});
