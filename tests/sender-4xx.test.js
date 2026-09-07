const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  sendPayload, flushQueue, dropSuperseded, resetNotices,
} = require("../lib/sender");

// Kuyruk ~/.claude ile AYNI dizinde durur; sender 401/403'te oradaki usagex.json'ı
// kapattığı için testler kuyruğu geçici bir "claude dizini" içinde kurar.
function tmpClaudeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-4xx-"));
}
function kur(cfg = {}) {
  const dir = tmpClaudeDir();
  fs.writeFileSync(path.join(dir, "usagex.json"), JSON.stringify({
    enabled: true, ingest_url: "https://example.invalid/ingest", device_token: "tok",
    send_project_names: false, ...cfg,
  }));
  return { dir, queuePath: path.join(dir, "usagex-queue.jsonl") };
}
const CONFIG = { ingest_url: "https://example.invalid/ingest", device_token: "tok" };
const readQueue = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const okRes = () => ({ ok: true, status: 200 });
const err = (status) => ({ ok: false, status, headers: { get: () => null } });
// R18: 401/403'te artık GÖVDE de okunuyor. `authErr` sunucunun kendi JSON hata
// biçimini taklit eder; `araKatmanErr` ise proxy/WAF'ın HTML (ya da boş) 403'ünü.
const authErr = (status, body = JSON.stringify({ error: "device_revoked" })) => ({
  ok: false, status, headers: { get: () => null }, text: async () => body,
});
const araKatmanErr = (status, body = "<html><body>403 Forbidden</body></html>") => ({
  ok: false, status, headers: { get: () => null }, text: async () => body,
});
const cfgOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "usagex.json"), "utf8"));
// Geçici 401/403 sonrası 60 sn'lik pencere var: ikinci deneme ancak saat
// ilerleyince ağa çıkar (sender bunu blocked damgasıyla yapıyor).
const saat = (baslangic = 1_000_000) => {
  let t = baslangic;
  const f = () => t;
  f.ilerlet = (ms) => { t += ms; };
  return f;
};

test.beforeEach(() => resetNotices());

// ── 400/404/413/422: payload KALICI olarak reddedildi (bulgu 4) ─────────────
// Eskiden bunlar "geçici" sayılıyordu: zehirli bir paket kuyruğun başında kalıp
// arkasındaki her şeyi süresiz kilitliyordu.

test("400 payload'ı kuyruğa YAZMAZ (zehirli paket kilitlemesin)", async () => {
  const { queuePath } = kur();
  let n = 0;
  const spy = async () => { n++; return err(400); };
  const ok = await sendPayload({ kind: "session", session_id: "a" }, CONFIG, { fetchImpl: spy, queuePath });
  assert.strictEqual(ok.status, "dropped");
  assert.strictEqual(n, 1);
  assert.strictEqual(fs.existsSync(queuePath), false, "düşürülmeli, kuyruğa yazılmamalı");
});

test("flush sırasında 400 alan kayıt DÜŞER, arkasındaki gönderilir", async () => {
  const { queuePath } = kur();
  fs.writeFileSync(queuePath, [
    JSON.stringify({ kind: "snapshot", i: 1 }),
    JSON.stringify({ kind: "snapshot", i: 2 }),
  ].join("\n") + "\n");
  const gorulen = [];
  const spy = async (_u, o) => {
    const p = JSON.parse(o.body);
    gorulen.push(p.i);
    return p.i === 1 ? err(422) : okRes();
  };
  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });
  assert.deepStrictEqual(gorulen, [1, 2], "zehirli paket kuyruğu tıkamamalı");
  assert.strictEqual(fs.existsSync(queuePath), false);
});

// R17: 415 (Unsupported Media Type) da kalıcı — sunucu Content-Type'ı reddediyorsa
// aynı paketi tekrar göndermek aynı sonucu verir, kuyruğu tıkamasın.
test("413, 415 ve 404 kalıcı sayılır", async () => {
  for (const status of [404, 413, 415]) {
    const { queuePath } = kur();
    await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl: async () => err(status), queuePath });
    assert.strictEqual(fs.existsSync(queuePath), false, `${status} düşürülmeliydi`);
  }
});

test("500 GEÇİCİ sayılır — kuyruğa yazılır (kalıcı hatalarla karışmasın)", async () => {
  const { queuePath } = kur();
  await sendPayload({ kind: "snapshot", i: 1 }, CONFIG, { fetchImpl: async () => err(500), queuePath });
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.i), [1]);
});

// ── 401/403: cihaz sunucuda iptal (bulgu 4 + C12) ──────────────────────────

test("İKİ ardışık JSON 401 config'i kapatır, kuyruğu siler ve tek satır uyarı basar", async () => {
  const { dir, queuePath } = kur();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "snapshot", i: 0 }) + "\n");
  const yazilan = [];
  const orj = process.stderr.write;
  const now = saat();
  const fetchImpl = async () => authErr(401);
  process.stderr.write = (s) => { yazilan.push(String(s)); return true; };
  try {
    // 1. tur: sayaç 1 — kapatmaz, kuyrukta bekletir
    const ilk = await sendPayload({ kind: "session", session_id: "a" }, CONFIG, { fetchImpl, queuePath, now });
    assert.strictEqual(ilk.status, "queued");
    assert.strictEqual(cfgOf(dir).enabled, true, "tek 401 kapatmamalı");
    // 60 sn'lik geçici pencere dolsun
    now.ilerlet(61_000);
    const ikinci = await sendPayload({ kind: "session", session_id: "a" }, CONFIG, { fetchImpl, queuePath, now });
    assert.strictEqual(ikinci.status, "auth_failed");
  } finally {
    process.stderr.write = orj;
  }

  const cfg = cfgOf(dir);
  assert.strictEqual(cfg.enabled, false);
  assert.match(cfg.auth_failed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(cfg.device_token, "tok", "token korunur — yeniden bağlanma kolay olsun");
  assert.strictEqual(cfg.send_project_names, false, "gizlilik tercihi korunur");
  assert.strictEqual(fs.existsSync(queuePath), false, "kuyruk silinmeli (sonsuza dek büyümesin)");

  const metin = yazilan.join("");
  assert.strictEqual(yazilan.length, 1, "tek satır");
  assert.match(metin, /iptal edilmiş/);
  assert.match(metin, /usagex-connect/);
});

test("401 sonrası loadConfig null döner — hook'lar bir daha ağa çıkmaz", async () => {
  const { dir, queuePath } = kur();
  const orj = process.stderr.write;
  const now = saat();
  process.stderr.write = () => true;
  try {
    const fetchImpl = async () => authErr(403);
    await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl, queuePath, now });
    now.ilerlet(61_000);
    await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl, queuePath, now });
  } finally {
    process.stderr.write = orj;
  }
  delete require.cache[require.resolve("../lib/config")];
  const { loadConfig, configProblem, readRawConfig } = require("../lib/config");
  assert.strictEqual(loadConfig(dir), null);
  assert.match(configProblem(readRawConfig(dir).cfg), /iptal edilmiş/);
});

test("uyarı süreç başına BİR KEZ basılır (her cevapta boğmasın)", async () => {
  const yazilan = [];
  const orj = process.stderr.write;
  process.stderr.write = (s) => { yazilan.push(String(s)); return true; };
  try {
    for (let i = 0; i < 3; i++) {
      const { queuePath } = kur();
      const now = saat();
      const fetchImpl = async () => authErr(401);
      await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl, queuePath, now });
      now.ilerlet(61_000);
      await sendPayload({ kind: "snapshot" }, CONFIG, { fetchImpl, queuePath, now });
    }
  } finally {
    process.stderr.write = orj;
  }
  assert.strictEqual(yazilan.length, 1);
});

test("flush 401 alırsa yeni payload da gönderilmez ve kuyruğa yazılmaz", async () => {
  const { queuePath } = kur();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "snapshot", i: 0 }) + "\n");
  let n = 0;
  const orj = process.stderr.write;
  const now = saat();
  const fetchImpl = async () => { n++; return authErr(401); };
  process.stderr.write = () => true;
  try {
    // 1. tur sayacı 1'e çıkarır (kuyruk satırı flush'ta 401 alır)
    await sendPayload({ kind: "session", session_id: "y" }, CONFIG, { fetchImpl, queuePath, now });
    now.ilerlet(61_000);
    const ok = await sendPayload({ kind: "session", session_id: "y" }, CONFIG, { fetchImpl, queuePath, now });
    assert.strictEqual(ok.status, "auth_failed");
  } finally {
    process.stderr.write = orj;
  }
  assert.strictEqual(n, 2, "her turda YALNIZ kuyruk denenmeli, yeni payload değil");
  assert.strictEqual(fs.existsSync(queuePath), false);
});

// ── eskiyen oturum kopyaları (bulgu 2) ──────────────────────────────────────

test("dropSuperseded aynı oturumun yalnız SON kopyasını bırakır", () => {
  const lines = [
    JSON.stringify({ kind: "session", session_id: "a", v: 1 }),
    JSON.stringify({ kind: "snapshot", v: "s1" }),
    JSON.stringify({ kind: "session", session_id: "b", v: 1 }),
    JSON.stringify({ kind: "session", session_id: "a", v: 2 }),
    JSON.stringify({ kind: "snapshot", v: "s2" }),
  ].map(String);
  const out = dropSuperseded(lines).map((l) => JSON.parse(l));
  assert.deepStrictEqual(
    out.map((p) => `${p.kind}:${p.session_id || p.v}`),
    ["snapshot:s1", "session:b", "session:a", "snapshot:s2"]
  );
  assert.strictEqual(out.find((p) => p.session_id === "a").v, 2, "en YENİ kopya kalmalı");
});

test("kuyruk eskiyen oturum kopyalarını biriktirmez", async () => {
  const { queuePath } = kur();
  const fail = async () => ({ ok: false, status: 0 });
  for (let i = 1; i <= 5; i++) {
    await sendPayload({ kind: "session", session_id: "s", v: i }, CONFIG, { fetchImpl: fail, queuePath });
  }
  const q = readQueue(queuePath);
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].v, 5);
});

// ── atomiklik / paralel oturum (bulgu 3) ────────────────────────────────────

test("iki eşzamanlı sendPayload: hiçbir kayıt kaybolmaz", async () => {
  const { queuePath } = kur();
  const fail = async () => ({ ok: false, status: 0 });
  await Promise.all([
    sendPayload({ kind: "session", session_id: "A" }, CONFIG, { fetchImpl: fail, queuePath }),
    sendPayload({ kind: "session", session_id: "B" }, CONFIG, { fetchImpl: fail, queuePath }),
  ]);
  const q = readQueue(queuePath);
  assert.deepStrictEqual(q.map((p) => p.session_id).sort(), ["A", "B"]);
});

test("flush sürerken eklenen satır SİLİNMEZ (rename ile kilitleme)", async () => {
  const { queuePath } = kur();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "session", session_id: "eski" }) + "\n");
  // İlk POST sırasında paralel bir oturum kuyruğa yazıyor gibi davran.
  let ilk = true;
  const spy = async () => {
    if (ilk) {
      ilk = false;
      fs.appendFileSync(queuePath, JSON.stringify({ kind: "session", session_id: "arada" }) + "\n");
      return { ok: false, status: 0 }; // flush burada dursun
    }
    return okRes();
  };
  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });
  const q = readQueue(queuePath).map((p) => p.session_id).sort();
  assert.deepStrictEqual(q, ["arada", "eski"], "iki kayıt da hayatta olmalı");
});

test("sahibi ölmüş .inflight dosyası kuyruğa geri alınır", async () => {
  const { queuePath } = kur();
  const oksuz = `${queuePath}.inflight.999999`;
  fs.writeFileSync(oksuz, JSON.stringify({ kind: "session", session_id: "kurtarilan" }) + "\n");
  // 11 dk eski göster (INFLIGHT_STALE_MS = 10 dk)
  const eski = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(oksuz, eski, eski);

  const gorulen = [];
  const spy = async (_u, o) => { gorulen.push(JSON.parse(o.body).session_id); return okRes(); };
  await flushQueue(CONFIG, { fetchImpl: spy, queuePath });

  assert.deepStrictEqual(gorulen, ["kurtarilan"]);
  assert.strictEqual(fs.existsSync(oksuz), false, "kurtarılan dosya temizlenmeli");
});

test("flush geride .inflight artığı bırakmaz", async () => {
  const { dir, queuePath } = kur();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "snapshot" }) + "\n");
  await flushQueue(CONFIG, { fetchImpl: async () => okRes(), queuePath });
  const artiklar = fs.readdirSync(dir).filter((f) => f.includes(".inflight"));
  assert.deepStrictEqual(artiklar, []);
});

// ── R18: ara katman 401/403'ü collector'ı kalıcı kapatmasın ────────────────
// Kurumsal proxy, WAF, otel wifi portalı ya da ters vekilin kendi hatası da 403
// döndürüyor. Eskiden bu tek yanıt config'i enabled:false yapıyor ve kullanıcı
// yeniden bağlanana kadar HİÇ veri gitmiyordu.

test("R18: tek 403 (gövde JSON değil) kapatmaz, kuyruğa yazar ve 60 sn bekler", async () => {
  const { dir, queuePath } = kur();
  let n = 0;
  const now = saat();
  const fetchImpl = async () => { n++; return araKatmanErr(403); };

  const ilk = await sendPayload({ kind: "session", session_id: "a" }, CONFIG, { fetchImpl, queuePath, now });
  assert.strictEqual(ilk.status, "queued");
  assert.strictEqual(cfgOf(dir).enabled, true, "ara katman 403'ü config'i kapatmamalı");
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.session_id), ["a"]);

  // 60 sn'lik pencere: ağa çıkılmaz, payload yine kuyrukta birikir
  now.ilerlet(30_000);
  await sendPayload({ kind: "session", session_id: "b" }, CONFIG, { fetchImpl, queuePath, now });
  assert.strictEqual(n, 1, "pencere içinde yeni istek atılmamalı");
  assert.strictEqual(cfgOf(dir).enabled, true);
});

test("R18: iki ardışık ara katman 403'ü de kapatmaz (sayaç yalnız JSON hatasında artar)", async () => {
  const { dir, queuePath } = kur();
  const now = saat();
  const fetchImpl = async () => araKatmanErr(401, "");  // boş gövde: en yaygın hal
  for (let i = 0; i < 3; i++) {
    await sendPayload({ kind: "snapshot", i }, CONFIG, { fetchImpl, queuePath, now });
    now.ilerlet(61_000);
  }
  assert.strictEqual(cfgOf(dir).enabled, true);
  assert.ok(fs.existsSync(queuePath), "kuyruk silinmemeli");
});

test("R18: araya başarılı gönderim girerse sayaç sıfırlanır", async () => {
  const { dir, queuePath } = kur();
  const now = saat();
  const orj = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await sendPayload({ kind: "snapshot", i: 1 }, CONFIG, { fetchImpl: async () => authErr(401), queuePath, now });
    now.ilerlet(61_000);
    // sunucu düzeldi
    await sendPayload({ kind: "snapshot", i: 2 }, CONFIG, { fetchImpl: async () => okRes(), queuePath, now });
    // yeni bir tek 401 tekrar kapatmamalı (sayaç 1'den başlar)
    await sendPayload({ kind: "snapshot", i: 3 }, CONFIG, { fetchImpl: async () => authErr(401), queuePath, now });
  } finally {
    process.stderr.write = orj;
  }
  assert.strictEqual(cfgOf(dir).enabled, true, "kesintili 401 kapatmamalı");
});

// ── R19: ekleme tek writeSync çağrısıyla (süreçler arası atomiklik) ─────────

test("R19: kuyruk eklemesi TEK writeSync ile yapılır, appendFileSync kullanılmaz", async () => {
  const { queuePath } = kur();
  const orjWrite = fs.writeSync;
  const orjAppend = fs.appendFileSync;
  let writeSayisi = 0;
  let appendSayisi = 0;
  fs.writeSync = (...a) => { writeSayisi++; return orjWrite.apply(fs, a); };
  fs.appendFileSync = (...a) => { appendSayisi++; return orjAppend.apply(fs, a); };
  try {
    await sendPayload({ kind: "session", session_id: "a" }, CONFIG, {
      fetchImpl: async () => ({ ok: false, status: 0 }), queuePath,
    });
  } finally {
    fs.writeSync = orjWrite;
    fs.appendFileSync = orjAppend;
  }
  assert.strictEqual(appendSayisi, 0, "appendFileSync tamponu bölebiliyor — kullanılmamalı");
  assert.strictEqual(writeSayisi, 1, "satır tek çağrıda yazılmalı");
  assert.strictEqual(readQueue(queuePath).length, 1);
});

test("R19: 64 KB'ı aşan satır ayrı taşma dosyasına gider, flush onu da toplar", async () => {
  const { dir, queuePath } = kur();
  const dev = { kind: "session", session_id: "dev", pad: "x".repeat(70 * 1024) };

  const r = await sendPayload(dev, CONFIG, { fetchImpl: async () => ({ ok: false, status: 0 }), queuePath });
  assert.strictEqual(r.status, "queued");
  assert.strictEqual(fs.existsSync(queuePath), false, "dev satır ana kuyruğa yazılmamalı");
  const tasma = fs.readdirSync(dir).filter((f) => /^usagex-queue\.jsonl\.\d+\.\d+\.jsonl$/.test(f));
  assert.strictEqual(tasma.length, 1, `taşma dosyası bekleniyordu: ${fs.readdirSync(dir)}`);

  const gorulen = [];
  await flushQueue(CONFIG, {
    fetchImpl: async (_u, o) => { gorulen.push(JSON.parse(o.body).session_id); return okRes(); },
    queuePath,
  });
  assert.deepStrictEqual(gorulen, ["dev"], "taşma dosyası da gönderilmeli");
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith("usagex-queue.jsonl")),
    [], "artık kalmamalı"
  );
});

// ── R20: kalan satırlar inflight SİLİNMEDEN ÖNCE geri yazılır ──────────────
// Tersi (eski sıra) iki işlem arasında süreç ölürse satırları tamamen kaybediyordu.

test("R20: flush kalanı önce kuyruğa yazar, inflight'ı SONRA siler", async () => {
  const { queuePath } = kur();
  fs.writeFileSync(queuePath, [
    JSON.stringify({ kind: "snapshot", i: 1 }),
    JSON.stringify({ kind: "snapshot", i: 2 }),
  ].join("\n") + "\n");

  const sira = [];
  const orjUnlink = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    if (String(p).includes(".inflight.")) {
      sira.push(fs.existsSync(queuePath) ? "kuyruk-geri-yazilmis" : "kuyruk-yok");
    }
    return orjUnlink.call(fs, p);
  };
  try {
    // 1. satır gider, 2. satır 500 alır → kuyrukta kalmalı
    await flushQueue(CONFIG, {
      fetchImpl: async (_u, o) => (JSON.parse(o.body).i === 1 ? okRes() : err(500)),
      queuePath,
    });
  } finally {
    fs.unlinkSync = orjUnlink;
  }
  assert.deepStrictEqual(sira, ["kuyruk-geri-yazilmis"]);
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.i), [2]);
});

// ── R21: Windows'ta rename EBUSY/EPERM sessizce vazgeçmesin ────────────────

function renameEBUSY(kacKez) {
  const orj = fs.renameSync;
  const durum = { deneme: 0, geriAl: () => { fs.renameSync = orj; } };
  fs.renameSync = (from, to) => {
    if (String(to).includes(".inflight.")) {
      durum.deneme++;
      if (durum.deneme <= kacKez) {
        const e = new Error("EBUSY: resource busy or locked");
        e.code = "EBUSY";
        throw e;
      }
    }
    return orj.call(fs, from, to);
  };
  return durum;
}

test("R21: rename EBUSY'de yeniden denenir ve kuyruk boşalır", async () => {
  const { queuePath } = kur();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "snapshot", i: 1 }) + "\n");
  const durum = renameEBUSY(2); // ilk iki deneme kilitli, 3.'sü geçer
  const gorulen = [];
  try {
    await flushQueue(CONFIG, {
      fetchImpl: async (_u, o) => { gorulen.push(JSON.parse(o.body).i); return okRes(); },
      queuePath,
    });
  } finally {
    durum.geriAl();
  }
  assert.strictEqual(durum.deneme, 3, "3 deneme yapılmalı");
  assert.deepStrictEqual(gorulen, [1], "3. denemede kuyruk boşalmalı");
  assert.strictEqual(fs.existsSync(queuePath), false);
});

test("R21: rename hep EBUSY ise tek satır uyarı basılır, kuyruk KORUNUR", async () => {
  const { queuePath } = kur();
  fs.writeFileSync(queuePath, JSON.stringify({ kind: "snapshot", i: 1 }) + "\n");
  const durum = renameEBUSY(Infinity);
  const yazilan = [];
  const orj = process.stderr.write;
  process.stderr.write = (s) => { yazilan.push(String(s)); return true; };
  let istek = 0;
  try {
    for (let i = 0; i < 2; i++) {
      await flushQueue(CONFIG, { fetchImpl: async () => { istek++; return okRes(); }, queuePath });
    }
  } finally {
    process.stderr.write = orj;
    durum.geriAl();
  }
  assert.strictEqual(durum.deneme, 6, "her turda 3 deneme");
  assert.strictEqual(istek, 0, "kilitliyken ağa çıkılmamalı");
  assert.strictEqual(yazilan.length, 1, "uyarı süreç başına tek satır");
  assert.match(yazilan[0], /EBUSY/);
  assert.deepStrictEqual(readQueue(queuePath).map((p) => p.i), [1], "kuyruk kaybolmamalı");
});
