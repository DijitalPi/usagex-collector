const test = require("node:test");
const assert = require("node:assert");
const { snapshotPayload, sessionPayload, projectLabel } = require("../lib/payload");

test("projectLabel açık modda adı aynen döner", () => {
  assert.strictEqual(projectLabel("musteri-x-sitesi", true), "musteri-x-sitesi");
});

test("projectLabel kapalı modda deterministik hash döner, ad sızmaz", () => {
  const a = projectLabel("musteri-x-sitesi", false);
  const b = projectLabel("musteri-x-sitesi", false);
  assert.strictEqual(a, b);
  assert.match(a, /^p-[0-9a-f]{8}$/);
  assert.ok(!a.includes("musteri"));
});

test("snapshotPayload zorunlu alanları içerir, hostname İÇERMEZ", () => {
  const p = snapshotPayload({ session_pct: 62, week_pct: 41 }, { source: "stop" });
  assert.strictEqual(p.kind, "snapshot");
  assert.strictEqual(p.schema_version, 1);
  assert.strictEqual(p.source, "stop");
  assert.strictEqual(p.plan_usage.session_pct, 62);
  // veri minimizasyonu: sunucu snapshot'ta machine'i saklamıyor — gönderilmez
  assert.strictEqual(p.machine, undefined);
});

test("sessionPayload send_project_names=false iken projeyi VE makine adını hash'ler", () => {
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "gizli-proje", started_at: "a", ended_at: "b", message_count: 3,
      models: { "claude-sonnet-5": { input_tokens: 1_000_000, output_tokens: 0 } },
    },
    plan_usage: null,
    config: { send_project_names: false },
  });
  assert.strictEqual(p.kind, "session");
  assert.match(p.project, /^p-[0-9a-f]{8}$/);
  // Bilgisayar adı da kişisel veri ("MacBook Pro — Ahmet Yılmaz") — aynı tercihe tabi.
  assert.match(p.machine, /^pc-[0-9a-f]{6}$/);
  assert.ok(!p.machine.includes(require("os").hostname()));
  // maliyet artık payload'ın KENDİ hesabı (üst düzey ile günler aynı sözlükten)
  assert.strictEqual(p.est_cost_usd, 2);
});

test("sessionPayload açık modda gerçek hostname'i gönderir", () => {
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "p", started_at: "a", ended_at: "b", message_count: 1,
      models: { "claude-sonnet-5": { input_tokens: 1 } },
    },
    plan_usage: null,
    config: { send_project_names: true },
  });
  assert.strictEqual(p.machine, require("os").hostname());
});

// Claude dışı modellerle (ollama/qwen) çalışılmış oturum: gönderilecek veri YOK.
// Eskiden models:{} ile boş satır gidiyor, sunucuda "0 token" oturumlar birikiyordu.
test("sessionPayload Claude modeli yoksa null döner (satır hiç gitmez)", () => {
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "p", started_at: "a", ended_at: "b", message_count: 9,
      models: { "qwen2.5-coder:7b": { input_tokens: 10_000 } },
      days: { "2026-07-01": { models: { "qwen2.5-coder:7b": { input_tokens: 10_000 } }, message_count: 9 } },
    },
    plan_usage: null,
    config: { send_project_names: true },
  });
  assert.strictEqual(p, null);
});

test("sessionPayload Claude modeli olmayan GÜNLERİ eler", () => {
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "p", started_at: "a", ended_at: "b", message_count: 4,
      models: { "claude-sonnet-5": { input_tokens: 1 } },
      days: {
        "2026-07-01": { models: { "claude-sonnet-5": { input_tokens: 1 } }, message_count: 1 },
        // yalnız mesaj sayısı var, Claude token'ı yok → sunucuya gitmemeli
        "2026-07-02": { models: {}, message_count: 3 },
      },
    },
    plan_usage: null,
    config: { send_project_names: true },
  });
  assert.deepStrictEqual(p.days.map((d) => d.day), ["2026-07-01"]);
});

test("sessionPayload gün dökümüne tz_offset_minutes taşır, `day` alanı bozulmaz", () => {
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "p", started_at: "a", ended_at: "b", message_count: 1,
      models: { "claude-x": { input_tokens: 3 } },
      days: {
        "2026-07-01": { models: { "claude-x": { input_tokens: 1 } }, message_count: 1, started_at: "a", ended_at: "b", tz_offset_minutes: 180 },
        // eski collector verisi: offset YOK → null gitmeli, alan yine de bulunmalı
        "2026-07-02": { models: { "claude-x": { input_tokens: 2 } }, message_count: 2, started_at: "c", ended_at: "d" },
      },
    },
    plan_usage: null,
    config: { send_project_names: true },
  });
  assert.strictEqual(p.days[0].day, "2026-07-01");
  assert.strictEqual(p.days[0].tz_offset_minutes, 180);
  assert.strictEqual(p.days[1].tz_offset_minutes, null);
});

// ── R16: days[] üst sınırı (413 → kalıcı düşürme zinciri kırılıyor) ────────
// Aylarca açık kalan oturum yüzlerce gün taşıyabiliyor; gövde /ingest tavanını
// aşınca sunucu 413 dönüyor, sender 413'ü KALICI sayıp oturumu düşürüyordu.

function gunlerUret(n, modelAdi = "claude-sonnet-5", tokenSayisi = 1) {
  const days = {};
  for (let i = 0; i < n; i++) {
    const g = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    days[g] = {
      models: { [modelAdi]: { input_tokens: tokenSayisi } },
      message_count: 1, started_at: `${g}T00:00:00Z`, ended_at: `${g}T23:00:00Z`,
    };
  }
  return days;
}
const oturum = (days) => sessionPayload({
  session_id: "uzun",
  summary: {
    project: "p", started_at: "a", ended_at: "b", message_count: 1,
    models: { "claude-sonnet-5": { input_tokens: 1 } },
    days,
  },
  plan_usage: null,
  config: { send_project_names: true },
});

test("sessionPayload days[] sayısını MAX_DAYS'e kırpar, EN YENİLERİ tutar", () => {
  const { MAX_DAYS } = require("../lib/payload");
  const p = oturum(gunlerUret(MAX_DAYS + 120));
  assert.strictEqual(p.days.length, MAX_DAYS);
  // ilk 120 gün atılır: kalan ilk gün 2024-01-01 + 120
  assert.strictEqual(p.days[0].day, new Date(Date.UTC(2024, 0, 1 + 120)).toISOString().slice(0, 10));
  assert.strictEqual(
    p.days[p.days.length - 1].day,
    new Date(Date.UTC(2024, 0, MAX_DAYS + 120)).toISOString().slice(0, 10),
    "son gün korunmalı"
  );
});

test("sessionPayload gövde MAX_BODY_BYTES'ı aşarsa günleri yarılayarak küçültür", () => {
  const { MAX_BODY_BYTES } = require("../lib/payload");
  // 300 gün × ~5 KB'lik model adı ≈ 1.5 MB → tek başına gün sayısı tavanı yetmez
  const sisman = "claude-sonnet-5-" + "x".repeat(5000);
  const p = oturum(gunlerUret(300, sisman, 7));
  const boyut = Buffer.byteLength(JSON.stringify(p), "utf8");
  assert.ok(boyut <= MAX_BODY_BYTES, `gövde ${boyut} bayt, tavan ${MAX_BODY_BYTES}`);
  assert.ok(p.days.length > 0 && p.days.length < 300, `günler kısalmalı (kalan: ${p.days.length})`);
  // en YENİ günler kalır
  assert.strictEqual(
    p.days[p.days.length - 1].day,
    new Date(Date.UTC(2024, 0, 300)).toISOString().slice(0, 10)
  );
});

test("sessionPayload kısa oturumda days[] AYNEN kalır (kırpma yan etkisi yok)", () => {
  const p = oturum(gunlerUret(3));
  assert.deepStrictEqual(p.days.map((d) => d.day), ["2024-01-01", "2024-01-02", "2024-01-03"]);
});

// claudeFirstUsedAt artık CLAUDE_CONFIG_DIR'i takip ediyor (config.js:claudeDir ile
// aynı mantık). Eskiden HER ZAMAN ~/.claude.json okunuyordu: özel config dizini
// kullanan (devcontainer, çoklu profil) kurulumlarda tarih ya yanlış ya boştu.
test("claudeFirstUsedAt CLAUDE_CONFIG_DIR altındaki .claude.json'ı okur", () => {
  const fs = require("fs"); const os = require("os"); const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-cfg-"));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
    claudeCodeFirstTokenDate: "2025-03-14T10:00:00.000Z",
    firstStartTime: "2025-06-01T00:00:00.000Z",
  }));
  const eski = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // modülü taze yükle (yol bazlı önbellek)
    delete require.cache[require.resolve("../lib/payload")];
    const { snapshotPayload: sp } = require("../lib/payload");
    // iki adaydan EN ESKİSİ seçilir
    assert.strictEqual(sp(null, { source: "ping" }).claude_first_used_at, "2025-03-14T10:00:00.000Z");
  } finally {
    if (eski === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = eski;
    delete require.cache[require.resolve("../lib/payload")];
  }
});

test("claudeFirstUsedAt dosya yoksa/bozuksa null (opsiyonel alan)", () => {
  const fs = require("fs"); const os = require("os"); const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagex-cfg-"));
  const eski = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    delete require.cache[require.resolve("../lib/payload")];
    const { snapshotPayload: sp } = require("../lib/payload");
    assert.strictEqual(sp(null, { source: "ping" }).claude_first_used_at, null);
  } finally {
    if (eski === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = eski;
    delete require.cache[require.resolve("../lib/payload")];
  }
});

test("filterClaudeModels sadece claude modellerini bırakır", () => {
  const { filterClaudeModels } = require("../lib/payload");
  const models = {
    "claude-fable-5": { input_tokens: 1 },
    "claude-opus-4-8": { input_tokens: 2 },
    "qwen2.5-coder:7b": { input_tokens: 3 },
    "gemma4:12b": { input_tokens: 4 },
    "<synthetic>": { input_tokens: 5 },
  };
  const out = filterClaudeModels(models);
  assert.deepStrictEqual(Object.keys(out).sort(), ["claude-fable-5", "claude-opus-4-8"]);
});

// ── fiyat kuşağı (pricing_version) ──────────────────────────────────────────
// Sunucu est_cost_usd'yi HANGİ tarifeyle hesapladığımızı bilmeli: tarife
// değişince eski satırları ayırt edip yeniden fiyatlandırma isteyebilsin.

test("sessionPayload pricing_version taşır (lib/pricing.js ile aynı sayı)", () => {
  const { PRICING_VERSION } = require("../lib/pricing");
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "p", started_at: "a", ended_at: "b", message_count: 1,
      models: { "claude-sonnet-5": { input_tokens: 1_000_000 } },
    },
    plan_usage: null,
    config: { send_project_names: true },
  });
  assert.strictEqual(p.pricing_version, PRICING_VERSION);
  assert.strictEqual(p.pricing_version, 5);
});

test("cost-state OTORİTE olsa bile pricing_version DOLU gider", () => {
  // Toplam Claude Code'un defterinden gelir ama gün kırılımı yine bizim
  // tahminimizin oranıyla ölçekleniyor → kuşak bu satırda da anlamlı.
  const p = sessionPayload({
    session_id: "s1",
    summary: {
      project: "p", started_at: "a", ended_at: "b", message_count: 1,
      models: { "claude-sonnet-5": { input_tokens: 1_000_000 } },
      claude_reported_cost_usd: 7.5,
      days: {
        "2026-07-01": { models: { "claude-sonnet-5": { input_tokens: 1_000_000 } }, message_count: 1 },
      },
    },
    plan_usage: null,
    config: { send_project_names: true },
  });
  assert.strictEqual(p.est_cost_usd, 7.5, "otorite toplam cost-state'ten gelmeli");
  assert.strictEqual(p.claude_reported_cost_usd, 7.5);
  assert.strictEqual(p.pricing_version, 5);
});

test("snapshotPayload'da pricing_version YOK (maliyet taşımıyor)", () => {
  const p = snapshotPayload({ session_pct: 10, week_pct: 10 }, { source: "ping" });
  assert.strictEqual(p.pricing_version, undefined);
});
