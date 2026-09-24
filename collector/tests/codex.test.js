const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRollout, sessionPayload } = require('../codex/rollout');
const { collect } = require('../codex/collect');
const now = Date.parse('2026-09-09T12:00:00Z');
const at = n => new Date(now - 60000 + n * 1000).toISOString();
const meta = (id = 'test-session') => ({ type: 'session_meta', payload: { id, cwd: '/private/customer-secret', model_provider: 'openai' } });
const context = model => ({ type: 'turn_context', payload: { model } });
const event = (n, input, output, cached = 0, extra = {}) => ({ type: 'event_msg', timestamp: at(n), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached }, last_token_usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 10 } }, ...extra } });
function fixture(t, rows, suffix = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usagex-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions);
  const file = path.join(sessions, 'rollout-2026-test.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + suffix);
  return { home, file, dir: path.join(home, 'usagex') };
}

function connected(f) {
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'usagex.json'), JSON.stringify({ provider: 'codex', consent_version: 1, device_token: 'test-token', ingest_url: 'http://127.0.0.1:12345/ingest', send_project_names: false }));
}
// Records where every rollout read starts, so an incremental scan can be told
// apart from a full re-read without reaching into collector internals.
function streamStarts(t) {
  const opened = [], real = fs.createReadStream;
  fs.createReadStream = (file, options) => { opened.push({ file, start: options?.start ?? 0 }); return real(file, options); };
  t.after(() => { fs.createReadStream = real; });
  return opened;
}
const append = (file, rows) => fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

test('Codex counts cumulative deltas, caches once, and keeps model/day breakdown', async t => {
  const { file } = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60), event(2, 100, 30, 60), event(3, 150, 40, 90), context('gpt-5.6-luna'), event(4, 170, 45, 100)]);
  const s = await readRollout(file, { now });
  assert.equal(s.message_count, 3);
  assert.deepEqual(s.models['gpt-5.6-sol'], { input_tokens: 60, output_tokens: 40, cache_read_tokens: 90, cache_creation_tokens: 0 });
  assert.deepEqual(s.models['gpt-5.6-luna'], { input_tokens: 10, output_tokens: 5, cache_read_tokens: 10, cache_creation_tokens: 0 });
  const payload = sessionPayload(s, { send_project_names: false }, now);
  assert.equal(payload.provider, 'codex'); assert.equal(payload.est_cost_usd, null);
  assert.match(payload.project, /^p-/); assert.ok(!JSON.stringify(payload).includes('customer-secret'));
  assert.equal(payload.days.reduce((n, d) => n + d.message_count, 0), 3);
});

test('Codex quota-only events retain original time and reported 30-day duration', async t => {
  const rate = { primary: { used_percent: 0, window_minutes: 43200, resets_at: now / 1000 + 3600 }, secondary: null, plan_type: 'go', credits: { has_credits: true, balance: '2.5', unlimited: false, secret: 'never-upload' } };
  const { file } = fixture(t, [meta(), event(1, 100, 30, 60), { type: 'event_msg', timestamp: at(2), payload: { type: 'token_count', info: null, rate_limits: rate } }]);
  const s = await readRollout(file, { now });
  assert.equal(s.plan_usage.session_window_seconds, 2592000);
  assert.equal(s.plan_usage.week_pct, null); assert.equal(s.plan_usage.session_pct, 0);
  assert.equal(s.plan_usage.measured_at, at(2)); assert.equal(s.message_count, 1);
  assert.ok(!JSON.stringify(s.plan_usage).includes('secret'));
});

test('rollout reader ignores prompts, oversized lines, incomplete writes and non-OpenAI sessions', async t => {
  const { file } = fixture(t, [meta(), { type: 'response_item', payload: { content: 'private-prompt'.repeat(50000) } }, context('gpt-5.6-sol'), event(1, 20, 5)], JSON.stringify(event(2, 40, 10)).slice(0, -10));
  const s = await readRollout(file, { now });
  assert.equal(s.message_count, 1); assert.ok(!JSON.stringify(s).includes('private-prompt'));
  fs.writeFileSync(file, [ { ...meta(), payload: { ...meta().payload, model_provider: 'custom' } }, event(1, 20, 5) ].map(JSON.stringify).join('\n') + '\n');
  assert.equal((await readRollout(file, { now })).message_count, 0);
});

test('counter reset uses last usage and replayed events do not multiply usage', async t => {
  const rows = [meta(), context('gpt-5.6-sol'), event(1, 100, 20, 60), event(2, 20, 5, 10), event(2, 20, 5, 10), event(3, 40, 10, 20)];
  const { file } = fixture(t, rows);
  const s = await readRollout(file, { now });
  assert.equal(s.models['gpt-5.6-sol'].input_tokens, 60);
  assert.equal(s.models['gpt-5.6-sol'].output_tokens, 30);
  assert.equal(s.message_count, 3);
});

test('collector is opt-in, reuses queued delivery and retries failed reads without exposing transcripts', async t => {
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 20, 5)]);
  const sent = [];
  const options = { ...f, now, send: async p => { sent.push(p); return { status: 'queued' }; }, flush: async () => ({}) };
  assert.equal((await collect(options)).status, 'disconnected'); assert.equal(sent.length, 0);
  fs.mkdirSync(f.dir);
  fs.writeFileSync(path.join(f.dir, 'usagex.json'), JSON.stringify({ provider: 'codex', consent_version: 1, enabled: true, device_token: 'test-token', ingest_url: 'http://127.0.0.1:12345/ingest', send_project_names: false }));
  assert.equal((await collect(options)).queued, 1);
  assert.equal((await collect(options)).queued, 0); assert.equal(sent.length, 1);
  fs.appendFileSync(f.file, JSON.stringify(event(2, 40, 10)) + '\n');
  assert.equal((await collect(options)).queued, 1); assert.equal(sent[1].message_count, 2);
  assert.ok(!fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8').includes('test-token'));
});

test('copied token events across fork files belong to one session', async t => {
  const f = fixture(t, [meta('parent'), context('gpt-5.6-sol'), event(1, 20, 5)]);
  fs.writeFileSync(path.join(f.home, 'sessions', 'rollout-2027-fork.jsonl'), [meta('child'), context('gpt-5.6-sol'), event(1, 20, 5), event(2, 40, 10)].map(JSON.stringify).join('\n') + '\n');
  fs.mkdirSync(f.dir);
  fs.writeFileSync(path.join(f.dir, 'usagex.json'), JSON.stringify({ provider: 'codex', consent_version: 1, device_token: 'test-token', ingest_url: 'http://127.0.0.1:12345/ingest' }));
  const sent = [];
  await collect({ ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } });
  assert.equal(sent.reduce((n, p) => n + p.models['gpt-5.6-sol'].input_tokens, 0), 40);
  assert.equal(sent.reduce((n, p) => n + p.message_count, 0), 2);
});

test('copies and resumed segments of one session produce one absolute summary', async t => {
  const f = fixture(t, [meta(), context('gpt-5.4'), event(1, 100, 20, 50)]);
  const next = path.join(f.home, 'sessions', 'rollout-resume.jsonl');
  fs.writeFileSync(next, [meta(), context('gpt-5.4'), event(1, 100, 20, 50), event(2, 150, 30, 70)].map(JSON.stringify).join('\n') + '\n');
  const s = await readRollout([next, f.file], { now });
  assert.equal(s.message_count, 2);
  assert.equal(s.models['gpt-5.4'].input_tokens, 80);
  assert.equal(s.models['gpt-5.4'].cache_read_tokens, 70);
});

test('named Codex limits keep their duration without replacing the account quota', async t => {
  const rate = { primary: { used_percent: 40, window_minutes: 300, resets_at: now / 1000 + 3600 } };
  const { file } = fixture(t, [meta(), event(1, 20, 5, 10, { rate_limits: rate }), event(2, 20, 5, 10, { rate_limits: { ...rate, limit_id: 'review', primary: { ...rate.primary, used_percent: 70 } } })]);
  const s = await readRollout(file, { now });
  assert.equal(s.plan_usage.session_pct, 40); assert.equal(s.plan_usage.scoped[0].percent, 70);
  assert.equal(s.plan_usage.scoped[0].window_seconds, 18000);
});

test('malformed model keys cannot mutate collector prototypes', async t => {
  const { file } = fixture(t, [meta(), context('__proto__'), event(1, 20, 5)]);
  const s = await readRollout(file, { now });
  assert.equal(s.models['codex-unknown'].input_tokens, 20);
  assert.equal(Object.getPrototypeOf(s.models), null);
});

test('Codex pairing refuses a Claude credential and cross-origin ingest redirect', async t => {
  const { connect } = require('../codex/connect'); const { dir } = fixture(t, []);
  for (const data of [{ provider: 'claude', device_token: 'secret' }, { provider: 'codex', device_token: 'secret', ingest_url: 'https://other.test/ingest' }]) {
    await assert.rejects(connect('ABCD2345', { dir, serverUrl: 'https://example.test', fetchImpl: async () => ({ ok: true, json: async () => data }) }));
  }
  assert.equal(fs.existsSync(path.join(dir, 'usagex.json')), false);
});

test('Codex mac service uses absolute paths and preserves existing Codex settings', t => {
  const { definition, install, uninstall } = require('../codex/service'); const { home } = fixture(t, []);
  const cfg = path.join(home, 'config.toml'); fs.writeFileSync(cfg, 'notify = ["existing-command"]\n');
  const options = { platform: 'darwin', home, codexHome: home, node: '/node path/bin/node', script: '/app path/collect.js', uid: 501, run: () => ({ status: 0 }) };
  install(options); const def = definition(options);
  assert.ok(fs.existsSync(def.file)); assert.match(def.text, /node path/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), 'notify = ["existing-command"]\n');
  uninstall(options); assert.equal(fs.existsSync(def.file), false);
});

test('history cutoff excludes old tokens while preserving the cumulative baseline', async t => {
  const { file } = fixture(t, [meta(), context('gpt-5.4'), event(1, 100, 20, 50), event(2, 150, 30, 70)]);
  const s = await readRollout(file, { now, since: Date.parse(at(2)) });
  assert.equal(s.message_count, 1);
  assert.equal(s.models['gpt-5.4'].input_tokens, 30);
  assert.equal(s.models['gpt-5.4'].cache_read_tokens, 20);
});

test('appended Codex rollouts resume and match a single full read', async t => {
  const quota = { primary: { used_percent: 12, window_minutes: 300, resets_at: now / 1000 + 3600 } };
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60)]);
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  append(f.file, [context('gpt-5.6-luna'), event(2, 150, 40, 90, { rate_limits: quota })]);
  await collect(options);
  append(f.file, [event(3, 170, 45, 100, { rate_limits: { ...quota, limit_id: 'review' } })]);
  await collect(options);
  assert.equal(sent.length, 3);
  const full = sessionPayload(await readRollout(f.file, { now }), { send_project_names: false }, now);
  // The payload sent after three incremental scans is the one a full read makes.
  assert.equal(JSON.stringify(sent[2]), JSON.stringify(full));
  assert.deepEqual(sent[2].models, full.models);
  assert.equal(sent[2].message_count, 3);
  assert.equal(sent[2].plan_usage.session_pct, 12);
  assert.equal(sent[2].plan_usage.scoped[0].id, 'review:0');
});

test('a rescan reads only the appended bytes and never reopens untouched sessions', async t => {
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60)]);
  const other = path.join(f.home, 'sessions', 'rollout-2026-other.jsonl');
  fs.writeFileSync(other, [meta('other-session'), context('gpt-5.6-sol'), event(1, 20, 5)].map(r => JSON.stringify(r)).join('\n') + '\n');
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  const size = fs.statSync(f.file).size;
  const opened = streamStarts(t);
  append(f.file, [event(2, 150, 40, 90)]);
  await collect(options);
  assert.deepEqual(opened, [{ file: f.file, start: size }]);
  assert.equal(sent[2].message_count, 2);
});

test('a half-written Codex line moves no offset and counts once it is complete', async t => {
  const tail = JSON.stringify(event(2, 150, 40, 90));
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60)], tail.slice(0, -12));
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  assert.equal(sent[0].message_count, 1);
  const whole = fs.statSync(f.file).size - Buffer.byteLength(tail.slice(0, -12), 'utf8');
  const opened = streamStarts(t);
  fs.appendFileSync(f.file, tail.slice(-12) + '\n');
  await collect(options);
  assert.deepEqual(opened.map(o => o.start), [whole]);
  assert.equal(sent[1].message_count, 2);
});

test('Codex offsets stay byte exact across multi-byte and oversized lines', async t => {
  const wide = { type: 'response_item', payload: { content: 'ölçüm-değeri-🚀'.repeat(20) } };
  const huge = { type: 'response_item', payload: { content: 'ş'.repeat(300000) } };
  const f = fixture(t, [meta(), wide, context('gpt-5.6-sol'), event(1, 100, 30, 60)]);
  connected(f);
  const first = fs.statSync(f.file).size;
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  const opened = streamStarts(t);
  append(f.file, [huge, wide, event(2, 150, 40, 90)]);
  const second = fs.statSync(f.file).size;
  await collect(options);
  append(f.file, [event(3, 170, 45, 100)]);
  await collect(options);
  assert.deepEqual(opened.map(o => o.start), [first, second]);
  assert.deepEqual(sent[2].models, (await readRollout(f.file, { now })).models);
  assert.equal(sent[2].message_count, 3);
});

test('a second file in a session group forces a full read with the same totals', async t => {
  const f = fixture(t, [meta(), context('gpt-5.4'), event(1, 100, 20, 50)]);
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  const resumed = path.join(f.home, 'sessions', 'rollout-2026-a-resume.jsonl');
  fs.writeFileSync(resumed, [meta(), context('gpt-5.4'), event(1, 100, 20, 50), event(2, 150, 30, 70)].map(r => JSON.stringify(r)).join('\n') + '\n');
  const opened = streamStarts(t);
  await collect(options);
  assert.deepEqual(opened.filter(o => o.start !== 0), []);
  const merged = await readRollout([resumed, f.file], { now });
  assert.equal(sent[1].message_count, merged.message_count);
  assert.deepEqual(sent[1].models, merged.models);
});

test('a rewritten shorter rollout is read from the start again', async t => {
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60), event(2, 150, 40, 90)]);
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  assert.equal(sent[0].message_count, 2);
  fs.writeFileSync(f.file, [meta(), context('gpt-5.6-sol'), event(3, 20, 5, 10)].map(r => JSON.stringify(r)).join('\n') + '\n');
  const opened = streamStarts(t);
  await collect(options);
  assert.deepEqual(opened.map(o => o.start), [0, 0]);
  assert.equal(sent[1].message_count, 1);
});

test('a version 1 Codex state is carried over instead of resending every session', async t => {
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60)]);
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8'));
  const files = Object.fromEntries(Object.entries(state.files).map(([key, entry]) => [key, entry.signature]));
  fs.writeFileSync(path.join(f.dir, 'state.json'), JSON.stringify({ version: 1, owner: state.owner, files }));
  const opened = streamStarts(t);
  await collect(options);
  assert.equal(sent.length, 1);
  assert.deepEqual(opened.map(o => o.start), [0]);
});

test('an idle rollout drops its resume cursor and is read in full if it grows again', async t => {
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60)]);
  const idle = new Date(now - 30 * 86400e3);
  fs.utimesSync(f.file, idle, idle);
  connected(f);
  const sent = [];
  const options = { ...f, now, flush: async () => ({}), send: async p => { sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  await collect(options);
  const tracked = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json'), 'utf8')).files;
  assert.deepEqual(Object.values(tracked).map(e => e.cursor), [undefined]);
  const opened = streamStarts(t);
  append(f.file, [event(2, 150, 40, 90)]);
  await collect(options);
  assert.deepEqual(opened.map(o => o.start), [0]);
  assert.equal(sent[1].message_count, 2);
});

test('a failed send leaves the resume cursor untouched and never double counts', async t => {
  const f = fixture(t, [meta(), context('gpt-5.6-sol'), event(1, 100, 30, 60)]);
  connected(f);
  const sent = [];
  let fail = false;
  const options = { ...f, now, flush: async () => ({}), send: async p => { if (fail) return { status: 'failed' }; sent.push(p); return { status: 'sent' }; } };
  await collect(options);
  append(f.file, [event(2, 150, 40, 90)]);
  fail = true; await collect(options);
  fail = false; await collect(options);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].message_count, 2);
  assert.deepEqual(sent[1].models['gpt-5.6-sol'], { input_tokens: 60, output_tokens: 40, cache_read_tokens: 90, cache_creation_tokens: 0 });
});
