const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Hook'ları GERÇEKTEN çalıştıran uçtan uca test: stdin'e hook JSON'ı verilir,
// sender/oauth-usage sahte modüllerle değiştirilir (NODE_PATH değil — require
// önbelleğine yazan küçük bir "harness" betiği kullanılır), exit kodu ve
// gönderilen payload'ın ŞEKLİ doğrulanır.
//
// Neden önemli: hook'lar oturumu bloklamamalı — her hata yolunda exit 0.
// Bu daha önce hiç test edilmiyordu; bir require hatası sessizce her oturumda
// hook'u çökertip veriyi kesebilirdi.

const ROOT = path.join(__dirname, "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usagex-hook-"));
}

// Harness: sahte sender/oauth-usage'ı require cache'ine koyar, sonra hook'u yükler.
// Gönderilen payload'lar OUT dosyasına JSONL olarak yazılır.
const HARNESS = `
const path = require("path");
const fs = require("fs");
const OUT = process.env.UX_OUT;
const LIB = path.join(${JSON.stringify(ROOT)}, "lib");

function fake(name, exports) {
  const p = require.resolve(path.join(LIB, name));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

fake("sender.js", {
  // sendPayload artık { status } döndürüyor (R23). Testler UX_SEND_STATUS ile
  // "dropped" / "auth_failed" gibi teslim EDİLMEMİŞ sonuçları taklit edebilir.
  sendPayload: async (payload) => {
    fs.appendFileSync(OUT, JSON.stringify({ event: "send", payload }) + "\\n");
    return { status: process.env.UX_SEND_STATUS || "sent" };
  },
  flushQueue: async () => {},
  postOnce: async () => true,
  defaultQueuePath: () => path.join(process.env.CLAUDE_CONFIG_DIR, "q.jsonl"),
});
fake("oauth-usage.js", {
  getPlanUsage: async (opts) => {
    fs.appendFileSync(OUT, JSON.stringify({ event: "plan_usage", force: !!(opts && opts.force) }) + "\\n");
    return process.env.UX_NO_USAGE ? null : { session_pct: 42, week_pct: 7 };
  },
});

require(process.env.UX_HOOK);
`;

function runHook(hookFile, input, { dir, env = {} } = {}) {
  const cfgDir = dir || tmpDir();
  const out = path.join(cfgDir, "out.jsonl");
  const harness = path.join(cfgDir, "harness.js");
  fs.writeFileSync(harness, HARNESS);
  // Aynı dizinde arka arkaya çalıştırmalarda çıktı BİRİKMESİN (throttle testleri
  // ikinci turda "0 gönderim" bekliyor; eski satırlar sayımı bozardı).
  try { fs.unlinkSync(out); } catch {}
  const r = spawnSync(process.execPath, [harness], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: cfgDir,
      UX_OUT: out,
      UX_HOOK: path.join(ROOT, "hooks", hookFile),
      ...env,
    },
  });
  let events = [];
  try {
    events = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, events, dir: cfgDir };
}

function writeConfig(dir, extra = {}) {
  fs.writeFileSync(
    path.join(dir, "usagex.json"),
    JSON.stringify({
      enabled: true,
      ingest_url: "https://example.invalid/ingest",
      device_token: "tok",
      ...extra,
    })
  );
}

function writeTranscript(dir, name = "s-1.jsonl") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp/proje-x" }),
    JSON.stringify({
      type: "assistant", timestamp: "2026-07-01T12:00:05Z",
      message: {
        id: "m1", model: "claude-sonnet-5",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      },
    }),
  ].join("\n") + "\n");
  return p;
}

const sends = (r) => r.events.filter((e) => e.event === "send").map((e) => e.payload);

// ── heartbeat.js ────────────────────────────────────────────────────────────

test("heartbeat: transcript varken oturum payload'ı gönderir, exit 0", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);

  const r = runHook("heartbeat.js", {
    hook_event_name: "SessionStart", session_id: "sess-1", transcript_path: tp, cwd: "/tmp/proje-x",
  }, { dir });

  assert.strictEqual(r.status, 0, r.stderr);
  const p = sends(r);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, "session");
  assert.strictEqual(p[0].schema_version, 1);
  assert.strictEqual(p[0].session_id, "sess-1");
  assert.strictEqual(p[0].source, "session-start");
  assert.strictEqual(p[0].project, "proje-x");
  assert.strictEqual(p[0].message_count, 2);
  assert.ok(p[0].models["claude-sonnet-5"], "model dökümü olmalı");
  assert.strictEqual(typeof p[0].est_cost_usd, "number");
  assert.deepStrictEqual(p[0].plan_usage, { session_pct: 42, week_pct: 7 });
  assert.ok(Array.isArray(p[0].days) && p[0].days.length === 1);
  assert.match(p[0].days[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(typeof p[0].days[0].tz_offset_minutes, "number");
});

test("heartbeat: Stop olayında source=stop", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);
  const r = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "s", transcript_path: tp }, { dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(sends(r)[0].source, "stop");
});

test("heartbeat: transcript yokken snapshot gönderir (hostname İÇERMEZ)", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const r = runHook("heartbeat.js", { hook_event_name: "SessionStart", session_id: "s" }, { dir });
  assert.strictEqual(r.status, 0);
  const p = sends(r);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, "snapshot");
  assert.strictEqual(p[0].machine, undefined);
  assert.deepStrictEqual(p[0].plan_usage, { session_pct: 42, week_pct: 7 });
});

test("heartbeat: throttle penceresi içinde İKİNCİ çalıştırma hiçbir şey göndermez", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);
  const input = { hook_event_name: "Stop", session_id: "aynı", transcript_path: tp };

  assert.strictEqual(sends(runHook("heartbeat.js", input, { dir })).length, 1);
  assert.strictEqual(sends(runHook("heartbeat.js", input, { dir })).length, 0, "5 dk dolmadan tekrar göndermemeli");
});

test("heartbeat: FARKLI oturum aynı pencerede kendi özetini gönderebilir", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const t1 = writeTranscript(dir, "a.jsonl");
  const t2 = writeTranscript(dir, "b.jsonl");

  const r1 = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "A", transcript_path: t1 }, { dir });
  const r2 = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "B", transcript_path: t2 }, { dir });

  assert.strictEqual(sends(r1).length, 1);
  assert.strictEqual(sends(r2).length, 1, "B oturumu A yüzünden susturulmamalı");
  assert.strictEqual(sends(r2)[0].session_id, "B");
});

test("heartbeat: config yoksa sessizce exit 0, ağ yok", () => {
  const r = runHook("heartbeat.js", { hook_event_name: "Stop" });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.events.length, 0);
});

test("heartbeat: enabled:false → hiçbir şey göndermez, exit 0", () => {
  const dir = tmpDir();
  writeConfig(dir, { enabled: false });
  const r = runHook("heartbeat.js", { hook_event_name: "Stop", transcript_path: writeTranscript(dir) }, { dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.events.length, 0);
});

test("heartbeat: bozuk stdin oturumu ÇÖKERTMEZ (exit 0)", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const harness = path.join(dir, "harness.js");
  fs.writeFileSync(harness, HARNESS);
  const r = spawnSync(process.execPath, [harness], {
    input: "bu json değil{{{", encoding: "utf8",
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: dir,
      UX_OUT: path.join(dir, "out.jsonl"), UX_HOOK: path.join(ROOT, "hooks", "heartbeat.js"),
    },
  });
  assert.strictEqual(r.status, 0, r.stderr);
});

test("heartbeat: plan_usage null + transcript yok → gönderim yok ama exit 0", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const r = runHook("heartbeat.js", { hook_event_name: "Stop" }, { dir, env: { UX_NO_USAGE: "1" } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(sends(r).length, 0);
});

test("heartbeat: transcript dosyası kayıpsa yüzde-yalnız yola düşer", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const r = runHook("heartbeat.js", {
    hook_event_name: "Stop", session_id: "s", transcript_path: path.join(dir, "yok.jsonl"),
  }, { dir });
  assert.strictEqual(r.status, 0);
  const p = sends(r);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, "snapshot");
});

// ── session-end.js ──────────────────────────────────────────────────────────

test("session-end: oturum payload'ı gönderir ve TAZE yüzde ister (force)", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);

  const r = runHook("session-end.js", {
    hook_event_name: "SessionEnd", session_id: "bitti", transcript_path: tp, cwd: "/tmp/proje-x",
  }, { dir });

  assert.strictEqual(r.status, 0, r.stderr);
  const p = sends(r);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, "session");
  assert.strictEqual(p[0].source, "session-end");
  assert.strictEqual(p[0].session_id, "bitti");
  assert.strictEqual(typeof p[0].machine, "string", "oturum payload'ında hostname VAR");
  assert.ok(r.events.some((e) => e.event === "plan_usage" && e.force), "kapanışta force:true olmalı");
});

test("session-end: throttle YOK — art arda iki kapanış da gönderir", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);
  const input = { hook_event_name: "SessionEnd", session_id: "s", transcript_path: tp };
  assert.strictEqual(sends(runHook("session-end.js", input, { dir })).length, 1);
  assert.strictEqual(sends(runHook("session-end.js", input, { dir })).length, 1);
});

test("session-end: boş transcript gönderim YAPMAZ, exit 0", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = path.join(dir, "bos.jsonl");
  fs.writeFileSync(tp, "");
  const r = runHook("session-end.js", { hook_event_name: "SessionEnd", transcript_path: tp }, { dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(sends(r).length, 0);
});

// transcript_path yoksa (ya da stdin bozuksa) oturum özeti üretilemez, ama
// elimizdeki TAZE limit yüzdesi yine de değerli: eskiden hepsi sessizce
// kayboluyordu (bulgu 15).
test("session-end: transcript_path yoksa en azından snapshot gönderir, exit 0", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const r = runHook("session-end.js", { hook_event_name: "SessionEnd" }, { dir });
  assert.strictEqual(r.status, 0);
  const p = sends(r);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, "snapshot");
});

test("session-end: limit verisi de yoksa hiçbir şey göndermez, exit 0", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const r = runHook("session-end.js", { hook_event_name: "SessionEnd" }, {
    dir, env: { UX_NO_USAGE: "1" },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(sends(r).length, 0);
});

test("session-end: BOZUK stdin oturumu çökertmez, snapshot yolu yine işler", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const harness = path.join(dir, "harness.js");
  fs.writeFileSync(harness, HARNESS);
  const out = path.join(dir, "out.jsonl");
  try { fs.unlinkSync(out); } catch {}
  const r = spawnSync(process.execPath, [harness], {
    input: "yarım json{{{", encoding: "utf8",
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: dir,
      UX_OUT: out, UX_HOOK: path.join(ROOT, "hooks", "session-end.js"),
    },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const events = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const p = events.filter((e) => e.event === "send").map((e) => e.payload);
  assert.strictEqual(p.length, 1, "bozuk stdin'de bile limit snapshot'ı gitmeli");
  assert.strictEqual(p[0].kind, "snapshot");
});

test("session-end: send_project_names=false iken proje adı HASH'lenir", () => {
  const dir = tmpDir();
  writeConfig(dir, { send_project_names: false });
  const tp = writeTranscript(dir);
  const r = runHook("session-end.js", {
    hook_event_name: "SessionEnd", session_id: "s", transcript_path: tp,
  }, { dir });
  const p = sends(r)[0];
  assert.match(p.project, /^p-[0-9a-f]{8}$/);
  assert.ok(!p.project.includes("proje-x"));
});

test("session-end: alt-ajan transkriptleri de sayılır", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir, "ana.jsonl");
  const sub = path.join(dir, "ana", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "alt.jsonl"), JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T13:00:00Z",
    message: { id: "alt-1", model: "claude-sonnet-5", usage: { input_tokens: 900, output_tokens: 0 } },
  }) + "\n");

  const r = runHook("session-end.js", {
    hook_event_name: "SessionEnd", session_id: "s", transcript_path: tp,
  }, { dir });

  const p = sends(r)[0];
  assert.strictEqual(p.models["claude-sonnet-5"].input_tokens, 1000, "100 (ana) + 900 (alt-ajan)");
});

// ── hook'lar OTURUMU KİRLETMEZ ──────────────────────────────────────────────
// Stop hook'unun stdout'u kullanıcının transkriptine karışır. Tek satır bile
// basmamalı; hata yolları stderr'a gider.

test("hook'lar stdout'a HİÇBİR ŞEY basmaz", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);
  const r1 = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "s", transcript_path: tp }, { dir });
  assert.strictEqual(r1.stdout, "", `heartbeat stdout: ${JSON.stringify(r1.stdout)}`);

  const dir2 = tmpDir();
  writeConfig(dir2);
  const r2 = runHook("session-end.js", {
    hook_event_name: "SessionEnd", session_id: "s", transcript_path: writeTranscript(dir2),
  }, { dir: dir2 });
  assert.strictEqual(r2.stdout, "", `session-end stdout: ${JSON.stringify(r2.stdout)}`);
});

test("config yokken de stdout temiz kalır", () => {
  const r = runHook("heartbeat.js", { hook_event_name: "Stop" });
  assert.strictEqual(r.stdout, "");
});

// ── peek/commit: boş transcript SLOTU YAKMAZ (bulgu 7) ─────────────────────

test("heartbeat: boş transcript oturum slotunu tüketmez", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const bos = path.join(dir, "bos.jsonl");
  fs.writeFileSync(bos, "");

  // 1. tur: oturum özeti yok → yalnız snapshot gider, oturum damgası BASILMAZ
  const r1 = runHook("heartbeat.js", { hook_event_name: "SessionStart", session_id: "s", transcript_path: bos }, { dir });
  assert.deepStrictEqual(sends(r1).map((p) => p.kind), ["snapshot"]);

  // 2. tur: transcript artık dolu — 5 dk beklemeden özet gitmeli
  fs.writeFileSync(bos, fs.readFileSync(writeTranscript(dir, "kaynak.jsonl"), "utf8"));
  const r2 = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "s", transcript_path: bos }, { dir });
  assert.deepStrictEqual(sends(r2).map((p) => p.kind), ["session"], "oturum slotu 1. turda yanmamalıydı");
});

test("heartbeat: küresel pencere kapalıyken oturum payload'ı plan_usage TAŞIMAZ", () => {
  const dir = tmpDir();
  writeConfig(dir);
  // 1. tur küresel pencereyi kapatır (snapshot + oturum birlikte gider)
  const t1 = writeTranscript(dir, "a.jsonl");
  const r1 = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "A", transcript_path: t1 }, { dir });
  assert.strictEqual(sends(r1)[0].plan_usage.session_pct, 42);

  // Paralel ikinci oturum: kendi özetini gönderir ama AYNI yüzdeyi ikinci kez
  // snapshot olarak yazdırmaz (3 paralel oturum = 3 aynı satır sorunu).
  const t2 = writeTranscript(dir, "b.jsonl");
  const r2 = runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "B", transcript_path: t2 }, { dir });
  const p = sends(r2);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].session_id, "B");
  assert.strictEqual(p[0].plan_usage, null, "küresel pencere kapalı → yüzde tekrar yazılmaz");
});

// ── mesaj sayımı ve gizlilik alanları payload'a yansır ─────────────────────

test("heartbeat: araç sonucu satırları message_count'a girmez, ayrı sayılır", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = path.join(dir, "araclı.jsonl");
  fs.writeFileSync(tp, [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp/proje-x", message: { content: "soru" } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T12:00:01Z", toolUseResult: {}, message: { content: [{ type: "tool_result" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T12:00:02Z", isMeta: true, message: { content: "not" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T12:00:03Z",
      message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 50 } } }),
  ].join("\n") + "\n");

  const p = sends(runHook("heartbeat.js", { hook_event_name: "Stop", session_id: "s", transcript_path: tp }, { dir }))[0];
  assert.strictEqual(p.message_count, 2, "1 istem + 1 cevap");
  assert.strictEqual(p.tool_result_count, 1);
});

test("session-end: send_project_names=false makine adını da hash'ler", () => {
  const dir = tmpDir();
  writeConfig(dir, { send_project_names: false });
  const r = runHook("session-end.js", {
    hook_event_name: "SessionEnd", session_id: "s", transcript_path: writeTranscript(dir),
  }, { dir });
  const p = sends(r)[0];
  assert.match(p.machine, /^pc-[0-9a-f]{6}$/);
  assert.ok(!p.machine.includes(os.hostname()));
});

test("session-end: Claude modeli olmayan oturum satırı GÖNDERİLMEZ", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = path.join(dir, "yerel.jsonl");
  fs.writeFileSync(tp, [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp/p", message: { content: "x" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T12:00:01Z",
      message: { id: "m1", model: "qwen2.5-coder:7b", usage: { input_tokens: 900 } } }),
  ].join("\n") + "\n");

  const p = sends(runHook("session-end.js", { hook_event_name: "SessionEnd", session_id: "s", transcript_path: tp }, { dir }));
  assert.deepStrictEqual(p.map((x) => x.kind), ["snapshot"], "oturum satırı değil, yalnız limit snapshot'ı");
});

test("cwd hiç yoksa project BOŞ gider ('unknown' sunucudaki adı ezmesin)", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = path.join(dir, "cwdsuz.jsonl");
  fs.writeFileSync(tp, JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T12:00:00Z",
    message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 10 } },
  }) + "\n");

  const p = sends(runHook("session-end.js", { hook_event_name: "SessionEnd", session_id: "s", transcript_path: tp }, { dir }))[0];
  assert.strictEqual(p.project, "");
});

// ── R23: damga yalnız TESLİM edilen payload için ────────────────────────────
// sendPayload kalıcı düşürmede (400/413/415 → "dropped") ya da yetki hatasında
// da false döndürüyordu ve heartbeat yine de markSessionSent basıyordu: oturum
// 5 dakika boyunca hiç raporlanmıyor, veri sessizce kayboluyordu.

test("heartbeat: dropped sonucunda oturum damgası BASILMAZ (hemen tekrar denenir)", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);
  const girdi = { hook_event_name: "Stop", session_id: "s", transcript_path: tp };

  const r1 = runHook("heartbeat.js", girdi, { dir, env: { UX_SEND_STATUS: "dropped" } });
  assert.deepStrictEqual(sends(r1).map((p) => p.kind), ["session"]);

  // 5 dk beklemeden ikinci tur: damga basılmadığı için oturum yine gitmeli
  const r2 = runHook("heartbeat.js", girdi, { dir, env: { UX_SEND_STATUS: "dropped" } });
  assert.deepStrictEqual(sends(r2).map((p) => p.kind), ["session"], "düşürülen oturum slotu yakmamalı");
  // küresel snapshot penceresi de yanmamalı: plan_usage hâlâ taşınıyor
  assert.strictEqual(sends(r2)[0].plan_usage.session_pct, 42);
});

test("heartbeat: queued teslim SAYILIR (çevrimdışı makinede kuyruk şişmesin)", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const tp = writeTranscript(dir);
  const girdi = { hook_event_name: "Stop", session_id: "s", transcript_path: tp };

  const r1 = runHook("heartbeat.js", girdi, { dir, env: { UX_SEND_STATUS: "queued" } });
  assert.deepStrictEqual(sends(r1).map((p) => p.kind), ["session"]);
  const r2 = runHook("heartbeat.js", girdi, { dir, env: { UX_SEND_STATUS: "queued" } });
  assert.deepStrictEqual(sends(r2), [], "kuyruğa yazılan payload damgalanmalı");
});

test("heartbeat: transcript yokken dropped snapshot küresel pencereyi yakmaz", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const girdi = { hook_event_name: "Stop" };

  const r1 = runHook("heartbeat.js", girdi, { dir, env: { UX_SEND_STATUS: "dropped" } });
  assert.deepStrictEqual(sends(r1).map((p) => p.kind), ["snapshot"]);
  const r2 = runHook("heartbeat.js", girdi, { dir, env: { UX_SEND_STATUS: "dropped" } });
  assert.deepStrictEqual(sends(r2).map((p) => p.kind), ["snapshot"], "düşürülen snapshot slotu yakmamalı");
});
