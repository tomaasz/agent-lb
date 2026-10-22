import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ClientUsageTracker } from '../src/client-usage.js';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const cases = [
  {
    name: 'native OpenAI JSON', provider: 'codex', path: '/v1/chat/completions', model: 'gpt-4o', stream: false,
    contentType: 'application/json',
    response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
  },
  {
    name: 'OpenAI SSE translated to Anthropic', provider: 'codex', path: '/v1/messages', model: 'claude-custom', stream: true,
    contentType: 'text/event-stream',
    response: frame({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] }) + frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } }) + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
  },
  {
    name: 'Anthropic SSE translated to OpenAI', provider: 'anthropic', path: '/v1/chat/completions', model: 'gpt-4o', stream: true,
    contentType: 'text/event-stream',
    response: frame({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } }) + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }) + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }) + frame({ type: 'message_stop' }),
  },
];

for (const fixture of cases) {
  test(`${fixture.name}: upstream usage is booked once and enforces client quota`, async t => {
    let upstreamCalls = 0;
    const upstream = await serve(t, http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume */ }
      upstreamCalls++;
      res.writeHead(200, { 'Content-Type': fixture.contentType });
      res.end(fixture.response);
    }));
    const manager = new AccountManager([{ name: 'fixture-account', provider: fixture.provider, type: 'api-key', apiKey: 'fixture', upstream }], 0.98, { crossProviderFallback: true });
    const usage = new ClientUsageTracker();
    const config = { upstream, proxy: { clientKeys: [{ name: 'worker', key: 'fixture-client', maxDailyTokens: 1 }] }, autoHealthCheck: { enabled: false } };
    const base = await serve(t, createProxyServer(manager, config, {}, null, usage));
    const call = () => fetch(base + fixture.path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'fixture-client', 'x-claude-code-session-id': 'fixture-session' },
      body: JSON.stringify({ model: fixture.model, stream: fixture.stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const first = await call();
    assert.equal(first.status, 200);
    await first.text();
    const second = await call();
    const secondStatus = second.status;
    await second.text();
    assert.equal(secondStatus, 429, 'the next call must stop before spending more upstream tokens');
    assert.equal(upstreamCalls, 1);
    assert.equal(usage.getClient('worker').dailyTokens, 150);
    assert.equal(manager.accounts[0].usage.totalInputTokens, 100);
    assert.equal(manager.accounts[0].usage.totalOutputTokens, 50);
    assert.equal(manager.accounts[0].usage.bySession['fixture-session'].totalTokens, 150);
    assert.equal(manager.accounts[0].usage.recent.length, 1);
  });
}
