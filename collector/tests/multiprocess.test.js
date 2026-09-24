const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dropSuperseded, drainQueue } = require('../lib/sender');
const { readState } = require('../lib/state');
const { acquire } = require('../lib/file-lock');
const { summarizeTranscript } = require('../lib/transcript');

function worker(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, ...args], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', b => { error += b; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${code}: ${error}`)));
  });
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usagex-races-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('parallel appends and compaction preserve every distinct queued session', async t => {
  const dir = temp(t), queuePath = path.join(dir, 'usagex-queue.jsonl');
  const source = `const {sendPayload}=require('./lib/sender');(async()=>{for(let i=0;i<30;i++)await sendPayload({kind:'session',session_id:process.argv[2]+'-'+i},{ingest_url:'https://example.test/ingest',device_token:'test'},{queuePath:process.argv[1],fetchImpl:async()=>({ok:false,status:503,headers:{get:()=>null}})});})().catch(e=>{console.error(e);process.exit(1)});`;
  await Promise.all(Array.from({ length: 4 }, (_, i) => worker(source, [queuePath, String(i)])));
  const delivered = [];
  await drainQueue({ ingest_url: 'https://example.test/ingest', device_token: 'test' }, { queuePath, fetchImpl: async (_url, options) => { delivered.push(JSON.parse(options.body)); return { ok: true, status: 200 }; }, wait: async () => {} });
  assert.equal(new Set(delivered.map(p => p.session_id)).size, 120);
});

test('parallel state commits preserve every session throttle stamp', async t => {
  const dir = temp(t);
  await Promise.all(Array.from({ length: 4 }, (_, n) => worker(`const {markSessionSent}=require('./lib/state');for(let i=0;i<40;i++)markSessionSent(process.argv[2]+'-'+i,{dir:process.argv[1]});`, [dir, String(n)])));
  assert.equal(Object.keys(readState(dir).sessions).length, 160);
});

test('live locks are never stolen because a file has an old mtime', t => {
  const dir = temp(t), lock = path.join(dir, 'lock');
  const release = acquire(lock); assert.ok(release);
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(acquire(lock), null); release(); assert.ok(acquire(lock));
});

test('newer session summaries win even when an older retry is appended later', () => {
  const old = { kind: 'session', session_id: 'same', queued_at: '2026-09-08T10:00:00Z', message_count: 3 };
  const fresh = { ...old, queued_at: '2026-09-08T10:05:00Z', message_count: 9 };
  assert.deepEqual(dropSuperseded([JSON.stringify(fresh), JSON.stringify(old)]).map(JSON.parse), [fresh]);
});

test('duplicate assistant IDs in different sessions are counted by only one process', async t => {
  const dir = temp(t);
  const msg = JSON.stringify({ type: 'assistant', timestamp: '2026-09-08T10:00:00Z', message: { id: 'shared-id', model: 'claude-sonnet-5', usage: { input_tokens: 17, output_tokens: 3 } } });
  const files = ['first', 'fork'].map(n => path.join(dir, n + '.jsonl')); files.forEach(file => fs.writeFileSync(file, msg));
  await Promise.all(files.map(file => worker(`const fs=require('node:fs');require('./lib/transcript').summarizeTranscript(process.argv[1],{ownershipDir:process.argv[2],cacheDir:null}).then(s=>fs.writeFileSync(process.argv[1]+'.result',JSON.stringify(s))).catch(e=>{console.error(e);process.exit(1)});`, [file, dir])));
  const read = () => files.map(file => JSON.parse(fs.readFileSync(file + '.result')));
  assert.equal(read().reduce((n, s) => n + (s.models['claude-sonnet-5']?.input_tokens || 0), 0), 17);
  for (const file of files) {
    const again = await summarizeTranscript(file, { ownershipDir: dir, cacheDir: null });
    assert.deepEqual(again.models, JSON.parse(fs.readFileSync(file + '.result')).models);
  }
});

test('collector package and marketplace manifest versions stay aligned', () => {
  assert.equal(require('../package.json').version, require('../.claude-plugin/plugin.json').version);
});


test('re-pairing archives legacy records and excludes the old account even when a late hook appends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usagex-repair-'));
  try {
    const queuePath = path.join(dir, 'usagex-queue.jsonl');
    const { saveConnection } = require('../scripts/connect');
    const { sendPayload, flushQueue } = require('../lib/sender');
    const old = { ingest_url: 'https://old.example/ingest', device_token: 'old-test' };
    const next = { ingest_url: 'https://new.example/ingest', device_token: 'new-test' };
    fs.writeFileSync(queuePath, JSON.stringify({ kind: 'session', session_id: 'legacy' }) + '\n');
    saveConnection(dir, next);
    assert.ok(fs.readdirSync(dir).some(n => n.includes('.quarantine-')));
    const fail = async () => ({ ok: false, status: 503 });
    await sendPayload({ kind: 'session', session_id: 'old-account' }, old, { queuePath, fetchImpl: fail });
    const sent = [];
    await sendPayload({ kind: 'session', session_id: 'new-account' }, next, { queuePath, fetchImpl: async (_, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; } });
    assert.deepEqual(sent.map(x => x.session_id), ['new-account']);
    assert.ok(!JSON.stringify(sent).includes('_usagex_queue_owner'));
    assert.match(fs.readFileSync(queuePath + '.quarantine', 'utf8'), /old-account/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('duplicate-only historical sessions emit zero day corrections instead of retaining old server totals', async t => {
  const dir = temp(t), a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl');
  const event = JSON.stringify({ type: 'assistant', timestamp: '2026-09-08T10:00:00Z', message: { id: 'shared-historical-id', model: 'claude-sonnet-5', usage: { input_tokens: 20, output_tokens: 10 } } }) + '\n';
  fs.writeFileSync(a, event); fs.writeFileSync(b, event);
  await summarizeTranscript(a, { cacheDir: null, ownershipDir: dir });
  const summary = await summarizeTranscript(b, { cacheDir: null, ownershipDir: dir });
  const { sessionPayload } = require('../lib/payload');
  const payload = sessionPayload({ session_id: 'b', summary, config: { send_project_names: false } });
  assert.ok(payload); assert.equal(payload.est_cost_usd, 0); assert.deepEqual(payload.models, {});
  assert.equal(payload.days.length, 1); assert.equal(payload.days[0].day, '2026-09-08'); assert.equal(payload.days[0].est_cost_usd, 0);
});

test('an old request cannot disable a newly paired config', t => {
  const dir = temp(t);
  const { saveConnection } = require('../scripts/connect');
  const { markAuthFailed, loadConfig } = require('../lib/config');
  saveConnection(dir, { enabled: true, ingest_url: 'https://example.test/ingest', device_token: 'new-token' });
  assert.equal(markAuthFailed(dir, Date.now(), 'old-token'), false);
  assert.equal(loadConfig(dir).device_token, 'new-token');
});
