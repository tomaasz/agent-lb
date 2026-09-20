import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { firstTokenObserver } from '../src/first-token.js';
import { ProxyMetrics } from '../src/metrics.js';
import { validateSubstitutionPolicy, substitutionAllowed, substitutedModel } from '../src/model-substitution.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { requestBudgetFor } from '../src/request-budget.js';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const frame = value => Buffer.from(`data: ${JSON.stringify(value)}\r\n\r\n`);

test('first-token detection ignores metadata, handles split frames and observes once', () => {
  for (const token of [
    { type: 'content_block_delta', delta: { text: 'hello' } },
    { choices: [{ delta: { content: 'hello' } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '{' } }] } }] },
    { type: 'response.output_text.delta', delta: 'hello' },
  ]) {
    let calls = 0; const observe = firstTokenObserver(() => calls++);
    observe(frame({ type: 'message_start', message: { usage: { input_tokens: 100 } } }));
    observe(frame({ choices: [{ delta: { role: 'assistant', content: '' } }] }));
    assert.equal(calls, 0);
    const bytes = frame(token); for (const byte of bytes) observe(Buffer.from([byte]));
    observe(bytes); assert.equal(calls, 1);
  }
});

test('unbounded malformed SSE frame is discarded and parsing recovers', () => {
  let calls = 0; const observe = firstTokenObserver(() => calls++);
  for (let i = 0; i < 100; i++) observe(Buffer.alloc(4096, 120));
  observe(Buffer.from('\n\n')); observe(frame({ type: 'response.output_text.delta', delta: 'ok' }));
  assert.equal(calls, 1);
});

test('metrics distinguish first token from headers and evaluate operational alerts', () => {
  const metrics = new ProxyMetrics();
  for (let i = 0; i < 20; i++) {
    const res = new EventEmitter(); res.statusCode = i < 3 ? 503 : 200; res.writableFinished = true;
    const firstToken = metrics.start(res);
    if (i >= 3) { firstToken(); firstToken(); }
    res.emit('finish'); res.emit('close');
  }
  assert.equal(metrics.active, 0);
  assert.equal(metrics.alerts()[0].firing, true);
  const text = metrics.render();
  assert.match(text, /agentlb_time_to_first_token_seconds_count 17/);
  assert.match(text, /agentlb_upstream_headers_seconds_count 0/);
  assert.match(text, /agentlb_alert\{name="high_error_rate"\} 1/);
  for (const row of metrics.recent) row.at -= 301_000;
  assert.equal(metrics.alerts()[0].firing, false);
});

test('explicit substitution is exact, rejects unknown/duplicate rules, and supports legacy migration', () => {
  const policy = { mode: 'explicit', rules: [{ fromModel: 'claude-custom', toProvider: 'codex', toModel: 'gpt-target' }] };
  validateSubstitutionPolicy(policy);
  assert.equal(substitutedModel(policy, 'claude-custom', 'codex'), 'gpt-target');
  assert.equal(substitutionAllowed(policy, 'claude-custom', 'codex', 'gpt-target'), true);
  assert.equal(substitutionAllowed(policy, 'claude-custom-extra', 'codex', 'gpt-target'), false);
  assert.equal(substitutionAllowed(policy, 'claude-custom', 'anthropic', 'gpt-target'), false);
  assert.equal(substitutionAllowed(policy, 'same', 'codex', 'same'), true);
  assert.equal(substitutionAllowed(undefined, 'old', 'codex', 'legacy'), true);
  assert.throws(() => validateSubstitutionPolicy({ mode: 'typo' }));
  assert.throws(() => validateSubstitutionPolicy({ ...policy, rules: [policy.rules[0], policy.rules[0]] }));
});

test('configured cross-provider model mapping controls real upstream delivery', async t => {
  const seen = [];
  const upstream = await serve(t, http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); seen.push(body.model);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }));
  const am = new AccountManager([{ name: 'codex', provider: 'codex', type: 'api-key', apiKey: 'fixture', upstream }]);
  am.setCrossProviderFallback(true);
  const config = { upstream, proxy: { clientKeys: [{ name: 'empty-policy', key: 'fixture-client', allowedProviders: [] }] }, autoHealthCheck: { enabled: false }, fallbackPolicy: { mode: 'explicit', rules: [] } };
  const base = await serve(t, createProxyServer(am, config));
  const call = () => fetch(base + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer fixture-client' }, body: JSON.stringify({ model: 'claude-custom', messages: [{ role: 'user', content: 'hi' }] }) });
  const denied = await call(); assert.equal(denied.status, 403); await denied.arrayBuffer(); assert.deepEqual(seen, []);
  config.fallbackPolicy.rules.push({ fromModel: 'claude-custom', toProvider: 'codex', toModel: 'gpt-target' });
  const allowed = await call(); assert.equal(allowed.status, 200); await allowed.arrayBuffer(); assert.deepEqual(seen, ['gpt-target']);
});

test('concurrent large requests reject excess load and release shared budget', async t => {
  let active = 0, peak = 0;
  const upstream = await serve(t, http.createServer(async (req, res) => {
    active++; peak = Math.max(peak, active);
    for await (const _chunk of req) { /* consume */ }
    await new Promise(resolve => setTimeout(resolve, 60));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); active--;
  }));
  const config = { upstream, proxy: { maxBufferedRequests: 2, maxBufferedBytes: 8 * 1024 * 1024 }, autoHealthCheck: { enabled: false } };
  const am = new AccountManager([{ name: 'a', type: 'api-key', apiKey: 'fixture', upstream }]);
  const base = await serve(t, createProxyServer(am, config));
  const body = JSON.stringify({ model: 'claude-safe', messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }] });
  const results = await Promise.all(Array.from({ length: 24 }, async () => {
    const res = await fetch(base + '/v1/messages', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    await res.arrayBuffer(); return res.status;
  }));
  assert.ok(results.includes(200)); assert.ok(results.includes(503)); assert.ok(peak <= 2);
  assert.ok(results.every(status => status === 200 || status === 503));
  assert.equal(requestBudgetFor(config).active, 0); assert.equal(requestBudgetFor(config).bytes, 0);
});

test('live SSE records first token only on content, not headers or metadata', async t => {
  const upstream = await serve(t, http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    res.write(frame({ type: 'content_block_delta', delta: { text: 'hello' } }));
    res.end(frame({ type: 'message_stop' }));
  }));
  const config = { upstream, proxy: { apiKey: 'master' }, autoHealthCheck: { enabled: false } };
  const am = new AccountManager([{ name: 'a', type: 'api-key', apiKey: 'fixture', upstream }]);
  const base = await serve(t, createProxyServer(am, config));
  const res = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'master' }, body: JSON.stringify({ model: 'claude-safe', stream: true }) });
  assert.equal(res.status, 200); assert.match(await res.text(), /hello/);
  const metrics = await fetch(base + '/metrics', { headers: { 'x-api-key': 'master' } });
  assert.match(await metrics.text(), /agentlb_time_to_first_token_seconds_count 1/);
  const alerts = await fetch(base + '/alerts', { headers: { 'x-api-key': 'master' } });
  assert.equal(alerts.status, 200); assert.equal((await alerts.json()).alerts[0].firing, false);
});
