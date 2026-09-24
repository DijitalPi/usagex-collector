const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listTranscripts } = require("../scripts/backfill");

// backfill mtime cutoff'u: N günden eski transkriptler HİÇ okunmaz (yüzlerce
// dosyayı boşuna ayrıştırmamak için). Cutoff'un yanlış tarafa kayması ya
// geçmişi eksik gönderir ya da her çalıştırmada her şeyi yeniden okur.

function tmpProjects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-bf-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(projects);
  return projects;
}

function addFile(projects, proje, name, mtimeMs) {
  const dir = path.join(projects, proje);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "{}\n");
  if (mtimeMs != null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

const GUN = 24 * 60 * 60 * 1000;

test("cutoff'tan YENİ dosyalar seçilir, eskiler atlanır", () => {
  const projects = tmpProjects();
  const now = Date.now();
  const cutoff = now - 90 * GUN;

  const yeni = addFile(projects, "p1", "yeni.jsonl", now - 1 * GUN);
  const sinirda = addFile(projects, "p1", "sinirda.jsonl", cutoff + 1000);
  addFile(projects, "p1", "eski.jsonl", now - 200 * GUN);
  addFile(projects, "p2", "cok-eski.jsonl", now - 91 * GUN);

  const { files, tooOld } = listTranscripts(projects, cutoff);

  assert.deepStrictEqual(files.sort(), [sinirda, yeni].sort());
  assert.strictEqual(tooOld, 2);
});

test("yalnız .jsonl toplanır; başka uzantılar ve alt klasörler görmezden gelinir", () => {
  const projects = tmpProjects();
  const now = Date.now();
  const jsonl = addFile(projects, "p1", "a.jsonl", now);
  addFile(projects, "p1", "notlar.md", now);
  addFile(projects, "p1", "a.jsonl.bak", now);
  fs.mkdirSync(path.join(projects, "p1", "a", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(projects, "p1", "a", "subagents", "s.jsonl"), "{}\n");

  const { files } = listTranscripts(projects, 0);

  // alt-ajan dosyaları AYRI gönderilmez — summarizeTranscript ana oturuma katar
  assert.deepStrictEqual(files, [jsonl]);
});

test("projects/ altındaki dosyalar (dizin olmayan) çökertmez", () => {
  const projects = tmpProjects();
  fs.writeFileSync(path.join(projects, "gevsek-dosya.txt"), "x");
  const p = addFile(projects, "p1", "a.jsonl", Date.now());
  assert.deepStrictEqual(listTranscripts(projects, 0).files, [p]);
});

test("projects klasörü yoksa boş sonuç, throw YOK", () => {
  const { files, tooOld } = listTranscripts(path.join(os.tmpdir(), "hic-olmayan-dizin-usagex"), 0);
  assert.deepStrictEqual(files, []);
  assert.strictEqual(tooOld, 0);
});

test("cutoff=0 ile her şey seçilir (sınırsız backfill)", () => {
  const projects = tmpProjects();
  addFile(projects, "p1", "a.jsonl", Date.now() - 3650 * GUN);
  addFile(projects, "p2", "b.jsonl", Date.now());
  assert.strictEqual(listTranscripts(projects, 0).files.length, 2);
});

// ── uçtan uca: backfill KUYRUĞA YAZMAZ (S: 598 gönderildi / 3813 kuyruğa) ───
// Gerçek çalıştırmada sunucunun hız sınırı 429 döndürünce sendPayload payload'ı
// kuyruğa yazıyordu; kuyruk kind başına 500'e kırpıldığı için eski günler
// kayboluyor, kalanlar Stop hook'larıyla 10'ar 10'ar aylarca akıyordu.
// Aşağıdaki testler betiği GERÇEKTEN çalıştırır (sender sahte, geri kalan gerçek).

const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

// -r ile önyüklenen bu betik lib/sender.js'i require önbelleğinde değiştirir;
// backfill.js normal şekilde (require.main === module) çalışır.
function stubYaz(dir, { sonuclar = ["sent"], drainSonuc = null } = {}) {
  const p = path.join(dir, "sender-stub.js");
  fs.writeFileSync(p, `
const path = require("path");
const fs = require("fs");
const OUT = process.env.UX_OUT;
const kaydet = (o) => fs.appendFileSync(OUT, JSON.stringify(o) + "\\n");
const sonuclar = ${JSON.stringify(sonuclar)};
let i = 0;
const p2 = require.resolve(path.join(${JSON.stringify(ROOT)}, "lib", "sender.js"));
require.cache[p2] = { id: p2, filename: p2, loaded: true, exports: {
  postOnce: async () => true,
  postDirect: async (payload) => {
    kaydet({ event: "direct", source: payload.source, session_id: payload.session_id });
    const s = sonuclar[Math.min(i++, sonuclar.length - 1)];
    return { status: s, tries: 1 };
  },
  // Kuyruk yolu HİÇ kullanılmamalı: çağrılırsa test bunu görür.
  sendPayload: async (payload) => { kaydet({ event: "queue", session_id: payload.session_id }); return { status: "queued" }; },
  drainQueue: async () => { kaydet({ event: "drain" }); return ${JSON.stringify(drainSonuc || { sent: 0, dropped: 0, kalan: 0, toplam: 0, status: "empty" })}; },
  flushQueue: async () => ({ authFailed: false }),
  defaultQueuePath: () => path.join(process.env.CLAUDE_CONFIG_DIR, "usagex-queue.jsonl"),
} };
`);
  return p;
}

function transkriptYaz(projects, ad) {
  const dir = path.join(projects, "proje");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, ad);
  fs.writeFileSync(p, [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp/proje" }),
    JSON.stringify({
      type: "assistant", timestamp: "2026-07-01T12:00:05Z",
      message: { id: `m-${ad}`, model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50 } },
    }),
  ].join("\n") + "\n");
  return p;
}

function backfillCalistir({ adet = 1, args = [], ...stubOpts } = {}) {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-bf2-"));
  fs.writeFileSync(path.join(cfgDir, "usagex.json"), JSON.stringify({
    enabled: true, ingest_url: "https://example.invalid/ingest", device_token: "tok",
  }));
  const projects = path.join(cfgDir, "projects");
  fs.mkdirSync(projects);
  for (let i = 0; i < adet; i++) transkriptYaz(projects, `s-${i}.jsonl`);
  const out = path.join(cfgDir, "out.jsonl");
  const stub = stubYaz(cfgDir, stubOpts);
  const r = spawnSync(process.execPath, ["-r", stub, path.join(ROOT, "scripts", "backfill.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, UX_OUT: out },
  });
  let events = [];
  try { events = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch {}
  return { ...r, events, cfgDir };
}

test("backfill doğrudan gönderir, kuyruk yoluna HİÇ düşmez", () => {
  const r = backfillCalistir({ adet: 3 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.events.filter((e) => e.event === "direct").length, 3);
  assert.strictEqual(r.events.filter((e) => e.event === "queue").length, 0, "sendPayload çağrılmamalı");
  assert.match(r.stdout, /Gönderilen: 3/);
  // Kuyruk dosyası hiç oluşmamalı
  assert.strictEqual(fs.existsSync(path.join(r.cfgDir, "usagex-queue.jsonl")), false);
});

test("backfill payload'ları source=backfill ile imzalar (sonraki --drain tanısın)", () => {
  const r = backfillCalistir({ adet: 2 });
  const kaynaklar = r.events.filter((e) => e.event === "direct").map((e) => e.source);
  assert.deepStrictEqual(kaynaklar, ["backfill", "backfill"]);
});

test("kalıcı 4xx (dropped) atlanır, iş DEVAM eder ve sayılır", () => {
  const r = backfillCalistir({ adet: 3, sonuclar: ["dropped", "sent", "sent"] });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.events.filter((e) => e.event === "direct").length, 3, "tek kayıt işi durdurmamalı");
  assert.match(r.stdout, /Gönderilen: 2/);
  assert.match(r.stdout, /Reddedilen: 1/);
});

test("rate_limited: iş durur, KALAN sayısı ve sebep bildirilir, çıkış kodu 1", () => {
  const r = backfillCalistir({ adet: 4, sonuclar: ["sent", "rate_limited"] });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.events.filter((e) => e.event === "direct").length, 2, "429'dan sonra devam edilmemeli");
  assert.match(r.stdout, /Gönderilen: 1/);
  // gönderilemeyen kayıt da kalanlara dahil: 4 dosya, 1 gitti, 3 kaldı
  assert.match(r.stdout, /Kalan: 3/);
  assert.match(r.stderr, /hız sınırı/i);
  assert.strictEqual(r.events.filter((e) => e.event === "queue").length, 0);
});

test("günlük satır kotası (budget) ayrı mesajla durdurur", () => {
  const r = backfillCalistir({ adet: 2, sonuclar: ["budget"] });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /GÜNLÜK/);
});

test("--drain önce kuyruğu boşaltır, sonra backfill'i çalıştırır", () => {
  const r = backfillCalistir({
    adet: 2, args: ["90", "--drain"],
    drainSonuc: { sent: 7, dropped: 1, kalan: 0, toplam: 8, status: "ok" },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.events[0].event, "drain", "drain backfill'den ÖNCE çalışmalı");
  assert.match(r.stdout, /Kuyruk: gönderilen 7/);
  assert.strictEqual(r.events.filter((e) => e.event === "direct").length, 2);
});

test("--drain olmadan kuyruğa dokunulmaz", () => {
  const r = backfillCalistir({ adet: 1 });
  assert.strictEqual(r.events.filter((e) => e.event === "drain").length, 0);
});

test("gün argümanı --drain ile karışmaz (bayrak sayı sanılmaz)", () => {
  // args yalnız --drain: gün varsayılanı (90) kullanılmalı, çökmemeli
  const r = backfillCalistir({ adet: 1, args: ["--drain"] });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.events.filter((e) => e.event === "direct").length, 1);
});

test("ilerleme 50 kayıtta bir stderr'e yazılır (stdout yalnız özet)", () => {
  const r = backfillCalistir({ adet: 51 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /^50\/51$/m);
  assert.doesNotMatch(r.stdout, /50\/51/, "ilerleme stdout'u kirletmemeli");
});

// ── durma mesajları ─────────────────────────────────────────────────────────
// "budget" mesajı sunucunun GÜNLÜK satır kotasını rakamla söylüyor. İstemci bu
// sayıyı uçtan öğrenemiyor (sunucu 429/400 gövdesinde vermiyor), yani sabit ELDE
// tutuluyor: sunucudaki MAX_ROWS_PER_DEVICE_DAY değişirse mesaj YANLIŞ olur.
// Kullanıcı "2000 doldu" okuyup 10.000'lik kotayı yanlış planlıyordu.
test("budget mesajındaki kota sunucudaki MAX_ROWS_PER_DEVICE_DAY ile aynı", (t) => {
  const { DURMA_MESAJI } = require("../scripts/backfill");
  let server;
  // Sunucu deposu yanımızda değilse (collector tek başına paketlenmiş) atla
  try { server = fs.readFileSync(path.join(__dirname, "../../server/api/server.js"), "utf8"); }
  catch { return t.skip("server/api/server.js yok"); }

  const m = server.match(/MAX_ROWS_PER_DEVICE_DAY\s*=\s*(\d+)/);
  assert.ok(m, "sunucuda MAX_ROWS_PER_DEVICE_DAY bulunamadı");
  const kota = Number(m[1]);
  assert.ok(
    DURMA_MESAJI.budget.includes(kota.toLocaleString("tr-TR")),
    `budget mesajı ${kota.toLocaleString("tr-TR")} demiyor: ${DURMA_MESAJI.budget}`
  );
  assert.ok(!/\b2000\b/.test(DURMA_MESAJI.budget), "eski (yanlış) 2000 sayısı kalmış");
});
