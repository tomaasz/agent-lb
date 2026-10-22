import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker } from '../src/client-usage.js';
import { renderDashboardHtml } from '../src/dashboard.js';
import { AuthAttemptLimiter, requestPasswordReset, completePasswordReset, validateResetCode, verifySession, verifyPassword, hashPassword } from '../src/web-auth.js';

async function serve(t, proxy = {}) {
  const config = { proxy: { apiKey: 'audit-master', trustLoopback: false, clientKeys: [{ name: 'worker', key: 'audit-worker' }], ...proxy }, autoHealthCheck: { enabled: false } };
  const manager = new AccountManager([{ name: 'audit-account', type: 'api-key', apiKey: 'test-only' }]);
  const server = createProxyServer(manager, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + '/agent-lb/api/auth/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { base, post, config, manager, server };
}

test('integration: delegated and missing keys never mint administrator sessions', async t => {
  for (const apiKey of ['audit-master', undefined]) {
    const { post } = await serve(t, { apiKey });
    for (const key of ['audit-worker', 'wrong-key', '']) {
      const res = await post('login', { key });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('set-cookie'), null);
      await res.arrayBuffer();
    }
  }
});

test('integration: master login, password change session revocation, logout cookie', async t => {
  const { base, post, config } = await serve(t);
  const login = await post('login', { key: 'audit-master' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.arrayBuffer();
  let res = await fetch(base + '/agent-lb/api/keys', { headers: { cookie } });
  assert.equal(res.status, 200); await res.arrayBuffer();
  config.proxy.webAuth = { passwordHash: 'changed-password-hash' };
  res = await fetch(base + '/agent-lb/api/keys', { headers: { cookie } });
  assert.equal(res.status, 401); await res.arrayBuffer();
  res = await post('logout', {});
  assert.match(res.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  await res.arrayBuffer();
});

test('integration: malformed auth input fails with 400, no side effects or cookies', async t => {
  for (const path of ['login', 'forgot-password', 'reset-password']) {
    const { post } = await serve(t);
    for (const body of ['{', 'null', '[]', { username: 3 }, { password: {} }]) {
      const res = await post(path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal(res.headers.get('set-cookie'), null);
      await res.arrayBuffer();
    }
  }
});

test('integration: auth attempt limit covers aliases and ignores spoofed forwarding headers', async t => {
  const { post } = await serve(t);
  for (let i = 0; i < 10; i++) {
    const res = await post('login', { key: 'wrong' }, { 'x-forwarded-for': `203.0.113.${i}` });
    assert.equal(res.status, 401); await res.arrayBuffer();
  }
  const res = await post('login', { key: 'audit-master' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  await res.arrayBuffer();
});

test('auth limiter bounds peers, enforces global cap, recovers after expiry', () => {
  let now = 100;
  const limiter = new AuthAttemptLimiter({ limit: 2, totalLimit: 3, windowMs: 1000, now: () => now });
  assert.equal(limiter.take('a'), 0); assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 1); assert.equal(limiter.take('b'), 0);
  assert.equal(limiter.take('c'), 1);
  now += 1000;
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.peers.size, 1);
  const bounded = new AuthAttemptLimiter({ totalLimit: 10000, now: () => now });
  for (let i = 0; i < 2000; i++) bounded.take(String(i));
  assert.equal(bounded.peers.size, 1024);
});

test('known legacy default secret cannot forge a session without a configured secret', () => {
  const payload = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 60000 })).toString('base64url');
  const sig = createHmac('sha256', 'agent-lb-default-secret').update(payload).digest('base64url');
  assert.equal(verifySession(`agentlb_session=${payload}.${sig}`, undefined).valid, false);
});

test('reset: trusted URL, configured recipient, delivery failure and single-use persistence', async () => {
  const config = { proxy: { webAuth: { username: 'operator', email: 'operator@example.test', publicUrl: 'https://control.example.test' } } };
  let message, recipient;
  const send = async (to, subject, body) => { recipient = to; message = body; return true; };
  const unknown = await requestPasswordReset('tomaasz', config, { send });
  assert.equal(message, undefined);
  const known = await requestPasswordReset('operator', config, { send });
  assert.deepEqual(known, unknown);
  assert.equal(recipient, 'operator@example.test');
  assert.match(message, /https:\/\/control.example.test\/dashboard\?reset_token=/);
  const token = message.match(/reset_token=([0-9a-f]+)/)[1];
  assert.ok(validateResetCode(token));
  await assert.rejects(hashPassword('x'.repeat(73)), /72/);
  assert.equal((await completePasswordReset(token, 'short')).ok, false);
  await assert.rejects(completePasswordReset(token, 'a-long-password', async () => { throw new Error('disk failed'); }), /disk failed/);
  assert.ok(validateResetCode(token), 'failed persistence does not burn the code');
  let writes = 0;
  const results = await Promise.all([0, 1].map(() => completePasswordReset(token, 'a-long-password', async () => { writes++; })));
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(writes, 1);
  assert.equal(validateResetCode(token), null);
  assert.equal(await verifyPassword('a-long-password', results.find(r => r.ok).newHash), true);
  message = undefined;
  const failed = await requestPasswordReset('operator', config, { send: async (to, subject, body) => { message = body; return false; } });
  assert.equal(failed.ok, false);
  assert.equal(validateResetCode(message.match(/reset_token=([0-9a-f]+)/)[1]), null);
});

test('usage restore preserves current counters, ignores stale periods and corrupt numbers', () => {
  const now = Date.UTC(2026, 9, 22);
  const tracker = new ClientUsageTracker({ now: () => now });
  tracker.recordTokens('worker', 40, 10);
  tracker.restore({ worker: { requests: -2, inputTokens: Infinity, outputTokens: 'NaN', dailyTokens: 100, dailyResetDay: '2026-10-22', monthlyTokens: 200, monthlyResetMonth: '2026-10' } });
  const client = tracker.getClient('worker');
  assert.equal(client.dailyTokens, 150); assert.equal(client.monthlyTokens, 250);
  assert.equal(client.inputTokens, 40); assert.equal(client.requests, 0);
  tracker.restore({ worker: { dailyTokens: 100, dailyResetDay: '2026-10-21', monthlyTokens: 100, monthlyResetMonth: '2026-09' } });
  assert.equal(client.dailyTokens, 150); assert.equal(client.monthlyTokens, 250);
  assert.equal(tracker.checkQuota('worker', { maxDailyTokens: 100 }).status, 429);
});

function pollContext(fetch) {
  const html = renderDashboardHtml();
  const start = html.indexOf('  var pollPending = false;');
  const end = html.indexOf('  function start() {', start);
  const elements = Object.fromEntries(['keybox', 'app', 'err'].map(id => [id, { style: {} }]));
  const state = { fetch, AbortController, setTimeout, clearTimeout, localStorage: { getItem: () => '' }, KEY: 'key', currentLang: 'pl', document: { getElementById: id => elements[id] }, render: () => { state.renders++; }, renders: 0, renderClientKeys: () => {}, updateQuickCmd: () => {}, note: () => {}, showKeybox: () => {}, primaryAdminKey: '' };
  vm.createContext(state); vm.runInContext(html.slice(start, end), state);
  return { state, elements };
}

test('dashboard: polls coalesce, reveal no secrets, and stale response cannot reopen after logout', async () => {
  let resolve, requests = [];
  const { state } = pollContext(url => { requests.push(url); return new Promise(r => { resolve = r; }); });
  const first = state.poll(); state.poll();
  assert.equal(requests.length, 1);
  state.pollGeneration++;
  resolve({ status: 200, ok: true, json: async () => ({}) });
  // poll currently returns its chain so callers and tests can await completion.
  await first;
  assert.equal(state.renders, 0);
  assert.equal(requests.length, 1);
  const next = pollContext(async url => {
    requests.push(url);
    return { status: 200, ok: true, json: async () => url.endsWith('/status') ? {} : { keys: [] } };
  });
  await next.state.poll();
  assert.equal(next.state.renders, 1);
  assert.ok(!requests.some(url => url.includes('/reveal')));
});

test('dashboard: failed status reports a visible fallback and permits the next poll', async () => {
  const { state, elements } = pollContext(async () => { throw new Error('network failed'); });
  await state.poll();
  assert.equal(elements.err.style.display, 'block');
  assert.match(elements.err.textContent, /network failed/);
  assert.equal(state.pollPending, false);
});


test('integration: malformed usage reset preserves counters; explicit empty object resets fleet', async t => {
  const { base, manager } = await serve(t);
  manager.accounts[0].usage = { totalRequests: 12 };
  for (const body of ['{', 'null', '[]', '{"account":3}']) {
    const res = await fetch(base + '/api/accounts/usage/reset', { method: 'POST', headers: { 'x-api-key': 'audit-master' }, body });
    assert.equal(res.status, 400); await res.arrayBuffer();
    assert.equal(manager.accounts[0].usage.totalRequests, 12);
  }
  const res = await fetch(base + '/api/accounts/usage/reset', { method: 'POST', headers: { 'x-api-key': 'audit-master' }, body: '{}' });
  assert.equal(res.status, 200); await res.arrayBuffer();
  assert.equal(manager.accounts[0].usage.totalRequests, 0);
});

test('integration: health settings validate types and persistence failure leaves runtime unchanged', async t => {
  const { base, server, config } = await serve(t);
  const health = server.healthChecker;
  const interval = health.intervalMs;
  for (const body of ['{', 'null', '{"enabled":"false"}', '{"intervalSeconds":-1}', '{"intervalSeconds":0.01}', '{"intervalSeconds":2147483648}']) {
    const res = await fetch(base + '/api/health-check/config', { method: 'POST', headers: { 'x-api-key': 'audit-master' }, body });
    assert.equal(res.status, 400); await res.arrayBuffer();
    assert.equal(health.intervalMs, interval);
    assert.equal(config.autoHealthCheck.enabled, false);
  }
  const beforePath = process.env.AGENT_LB_CONFIG;
  const directory = await mkdtemp(join(tmpdir(), 'agentlb-audit-config-'));
  try {
    process.env.AGENT_LB_CONFIG = directory; // reading a directory fails before a write
    const res = await fetch(base + '/api/health-check/config', { method: 'POST', headers: { 'x-api-key': 'audit-master' }, body: '{"enabled":true,"intervalSeconds":1}' });
    assert.equal(res.status, 502); await res.arrayBuffer();
    assert.equal(health.intervalMs, interval);
    assert.equal(config.autoHealthCheck.enabled, false);
  } finally {
    process.env.AGENT_LB_CONFIG = beforePath;
    await rm(directory, { recursive: true, force: true });
  }
});


test('dashboard: session table bounds DOM rows, navigates pages, clamps after filtering', () => {
  const html = renderDashboardHtml();
  const start = html.indexOf('  var sessionPage = 0;');
  const end = html.indexOf('  function fillFilter(', start);
  function node() {
    return { style: {}, children: [], value: '', _text: '', appendChild(child) { this.children.push(child); }, addEventListener(name, fn) { this[name] = fn; }, set textContent(v) { this._text = v; this.children = []; }, get textContent() { return this._text; } };
  }
  const elements = Object.fromEntries(['sessionsWrap', 'fProject', 'fClient', 'sessionCount', 'sessions'].map(id => [id, node()]));
  const sessions = { items: Array.from({ length: 250 }, (_, i) => ({ id: String(i), project: 'test' })) };
  const state = { document: { getElementById: id => elements[id] }, el: node, sessionRows: s => s.items, fillFilter: () => {}, uniqSorted: a => a, filterSessionRows: rows => rows, sortRows: rows => rows, sortState: { sessions: {} }, sessionFilters: {}, SESSION_COLUMNS: [], addSortableHeader: () => {}, fmtNum: String, fmtAgo: String, lastStatus: { sessions } };
  vm.createContext(state); vm.runInContext(html.slice(start, end), state);
  state.renderSessions(sessions);
  assert.equal(elements.sessions.children.length, 101);
  assert.equal(elements.sessionCount.children[0].disabled, true);
  elements.sessionCount.children[1].click();
  assert.equal(state.sessionPage, 1);
  assert.equal(elements.sessions.children.length, 101);
  elements.sessionCount.children[1].click();
  assert.equal(elements.sessions.children.length, 51);
  assert.equal(elements.sessionCount.children[1].disabled, true);
  state.renderSessions({ items: sessions.items.slice(0, 3) });
  assert.equal(state.sessionPage, 0);
  assert.equal(elements.sessions.children.length, 4);
});


test('dashboard: an in-flight key reveal cannot restore credentials after logout', async () => {
  const html = renderDashboardHtml();
  const start = html.indexOf('  function apiCall(');
  const end = html.indexOf('  function copyToClipboard(', start);
  let resolveBody;
  const state = { pollGeneration: 0, KEY: 'key', localStorage: { getItem: () => '' }, fetch: async () => ({ status: 200, json: () => new Promise(resolve => { resolveBody = resolve; }) }) };
  vm.createContext(state); vm.runInContext(html.slice(start, end), state);
  const result = state.apiCall('/agent-lb/api/keys/reveal', 'POST', { name: 'worker' });
  await new Promise(resolve => setImmediate(resolve));
  state.pollGeneration++;
  resolveBody({ ok: true, key: 'test-only-key' });
  assert.equal(await result, null);
});
