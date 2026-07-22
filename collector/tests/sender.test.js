const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { sendPayload, MAX_QUEUE_SIZE } = require("../lib/sender");

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
