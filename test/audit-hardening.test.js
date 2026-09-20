import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer, createProxyRequestListener, tailnetExempt, loopbackExempt, idleBody, relayPolicyAllowed } from '../src/server.js';
import { resolveConnectAuth } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker } from '../src/client-usage.js';
import { FleetHealthChecker } from '../src/health-checker.js';
import { RequestBudget, requestBudgetFor } from '../src/request-budget.js';
import { acquireConfigLock } from '../src/config.js';

const proxyConfig = () => ({ apiKey: 'audit-master', trustLoopback: false, trustTailnet: false, clientKeys: [{ name: 'worker', key: 'audit-client' }] });
async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('all management aliases refuse client keys before handlers, master lists only masked keys', async t => {
  let mutations = 0;
  const server = createProxyServer(new AccountManager([]), { proxy: proxyConfig(), autoHealthCheck: { enabled: false } }, { reload: () => { mutations++; } });
  const base = await serve(t, server);
  for (const prefix of ['', '/agent-lb', '/agentlb', '/claude-lb']) {
    for (const [method, path] of [['GET', '/api/keys'], ['GET', '/accounts/export'], ['POST', '/reload'], ['POST', '/switch'], ['POST', '/api/setup/pull'], ['POST', '/api/routing'], ['POST', '/drain'], ['POST', '/restart'], ['POST', '/health-check/run'], ['GET', '/api/auth/verify']]) {
      const res = await fetch(base + prefix + path, { method, headers: { 'x-api-key': 'audit-client' } });
      assert.equal(res.status, 403, `${method} ${prefix}${path}`);
      await res.arrayBuffer();
    }
  }
  assert.equal(mutations, 0);
  const res = await fetch(base + '/agent-lb/api/keys', { headers: { 'x-api-key': 'audit-master' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const raw = await res.text();
  assert.ok(!raw.includes('audit-client') && !raw.includes('audit-master'));
  assert.equal(JSON.parse(raw).keys[0].rawKey, undefined);
});

test('forwarded spoofing and invalid credentials never gain local trust', async t => {
  const cfg = proxyConfig(); cfg.trustLoopback = true; cfg.trustTailnet = true;
  const base = await serve(t, createProxyServer(new AccountManager([]), { proxy: cfg, autoHealthCheck: { enabled: false } }));
  for (const headers of [
    { 'x-forwarded-for': '100.64.0.1, 203.0.113.1' },
    { 'x-forwarded-for': '203.0.113.1', 'x-from-tailnet': '1' },
    { forwarded: 'for=100.64.0.1' },
    { 'x-api-key': 'wrong' },
  ]) {
    const res = await fetch(base + '/agent-lb/api/keys', { headers });
    assert.equal(res.status, 401); await res.arrayBuffer();
  }
  assert.equal(loopbackExempt({}, '127.0.0.1', {}), false);
  assert.equal(tailnetExempt({}, '127.0.0.1', { trustTailnet: true }), false);
  assert.equal(tailnetExempt({}, '100.64.0.1', { trustTailnet: true }), true);
  assert.equal(resolveConnectAuth({ headers: { 'proxy-authorization': 'Bearer wrong' } }, { remoteAddress: '127.0.0.1' }, cfg).ok, false);
});

async function invokeListener(listener, body = '{}') {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { headers: { 'content-type': 'application/json' }, url: '/v1/messages', method: 'POST' });
  const res = new EventEmitter(); res.setHeader = () => {};
  res.writeHead = status => { res.status = status; res.headersSent = true; };
  res.end = value => { res.body = value; res.writableEnded = true; };
  await listener(req, res);
  return res;
}

test('MITM listener revalidates credential, expiry, quotas and models on every request', async () => {
  const config = { proxy: proxyConfig() };
  const am = new AccountManager([]);
  const usage = new ClientUsageTracker();
  const listener = createProxyRequestListener({ accountManager: am, config, forcedCredential: 'audit-client', forcedClient: 'worker', clientUsage: usage });
  config.proxy.clientKeys[0].expiresAt = '2000-01-01';
  assert.equal((await invokeListener(listener)).status, 403);
  delete config.proxy.clientKeys[0].expiresAt;
  config.proxy.clientKeys[0].allowedModels = ['claude-safe'];
  assert.equal((await invokeListener(listener, '{"model":"claude-safe-evil"}')).status, 403);
  assert.equal((await invokeListener(listener, '{}')).status, 403);
  delete config.proxy.clientKeys[0].allowedModels;
  config.proxy.clientKeys[0].maxDailyTokens = 1;
  usage.recordTokens('worker', 2);
  assert.equal((await invokeListener(listener)).status, 429);
  config.proxy.clientKeys[0].key = 'rotated';
  assert.equal((await invokeListener(listener)).status, 401);
});

test('selected provider authorization prevents cross-provider spending', async t => {
  let calls = 0;
  const up = await serve(t, http.createServer((_req, res) => { calls++; res.end('{}'); }));
  const cfg = { proxy: proxyConfig(), upstream: up, autoHealthCheck: { enabled: false } };
  cfg.proxy.clientKeys[0].allowedProviders = ['anthropic'];
  const am = new AccountManager([{ name: 'codex', provider: 'codex', type: 'api-key', apiKey: 'fixture', upstream: up }]);
  const base = await serve(t, createProxyServer(am, cfg));
  const res = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'audit-client', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 403); await res.arrayBuffer(); assert.equal(calls, 0);
});

test('restricted keys cannot bypass metering using opaque relays', () => {
  for (const entry of [{ allowedProviders: ['codex'] }, { allowedModels: ['safe'] }, { maxDailyTokens: 100 }, { expiresAt: '2000-01-01' }]) {
    assert.equal(relayPolicyAllowed({ ok: true, client: 'worker', entry }), false);
  }
  assert.equal(relayPolicyAllowed({ ok: true, client: 'worker', entry: {} }), true);
});

test('request budgets share capacity, bound memory, and release exactly once', () => {
  const config = {}; assert.equal(requestBudgetFor(config), requestBudgetFor(config));
  const budget = new RequestBudget(1, 20); const release = budget.acquire();
  assert.equal(budget.acquire(), null); assert.equal(release.reserve(10), true); assert.equal(release.reserve(1), false);
  release(); release(); assert.equal(budget.active, 0); assert.equal(budget.bytes, 0); assert.ok(budget.acquire());
});

test('health check rejects SSE failure and missing terminal success', async () => {
  for (const raw of ['data: {"type":"response.failed"}\n\n', 'data: [DONE]\n\n']) {
    let success = false;
    const hc = new FleetHealthChecker({ recordAccountSuccess() { success = true; } }, { fetchFn: async () => ({ ok: true, status: 200, text: async () => raw }) });
    const result = await hc.probeAccount({ type: 'oauth', provider: 'codex', index: 0 });
    assert.equal(result.ok, false); assert.equal(success, false);
  }
});

test('health probe aborts stalled transport within its deadline', async () => {
  let aborted = false;
  const hc = new FleetHealthChecker({}, { timeoutMs: 20, fetchFn: (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => { aborted = true; reject(opts.signal.reason); }, { once: true })) });
  assert.equal((await hc.probeAccount({ type: 'api-key', provider: 'anthropic', index: 0 })).ok, false);
  assert.equal(aborted, true);
});

test('translated pipeline aborts idle body and cancels upstream', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(pipeline(Readable.from(idleBody(body, 20)), new Writable({ write(_chunk, _enc, cb) { cb(); } })), /idle/);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test('active count excludes breaker and recognizes expired rate-limit holds', () => {
  const am = new AccountManager([{ name: 'a', type: 'api-key', provider: 'codex', apiKey: 'fixture' }]);
  const a = am.accounts[0]; a.circuitBreakerUntil = Date.now() + 1000;
  assert.equal(am.getActiveCount('codex'), 0);
  a.circuitBreakerUntil = null; a.rateLimitedUntil = Date.now() - 1000; a.status = 'throttled';
  assert.equal(am.getActiveCount('codex'), 1);
});

test('contended config lock times out without deleting live owner lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentlb-lock-test-'));
  const old = process.env.AGENT_LB_CONFIG; process.env.AGENT_LB_CONFIG = join(dir, 'config.json');
  let release;
  try {
    release = await acquireConfigLock();
    await assert.rejects(acquireConfigLock(20), { code: 'AGENTLB_CONFIG_LOCK_TIMEOUT' });
    assert.equal((await readFile(join(dir, 'config.json.lock'), 'utf8')).trim(), String(process.pid));
  } finally {
    await release?.(); if (old === undefined) delete process.env.AGENT_LB_CONFIG; else process.env.AGENT_LB_CONFIG = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('health stop cancels the cycle without probing subsequent accounts', async () => {
  let calls = 0;
  const am = { accounts: [{ index: 0, type: 'api-key' }, { index: 1, type: 'api-key' }] };
  const hc = new FleetHealthChecker(am, { staggerMs: 0, fetchFn: async (_url, opts) => {
    calls++; hc.stop(); opts.signal.throwIfAborted();
  } });
  await hc.runCheckCycle({ force: true });
  assert.equal(calls, 1);
});

test('OAuth token relay is covered by the shared request admission budget', async t => {
  const config = { proxy: { ...proxyConfig(), maxBufferedRequests: 1 }, autoHealthCheck: { enabled: false } };
  const base = await serve(t, createProxyServer(new AccountManager([]), config));
  const release = requestBudgetFor(config).acquire();
  try {
    const res = await fetch(base + '/v1/oauth/token', { method: 'POST', headers: { 'x-api-key': 'audit-client' }, body: '{}' });
    assert.equal(res.status, 503); await res.arrayBuffer();
  } finally { release(); }
});

test('real CONNECT TLS tunnel revalidates a rotated credential on its next request', async t => {
  const https = await import('node:https');
  const tls = await import('node:tls');
  const { createConnectHandler } = await import('../src/mitm.js');
  const { generateCertChain } = await import('../src/x509.js');
  let upstreamCalls = 0;
  const upstream = await serve(t, http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    upstreamCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-safe', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  }));
  const config = { proxy: proxyConfig(), upstream, mitm: { http1Only: true } };
  const am = new AccountManager([{ name: 'fixture', type: 'api-key', apiKey: 'fixture', upstream }]);
  const certs = generateCertChain(['api.anthropic.com']);
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({ config, accountManager: am, clientUsage: new ClientUsageTracker(), ensureLeaf: async () => ({ key: certs.leafKeyPem, cert: certs.leafCertPem }) }));
  const sockets = new Set(); proxy.on('connection', sock => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  const base = await serve(t, proxy);
  t.after(() => { for (const sock of sockets) sock.destroy(); });
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let tunnels = 0;
  agent.createConnection = (_opts, callback) => {
    tunnels++;
    const request = http.request(base, { method: 'CONNECT', path: 'api.anthropic.com:443', headers: { 'Proxy-Authorization': 'Bearer audit-client' } });
    request.on('connect', (res, socket) => {
      assert.equal(res.statusCode, 200);
      const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca: certs.caCertPem }, () => callback(null, secure));
      secure.on('error', callback);
    });
    request.on('error', callback); request.end();
  };
  const call = () => new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', { agent, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject);
    });
    req.on('error', reject); req.end(JSON.stringify({ model: 'claude-safe', messages: [{ role: 'user', content: 'hi' }] }));
  });
  assert.equal(await call(), 200);
  config.proxy.clientKeys[0].key = 'rotated';
  assert.equal(await call(), 401);
  assert.equal(tunnels, 1); assert.equal(upstreamCalls, 1);
  agent.destroy(); for (const sock of sockets) sock.destroy();
});
