const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { machineLabel, projectLabel } = require('../lib/payload');

const number = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });

// Discard long content lines without retaining their bodies. A partially written
// final JSON line is retried on the next scan; it never becomes a partial count.
// `cursor.offset` follows the byte after the last complete line — skipped lines
// included — so the next scan can resume exactly where this one stopped.
async function* boundedLines(file, cursor = { offset: 0 }) {
  let pending = '', skipping = false, bytes = 0;
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024, start: cursor.offset })) {
    for (const [i, part] of chunk.split('\n').entries()) {
      if (i > 0) {
        const line = skipping ? '' : pending;
        cursor.offset += bytes + 1;
        pending = ''; skipping = false; bytes = 0;
        if (line) yield line;
      }
      bytes += Buffer.byteLength(part, 'utf8');
      if (!skipping) {
        pending += part;
        if (pending.length > 256 * 1024) { pending = ''; skipping = true; }
      }
    }
  }
}

function rateLimits(rate, measuredAt) {
  if (!rate || !measuredAt) return null;
  const window = w => {
    if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
    const seconds = Number.isFinite(w.window_minutes) && w.window_minutes > 0 && w.window_minutes <= 366 * 1440 ? w.window_minutes * 60 : null;
    const reset = Number.isFinite(w.resets_at) && w.resets_at >= 1577836800 && w.resets_at <= Date.parse(measuredAt) / 1000 + 366 * 86400 ? new Date(w.resets_at * 1000).toISOString() : null;
    return { pct: Math.floor(Math.max(0, Math.min(100, w.used_percent))), seconds, reset };
  };
  const primary = window(rate.primary), secondary = window(rate.secondary);
  if (!primary && !secondary) return null;
  const balance = rate.credits?.balance;
  return {
    measured_at: measuredAt,
    session_pct: primary?.pct ?? null, week_pct: secondary?.pct ?? null,
    session_resets_at: primary?.reset ?? null, week_resets_at: secondary?.reset ?? null,
    session_window_seconds: primary?.seconds ?? null, week_window_seconds: secondary?.seconds ?? null,
    plan_type: typeof rate.plan_type === 'string' ? rate.plan_type.slice(0, 40) : null,
    credits: rate.credits && {
      has_credits: rate.credits.has_credits === true, unlimited: rate.credits.unlimited === true,
      balance: (typeof balance === 'number' || typeof balance === 'string') && Number.isFinite(Number(balance)) && Number(balance) >= 0 ? String(balance).slice(0, 40) : null,
    },
    rate_limit_reached_type: typeof rate.rate_limit_reached_type === 'string' ? rate.rate_limit_reached_type.slice(0, 80) : null,
  };
}

function tokenTotals(usage) {
  if (!usage || typeof usage !== 'object' || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
  return { input: number(usage.input_tokens), output: number(usage.output_tokens), cached: number(usage.cached_input_tokens) };
}
const sumUsage = (target, usage) => { for (const key of Object.keys(target)) target[key] += usage[key]; };
const usageMap = source => {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(source && typeof source === 'object' ? source : {})) {
    const usage = emptyUsage();
    for (const field of Object.keys(usage)) usage[field] = number(value?.[field]);
    out[key] = usage;
  }
  return out;
};

// Resume state comes back from state.json. Rebuild it into fresh prototype-free
// objects: a summary that is never sent must not leave a moved cursor on disk,
// and anything unexpected drops the resume so the file is read in full again.
function restoreCursor(cursor) {
  if (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return null;
  const days = Object.create(null);
  for (const [key, value] of Object.entries(cursor.days && typeof cursor.days === 'object' ? cursor.days : {})) {
    const startedAt = iso(value?.started_at), endedAt = iso(value?.ended_at);
    if (typeof value?.day !== 'string' || !startedAt || !endedAt) return null;
    days[key] = {
      day: value.day, tz_offset_minutes: Number.isSafeInteger(value.tz_offset_minutes) ? value.tz_offset_minutes : 0,
      models: usageMap(value.models), message_count: number(value.message_count), started_at: startedAt, ended_at: endedAt, est_cost_usd: null,
    };
  }
  const plan = cursor.plan && typeof cursor.plan === 'object' ? { ...cursor.plan } : null;
  if (plan) delete plan.scoped;
  const totals = v => v && typeof v === 'object' ? { input: number(v.input), output: number(v.output), cached: number(v.cached) } : null;
  return {
    offset: cursor.offset, seenEvents: number(cursor.seenEvents), forked: cursor.forked === true, days, plan,
    sessionId: typeof cursor.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(cursor.sessionId) ? cursor.sessionId : null,
    project: typeof cursor.project === 'string' ? cursor.project : '',
    provider: typeof cursor.provider === 'string' ? cursor.provider : 'openai',
    model: typeof cursor.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(cursor.model) ? cursor.model : 'codex-unknown',
    previous: totals(cursor.previous), models: usageMap(cursor.models), message_count: number(cursor.message_count),
    started_at: iso(cursor.started_at), ended_at: iso(cursor.ended_at),
    scoped: (Array.isArray(cursor.scoped) ? cursor.scoped : []).filter(e => Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object').slice(0, 20).map(([id, p]) => [id, { ...p }]),
  };
}

async function readRollout(file, { claimEvent = () => true, now = Date.now(), since = 0, resume = null } = {}) {
  const sources = Array.isArray(file) ? file : [file];
  const start = sources.length === 1 ? restoreCursor(resume) : null;
  let sessionId = start?.sessionId ?? null, project = start?.project ?? '', previous = start?.previous ?? null, forked = start?.forked ?? false;
  let plan = start?.plan ?? null, startedAt = start?.started_at ?? null, endedAt = start?.ended_at ?? null, count = start?.message_count ?? 0;
  let model = start?.model ?? 'codex-unknown', provider = start?.provider ?? 'openai', offset = start?.offset ?? 0;
  const models = start ? start.models : Object.create(null), days = start ? start.days : Object.create(null);
  const seen = new Set(), events = [], scoped = new Map(start?.scoped ?? []), budget = start?.seenEvents ?? 0;
  for (const source of sources) {
    if (!start) { model = 'codex-unknown'; provider = 'openai'; offset = 0; }
    const cursor = { offset };
    for await (const line of boundedLines(source, cursor)) {
    if (!/"(?:session_meta|turn_context|token_count)"/.test(line)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload;
    if (!p || typeof p !== 'object') continue;
    if (row.type === 'session_meta') {
      if (typeof p.id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(p.id)) {
        if (sessionId && sessionId !== p.id) throw new Error('Cannot merge different Codex sessions');
        sessionId = p.id;
      }
      if (typeof p.cwd === 'string') project = path.basename(p.cwd);
      if (typeof p.model_provider === 'string') provider = p.model_provider;
      forked = !!p.forked_from_id;
      continue;
    }
    if (row.type === 'turn_context') {
      if (typeof p.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(p.model)) model = p.model;
      continue;
    }
    if (row.type !== 'event_msg' || p.type !== 'token_count' || provider !== 'openai') continue;
    const at = iso(row.timestamp);
    if (!at || Date.parse(at) > now + 60000 || Date.parse(at) < 1577836800000) continue;
    const nextPlan = Date.parse(at) >= since ? rateLimits(p.rate_limits, at) : null;
    const bucket = p.rate_limits?.limit_id;
    if (nextPlan && bucket && bucket !== 'codex') {
      if (typeof bucket === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(bucket) && (!scoped.has(bucket) || at >= scoped.get(bucket).measured_at)) scoped.set(bucket, nextPlan);
    } else if (nextPlan && (!plan || at >= plan.measured_at)) plan = nextPlan;
    const total = tokenTotals(p.info?.total_token_usage);
    if (!total || !sessionId) continue;
    const last = tokenTotals(p.info?.last_token_usage);
    // Retain only allowlisted counters, never original JSON/content. Sorting
    // merged copies/resumed segments avoids attributing inherited totals twice.
    events.push({ at, model, total, last });
    if (budget + events.length > 250000) throw new Error('Codex session exceeds the bounded event budget');
    }
    offset = cursor.offset;
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || (a.total.input + a.total.output) - (b.total.input + b.total.output));
  for (const { at, model, total, last } of events) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([at, model, total, last])).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    let delta;
    if (!previous) delta = forked ? last : total;
    else if (Object.keys(total).every(key => total[key] >= previous[key])) delta = Object.fromEntries(Object.keys(total).map(key => [key, total[key] - previous[key]]));
    else delta = last; // Compaction/reset: use this request, never a negative delta.
    previous = total;
    if (Date.parse(at) < since) continue;
    if (!delta || delta.input + delta.output === 0) continue;
    if (!claimEvent(sessionId, fingerprint)) continue;
    // Codex input includes cached input; reasoning is already part of output.
    const cached = Math.min(delta.input, delta.cached);
    const usage = { ...emptyUsage(), input_tokens: delta.input - cached, output_tokens: delta.output, cache_read_tokens: cached };
    const date = new Date(at);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const d = days[day] || (days[day] = { day, tz_offset_minutes: -date.getTimezoneOffset(), models: Object.create(null), message_count: 0, started_at: at, ended_at: at, est_cost_usd: null });
    sumUsage(models[model] || (models[model] = emptyUsage()), usage);
    sumUsage(d.models[model] || (d.models[model] = emptyUsage()), usage);
    d.message_count++; count++;
    d.started_at = at < d.started_at ? at : d.started_at;
    d.ended_at = at > d.ended_at ? at : d.ended_at;
    startedAt = !startedAt || at < startedAt ? at : startedAt;
    endedAt = !endedAt || at > endedAt ? at : endedAt;
  }
  const buckets = plan && scoped.size ? [...scoped.entries()].slice(0, 20).flatMap(([id, p]) => ['session', 'week'].map((kind, index) => p[kind + '_pct'] == null ? null : {
    id: `${id}:${index}`, model: index ? `${id} · 2` : id, percent: p[kind + '_pct'], resets_at: p[kind + '_resets_at'], window_seconds: p[kind + '_window_seconds'], measured_at: p.measured_at,
  }).filter(Boolean)) : null;
  const summary = { sessionId, project, models, days: Object.values(days).sort((a, b) => a.day.localeCompare(b.day)), message_count: count, started_at: startedAt, ended_at: endedAt, plan_usage: buckets ? { ...plan, scoped: buckets } : plan };
  // Only a lone file can be resumed: merged copies are read in timestamp order.
  if (sources.length === 1) summary.cursor = {
    offset, seenEvents: budget + events.length, sessionId, project, provider, forked, model, previous, models, days,
    message_count: count, started_at: startedAt, ended_at: endedAt, plan, scoped: [...scoped.entries()].slice(0, 20),
  };
  return summary;
}

function sessionPayload(summary, config, now = Date.now()) {
  if (!summary.sessionId || !summary.days.length) return null;
  return {
    schema_version: 1, provider: 'codex', kind: 'session', source: 'codex-rollout',
    session_id: summary.sessionId, generated_at: new Date(now).toISOString(),
    machine: machineLabel(config.send_project_names === true), project: projectLabel(summary.project, config.send_project_names === true),
    started_at: summary.started_at, ended_at: summary.ended_at, message_count: summary.message_count,
    models: summary.models, days: summary.days.slice(-400), est_cost_usd: null,
    plan_usage: summary.plan_usage,
  };
}
async function rolloutIdentity(file) {
  let n = 0;
  for await (const line of boundedLines(file)) {
    if (++n > 30) break;
    try { const row = JSON.parse(line); if (row.type === 'session_meta' && /^[a-zA-Z0-9_-]{1,160}$/.test(row.payload?.id)) return row.payload.id; } catch {}
  }
  return null;
}
module.exports = { readRollout, rateLimits, sessionPayload, boundedLines, rolloutIdentity, restoreCursor };
