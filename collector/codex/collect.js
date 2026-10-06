#!/usr/bin/env node
// Windows Görev Zamanlayıcı ortamı --env=AD=değer ile verir (lib/task-env.js).
require('../lib/task-env').applyEnvArgs();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { codexDir, dataDir, loadConfig } = require('./config');
const { readRollout, sessionPayload, rolloutIdentity } = require('./rollout');
const { messageOwner } = require('../lib/message-owners');
const { acquire } = require('../lib/file-lock');
const { sendPayload, flushQueue } = require('../lib/sender');

// A rollout that has been idle for a week will not be appended to again; its
// resume cursor is dropped so state.json stays proportional to live sessions.
const RESUME_IDLE_MS = 7 * 86400e3;

function rolloutFiles(root, since) {
  const out = [];
  const visit = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) && fs.statSync(file).mtimeMs >= since) out.push(file);
    }
  };
  visit(root);
  return out.sort();
}
function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s?.version === 2) return s;
    // Version 1 held a bare signature string per session. Keep those so an
    // upgrade does not re-read and re-send every session, only cursors are new.
    if (s?.version === 1 && s.files && typeof s.files === 'object') {
      const files = Object.entries(s.files).filter(([, sig]) => typeof sig === 'string').map(([key, sig]) => [key, { signature: sig }]);
      return { version: 2, owner: s.owner, files: Object.fromEntries(files), identity: {} };
    }
    return { version: 2, files: {}, identity: {} };
  } catch (e) { if (e.code !== 'ENOENT') throw e; return { version: 2, files: {}, identity: {} }; }
}
function saveState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file);
}

async function collect({ home = codexDir(), dir = dataDir(), now = Date.now(), send = sendPayload, flush = flushQueue } = {}) {
  const config = loadConfig(dir);
  if (!config) return { status: 'disconnected', sent: 0 };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquire(path.join(dir, 'collect.lock'));
  if (!release) return { status: 'busy', sent: 0 };
  try {
    const stateFile = path.join(dir, 'state.json');
    const owner = crypto.createHash('sha256').update(config.device_token).digest('hex');
    const state = readState(stateFile);
    if (state.owner !== owner) { state.owner = owner; state.files = {}; state.identity = {}; }
    const queuePath = path.join(dir, 'usagex-queue.jsonl');
    const queue = await flush(config, { queuePath });
    if (queue?.authFailed) return { status: 'auth_failed', sent: 0 };
    const claims = new Map();
    const claimEvent = (session, event) => {
      if (!claims.has(session)) claims.set(session, messageOwner(dir, session));
      return claims.get(session)(event);
    };
    let sent = 0, pending = 0;
    const since = now - Math.min(90, Math.max(1, Number(config.history_days) || 90)) * 86400e3;
    const files = rolloutFiles(path.join(home, 'sessions'), since);
    const live = new Set();
    const groups = new Map(), stats = new Map();
    const known = Object.assign(Object.create(null), state.identity);
    const identity = Object.create(null);
    for (const file of files) {
      const stat = fs.statSync(file); stats.set(file, stat);
      // A rollout only grows, so its session id is re-read when the path is new
      // or the file shrank (replaced) — not on every scan of every session.
      const cached = known[file];
      const id = cached && typeof cached.id === 'string' && stat.size >= cached.size ? cached.id : await rolloutIdentity(file);
      identity[file] = { id: typeof id === 'string' ? id : null, size: stat.size };
      const group = id || file;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(file);
    }
    state.identity = identity;
    for (const [id, sources] of groups) {
      const key = crypto.createHash('sha256').update(id).digest('hex'); live.add(key);
      const signature = sources.map(file => { const stat = stats.get(file); return `${stat.size}:${stat.mtimeMs}`; }).join('|');
      const entry = state.files[key];
      const idle = Math.max(...sources.map(file => stats.get(file).mtimeMs)) < now - RESUME_IDLE_MS;
      if (entry?.signature === signature) { if (idle && entry.cursor) delete entry.cursor; continue; }
      // Only an appended lone file resumes; merged copies (fork/resume segments
      // are combined in timestamp order), a shrunk file or a moved path re-read.
      const resume = sources.length === 1 && entry?.path === sources[0] && entry.cursor && stats.get(sources[0]).size >= entry.cursor.offset ? entry.cursor : null;
      const summary = await readRollout(sources, { claimEvent, now, since, resume });
      const next = { signature, path: sources.length === 1 ? sources[0] : null, cursor: summary.cursor || null };
      const payload = sessionPayload(summary, config, now) || (summary.plan_usage && {
        schema_version: 1, provider: 'codex', kind: 'snapshot', source: 'codex-rollout', generated_at: new Date(now).toISOString(), plan_usage: summary.plan_usage,
      });
      if (!payload) { state.files[key] = next; continue; }
      const result = await send(payload, config, { queuePath });
      if (result?.status === 'auth_failed') { saveState(stateFile, state); return { status: 'auth_failed', sent }; }
      if (result?.status === 'sent' || result?.status === 'queued') {
        state.files[key] = next;
        if (result.status === 'sent') sent++; else pending++;
        saveState(stateFile, state);
      }
    }
    state.files = Object.fromEntries(Object.entries(state.files).filter(([key]) => live.has(key)));
    saveState(stateFile, state);
    return { status: 'ok', sent, queued: pending, files: files.length };
  } finally { release(); }
}

async function main() {
  // notify's final argument can contain prompts. It is deliberately never parsed,
  // logged, persisted or forwarded. Both notify and polling read counters only.
  const watch = process.argv.includes('--watch');
  do {
    try { const result = await collect(); if (watch || process.argv.includes('--once')) console.log(JSON.stringify(result)); }
    catch { if (watch || process.argv.includes('--once')) console.error('Codex usage scan failed; local files retained.'); }
    if (watch) await new Promise(resolve => setTimeout(resolve, 60000));
  } while (watch);
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { collect, rolloutFiles };
