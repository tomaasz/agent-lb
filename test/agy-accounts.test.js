import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { AgyAccountStore, AgyLoginManager, withAccountChooser, parseAgyToken } from '../src/agy-accounts.js';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function agyToken(email, sub = email) {
  return {
    token: { access_token: 'ya29.test', token_type: 'Bearer', refresh_token: `1//refresh-${sub}`, expiry: '2026-09-22T12:00:00Z' },
    auth_method: 'consumer',
    id_token: `h.${b64url({ email, sub })}.s`,
  };
}

// Stand-in for `agy --print`: prints Google's consent URL, reads the code and
// writes AGY's token file into $HOME/.gemini like the real CLI.
function fakeAgy(dir, email) {
  const script = path.join(dir, 'fake-agy.mjs');
  fs.writeFileSync(script, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
console.log('Authentication required. Please visit the URL to log in:');
console.log('  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x&prompt=consent&state=s');
console.log('Or, paste the authorization code here and press Enter:');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (code) => {
  if (code.trim() !== 'good-code-1234567890') {
    console.log('Error: authentication failed: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."');
    process.exit(1);
  }
  fs.mkdirSync(process.env.HOME + '/.gemini/antigravity-cli', { recursive: true });
  fs.writeFileSync(process.env.HOME + '/.gemini/antigravity-cli/antigravity-oauth-token', ${JSON.stringify(JSON.stringify(agyToken(email)))});
  setTimeout(() => process.exit(0), 5000); // AGY goes on to run the prompt
});
`, { mode: 0o755 });
  return script;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-accounts-test-'));
}

describe('AGY account store', () => {
  it('stores accounts privately and never lists their tokens', () => {
    const dir = tmpDir();
    const store = new AgyAccountStore(path.join(dir, 'agy.json'));
    const a = store.upsert(JSON.stringify(agyToken('A@example.com', 'sub-a')));
    assert.equal(a.email, 'a@example.com');
    assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(store.list()).includes('refresh'), 'list() leaks no token');
    // Logging the same account in again refreshes it instead of adding a copy.
    store.upsert(agyToken('a@example.com', 'sub-a'));
    assert.equal(store.list().length, 1);
    assert.throws(() => store.upsert({ token: {} }), /refresh token/);
    assert.throws(() => parseAgyToken({ token: { refresh_token: 'x' }, id_token: 'bad' }), /e-mail/);
  });

  it('stores per-model usage reported by a station, keeping the most spent duplicate', () => {
    const store = new AgyAccountStore(path.join(tmpDir(), 'agy.json'));
    store.upsert(agyToken('a@example.com'));
    const ok = store.setUsage('A@example.com', [
      { label: 'Gemini Pro', remaining: 0.8, resetAt: 1000 },
      { label: 'Gemini Pro', remaining: 0.3, resetAt: 2000 },
      { label: 'bad', remaining: 'x' },
      { label: 'Over', remaining: 5 },
    ]);
    assert.equal(ok, true);
    const usage = store.list()[0].usage;
    assert.deepEqual(usage.models.map(m => [m.label, m.remaining]), [['Gemini Pro', 0.3], ['Over', 1]]);
    assert.equal(store.setUsage('nobody@example.com', []), false);
  });

  it('renames profiles without changing identity, routing or credentials', () => {
    const store = new AgyAccountStore(path.join(tmpDir(), 'agy.json'));
    const original = agyToken('a@example.com');
    const a = store.upsert(original);
    store.pin(a.id);
    assert.equal(store.rename(a.id, '  Prywatne Pro  '), true);
    assert.equal(new AgyAccountStore(store.path).list()[0].name, 'Prywatne Pro');
    assert.equal(store.list()[0].email, a.email);
    assert.equal(store.pick().id, a.id);
    assert.deepEqual(store.credentialFor('test').token, original);
    // Renewing the login preserves the custom profile name.
    store.upsert(original);
    assert.equal(store.list()[0].name, 'Prywatne Pro');
    assert.equal(store.rename(a.id, 'x'.repeat(101)), false);
    assert.equal(store.rename(a.id, {}), false);
    assert.equal(store.rename('missing', 'x'), false);
    assert.equal(store.rename(a.id, '  '), true);
    assert.equal(store.list()[0].name, null);
  });

  it('rotates to the next free account when a quota is spent', () => {
    let now = 1_000_000;
    const store = new AgyAccountStore(path.join(tmpDir(), 'agy.json'), () => now);
    const a = store.upsert(agyToken('a@example.com'));
    const b = store.upsert(agyToken('b@example.com'));
    assert.equal(store.credentialFor('1dtl1').account.id, a.id);
    const next = store.reportQuota('1dtl1', a.id, 3600, 'Individual quota reached. Resets in 1h.');
    assert.equal(next.account.id, b.id);
    assert.ok(next.token.token.refresh_token.includes('b@example.com'));
    assert.ok(store.list()[0].quotaUntil > now);
    assert.deepEqual(store.list()[1].usedBy, ['1dtl1']);
    // A station keeps its current account while it is free.
    now += 3601 * 1000;
    assert.equal(store.credentialFor('1dtl1', b.id).account.id, b.id);
    assert.equal(store.credentialFor('other').account.id, a.id);
    // Every account spent: nothing to hand out.
    store.reportQuota('x', a.id, 60);
    store.reportQuota('x', b.id, 60);
    assert.equal(store.credentialFor('x'), null);
  });

  it('honours pin, enable and order', () => {
    const store = new AgyAccountStore(path.join(tmpDir(), 'agy.json'));
    const a = store.upsert(agyToken('a@example.com'));
    const b = store.upsert(agyToken('b@example.com'));
    assert.ok(store.pin(b.id));
    assert.equal(store.credentialFor('s', a.id).account.id, b.id, 'pinned wins over current');
    store.setEnabled(b.id, false);
    assert.equal(store.credentialFor('s').account.id, a.id, 'a disabled pin is skipped');
    store.pin(null);
    store.setEnabled(b.id, true);
    store.reorder([b.id, a.id]);
    assert.equal(store.credentialFor('new').account.id, b.id);
    assert.ok(store.remove(b.id));
    assert.equal(store.list().length, 1);
    assert.equal(store.pin('missing'), false);
  });

  it('a failing deferred stats save is logged briefly and never thrown into the process', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const warn = mock.method(console, 'warn', () => {});
    try {
      const dir = tmpDir();
      let now = 1000;
      const store = new AgyAccountStore(path.join(dir, 'agy.json'), () => now);
      const a = store.upsert(agyToken('a@example.com'));
      store._save = () => { throw Object.assign(new Error(`EACCES: permission denied, open '${dir}/agy.json.tmp'`), { code: 'EACCES' }); };
      assert.equal(store.recordRequest(a.id, { inputTokens: 1, outputTokens: 2 }), true);
      assert.doesNotThrow(() => mock.timers.tick(10_000));
      assert.equal(warn.mock.callCount(), 1);
      const logged = warn.mock.calls[0].arguments.join(' ');
      assert.match(logged, /AGY stats save failed: EACCES/);
      assert.ok(!logged.includes(dir), 'no path in the log line');
      assert.equal(store.statsSaveTimer, null, 'a later request can schedule the next save');
    } finally {
      warn.mock.restore();
      mock.timers.reset();
    }
  });

  it('asks Google for the account chooser', () => {
    const url = withAccountChooser('https://accounts.google.com/o/oauth2/auth?prompt=consent&state=s');
    assert.equal(new URL(url).searchParams.get('prompt'), 'select_account consent');
    assert.equal(new URL(url).searchParams.get('state'), 's');
  });
});

describe('AGY login through AGY itself', () => {
  for (const usePty of [true, false]) {
    it(`adds an account from the authorization code (${usePty ? 'pty via script' : 'pipes'})`, async () => {
      const dir = tmpDir();
      const store = new AgyAccountStore(path.join(dir, 'agy.json'));
      const logins = new AgyLoginManager({ command: fakeAgy(dir, 'new@example.com'), store, usePty });
      const started = await logins.start();
      assert.match(started.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
      assert.equal(new URL(started.url).searchParams.get('prompt'), 'select_account consent');
      const account = await logins.submit(started.loginId, 'good-code-1234567890');
      assert.equal(account.email, 'new@example.com');
      assert.equal(store.list().length, 1);
      await assert.rejects(logins.submit(started.loginId, 'good-code-1234567890'), /ended/);
    });
  }

  it('reports a wrong code and refuses junk before it reaches AGY', async () => {
    const dir = tmpDir();
    const store = new AgyAccountStore(path.join(dir, 'agy.json'));
    const logins = new AgyLoginManager({ command: fakeAgy(dir, 'x@example.com'), store, usePty: false });
    const first = await logins.start();
    await assert.rejects(logins.submit(first.loginId, 'bad\ncode'), /authorization code/);
    await assert.rejects(logins.submit(first.loginId, 'wrong-code-1234567890'), /invalid_grant/);
    assert.equal(store.list().length, 0);
  });

  it('leaves no AGY process behind when a login is cancelled (pty)', async () => {
    const dir = tmpDir();
    const store = new AgyAccountStore(path.join(dir, 'agy.json'));
    const command = fakeAgy(dir, 'z@example.com');
    const logins = new AgyLoginManager({ command, store, usePty: true });
    const started = await logins.start();
    const { execFileSync } = await import('node:child_process');
    const running = () => {
      try { return execFileSync('pgrep', ['-f', command]).toString().trim().split('\n').filter(Boolean).length; } catch { return 0; }
    };
    assert.ok(running() >= 1, 'fake AGY runs under script');
    logins.cancel(started.loginId);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(running(), 0, 'AGY was killed with script, not orphaned');
  });

  it('checks one code per login at a time', async () => {
    const dir = tmpDir();
    const store = new AgyAccountStore(path.join(dir, 'agy.json'));
    const logins = new AgyLoginManager({ command: fakeAgy(dir, 'w@example.com'), store, usePty: false });
    const started = await logins.start();
    const first = logins.submit(started.loginId, 'good-code-1234567890');
    await assert.rejects(logins.submit(started.loginId, 'good-code-1234567890'), /already being checked/);
    assert.equal((await first).email, 'w@example.com');
  });

  it('removes the throwaway HOME after the login', async () => {
    const dir = tmpDir();
    const store = new AgyAccountStore(path.join(dir, 'agy.json'));
    const logins = new AgyLoginManager({ command: fakeAgy(dir, 'y@example.com'), store, usePty: false });
    const started = await logins.start();
    const home = logins.logins.get(started.loginId).home;
    assert.ok(fs.existsSync(home));
    await logins.submit(started.loginId, 'good-code-1234567890');
    assert.ok(!fs.existsSync(home));
  });
});

describe('AGY routes on the proxy', () => {
  let server, base, dir;
  const admin = 'tc-admin-key';
  const station = 'tc-station-1dtl1';
  const restricted = 'tc-restricted';

  before(async () => {
    dir = tmpDir();
    const config = {
      proxy: {
        apiKey: admin,
        clientKeys: [
          { name: '1dtl1', key: station, allowCredentialRelay: true },
          { name: 'api-only', key: 'tc-api-only' },
          { name: 'limited', key: restricted, allowedModels: ['claude-haiku-4-5-20251001'] },
        ],
      },
      agy: { command: fakeAgy(dir, 'route@example.com'), accountsPath: path.join(dir, 'agy.json') },
    };
    server = createProxyServer(new AccountManager([], 0.98), config, {
      // Fakes keep the catalog and worker pool away from ~/.config/agy-homes and the real agy.
      agyPool: { busy: () => 0, ensureHome: () => dir, acquire: async () => { throw new Error('no workers in this test'); }, stopAll() {} },
      agyModels: { list: async () => [], resolveAlias: () => null },
      agySubscriptionRefresh: async () => ({ ok: true }),
    }, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const call = (p, key, body) => fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('keeps account management for the administrator', async () => {
    assert.equal((await call('/api/agy/accounts', station)).status, 403);
    const res = await call('/api/agy/accounts', admin);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).accounts, []);
  });

  it('logs an account in from the dashboard and hands it to a station', async () => {
    const start = await (await call('/api/agy/login/start', admin, {})).json();
    assert.ok(start.ok, JSON.stringify(start));
    const submit = await (await call('/api/agy/login/submit', admin, { loginId: start.loginId, code: 'good-code-1234567890' })).json();
    assert.equal(submit.account.email, 'route@example.com');

    const listed = await (await call('/api/agy/accounts', admin)).json();
    assert.ok(!JSON.stringify(listed).includes('refresh'), 'dashboard never sees tokens');

    const cred = await call('/agy/credential', station);
    assert.equal(cred.status, 200);
    const body = await cred.json();
    assert.equal(body.account.email, 'route@example.com');
    assert.ok(body.token.token.refresh_token);

    const after = await (await call('/api/agy/accounts', admin)).json();
    assert.deepEqual(after.accounts[0].usedBy, ['1dtl1']);
  });

  it('refuses credentials to restricted or missing keys', async () => {
    assert.equal((await call('/agy/credential', restricted)).status, 403);
    assert.equal((await call('/agy/credential', null)).status, 401);
    assert.equal((await call('/agy/credential', 'tc-wrong')).status, 401);
    assert.equal((await call('/agy/credential', 'tc-api-only')).status, 403);
  });

  it('accepts station subscription reports but restricts refresh to administrators', async () => {
    const [account] = (await (await call('/api/agy/accounts', admin)).json()).accounts;
    const report = { accountId: account.id, models: [], subscription: { id: 'g1-pro-tier', name: 'Google AI Pro', token: 'must-not-leak' } };
    assert.equal((await call('/agy/usage', restricted, report)).status, 403);
    assert.equal((await call('/agy/usage', station, report)).status, 200);
    const listed = await (await call('/api/agy/accounts', admin)).json();
    assert.deepEqual(listed.accounts[0].subscription.id, 'g1-pro-tier');
    assert.ok(!JSON.stringify(listed).includes('must-not-leak'));
    assert.equal((await call('/api/agy/accounts/subscription', station, { id: account.id })).status, 403);
    assert.equal((await call('/api/agy/accounts/subscription', admin, { id: 'missing' })).status, 404);
    assert.equal((await (await call('/api/agy/accounts/subscription', admin, { id: account.id })).json()).ok, true);
  });

  it('allows only administrators to edit a Google profile name', async () => {
    const [account] = (await (await call('/api/agy/accounts', admin)).json()).accounts;
    const body = { id: account.id, name: 'Praca Ultra' };
    assert.equal((await call('/api/agy/accounts/rename', station, body)).status, 403);
    assert.equal((await call('/api/agy/accounts/rename', admin, { id: account.id, name: {} })).status, 400);
    assert.equal((await call('/api/agy/accounts/rename', admin, { id: 'missing', name: 'X' })).status, 404);
    assert.equal((await call('/api/agy/accounts/rename', admin, body)).status, 200);
    const [renamed] = (await (await call('/api/agy/accounts', admin)).json()).accounts;
    assert.equal(renamed.name, body.name);
    assert.equal(renamed.id, account.id);
    assert.equal(renamed.email, account.email);
  });

  it('rotates when a station reports a spent quota', async () => {
    const accounts = (await (await call('/api/agy/accounts', admin)).json()).accounts;
    const res = await call('/agy/quota', station, { accountId: accounts[0].id, resetSeconds: 3600, message: 'Individual quota reached.' });
    assert.equal(res.status, 404, 'only one account, now spent');
    const listed = (await (await call('/api/agy/accounts', admin)).json()).accounts;
    assert.ok(listed[0].quotaUntil);
    assert.equal((await call('/api/agy/accounts/clear-quota', admin, { id: listed[0].id })).status, 200);
    assert.equal((await call('/agy/credential', station)).status, 200);
  });
});

describe('AGY accounts in the dashboard', () => {
  it('has the AGY section and the login dialog', async () => {
    const { renderDashboardHtml } = await import('../src/dashboard.js');
    const html = renderDashboardHtml();
    for (const id of ['colAgy', 'listAgy', 'btnAgyLogin', 'modalAgyLogin', 'agyLoginLink', 'agyLoginCode', 'btnAgySubmitCode', 'agyLoginCountdown', 'btnAgyNewLink']) {
      assert.ok(html.includes(`id="${id}"`), `${id} present`);
    }
    assert.ok(html.includes("'/agent-lb/api/agy/login/start'"));
    // The account list is built with textContent, never innerHTML, so an e-mail cannot inject markup.
    const agyJs = html.slice(html.indexOf('function renderAgyAccounts'), html.indexOf('function agyEl'));
    assert.ok(agyJs.length > 0 && !agyJs.includes('innerHTML'));
  });
});

describe('AGY account cards: stats, busy and the Test button', () => {
  let server, base, dir, store, workers, hits, acquired, released, catalogMode;
  const admin = 'tc-admin-key';
  const station = 'tc-station-card';
  let idA, idB;

  const listen = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const call = (p, key, body) => fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sse = (events) => (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ port: req.socket.localPort, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events);
    });
  };
  const OK_STREAM = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';

  before(async () => {
    dir = tmpDir();
    hits = []; acquired = []; released = []; catalogMode = 'ok';
    store = new AgyAccountStore(path.join(dir, 'agy.json'));
    idA = store.upsert(JSON.stringify(agyToken('a@example.com', 'sub-a'))).id;
    idB = store.upsert(JSON.stringify(agyToken('b@example.com', 'sub-b'))).id;
    store.recordRequest(idA, { inputTokens: 10, outputTokens: 5 });
    workers = { [idA]: await listen(sse(OK_STREAM)), [idB]: await listen(sse(OK_STREAM)) };
    const active = new Map();
    const pool = {
      busy: (id) => active.get(id) || 0,
      ensureHome: () => dir,
      stopAll() {},
      async acquire(id) {
        acquired.push(id);
        active.set(id, (active.get(id) || 0) + 1);
        return { port: workers[id].address().port, token: `worker-secret-${id}`, release: () => { released.push(id); active.set(id, active.get(id) - 1); } };
      },
    };
    const agyModels = {
      async list() {
        if (catalogMode === 'fail') throw new Error('agy models failed');
        return [{ id: 'gemini-x-high', name: 'X High' }, { id: 'gemini-x-low', name: 'X Low' }];
      },
      resolveAlias: (m) => m,
    };
    const config = { proxy: { apiKey: admin, clientKeys: [{ name: 'st', key: station }] }, agy: { accountsPath: path.join(dir, 'agy.json') } };
    server = createProxyServer(new AccountManager([], 0.98), config, { agyStore: store, agyPool: pool, agyModels }, null, null, null);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const w of Object.values(workers)) await new Promise((resolve) => { w.closeAllConnections?.(); w.close(resolve); });
  });

  it('lists stats, busy and the model ids without any token or seededAt', async () => {
    const body = await (await call('/api/agy/accounts', admin)).json();
    assert.equal(body.ok, true);
    const a = body.accounts.find((x) => x.id === idA);
    assert.deepEqual({ requests: a.stats.requests, in: a.stats.inputTokens, out: a.stats.outputTokens }, { requests: 1, in: 10, out: 5 });
    assert.equal(a.busy, 0);
    assert.deepEqual(body.models, ['gemini-x-high', 'gemini-x-low']);
    const text = JSON.stringify(body);
    assert.ok(!/refresh|ya29|seededAt|worker-secret/.test(text), 'no token material or seededAt in the list');
  });

  it('keeps the list working when the model catalog fails', async () => {
    catalogMode = 'fail';
    try {
      const res = await call('/api/agy/accounts', admin);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).accounts.length, 2);
    } finally { catalogMode = 'ok'; }
  });

  it('tests only the chosen account on the first -low model and never leaks the worker token', async () => {
    hits.length = 0; acquired.length = 0; released.length = 0;
    const res = await call('/api/agy/accounts/test', admin, { id: idB });
    assert.equal(res.status, 200);
    const text = await res.text();
    const out = JSON.parse(text);
    assert.equal(out.ok, true);
    assert.equal(out.model, 'gemini-x-low');
    const listed = await (await call('/api/agy/accounts', admin)).json();
    assert.equal(listed.events.at(-1).accountId, idB);
    assert.equal(listed.events.at(-1).outcome, 'success');
    const reloaded = new AgyAccountStore(path.join(dir, 'agy.json'));
    assert.equal(reloaded.data.events.at(-1).outcome, 'success');
    assert.equal(typeof out.ms, 'number');
    assert.ok(!text.includes('worker-secret'), 'worker token is not returned');
    assert.deepEqual(acquired, [idB]);
    assert.deepEqual(released, [idB]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].port, workers[idB].address().port);
    assert.equal(hits[0].auth, `Bearer worker-secret-${idB}`);
    assert.equal(hits[0].body.model, 'gemini-x-low');
    assert.match(JSON.stringify(hits[0].body.messages), /Odpowiedz jednym słowem: OK/);
    // Test neither reorders nor pins.
    const after = await (await call('/api/agy/accounts', admin)).json();
    assert.deepEqual(after.accounts.map((x) => x.id), [idA, idB]);
    assert.equal(after.pinned, null);
  });

  it('reports an in-band SSE error event as a failure and still releases once', async () => {
    const original = workers[idA];
    workers[idA] = await listen(sse('data: {"error":{"message":"model overloaded worker-secret-leak"}}\n\n'));
    acquired.length = 0; released.length = 0;
    try {
      const out = await (await call('/api/agy/accounts/test', admin, { id: idA })).json();
      assert.equal(out.ok, false);
      assert.match(out.error, /overloaded/);
      const listed = await (await call('/api/agy/accounts', admin)).json();
      assert.equal(listed.events.at(-1).outcome, 'test_failed');
      assert.equal(new AgyAccountStore(path.join(dir, 'agy.json')).data.events.at(-1).outcome, 'test_failed');
      assert.ok(!JSON.stringify(listed.events).includes('worker-secret'));
      assert.deepEqual(acquired, [idA]);
      assert.deepEqual(released, [idA]);
    } finally {
      await new Promise((resolve) => workers[idA].close(resolve));
      workers[idA] = original;
    }
  });

  it('reports a dead worker as an error, releases once, and does not leak the token', async () => {
    const original = workers[idA];
    const dead = await listen(() => {});
    const port = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));
    workers[idA] = { address: () => ({ port }) };
    acquired.length = 0; released.length = 0;
    try {
      const res = await call('/api/agy/accounts/test', admin, { id: idA });
      const text = await res.text();
      const out = JSON.parse(text);
      assert.equal(out.ok, false);
      assert.ok(out.error);
      assert.ok(!text.includes('worker-secret'));
      assert.deepEqual(released, [idA]);
    } finally { workers[idA] = original; }
  });

  it('refuses a disabled or quota-spent account without touching any worker', async () => {
    acquired.length = 0; released.length = 0;
    store.setEnabled(idA, false);
    let out = await (await call('/api/agy/accounts/test', admin, { id: idA })).json();
    assert.equal(out.ok, false);
    assert.match(out.error, /wyłączone|disabled/i);
    store.setEnabled(idA, true);
    store.markQuota(idA, 3600, 'AGY quota exhausted');
    out = await (await call('/api/agy/accounts/test', admin, { id: idA })).json();
    assert.equal(out.ok, false);
    assert.match(out.error, /limit|quota/i);
    store.clearQuota(idA);
    assert.deepEqual(acquired, [], 'no other account or worker was used');
  });

  it('reports a catalog failure as a test error only', async () => {
    catalogMode = 'fail';
    try {
      const out = await (await call('/api/agy/accounts/test', admin, { id: idB })).json();
      assert.equal(out.ok, false);
      assert.ok(out.error);
    } finally { catalogMode = 'ok'; }
  });

  it('rejects unknown ids and non-administrators', async () => {
    assert.equal((await call('/api/agy/accounts/test', admin, { id: 'nope' })).status, 404);
    assert.equal((await call('/api/agy/accounts/test', admin, {})).status, 400);
    assert.equal((await call('/api/agy/accounts/test', station, { id: idA })).status, 403);
  });
});

describe('AGY test isolation: no default config, accounts or homes are touched', () => {
  const savedEnv = {};
  let sandboxHome, dir, server, base;

  // A stand-in for `agy models` that records that it ran and which HOME it got.
  function modelsAgy(file, log) {
    fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, process.env.HOME + '\\n');
console.log('gemini-fake-low\\tFake Low');
`, { mode: 0o755 });
    return file;
  }

  async function start(accounts) {
    dir = tmpDir();
    const accountsPath = path.join(dir, 'agy.json');
    const log = path.join(dir, 'agy-calls.log');
    const store = new AgyAccountStore(accountsPath);
    for (const email of accounts) store.upsert(JSON.stringify(agyToken(email, email)));
    // The sandbox HOME stands in for the real one: anything written there is a leak.
    sandboxHome = tmpDir();
    for (const k of ['HOME', 'XDG_CONFIG_HOME', 'AGENT_LB_CONFIG', 'AGENTLB_CONFIG', 'CLAUDE_LB_CONFIG']) savedEnv[k] = process.env[k];
    process.env.HOME = sandboxHome;
    delete process.env.XDG_CONFIG_HOME; delete process.env.AGENT_LB_CONFIG; delete process.env.AGENTLB_CONFIG; delete process.env.CLAUDE_LB_CONFIG;
    const config = { proxy: { apiKey: 'tc-iso', trustLoopback: false, trustTailnet: false }, agy: { accountsPath, command: modelsAgy(path.join(dir, 'models-agy.mjs'), log) } };
    server = createProxyServer(new AccountManager([], 0.98), config, {}, null, null, null);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    return { log, accountsPath };
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

  it('keeps homes next to the configured accounts file and never under the real HOME', async () => {
    const { log, accountsPath } = await start(['iso@example.com']);
    try {
      const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'tc-iso' } });
      assert.equal(res.status, 200);
      assert.ok((await res.json()).data.some((m) => m.id === 'gemini-fake-low'));
      const homes = path.join(path.dirname(accountsPath), 'agy-homes');
      const entries = fs.readdirSync(homes);
      assert.equal(entries.length, 1, 'the account home is created beside the accounts file');
      assert.ok(fs.existsSync(path.join(homes, entries[0], '.gemini', 'antigravity-cli', 'antigravity-oauth-token')));
      assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [path.join(homes, entries[0])], 'agy models ran with the isolated HOME');
      assert.deepEqual(fs.readdirSync(sandboxHome), [], 'nothing was written under the default HOME/.config');
    } finally { await stop(); }
  });

  it('spawns nothing and seeds nothing while the store has no account', async () => {
    const { log, accountsPath } = await start([]);
    try {
      const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'tc-iso' } });
      assert.equal(res.status, 200);
      assert.ok(!fs.existsSync(log), 'agy was never started');
      assert.ok(!fs.existsSync(path.join(path.dirname(accountsPath), 'agy-homes')), 'no home was created');
      assert.deepEqual(fs.readdirSync(sandboxHome), []);
    } finally { await stop(); }
  });

  it('honors an explicit config.agy.homesDir', async () => {
    const { resolveAgyHomesDir } = await import('../src/agy-workers.js');
    assert.equal(resolveAgyHomesDir({ agy: { accountsPath: '/x/y/agy.json' } }), '/x/y/agy-homes');
    assert.equal(resolveAgyHomesDir({ agy: { accountsPath: '/x/y/agy.json', homesDir: '/h' } }), '/h');
  });
});

describe('testAgyAccount acquire timeout', () => {
  const fakeStore = { list: () => [{ id: 'a', enabled: true, quotaUntil: null }] };
  const fakeCatalog = { list: async () => [{ id: 'gemini-x-low' }] };
  let listener;
  before(async () => {
    // In production the HTTP listener keeps the loop alive while unref'd timeouts run.
    listener = http.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  });
  after(async () => { await new Promise(resolve => listener.close(resolve)); });

  it('gives up on a hanging acquire after the timeout and returns an error', async () => {
    const { testAgyAccount } = await import('../src/agy-gateway.js');
    const pool = { acquire: () => new Promise(() => {}) };
    const started = Date.now();
    const out = await testAgyAccount({ store: fakeStore, pool, catalog: fakeCatalog, id: 'a', timeoutMs: 50 });
    assert.equal(out.ok, false);
    assert.match(out.error, /timeout/i);
    assert.ok(Date.now() - started < 2000);
  });

  it('releases a lease that arrives after the timeout', async () => {
    const { testAgyAccount } = await import('../src/agy-gateway.js');
    let release = 0;
    const pool = { acquire: () => new Promise((resolve) => setTimeout(() => resolve({ port: 1, token: 't', release: () => { release++; } }), 120)) };
    const out = await testAgyAccount({ store: fakeStore, pool, catalog: fakeCatalog, id: 'a', timeoutMs: 40 });
    assert.equal(out.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(release, 1);
  });
});
