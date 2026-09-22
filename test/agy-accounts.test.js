import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
          { name: '1dtl1', key: station },
          { name: 'limited', key: restricted, allowedModels: ['claude-haiku-4-5-20251001'] },
        ],
      },
      agy: { command: fakeAgy(dir, 'route@example.com'), accountsPath: path.join(dir, 'agy.json') },
    };
    server = createProxyServer(new AccountManager([], 0.98), config, {}, null, null, null);
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
