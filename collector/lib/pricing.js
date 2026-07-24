// USD / 1M token — API eşdeğeri (Max/Pro planda gerçek fatura yok, bu TAHMİNİ maliyettir).
// Fiyat güncellemesi gerekirse sadece bu tabloyu düzenle.
const PRICES = [
  // Spesifik Anthropic model tanımları
  // Claude 5 ailesi — resmî API fiyatı yayınlandığında güncelle
  // (şimdilik Opus tarifesi: alt sınır; eşleşme yoksa maliyet 0 sayılıyordu ki o çok daha yanlış)
  { match: "fable", input: 15, output: 75 },
  { match: "mythos", input: 15, output: 75 },
  { match: "sonnet-5", input: 3, output: 15 },
  { match: "3-7-sonnet", input: 3, output: 15 },
  { match: "3-5-sonnet", input: 3, output: 15 },
  { match: "3-5-haiku", input: 0.8, output: 4 },
  { match: "3-opus", input: 15, output: 75 },
  { match: "opus-4", input: 15, output: 75 },
  { match: "sonnet-4", input: 3, output: 15 },
  { match: "haiku-4", input: 1, output: 5 },
  // Genel aile eşleşmeleri (fallback)
  { match: "opus", input: 15, output: 75 },
  { match: "sonnet", input: 3, output: 15 },
  { match: "haiku", input: 1, output: 5 },
];

function priceFor(model) {
  if (!model || typeof model !== "string") return null;
  const m = model.toLowerCase();
  return PRICES.find((p) => m.includes(p.match)) || null;
}

// Cache yazma = input * 1.25, cache okuma = input * 0.1 (API fiyatlama kuralı)
function estimateCostUsd(models) {
  const M = 1_000_000;
  let total = 0;
  for (const [model, u] of Object.entries(models)) {
    const p = priceFor(model);
    if (!p) continue;
    total +=
      ((u.input_tokens || 0) / M) * p.input +
      ((u.output_tokens || 0) / M) * p.output +
      ((u.cache_creation_tokens || 0) / M) * p.input * 1.25 +
      ((u.cache_read_tokens || 0) / M) * p.input * 0.1;
  }
  return Math.round(total * 100) / 100;
}

module.exports = { estimateCostUsd, priceFor };
