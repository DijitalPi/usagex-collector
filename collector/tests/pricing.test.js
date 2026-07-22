const test = require("node:test");
const assert = require("node:assert");
const { priceFor, estimateCostUsd } = require("../lib/pricing");

test("priceFor Anthropic gerçek model string'lerini doğru eşleştirir", () => {
  assert.ok(priceFor("claude-3-5-sonnet-20241022"));
  assert.strictEqual(priceFor("claude-3-5-sonnet-20241022").input, 3);
  assert.strictEqual(priceFor("claude-3-5-sonnet-20241022").output, 15);

  assert.ok(priceFor("claude-3-7-sonnet"));
  assert.strictEqual(priceFor("claude-3-7-sonnet").input, 3);

  assert.ok(priceFor("claude-3-opus-20240229"));
  assert.strictEqual(priceFor("claude-3-opus-20240229").input, 15);

  assert.ok(priceFor("claude-3-5-haiku-20241022"));
  assert.strictEqual(priceFor("claude-3-5-haiku-20241022").input, 0.8);
});

test("priceFor bilinmeyen modeller için genel aile eşleşmesi (fallback) yapar", () => {
  assert.strictEqual(priceFor("custom-sonnet-model").input, 3);
  assert.strictEqual(priceFor("custom-opus-model").input, 15);
  assert.strictEqual(priceFor("custom-haiku-model").input, 1);
  assert.strictEqual(priceFor("unknown-model-x"), null);
});

test("estimateCostUsd token ve cache maliyetini doğru hesaplar", () => {
  const models = {
    "claude-3-5-sonnet-20241022": {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
    },
  };
  // input: 3, output: 15, cache_write: 3 * 1.25 = 3.75, cache_read: 3 * 0.1 = 0.3
  // Toplam = 3 + 15 + 3.75 + 0.3 = 22.05
  const cost = estimateCostUsd(models);
  assert.strictEqual(cost, 22.05);
});
