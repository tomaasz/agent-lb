import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { SessionTracker } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';
import {
  resolveMaxSessionTokens,
  resolveSessionBudgetStatusCode,
} from '../src/config.js';
import { createProxyServer, createProxyRequestListener } from '../src/server.js';

function mockRequest(url = '/v1/messages', method = 'POST', headers = {}, bodyStr = '{}') {
  const req = Readable.from([Buffer.from(bodyStr)]);
  Object.assign(req, {
    url,
    method,
    headers: { 'content-type': 'application/json', ...headers },
  });
  return req;
}

function mockResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    res.headersSent = true;
    for (const [k, v] of Object.entries(headers)) {
      res.headers[k.toLowerCase()] = v;
    }
  };
  res.end = (val) => {
    res.body = val;
    res.writableEnded = true;
  };
  return res;
}

test('SessionTracker records and sums cumulative tokens per session across buckets', () => {
  const tracker = new SessionTracker();
  const now = 1000000;
  const sid = 'sess-agent-loop-1';

  tracker.touch(sid, 0, 'claude-3-opus', now);
  assert.equal(tracker.totalTokens(sid), 0);
  assert.equal(tracker.sessionTokens(sid), 0);

  // Record tokens in bucket 1
  tracker.recordTokens(sid, 'claude-3-opus', {
    input_tokens: 30000,
    output_tokens: 15000,
    cache_read_input_tokens: 10000,
    cache_creation_input_tokens: 5000,
  }, now);

  assert.equal(tracker.totalTokens(sid), 60000);
  assert.equal(tracker.sessionTokens(sid), 60000);

  // Record tokens in bucket 2 (e.g. fast model)
  tracker.recordTokens(sid, 'claude-3-5-sonnet', {
    input_tokens: 25000,
    output_tokens: 15000,
  }, now);

  assert.equal(tracker.totalTokens(sid), 100000);

  // Stats with detail includes totalTokens
  const stats = tracker.stats(now, { detail: true });
  assert.ok(Array.isArray(stats.items));
  const item = stats.items.find(i => i.id === sid);
  assert.ok(item);
  assert.equal(item.totalTokens, 100000);

  // Reset tokens
  assert.equal(tracker.resetSessionTokens(sid), true);
  assert.equal(tracker.totalTokens(sid), 0);
  assert.equal(tracker.resetSessionTokens('non-existent'), false);
});

test('AccountManager queries and resets session tokens', () => {
  const am = new AccountManager([{ name: 'test-acct', type: 'api-key', apiKey: 'test-key' }]);
  const sid = 'sess-am-test-1';

  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 50000,
    output_tokens: 20000,
  });

  assert.equal(am.sessionTokens(sid), 70000);
  assert.equal(am.resetSessionTokens(sid), true);
  assert.equal(am.sessionTokens(sid), 0);
  assert.equal(am.sessionTokens(null), 0);
});

test('Config helper functions resolve session token budget and status code', () => {
  const prevEnvTokens = process.env.AGENTLB_MAX_SESSION_TOKENS;
  const prevEnvCode = process.env.AGENTLB_SESSION_BUDGET_STATUS_CODE;
  try {
    delete process.env.AGENTLB_MAX_SESSION_TOKENS;
    delete process.env.AGENTLB_SESSION_BUDGET_STATUS_CODE;

    assert.equal(resolveMaxSessionTokens({}, null), null);
    assert.equal(resolveMaxSessionTokens({ maxSessionTokens: 50000 }), 50000);
    assert.equal(resolveMaxSessionTokens({ proxy: { maxSessionTokens: 80000 } }), 80000);
    assert.equal(resolveMaxSessionTokens({ proxy: { maxSessionTokens: 80000 } }, { maxSessionTokens: 30000 }), 30000);

    process.env.AGENTLB_MAX_SESSION_TOKENS = '120000';
    assert.equal(resolveMaxSessionTokens({}), 120000);

    assert.equal(resolveSessionBudgetStatusCode({}), 429);
    assert.equal(resolveSessionBudgetStatusCode({ proxy: { sessionBudgetStatusCode: 402 } }), 402);
    process.env.AGENTLB_SESSION_BUDGET_STATUS_CODE = '402';
    assert.equal(resolveSessionBudgetStatusCode({}), 402);
  } finally {
    if (prevEnvTokens !== undefined) process.env.AGENTLB_MAX_SESSION_TOKENS = prevEnvTokens;
    else delete process.env.AGENTLB_MAX_SESSION_TOKENS;
    if (prevEnvCode !== undefined) process.env.AGENTLB_SESSION_BUDGET_STATUS_CODE = prevEnvCode;
    else delete process.env.AGENTLB_SESSION_BUDGET_STATUS_CODE;
  }
});

test('createProxyRequestListener blocks request with 429 when session exceeds 100k hard budget cap', async () => {
  const am = new AccountManager([]);
  const config = {
    proxy: {
      maxSessionTokens: 100000,
    },
  };

  let endHookCalled = false;
  let endHookStatus = null;
  const hooks = {
    onRequestEnd: (_id, info) => {
      endHookCalled = true;
      endHookStatus = info.status;
    },
  };

  const listener = createProxyRequestListener({
    accountManager: am,
    config,
    hooks,
  });

  const sid = 'sess-loop-prevent-1';

  // 1. Session under limit (80k tokens): should NOT be rejected by budget check
  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 50000,
    output_tokens: 30000,
  });
  assert.equal(am.sessionTokens(sid), 80000);

  // Request with sessionId passes budget check (it reaches account selection)
  let req = mockRequest('/v1/messages', 'POST', { 'x-claude-code-session-id': sid });
  let res = mockResponse();
  await listener(req, res);
  assert.ok(res.body);
  let underLimitParsed = JSON.parse(res.body);
  assert.ok(!underLimitParsed.error?.message?.includes('Session token budget exceeded'));
  assert.ok(underLimitParsed.error?.message?.includes('No accounts configured'));

  // 2. Add tokens to exceed 100k limit
  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 20001,
  });
  assert.equal(am.sessionTokens(sid), 100001);

  // Request should now be blocked immediately with 429
  endHookCalled = false;
  req = mockRequest('/v1/messages', 'POST', { 'x-claude-code-session-id': sid });
  res = mockResponse();
  await listener(req, res);

  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '60');
  assert.equal(endHookCalled, true);
  assert.equal(endHookStatus, 429);

  const parsed = JSON.parse(res.body);
  assert.equal(parsed.type, 'error');
  assert.equal(parsed.error.type, 'rate_limit_error');
  assert.ok(parsed.error.message.includes('Session token budget exceeded'));
  assert.ok(parsed.error.message.includes('100,001 >= 100,000 limit'));
  assert.ok(parsed.error.message.includes(sid));

  // 3. Different session is not affected
  const sidOther = 'sess-loop-prevent-other';
  req = mockRequest('/v1/messages', 'POST', { 'x-session-id': sidOther });
  res = mockResponse();
  await listener(req, res);
  assert.ok(res.body);
  let otherParsed = JSON.parse(res.body);
  assert.ok(!otherParsed.error?.message?.includes('Session token budget exceeded'));
  assert.ok(otherParsed.error?.message?.includes('No accounts configured'));

  // 4. Resetting session allows requests to proceed again
  am.resetSessionTokens(sid);
  assert.equal(am.sessionTokens(sid), 0);

  req = mockRequest('/v1/messages', 'POST', { 'session-id': sid });
  res = mockResponse();
  await listener(req, res);
  assert.ok(res.body);
  let resetParsed = JSON.parse(res.body);
  assert.ok(!resetParsed.error?.message?.includes('Session token budget exceeded'));
  assert.ok(resetParsed.error?.message?.includes('No accounts configured'));
});

test('createProxyRequestListener supports 402 Payment Required status code for hard budget cap', async () => {
  const am = new AccountManager([]);
  const config = {
    proxy: {
      maxSessionTokens: 50000,
      sessionBudgetStatusCode: 402,
    },
  };

  const listener = createProxyRequestListener({
    accountManager: am,
    config,
  });

  const sid = 'sess-402-test';
  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 50000,
  });

  const req = mockRequest('/v1/messages', 'POST', { 'x-claude-code-session-id': sid });
  const res = mockResponse();
  await listener(req, res);

  assert.equal(res.status, 402);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.type, 'budget_exceeded');
  assert.ok(parsed.error.message.includes('Session token budget exceeded'));
});

test('key-level maxSessionTokens overrides proxy config', async () => {
  const am = new AccountManager([]);
  const config = {
    proxy: {
      maxSessionTokens: 200000,
      clientKeys: [
        { name: 'restricted-key', key: 'key-123', maxSessionTokens: 10000 },
      ],
    },
  };

  const listener = createProxyRequestListener({
    accountManager: am,
    config,
    forcedCredential: 'key-123',
    forcedClient: 'restricted-key',
  });

  const sid = 'sess-key-override';
  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 12000,
  });

  const req = mockRequest('/v1/messages', 'POST', { 'x-claude-code-session-id': sid });
  const res = mockResponse();
  await listener(req, res);

  assert.equal(res.status, 429);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.error.message.includes('12,000 >= 10,000 limit'));
});

test('end-to-end: live HTTP proxy blocks request when session reaches 100k cap without calling upstream', async (t) => {
  let upstreamCalls = 0;
  const upstreamServer = http.createServer((req, res) => {
    upstreamCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }));
  });
  await new Promise(r => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamPort = upstreamServer.address().port;
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  t.after(() => {
    upstreamServer.close();
  });

  const am = new AccountManager([
    {
      name: 'primary',
      type: 'api-key',
      apiKey: 'test-key',
      upstream: upstreamUrl,
    },
  ]);

  const cfg = {
    proxy: {
      apiKey: 'master-key',
      maxSessionTokens: 100000,
      clientKeys: [{ name: 'test-client', key: 'client-key' }],
    },
    autoHealthCheck: { enabled: false },
  };

  const proxyServer = createProxyServer(am, cfg);
  await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
  const proxyPort = proxyServer.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  t.after(() => {
    proxyServer.close();
  });

  const sid = 'sess-e2e-100k';

  // Under budget: session at 60k tokens
  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 40000,
    output_tokens: 20000,
  });

  const res1 = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'client-key',
      'content-type': 'application/json',
      'x-claude-code-session-id': sid,
    },
    body: JSON.stringify({ model: 'claude-3-7-sonnet', messages: [{ role: 'user', content: 'hello' }] }),
  });

  assert.equal(res1.status, 200);
  assert.equal(upstreamCalls, 1);

  // Exceed 100k cap (60k + 40,001 = 100,001)
  am.recordTokenUsage(0, sid, 'claude-3-7-sonnet', {
    input_tokens: 40001,
  });

  const res2 = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'client-key',
      'content-type': 'application/json',
      'x-claude-code-session-id': sid,
    },
    body: JSON.stringify({ model: 'claude-3-7-sonnet', messages: [{ role: 'user', content: 'hello again' }] }),
  });

  assert.equal(res2.status, 429);
  assert.equal(upstreamCalls, 1); // upstream was NOT called!
  const body2 = await res2.json();
  assert.equal(body2.type, 'error');
  assert.equal(body2.error.type, 'rate_limit_error');
  assert.ok(body2.error.message.includes('Session token budget exceeded'));
});
