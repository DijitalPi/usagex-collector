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

test("sessionPayload send_project_names=false iken projeyi hash'ler", () => {
  const p = sessionPayload({
    session_id: "s1",
    summary: { project: "gizli-proje", started_at: "a", ended_at: "b", message_count: 3, models: {} },
    est_cost_usd: 0.5,
    plan_usage: null,
    config: { send_project_names: false },
  });
  assert.strictEqual(p.kind, "session");
  assert.match(p.project, /^p-[0-9a-f]{8}$/);
  assert.strictEqual(p.est_cost_usd, 0.5);
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
