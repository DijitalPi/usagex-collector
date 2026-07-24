const { test } = require("node:test");
const assert = require("node:assert");
const { summarizeLines } = require("../lib/transcript");
const { sessionPayload } = require("../lib/payload");

const L = (o) => JSON.stringify(o);
// Yerel gün sınırına takılmasın diye UTC öğlen kullan (testler her tz'de geçmeli)
const LINES = [
  L({ type: "user", timestamp: "2026-07-01T12:00:00Z" }),
  L({ type: "assistant", timestamp: "2026-07-01T12:00:05Z",
      message: { id: "m1", model: "claude-x", usage: { input_tokens: 10, output_tokens: 20 } } }),
  // aynı message.id ikinci satır (content block başına satır) — SAYILMAMALI
  L({ type: "assistant", timestamp: "2026-07-01T12:00:06Z",
      message: { id: "m1", model: "claude-x", usage: { input_tokens: 10, output_tokens: 20 } } }),
  L({ type: "assistant", timestamp: "2026-07-03T12:00:00Z",
      message: { id: "m2", model: "claude-x", usage: { input_tokens: 1, output_tokens: 2 } } }),
];
const ioSum = (models) =>
  Object.values(models).reduce((a, u) => a + u.input_tokens + u.output_tokens, 0);

test("gün dökümü: her satır kendi gününe, id tekrarı bir kez, toplam korunur", () => {
  const s = summarizeLines(LINES);
  assert.equal(s.models["claude-x"].input_tokens, 11); // 10 + 1 (tekrar sayılmadı)
  assert.equal(s.models["claude-x"].output_tokens, 22);
  const days = Object.keys(s.days).sort();
  assert.equal(days.length, 2); // 1 Tem + 3 Tem — bitiş gününe yığılmıyor
  const daySum = Object.values(s.days).reduce((a, d) => a + ioSum(d.models), 0);
  assert.equal(daySum, ioSum(s.models)); // günlerin toplamı = oturum toplamı (kayıp/çift yok)
});

test("sessionPayload: days dizisi gün başına model + maliyetle gider", () => {
  const summary = summarizeLines(LINES);
  summary.project = "proj";
  const p = sessionPayload({
    session_id: "s1", summary, est_cost_usd: 0.5, plan_usage: null,
    config: { send_project_names: true },
  });
  assert.ok(Array.isArray(p.days));
  assert.equal(p.days.length, 2);
  assert.ok(p.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
  assert.ok(p.days.every((d) => typeof d.est_cost_usd === "number"));
  // geriye uyumluluk: üst düzey toplam alanlar hâlâ yerinde (eski sunucu bunları okur)
  assert.equal(ioSum(p.models), 33);
});

test("fable/mythos fiyatlandırılır — maliyet artık 0 değil", () => {
  const { estimateCostUsd, priceFor } = require("../lib/pricing");
  assert.ok(priceFor("claude-fable-5"));
  assert.ok(priceFor("claude-mythos-5"));
  const c = estimateCostUsd({ "claude-fable-5": {
    input_tokens: 1_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 } });
  assert.ok(c > 0);
});
