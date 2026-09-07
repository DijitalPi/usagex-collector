// USD / 1M token — API eşdeğeri (Max/Pro planda gerçek fatura yok, bu TAHMİNİ maliyettir).
// Fiyat güncellemesi gerekirse sadece bu tabloyu düzenle.
// SIRA ÖNEMLİ: priceFor ilk eşleşmeyi alır → spesifik kalıplar genelden ÖNCE.
// Güncel tarifeler resmî fiyat sayfasından:
// https://platform.claude.com/docs/en/about-claude/pricing (çekildi: 07.09.2026).
// Eskiden Claude 5 ailesi ve Opus 4.x "Opus tarifesi" varsayımıyla 15/75 yazılmıştı;
// gerçekte Opus katmanı 5/25, Fable 10/50 — maliyet tahmini 2-3 KAT şişikti.
// İsteğe bağlı `cache_read`: cache okumanın input fiyatına oranı. Yazılmazsa 0.1
// (resmî varsayılan çarpan); yalnız Fable/Mythos 5.1'de 0.025.
const PRICES = [
  // — Claude 5 ailesi —
  // 5.1'ler cache okumada 0.025x ($0.25/MTok) — 5.0 sürümlerinden FARKLI (onlar 0.1x).
  // Kaynak: resmî fiyat tablosu dipnotu, 07.09.2026.
  { match: "fable-5-1", input: 10, output: 50, cache_read: 0.025 },
  { match: "mythos-5-1", input: 10, output: 50, cache_read: 0.025 },
  { match: "fable", input: 10, output: 50 },
  { match: "mythos", input: 10, output: 50 },  // Fable ile aynı tarife
  { match: "opus-5", input: 5, output: 25 },
  // Sonnet 5: 2/10. "31 Ağu 2026'ya kadar tanıtım" notu geçersiz — 1 Eyl 2026 zammı
  // İPTAL edildi, 2/10 kalıcı standart tarife oldu (resmî sayfa notu, 07.09.2026).
  { match: "sonnet-5", input: 2, output: 10 },
  // — Claude 4.x — Opus 4.5/4.6/4.7/4.8 Opus katmanı (5/25); 4.0/4.1 ESKİ tarifede (15/75)
  { match: "opus-4-8", input: 5, output: 25 },
  { match: "opus-4-7", input: 5, output: 25 },
  { match: "opus-4-6", input: 5, output: 25 },
  { match: "opus-4-5", input: 5, output: 25 }, // resmî tabloda doğrulandı (07.09.2026)
  { match: "sonnet-4-6", input: 3, output: 15 },
  { match: "haiku-4", input: 1, output: 5 },
  { match: "opus-4", input: 15, output: 75 },  // yalnız Opus 4.0 / 4.1 buraya düşer
  { match: "sonnet-4", input: 3, output: 15 },
  // — Claude 3.x (emekli; geçmiş transkriptler için) —
  { match: "3-7-sonnet", input: 3, output: 15 },
  { match: "3-5-sonnet", input: 3, output: 15 },
  { match: "3-5-haiku", input: 0.8, output: 4 },
  // Claude 3 Haiku güncel fiyat sayfasında ARTIK YOK (emekli). 0.25/1.25 Anthropic'in
  // 2024 tarifesi; 07.09.2026 sayfasından doğrulanamadı, eski transkriptler için duruyor.
  { match: "3-haiku", input: 0.25, output: 1.25 },
  { match: "3-opus", input: 15, output: 75 },
  // — Genel aile yedeği: tanınmayan yeni model güncel katman tarifesiyle sayılır —
  { match: "opus", input: 5, output: 25 },
  { match: "sonnet", input: 3, output: 15 },
  { match: "haiku", input: 1, output: 5 },
];

function priceFor(model) {
  if (!model || typeof model !== "string") return null;
  const m = model.toLowerCase();
  return PRICES.find((p) => m.includes(p.match)) || null;
}

// Cache okuma = input * cache_read (varsayılan 0.1). Cache YAZMA ise TTL'e göre değişir:
//   5 dakikalık cache = input * 1.25   ·   1 saatlik cache = input * 2
// Eskiden tüm cache yazımı 1.25 ile fiyatlanıyordu. Gerçek transkriptlerde ölçüldü:
// Claude Code'un cache yazımlarının TAMAMI 1 saatlik → maliyet tahmini sistematik
// olarak düşük çıkıyordu (bu makinedeki 60 transkriptte $5.462 yerine $5.930, %7.9).
// Döküm transkriptte zaten var (usage.cache_creation.ephemeral_{5m,1h}_input_tokens);
// transcript.js bunu cache_creation_{5m,1h}_tokens olarak taşır.
function cacheWriteUnits(u) {
  const total = u.cache_creation_tokens || 0;
  const c5 = u.cache_creation_5m_tokens || 0;
  const c1 = u.cache_creation_1h_tokens || 0;
  // Döküm yoksa (eski transkript / eski collector verisi) eski varsayıma düş.
  if (c5 + c1 === 0) return total * 1.25;
  // Döküm toplamı tutmuyorsa artan kısmı ucuz tarifeyle say (sessizce kaybolmasın).
  const artan = Math.max(0, total - c5 - c1);
  return c5 * 1.25 + c1 * 2 + artan * 1.25;
}

function estimateCostUsd(models) {
  const M = 1_000_000;
  let total = 0;
  for (const [model, u] of Object.entries(models)) {
    const p = priceFor(model);
    if (!p) continue;
    total +=
      ((u.input_tokens || 0) / M) * p.input +
      ((u.output_tokens || 0) / M) * p.output +
      (cacheWriteUnits(u) / M) * p.input +
      // Cache okuma katsayısı modele göre değişebiliyor (Fable/Mythos 5.1: 0.025).
      ((u.cache_read_tokens || 0) / M) * p.input * (p.cache_read ?? 0.1);
  }
  // 6 ONDALIK: sente yuvarlamak gün bazlı dökümü yiyordu — $0.004'lük bir gün
  // $0.00 olarak gidiyor, 30 günün toplamı da sıfır çıkıyordu. Yuvarlama artık
  // GÖSTERİM katmanının işi; taşıma katmanı ham değeri korur.
  // (Kayan nokta artıklarını temizlemek için yine de kırpıyoruz: 0.1+0.2 sorunu.)
  return Math.round(total * 1e6) / 1e6;
}

module.exports = { estimateCostUsd, priceFor };
