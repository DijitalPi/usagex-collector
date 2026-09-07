const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarizeLines, summarizeTranscript } = require("../lib/transcript");
const { sessionPayload } = require("../lib/payload");

// SENTETİK fixture: gerçek ~/.claude/projects dosyaları TESTE KOPYALANMAZ
// (kişisel veri). Alan adları ve tipler gerçek transkriptten ölçülerek alındı:
//   cost-state → { type, sessionId, totalCostUSD, modelUsage:{model:{inputTokens,
//                  outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
//                  costUSD, ...}}, hasUnknownModelCost }
const L = (o) => JSON.stringify(o);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-cs-"));
}

const COST_STATE = {
  type: "cost-state",
  sessionId: "s-1",
  totalCostUSD: 4.5,
  startTime: 1_800_000_000_000,
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 5_000_000, outputTokens: 0, thinkingTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 4.5,
    },
    // Transkriptte HİÇ satırı olmayan model: arka planda çağrılan haiku.
    // Bizim sayımımız bunu göremiyor — cost-state'ten gelmeli.
    "claude-haiku-4-5-20251001": {
      inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 1,
    },
  },
  hasUnknownModelCost: false,
};

// ── mesaj sayımı (bulgu 5) ──────────────────────────────────────────────────

test("message_count araç sonuçlarını ve isMeta satırlarını SAYMAZ", () => {
  const s = summarizeLines([
    // gerçek istem
    L({ type: "user", timestamp: "2026-07-01T12:00:00Z", message: { content: "merhaba" } }),
    // araç sonucu — iki farklı işaret, ikisi de sayılmamalı
    L({ type: "user", timestamp: "2026-07-01T12:00:01Z", toolUseResult: { ok: true },
        message: { content: [{ type: "tool_result", content: "…" }] } }),
    L({ type: "user", timestamp: "2026-07-01T12:00:02Z",
        message: { content: [{ type: "tool_result", content: "…" }] } }),
    // sistem notu
    L({ type: "user", timestamp: "2026-07-01T12:00:03Z", isMeta: true, message: { content: "hook çıktısı" } }),
    // asistan cevabı sayılır
    L({ type: "assistant", timestamp: "2026-07-01T12:00:04Z",
        message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 } } }),
  ]);
  assert.strictEqual(s.message_count, 2, "1 gerçek istem + 1 asistan cevabı");
  assert.strictEqual(s.tool_result_count, 2);
});

test("araç sonucu satırı GÜN kovasını da şişirmez", () => {
  const s = summarizeLines([
    L({ type: "user", timestamp: "2026-07-01T12:00:00Z", message: { content: "soru" } }),
    L({ type: "user", timestamp: "2026-07-01T12:00:01Z", toolUseResult: {}, message: { content: [] } }),
  ]);
  assert.strictEqual(s.days["2026-07-01"].message_count, 1);
});

test("araç sonucu satırı oturum zaman aralığını YİNE DE genişletir", () => {
  // Sayılmıyor olması "hiç olmadı" demek değil: oturum o saatte hâlâ açıktı.
  const s = summarizeLines([
    L({ type: "user", timestamp: "2026-07-01T12:00:00Z", message: { content: "soru" } }),
    L({ type: "user", timestamp: "2026-07-01T18:00:00Z", toolUseResult: {}, message: { content: [] } }),
  ]);
  assert.strictEqual(s.ended_at, "2026-07-01T18:00:00Z");
});

// ── cost-state otoritesi (bulgu 6) ──────────────────────────────────────────

test("cost-state yoksa alanlar null kalır (geriye uyumlu)", () => {
  const s = summarizeLines([
    L({ type: "assistant", timestamp: "2026-07-01T12:00:00Z",
        message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1 } } }),
  ]);
  assert.strictEqual(s.claude_reported_cost_usd, null);
  assert.strictEqual(s.has_unknown_model_cost, null);
});

test("cost-state model sayaçlarını BÜYÜĞÜ ile birleştirir, eksik modeli ekler", () => {
  const s = summarizeLines([
    // bizim gördüğümüz: 5M input (cost-state ile aynı) + 2M output (cost-state'te YOK)
    L({ type: "assistant", timestamp: "2026-07-01T12:00:00Z",
        message: { id: "m1", model: "claude-sonnet-5",
                   usage: { input_tokens: 5_000_000, output_tokens: 2_000_000 } } }),
    L(COST_STATE),
  ]);
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 5_000_000);
  // cost-state 0 diyor ama biz 2M gördük → bizimki kazanır (alt-ajan/eksik kapsama)
  assert.strictEqual(s.models["claude-sonnet-5"].output_tokens, 2_000_000);
  // transkriptte hiç satırı olmayan arka plan modeli eklendi
  assert.strictEqual(s.models["claude-haiku-4-5-20251001"].input_tokens, 1_000_000);
  assert.strictEqual(s.claude_reported_cost_usd, 4.5);
  assert.strictEqual(s.has_unknown_model_cost, false);
});

test("SON cost-state otoritedir (öncekiler eskimiştir)", () => {
  const s = summarizeLines([
    L({ ...COST_STATE, totalCostUSD: 1.1 }),
    L({ ...COST_STATE, totalCostUSD: 9.9 }),
  ]);
  assert.strictEqual(s.claude_reported_cost_usd, 9.9);
});

test("bozuk cost-state (totalCostUSD sayı değil) yok sayılır", () => {
  const s = summarizeLines([L({ type: "cost-state", totalCostUSD: "çok" })]);
  assert.strictEqual(s.claude_reported_cost_usd, null);
});

// ── payload: toplam otorite + günlere ORANLI dağıtım (bulgu 6 + 17) ─────────

test("payload est_cost_usd cost-state toplamını alır, günler oranla ölçeklenir", () => {
  const summary = summarizeLines([
    L({ type: "assistant", timestamp: "2026-07-01T12:00:00Z",
        message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1_000_000 } } }),
    L({ type: "assistant", timestamp: "2026-07-02T12:00:00Z",
        message: { id: "m2", model: "claude-sonnet-5", usage: { input_tokens: 3_000_000 } } }),
    L({ ...COST_STATE, modelUsage: {}, totalCostUSD: 8 }),
  ]);
  summary.project = "p";
  const p = sessionPayload({ session_id: "s", summary, plan_usage: null, config: { send_project_names: true } });

  assert.strictEqual(p.est_cost_usd, 8, "toplam Claude'un bildirdiği değer");
  assert.strictEqual(p.claude_reported_cost_usd, 8);
  // Tahminimiz 1M*2 + 3M*2 = $2 + $6 = $8 → oran 1; ama oranın uygulandığını
  // 1:3 dağılımıyla doğruluyoruz.
  const toplam = p.days.reduce((a, d) => a + d.est_cost_usd, 0);
  assert.strictEqual(Math.round(toplam * 1e6) / 1e6, 8, "günlerin toplamı otoriter toplama eşit");
  assert.strictEqual(p.days[0].est_cost_usd, 2);
  assert.strictEqual(p.days[1].est_cost_usd, 6);
});

test("tahminimiz 0 iken cost-state maliyeti son güne yazılır (kaybolmaz)", () => {
  const summary = summarizeLines([
    // tanınmayan model → estimateCostUsd 0, ama Claude bir maliyet bildirdi
    L({ type: "assistant", timestamp: "2026-07-01T12:00:00Z",
        message: { id: "m1", model: "claude-yeni-model-x", usage: { input_tokens: 1 } } }),
    L({ ...COST_STATE, modelUsage: {}, totalCostUSD: 3.25 }),
  ]);
  summary.project = "p";
  const p = sessionPayload({ session_id: "s", summary, plan_usage: null, config: { send_project_names: true } });
  assert.strictEqual(p.est_cost_usd, 3.25);
  assert.strictEqual(p.days[p.days.length - 1].est_cost_usd, 3.25);
});

test("maliyet 6 ondalıkla taşınır — kuruşaltı günler sıfırlanmaz", () => {
  const summary = summarizeLines([
    L({ type: "assistant", timestamp: "2026-07-01T12:00:00Z",
        message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 2_000 } } }),
  ]);
  summary.project = "p";
  const p = sessionPayload({ session_id: "s", summary, plan_usage: null, config: { send_project_names: true } });
  // 2000 token * $2/MTok = $0.004 — sente yuvarlansa $0.00 olurdu
  assert.strictEqual(p.days[0].est_cost_usd, 0.004);
  assert.strictEqual(p.est_cost_usd, 0.004);
});

// ── alt-ajanlar: özyinelemeli tarama + önbellek (bulgu 16) ──────────────────

function yaz(p, satirlar) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, satirlar.join("\n") + "\n");
}
const altSatir = (id, tokens, ts = "2026-07-01T13:00:00Z") =>
  L({ type: "assistant", timestamp: ts,
      message: { id, model: "claude-sonnet-5", usage: { input_tokens: tokens } } });

test("alt-ajan taraması subagents/workflows/<wf>/ ALTINI da okur", async () => {
  const dir = tmpDir();
  const ana = path.join(dir, "ana.jsonl");
  yaz(ana, [L({ type: "assistant", timestamp: "2026-07-01T12:00:00Z",
                message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 100 } } })]);
  yaz(path.join(dir, "ana", "subagents", "a.jsonl"), [altSatir("a1", 200)]);
  yaz(path.join(dir, "ana", "subagents", "workflows", "wf_1", "b.jsonl"), [altSatir("b1", 400)]);

  const s = await summarizeTranscript(ana, { cacheDir: null });
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 700, "100 + 200 + 400");
});

test("alt-ajan .meta.json dosyaları yok sayılır", async () => {
  const dir = tmpDir();
  const ana = path.join(dir, "ana.jsonl");
  yaz(ana, [altSatir("m1", 10, "2026-07-01T12:00:00Z")]);
  const sub = path.join(dir, "ana", "subagents");
  yaz(path.join(sub, "a.jsonl"), [altSatir("a1", 20)]);
  fs.writeFileSync(path.join(sub, "a.meta.json"), '{"bozuk": true}');

  const s = await summarizeTranscript(ana, { cacheDir: null });
  assert.strictEqual(s.models["claude-sonnet-5"].input_tokens, 30);
});

test("alt-ajan özeti (size, mtime) değişmedikçe ÖNBELLEKTEN gelir", async () => {
  const dir = tmpDir();
  const cacheDir = tmpDir();
  const ana = path.join(dir, "ana.jsonl");
  yaz(ana, [altSatir("m1", 100, "2026-07-01T12:00:00Z")]);
  const altYol = path.join(dir, "ana", "subagents", "a.jsonl");
  yaz(altYol, [altSatir("a1", 900)]);

  const ilk = await summarizeTranscript(ana, { cacheDir });
  assert.strictEqual(ilk.models["claude-sonnet-5"].input_tokens, 1000);

  const cachePath = path.join(cacheDir, "usagex-subagent-cache.json");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.ok(cache[altYol], "önbellekte dosya başına kayıt olmalı");
  assert.strictEqual(typeof cache[altYol].size, "number");
  assert.strictEqual(typeof cache[altYol].mtime, "number");

  // Önbellekteki ÖZETİ tanınabilir bir değere çevir; dosyaya dokunma.
  // İkinci turda bu değer görünüyorsa dosya yeniden ayrıştırılmamış demektir.
  cache[altYol].summary.models["claude-sonnet-5"].input_tokens = 424242;
  fs.writeFileSync(cachePath, JSON.stringify(cache));

  const ikinci = await summarizeTranscript(ana, { cacheDir });
  assert.strictEqual(
    ikinci.models["claude-sonnet-5"].input_tokens, 424342, // 100 (ana) + 424242 (önbellek)
    "değişmeyen alt-ajan dosyası önbellekten gelmeli"
  );
});

test("alt-ajan dosyası DEĞİŞİRSE önbellek atlanır, yeniden okunur", async () => {
  const dir = tmpDir();
  const cacheDir = tmpDir();
  const ana = path.join(dir, "ana.jsonl");
  yaz(ana, [altSatir("m1", 100, "2026-07-01T12:00:00Z")]);
  const altYol = path.join(dir, "ana", "subagents", "a.jsonl");
  yaz(altYol, [altSatir("a1", 900)]);
  await summarizeTranscript(ana, { cacheDir });

  yaz(altYol, [altSatir("a1", 900), altSatir("a2", 5)]);
  const ikinci = await summarizeTranscript(ana, { cacheDir });
  assert.strictEqual(ikinci.models["claude-sonnet-5"].input_tokens, 1005);
});

test("alt-ajan dosya sayısı tavanı uygulanır (hook oturumu bekletmesin)", async () => {
  const { listSubagentFiles, SUB_MAX_FILES } = require("../lib/transcript");
  const dir = tmpDir();
  const sub = path.join(dir, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < SUB_MAX_FILES + 25; i++) {
    fs.writeFileSync(path.join(sub, `a${String(i).padStart(4, "0")}.jsonl`), "{}\n");
  }
  const files = listSubagentFiles(sub);
  assert.strictEqual(files.length, SUB_MAX_FILES);
  // deterministik sıra: ada göre ilk N — iki ardışık gönderim aynı kümeyi görsün
  assert.match(files[0].path, /a0000\.jsonl$/);
});

test("alt-ajan derinlik tavanı: çok derindeki dosya taranmaz", () => {
  const { listSubagentFiles, SUB_MAX_DEPTH } = require("../lib/transcript");
  const dir = tmpDir();
  const sub = path.join(dir, "subagents");
  let derin = sub;
  for (let i = 0; i <= SUB_MAX_DEPTH + 1; i++) derin = path.join(derin, `d${i}`);
  fs.mkdirSync(derin, { recursive: true });
  fs.writeFileSync(path.join(derin, "cok-derin.jsonl"), "{}\n");
  fs.writeFileSync(path.join(sub, "yuzeyde.jsonl"), "{}\n");

  const files = listSubagentFiles(sub).map((f) => path.basename(f.path));
  assert.deepStrictEqual(files, ["yuzeyde.jsonl"]);
});
