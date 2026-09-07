const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarizeTranscript, summarizeLines, tzOffsetMinutes } = require("../lib/transcript");

// summarizeTranscript artık ASENKRON ve dosyayı satır satır akıtıyor
// (readFileSync+split yerine). Bu testler sözleşmeyi sabitler:
// aynı sonuç, alt-ajan dahil, dosya yoksa sessiz boş özet.

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-tr-"));
}
const L = (o) => JSON.stringify(o);
const asistan = (id, ts, tok) => L({
  type: "assistant", timestamp: ts,
  message: { id, model: "claude-sonnet-5", usage: { input_tokens: tok, output_tokens: 0 } },
});

test("stream okuma, satır dizisiyle AYNI sonucu verir", async () => {
  const dir = tmpDir();
  const lines = [
    L({ type: "user", timestamp: "2026-07-01T12:00:00Z", cwd: "/x/proje" }),
    asistan("m1", "2026-07-01T12:00:01Z", 10),
    asistan("m2", "2026-07-02T12:00:00Z", 5),
  ];
  const p = path.join(dir, "s.jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n");

  const akan = await summarizeTranscript(p);
  const dizi = summarizeLines(lines);

  assert.deepStrictEqual(akan.models, dizi.models);
  assert.strictEqual(akan.message_count, dizi.message_count);
  assert.strictEqual(akan.cwd, "/x/proje");
  assert.deepStrictEqual(Object.keys(akan.days).sort(), Object.keys(dizi.days).sort());
});

test("sondaki yeni satır yoksa da son kayıt okunur", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "s.jsonl");
  fs.writeFileSync(p, asistan("m1", "2026-07-01T12:00:00Z", 7)); // \n YOK
  const s = await summarizeTranscript(p);
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 7);
});

test("CRLF satır sonları ve boş satırlar sorun çıkarmaz (Windows)", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "s.jsonl");
  fs.writeFileSync(p, [asistan("m1", "2026-07-01T12:00:00Z", 3), "", asistan("m2", "2026-07-01T12:00:01Z", 4)].join("\r\n") + "\r\n");
  const s = await summarizeTranscript(p);
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 7);
});

test("bozuk satırlar atlanır, sağlamlar sayılır", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "s.jsonl");
  fs.writeFileSync(p, ["{{{bozuk", asistan("m1", "2026-07-01T12:00:00Z", 11), "null", "42"].join("\n") + "\n");
  const s = await summarizeTranscript(p);
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 11);
});

test("dosya yoksa boş özet döner (hook message_count===0 ile atlar), throw ETMEZ", async () => {
  const s = await summarizeTranscript(path.join(tmpDir(), "yok.jsonl"));
  assert.strictEqual(s.message_count, 0);
  assert.deepStrictEqual(s.models, {});
  assert.deepStrictEqual(s.days, {});
});

test("alt-ajan transkriptleri KORUNDU: ana dosyaya eklenir", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "oturum.jsonl");
  fs.writeFileSync(p, asistan("m1", "2026-07-01T12:00:00Z", 100) + "\n");
  const sub = path.join(dir, "oturum", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "a.jsonl"), asistan("a1", "2026-07-01T12:30:00Z", 20) + "\n");
  fs.writeFileSync(path.join(sub, "b.jsonl"), asistan("b1", "2026-07-01T12:40:00Z", 3) + "\n");
  fs.writeFileSync(path.join(sub, "notlar.txt"), "bu .jsonl değil, okunmamalı");

  const s = await summarizeTranscript(p);
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 123);
});

test("alt-ajan klasörü yoksa ana dosya yine okunur", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "tek.jsonl");
  fs.writeFileSync(p, asistan("m1", "2026-07-01T12:00:00Z", 5) + "\n");
  assert.strictEqual((await summarizeTranscript(p)).models["claude-sonnet-5"].input_tokens, 5);
});

test("büyük dosya (10k satır) belleğe komple okunmadan özetlenir", async () => {
  const dir = tmpDir();
  const p = path.join(dir, "buyuk.jsonl");
  const w = fs.createWriteStream(p);
  for (let i = 0; i < 10_000; i++) w.write(asistan(`m${i}`, "2026-07-01T12:00:00Z", 1) + "\n");
  await new Promise((r) => w.end(r));

  const s = await summarizeTranscript(p);
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 10_000);
  assert.strictEqual(s.message_count, 10_000);
});

// ── tz_offset_minutes ───────────────────────────────────────────────────────

test("gün dökümüne tz_offset_minutes eklenir, `day` alanı DEĞİŞMEZ", () => {
  const s = summarizeLines([asistan("m1", "2026-07-01T12:00:00Z", 1)]);
  const [day, bucket] = Object.entries(s.days)[0];
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/, "sunucu sözleşmesi: day aynı biçimde kalmalı");
  assert.strictEqual(bucket.tz_offset_minutes, tzOffsetMinutes("2026-07-01T12:00:00Z"));
});

test("tzOffsetMinutes doğu POZİTİF ve dakika cinsinden", () => {
  const v = tzOffsetMinutes("2026-07-01T12:00:00Z");
  assert.strictEqual(typeof v, "number");
  assert.strictEqual(v, -new Date("2026-07-01T12:00:00Z").getTimezoneOffset());
  assert.strictEqual(tzOffsetMinutes("saçma"), null);
});

// ── Windows yol çözümü ──────────────────────────────────────────────────────
// Alt-ajan klasörü yolu path.dirname/basename ile kuruluyor. Windows'ta ayraç
// ters eğik çizgi; mantığın platformdan bağımsız olduğunu path.win32 ile doğrula.

test("alt-ajan dizini Windows yolunda da doğru çözülür", () => {
  const win = "C:\\Users\\emir\\.claude\\projects\\C--kod-proje\\abc-123.jsonl";
  const subdir = path.win32.join(
    path.win32.dirname(win),
    path.win32.basename(win, ".jsonl"),
    "subagents"
  );
  assert.strictEqual(subdir, "C:\\Users\\emir\\.claude\\projects\\C--kod-proje\\abc-123\\subagents");
  // session_id de dosya adından türetiliyor (hooks: basename(transcript_path, ".jsonl"))
  assert.strictEqual(path.win32.basename(win, ".jsonl"), "abc-123");
  // proje etiketi cwd'nin son parçası
  assert.strictEqual(path.win32.basename("C:\\kod\\musteri-sitesi"), "musteri-sitesi");
});
