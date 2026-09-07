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

// plan_usage artık iki EK alan taşıyor: measured_at (ölçüm zamanı, sunucu taken_at'i
// bununla yazsın diye) ve scoped (model bazlı haftalık limitler). Aşağıdaki eski
// testler yüzde/reset sözleşmesini doğruluyor; ek alanların kendi testleri var.
function cekirdek(u) {
  if (!u || typeof u !== "object") return u;
  const { measured_at, scoped, ...kalan } = u;
  return kalan;
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
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
// 429 + retry-after (saniye)
const tooMany = (retryAfter) => ({
  ok: false, status: 429,
  headers: { get: (h) => (h.toLowerCase() === "retry-after" ? String(retryAfter) : null) },
  json: async () => ({}),
});

test("taze cache varken fetch çağrılmaz, cache'teki değer döner", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 12, week_pct: 34, session_resets_at: null, week_resets_at: null };
  writeCache(dir, now, cached); // age = 0 → taze
  const spy = fetchSpy(okJson({ five_hour: { utilization: 99 }, seven_day: { utilization: 99 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.deepStrictEqual(cekirdek(res), cached);
  assert.strictEqual(spy.calls.length, 0); // taze cache → ağ yok
});

// SÖZLEŞME DEĞİŞTİ: force artık cache'i KOŞULSUZ atlamıyor — yalnız okuma
// FORCE_MIN_AGE_MS'ten (60 sn) eskiyse ağa çıkar. Sebep: uç 429 veriyor
// (retry-after ~246 sn) ve dakikada birkaç oturum kapatan kurulumda koşulsuz
// force limit verisini büsbütün kaybettiriyordu. 60 sn'den taze okumanın
// tazelenmesinin bilgi değeri yok, 429 riski var.
test("force:true 60 sn'den ESKİ cache'i atlar, yeni değeri döner ve cache'i günceller", async () => {
  const dir = tmpDir();
  writeCreds(dir, "tok-xyz");
  const now = 2_000_000_000;
  writeCache(dir, now - 120_000, { session_pct: 12, week_pct: 34, session_resets_at: null, week_resets_at: null });
  const spy = fetchSpy(okJson({
    five_hour: { utilization: 55, resets_at: "R5" },
    seven_day: { utilization: 66, resets_at: "R7" },
  }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.strictEqual(spy.calls.length, 1); // taze cache atlandı
  assert.deepStrictEqual(cekirdek(res), {
    session_pct: 55, week_pct: 66, session_resets_at: "R5", week_resets_at: "R7",
  });
  // credential dosyasından okunan token Bearer olarak gitmeli
  assert.strictEqual(spy.calls[0].opts.headers.Authorization, "Bearer tok-xyz");
  // cache taze değerle güncellendi. measured_at cache'e YAZILMAZ: fetched_at zaten
  // o bilgiyi taşıyor, iki yerde tutmak eskiyen kopyalarda çelişki üretirdi.
  const cache = readCache(dir);
  assert.strictEqual(cache.fetched_at, now);
  assert.strictEqual(cache.plan_usage.measured_at, undefined);
  const { measured_at, ...resSizMeasured } = res;
  assert.deepStrictEqual(cache.plan_usage, resSizMeasured);
  assert.strictEqual(measured_at, new Date(now).toISOString());
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

test("pct kelepçesi: 150 → 100, -5 → 0, ve AŞAĞI yuvarlama", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 7_000_000_000;
  const spy = fetchSpy(okJson({ five_hour: { utilization: 150 }, seven_day: { utilization: -5 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
  assert.strictEqual(res.session_pct, 100); // üst kelepçe
  assert.strictEqual(res.week_pct, 0); // alt kelepçe

  // AŞAĞI yuvarlama (floor): 42.6 → 42, 99.5 → 99. Math.round %99.5'i "100" yapıp
  // limit dolmuş izlenimi veriyordu — bulgu 22.
  // (force cache'i ancak 60 sn'den eskiyse atlar → saati 120 sn ileri al)
  const spy2 = fetchSpy(okJson({ five_hour: { utilization: 42.6 }, seven_day: { utilization: 99.5 } }));
  const res2 = await getPlanUsage({ dir, fetchImpl: spy2, now: () => now + 120_000, force: true });
  assert.strictEqual(res2.session_pct, 42);
  assert.strictEqual(res2.week_pct, 99, "99.5 → 100 DEĞİL");
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

// ── 429 back-off ────────────────────────────────────────────────────────────
// Uç ölçülerek doğrulandı: arka arkaya çağrıda HTTP 429 + retry-after ~246 sn.
// Eskiden 429 sessizce null dönüyordu → sunucu snapshot yazmıyor → limit verisi
// TAMAMEN kayboluyordu. Üstelik force:true her oturum kapanışında cache'i
// atladığı için dakikada birkaç oturum kapatan kurulumda bu sürekli oluyordu.

test("429: son bilinen taze okuma korunur, null dönmez", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 38, week_pct: 69, session_resets_at: null, week_resets_at: null };
  writeCache(dir, now - 90_000, cached);
  const spy = fetchSpy(tooMany(246));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.deepStrictEqual(cekirdek(res), cached, "429'da son bilinen değer dönmeli (null değil)");
  assert.strictEqual(spy.calls.length, 1);
  const c = readCache(dir);
  assert.strictEqual(c.blocked_until, now + 246_000, "retry-after'a saygı duyulmalı");
  assert.strictEqual(c.fetched_at, now - 90_000, "tazelik damgası DEĞİŞMEMELİ");
});

test("back-off penceresinde force olsa bile ağa ÇIKILMAZ", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 38, week_pct: 69, session_resets_at: null, week_resets_at: null };
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({
    fetched_at: now - 90_000, plan_usage: cached, blocked_until: now + 120_000,
  }));
  const spy = fetchSpy(okJson({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.strictEqual(spy.calls.length, 0, "pencere içinde istek atılmamalı");
  assert.deepStrictEqual(cekirdek(res), cached);
});

test("back-off bitince yeniden denenir ve damga temizlenir", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({
    fetched_at: now - 600_000, plan_usage: { session_pct: 5, week_pct: 5 },
    blocked_until: now - 1,
  }));
  const spy = fetchSpy(okJson({ five_hour: { utilization: 41 }, seven_day: { utilization: 70 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(res.session_pct, 41);
  assert.strictEqual(readCache(dir).blocked_until, undefined, "başarılı okumada damga silinmeli");
});

test("force, 60 sn'den taze okuma varken ucu tekrar dövmez", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 38, week_pct: 69, session_resets_at: null, week_resets_at: null };
  writeCache(dir, now - 10_000, cached);
  const spy = fetchSpy(okJson({ five_hour: { utilization: 99 }, seven_day: { utilization: 99 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.strictEqual(spy.calls.length, 0, "10 sn önce okunmuşsa force da sormamalı");
  assert.deepStrictEqual(cekirdek(res), cached);
});

test("force, 60 sn'den ESKİ okumada gerçekten taze veri çeker", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  writeCache(dir, now - 120_000, { session_pct: 10, week_pct: 10 });
  const spy = fetchSpy(okJson({ five_hour: { utilization: 55 }, seven_day: { utilization: 66 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(res.session_pct, 55);
  assert.strictEqual(res.week_pct, 66);
});

// ── 401/403/5xx: 429'un HAFİF hâli (60 sn) ──────────────────────────────────
// Eskiden !res.ok sessizce null dönüyordu: uç bozukken/token bayatken her hook
// 3 sn'lik isteğe çıkıp bekliyor, üstelik elde son bilinen okuma varken bile
// sunucuya null gidiyordu (snapshot hiç yazılmıyor → veri kayıp).

const httpErr = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });

for (const status of [401, 403, 500, 503]) {
  test(`${status}: 60 sn'lik kısa back-off yazılır, pencerede ağa çıkılmaz`, async () => {
    const dir = tmpDir();
    writeCreds(dir);
    let now = 1_000_000_000;
    const spy = fetchSpy(httpErr(status));

    const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
    assert.strictEqual(res, null, "elde okuma yokken null");
    assert.strictEqual(spy.calls.length, 1);
    assert.strictEqual(readCache(dir).blocked_until, now + 60_000);

    // pencere içinde: istek YOK
    now += 30_000;
    await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });
    assert.strictEqual(spy.calls.length, 1, "60 sn dolmadan tekrar sorulmamalı");

    // pencere bitince yeniden dener
    now += 31_000;
    await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
    assert.strictEqual(spy.calls.length, 2);
  });
}

test("5xx: son bilinen TAZE okuma korunur (stale işareti YOK)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 38, week_pct: 69, session_resets_at: null, week_resets_at: null };
  writeCache(dir, now - 90_000, cached); // 90 sn: TTL içinde, force eşiğinin dışında
  const spy = fetchSpy(httpErr(502));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.deepStrictEqual(cekirdek(res), cached);
  assert.strictEqual(readCache(dir).fetched_at, now - 90_000, "tazelik damgası DEĞİŞMEMELİ");
});

// ── stale bayrağı ───────────────────────────────────────────────────────────
// Back-off penceresinde cache 5 dk'dan eskiyse null yerine son bilinen değer
// dönüyor, ama `stale: true` ile. Sunucu bu alanı tanımıyorsa yok sayar.

test("back-off + bayat cache → null DEĞİL, stale:true ile son bilinen değer", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 38, week_pct: 69, session_resets_at: "R5", week_resets_at: "R7" };
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({
    fetched_at: now - 20 * 60 * 1000, // 20 dk: TTL'in ÇOK dışında
    plan_usage: cached,
    blocked_until: now + 120_000,
  }));
  const spy = fetchSpy(okJson({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now, force: true });

  assert.strictEqual(spy.calls.length, 0, "pencere içinde istek atılmamalı");
  assert.deepStrictEqual(cekirdek(res), { ...cached, stale: true });
});

test("429 + bayat cache de stale:true ile döner", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  const cached = { session_pct: 5, week_pct: 6, session_resets_at: null, week_resets_at: null };
  writeCache(dir, now - 20 * 60 * 1000, cached);
  const spy = fetchSpy(tooMany(246));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.deepStrictEqual(cekirdek(res), { ...cached, stale: true });
  assert.strictEqual(readCache(dir).blocked_until, now + 246_000);
});

test("cache'te hiç okuma yoksa back-off penceresi null döndürür (uydurma yok)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 1_000_000_000;
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({
    fetched_at: 0, plan_usage: null, blocked_until: now + 60_000,
  }));
  const spy = fetchSpy(okJson({ five_hour: { utilization: 1 } }));

  assert.strictEqual(await getPlanUsage({ dir, fetchImpl: spy, now: () => now }), null);
  assert.strictEqual(spy.calls.length, 0);
});

// ── scoped: model bazlı haftalık limitler (bulgu 8) ────────────────────────
// Uç `limits[]` altında model kırılımı veriyor; collector bunu hiç okumuyordu.
// Kural app'teki ClaudeConnect.toPlanUsage ile birebir: group==="weekly" ve
// scope.model.display_name dolu olanlar.

const usageWithLimits = () => ({
  five_hour: { utilization: 80, resets_at: "2026-09-07T11:50:00+00:00" },
  seven_day: { utilization: 16, resets_at: "2026-09-08T15:00:00+00:00" },
  limits: [
    { group: "weekly", percent: 42.9, resets_at: "2026-09-08T15:00:00+00:00",
      scope: { model: { display_name: "Claude Fable 5.1" } } },
    // model kırılımı OLMAYAN haftalık limit → scoped'a girmez (genel hafta zaten var)
    { group: "weekly", percent: 16, resets_at: "2026-09-08T15:00:00+00:00", scope: {} },
    // haftalık olmayan grup → girmez
    { group: "five_hour", percent: 80, scope: { model: { display_name: "Claude Fable 5.1" } } },
  ],
});

test("scoped: yalnız weekly + model adı olan limitler, yüzdeler FLOOR", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 9_100_000_000;
  const spy = fetchSpy(okJson(usageWithLimits()));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.deepStrictEqual(res.scoped, [
    { model: "Claude Fable 5.1", percent: 42, resets_at: "2026-09-08T15:00:00+00:00" },
  ]);
  // resets_at alanları da taşınıyor (bildirim/geri sayım için)
  assert.strictEqual(res.session_resets_at, "2026-09-07T11:50:00+00:00");
  assert.strictEqual(res.week_resets_at, "2026-09-08T15:00:00+00:00");
});

test("scoped: limits yoksa boş dizi (alan hep var, şema kırılmasın)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 9_200_000_000;
  const spy = fetchSpy(okJson({ five_hour: { utilization: 5 }, seven_day: { utilization: 5 } }));
  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
  assert.deepStrictEqual(res.scoped, []);
});

test("scoped: bozuk limits girdileri çökertmez, elenirler", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 9_300_000_000;
  const spy = fetchSpy(okJson({
    five_hour: { utilization: 5 }, seven_day: { utilization: 5 },
    limits: [null, { group: "weekly" }, { group: "weekly", scope: { model: null } }, "metin"],
  }));
  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });
  assert.deepStrictEqual(res.scoped, []);
});

// ── measured_at (bulgu 9) ──────────────────────────────────────────────────

test("measured_at cache'ten dönerken CACHE'in zamanını taşır (şimdi değil)", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 9_400_000_000;
  const olculdu = now - 4 * 60 * 1000; // 4 dk önce ölçülmüş, hâlâ taze (TTL 5 dk)
  writeCache(dir, olculdu, { session_pct: 50, week_pct: 20, session_resets_at: null, week_resets_at: null });
  const spy = fetchSpy(okJson({ five_hour: { utilization: 99 }, seven_day: { utilization: 99 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(spy.calls.length, 0, "taze cache — ağa çıkılmamalı");
  assert.strictEqual(res.measured_at, new Date(olculdu).toISOString());
  assert.notStrictEqual(res.measured_at, new Date(now).toISOString());
});

test("measured_at bayat (stale) değerde de ölçüm zamanını söyler", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const now = 9_500_000_000;
  const olculdu = now - 30 * 60 * 1000;
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({
    fetched_at: olculdu,
    plan_usage: { session_pct: 38, week_pct: 69, session_resets_at: null, week_resets_at: null },
    blocked_until: now + 60_000,
  }));
  const spy = fetchSpy(okJson({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }));

  const res = await getPlanUsage({ dir, fetchImpl: spy, now: () => now });

  assert.strictEqual(spy.calls.length, 0);
  assert.strictEqual(res.stale, true);
  assert.strictEqual(res.measured_at, new Date(olculdu).toISOString());
});
