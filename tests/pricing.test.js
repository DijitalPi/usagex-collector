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
  assert.strictEqual(priceFor("custom-opus-model").input, 5); // güncel Opus katmanı
  assert.strictEqual(priceFor("custom-haiku-model").input, 1);
  assert.strictEqual(priceFor("unknown-model-x"), null);
});

// Bu makinedeki transkriptlerde GERÇEKTEN görülen model adları + eşleşme sırası.
// Sıra bozulursa (ör. "opus-4" spesifik kalıplardan öne alınırsa) Opus 4.8 sessizce
// 3 KAT fazla fiyatlanır — bu testin asıl işi o regresyonu yakalamak.
test("gerçek model adları resmî tarifelere eşleşir", () => {
  const t = (m) => [priceFor(m).input, priceFor(m).output];
  assert.deepStrictEqual(t("claude-opus-5"), [5, 25]);
  assert.deepStrictEqual(t("claude-opus-4-8"), [5, 25]);
  assert.deepStrictEqual(t("claude-opus-4-7"), [5, 25]);
  assert.deepStrictEqual(t("claude-opus-4-6"), [5, 25]);
  assert.deepStrictEqual(t("claude-fable-5"), [10, 50]);
  assert.deepStrictEqual(t("claude-fable-5-1"), [10, 50]);
  assert.deepStrictEqual(t("claude-mythos-5"), [10, 50]);
  assert.deepStrictEqual(t("claude-mythos-5-1"), [10, 50]);
  // Sonnet 5 = 2/10. Tanıtım fiyatıydı, 1 Eyl 2026 zammı iptal edildi → kalıcı
  // (resmî fiyat sayfası, 07.09.2026). Eskiden burada 3/15 yazıyordu.
  assert.deepStrictEqual(t("claude-sonnet-5"), [2, 10]);
  assert.deepStrictEqual(t("claude-sonnet-4-6"), [3, 15]);
  assert.deepStrictEqual(t("claude-haiku-4-5-20251001"), [1, 5]);
});

test("cache_read katsayısı: yalnız 5.1'lerde 0.025, geri kalanda varsayılan 0.1", () => {
  assert.strictEqual(priceFor("claude-fable-5-1").cache_read, 0.025);
  assert.strictEqual(priceFor("claude-mythos-5-1").cache_read, 0.025);
  // 5.0 sürümleri ve diğerleri katsayı TAŞIMAZ → estimateCostUsd 0.1'e düşer
  assert.strictEqual(priceFor("claude-fable-5").cache_read, undefined);
  assert.strictEqual(priceFor("claude-opus-5").cache_read, undefined);

  const oku = (m) => estimateCostUsd({ [m]: { cache_read_tokens: 1_000_000 } });
  assert.strictEqual(oku("claude-fable-5-1"), 0.25); // 10 * 0.025
  assert.strictEqual(oku("claude-fable-5"), 1);      // 10 * 0.1
  assert.strictEqual(oku("claude-opus-5"), 0.5);     // 5 * 0.1
});

test("claude-3-haiku kendi (emekli) tarifesine düşer, genel haiku'ya değil", () => {
  assert.deepStrictEqual(
    [priceFor("claude-3-haiku-20240307").input, priceFor("claude-3-haiku-20240307").output],
    [0.25, 1.25]
  );
  // sıra tuzağı: 3-5-haiku "3-haiku"ya DÜŞMEMELİ, genel haiku da 3-haiku'yu yutmamalı
  assert.strictEqual(priceFor("claude-3-5-haiku-20241022").input, 0.8);
  assert.strictEqual(priceFor("claude-haiku-4-5").input, 1);
});

test("eski Opus'lar ESKİ tarifede kalır (yeni katmana kaymaz)", () => {
  assert.deepStrictEqual([priceFor("claude-opus-4-1-20250805").input, priceFor("claude-opus-4-1-20250805").output], [15, 75]);
  assert.deepStrictEqual([priceFor("claude-opus-4-20250514").input, priceFor("claude-opus-4-20250514").output], [15, 75]);
  assert.deepStrictEqual([priceFor("claude-3-opus-20240229").input, priceFor("claude-3-opus-20240229").output], [15, 75]);
  // opus-4-5 "opus-5" kalıbına YANLIŞLIKLA düşmemeli (substring tuzağı)
  assert.deepStrictEqual([priceFor("claude-opus-4-5-20251101").input], [5]);
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
  // Döküm YOK → eski varsayım: cache yazma 5 dk tarifesiyle.
  // input: 3, output: 15, cache_write: 3 * 1.25 = 3.75, cache_read: 3 * 0.1 = 0.3
  // Toplam = 3 + 15 + 3.75 + 0.3 = 22.05
  assert.strictEqual(estimateCostUsd(models), 22.05);
});

test("cache yazma TTL'e göre fiyatlanır: 1 saatlik 2x, 5 dakikalık 1.25x", () => {
  const base = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  // Hepsi 1 SAATLİK (Claude Code'un gerçek davranışı): 3 * 2 = 6
  assert.strictEqual(estimateCostUsd({
    "claude-3-5-sonnet-20241022": {
      ...base, cache_creation_tokens: 1_000_000,
      cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 1_000_000,
    },
  }), 6);
  // Hepsi 5 DAKİKALIK: 3 * 1.25 = 3.75
  assert.strictEqual(estimateCostUsd({
    "claude-3-5-sonnet-20241022": {
      ...base, cache_creation_tokens: 1_000_000,
      cache_creation_5m_tokens: 1_000_000, cache_creation_1h_tokens: 0,
    },
  }), 3.75);
  // Yarı yarıya: 0.5*3*1.25 + 0.5*3*2 = 1.875 + 3 = 4.875
  // Artık SENTE yuvarlanmıyor (6 ondalık): gün bazlı dökümde $0.004'lük günler
  // $0.00'a düşüp toplamdan siliniyordu.
  assert.strictEqual(estimateCostUsd({
    "claude-3-5-sonnet-20241022": {
      ...base, cache_creation_tokens: 1_000_000,
      cache_creation_5m_tokens: 500_000, cache_creation_1h_tokens: 500_000,
    },
  }), 4.875);
});

test("döküm toplamı tutmazsa artan kısım sessizce kaybolmaz", () => {
  // Toplam 1M ama döküm yalnız 600K'yı açıklıyor → artan 400K ucuz tarifeyle.
  // 0.6*3*2 + 0.4*3*1.25 = 3.6 + 1.5 = 5.1
  assert.strictEqual(estimateCostUsd({
    "claude-3-5-sonnet-20241022": {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_creation_tokens: 1_000_000,
      cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 600_000,
    },
  }), 5.1);
});

test("regresyon: gerçek Claude Code usage biçimi transcript üzerinden fiyatlanır", () => {
  const { summarizeLines } = require("../lib/transcript");
  // Gerçek transkriptlerdeki alan adları (ölçüldü: cache_creation dökümü HER mesajda var)
  const out = summarizeLines([
    JSON.stringify({
      type: "assistant", timestamp: "2026-07-25T10:00:00.000Z",
      message: {
        id: "msg_1", model: "claude-3-5-sonnet-20241022",
        usage: {
          input_tokens: 0, output_tokens: 0,
          cache_creation_input_tokens: 1_000_000,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
        },
      },
    }),
  ]);
  const u = out.models["claude-3-5-sonnet-20241022"];
  assert.strictEqual(u.cache_creation_tokens, 1_000_000, "toplam alan korunmalı (sunucu bunu okuyor)");
  assert.strictEqual(u.cache_creation_1h_tokens, 1_000_000);
  assert.strictEqual(u.cache_creation_5m_tokens, 0);
  assert.strictEqual(estimateCostUsd(out.models), 6); // 1.25x değil 2x
});
