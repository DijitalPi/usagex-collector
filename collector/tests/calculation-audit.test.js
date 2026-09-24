const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeLines } = require('../lib/transcript');
const { sessionPayload } = require('../lib/payload');
const { estimateCostUsd } = require('../lib/pricing');
const model = 'claude-sonnet-5';
const line = (output, id = 'm', timestamp = '2026-07-01T12:00:00Z') => JSON.stringify({ type: 'assistant', timestamp, message: { id, model, usage: { input_tokens: 100, output_tokens: output } } });
const payload = summary => sessionPayload({ session_id: 'audit', summary, config: { send_project_names: false }, plan_usage: null });
test('streamed output increases count once and stays on its original day', () => {
  const s = summarizeLines([line(10), line(30, 'm', '2026-07-02T12:00:00Z'), line(10)]);
  assert.equal(s.message_count, 1);
  assert.equal(s.models[model].input_tokens, 100);
  assert.equal(s.models[model].output_tokens, 30);
  assert.equal(Object.values(s.days)[0].models[model].output_tokens, 30);
  assert.equal(Object.keys(s.days).length, 1);
});
test('negative, infinite, fractional and string counters cannot become a cost', () => {
  for (const n of [-1, Infinity, NaN, 1.5, '10']) assert.equal(estimateCostUsd({ [model]: { input_tokens: n } }), null);
  assert.equal(estimateCostUsd({ [model]: { cache_creation_tokens: 10, cache_creation_1h_tokens: 11 } }), null);
});
test('reported total allocation preserves every microdollar', () => {
  const s = summarizeLines([line(10, 'a'), line(10, 'b', '2026-07-02T12:00:00Z'), line(10, 'c', '2026-07-03T12:00:00Z')]);
  s.claude_reported_cost_usd = 1;
  const p = payload(s);
  assert.equal(p.days.reduce((n, d) => n + Math.round(d.est_cost_usd * 1e6), 0), 1000000);
});
test('trimming 401 days does not redistribute the removed day into recent costs', () => {
  const days = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10), { models: { [model]: { input_tokens: 1000000 } } }]));
  const p = payload({ models: { [model]: { input_tokens: 401000000 } }, days, claude_reported_cost_usd: 401 });
  assert.equal(p.days.length, 400);
  assert.ok(p.days.every(d => d.est_cost_usd === 1));
});
test('unknown daily weights stay unknown instead of moving total cost to an arbitrary date', () => {
  const p = payload({ models: { 'claude-unknown': { input_tokens: 2 } }, days: {
    '2026-07-01': { models: { 'claude-unknown': { input_tokens: 1 } } },
    '2026-07-02': { models: { 'claude-unknown': { input_tokens: 1 } } },
  }, claude_reported_cost_usd: 5 });
  assert.equal(p.est_cost_usd, 5);
  assert.ok(p.days.every(d => d.est_cost_usd === null));
});
test('partial cost-state cannot overwrite a larger transcript with subagent usage', () => {
  const s = summarizeLines([line(1000000), JSON.stringify({ type: 'cost-state', totalCostUSD: 1, modelUsage: { [model]: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } })]);
  assert.equal(s.cost_state_covers_usage, false);
  assert.equal(payload(s).est_cost_usd, 10.0002);
});
