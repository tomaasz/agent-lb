import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgyAccountStore } from '../src/agy-accounts.js';
import { AgyWorkerPool, accountHome } from '../src/agy-workers.js';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function agyToken(email, access = 'ya29.one') {
  return {
    token: { access_token: access, token_type: 'Bearer', refresh_token: `1//refresh-${email}`, expiry: '2026-09-22T12:00:00Z' },
    auth_method: 'consumer',
    id_token: `h.${b64url({ email, sub: email })}.s`,
  };
}

// Fake `agybridge serve`: a tiny HTTP server answering /health on the requested port.
function makeFakeSpawn(opts = {}) {
  const calls = [];
  const fake = (cmd, args, options) => {
    const child = new EventEmitter();
    const port = Number(args[args.indexOf('--port') + 1]);
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/health' ? 200 : 404;
      res.end('{}');
    });
    child.kill = () => {
      if (child.killed) return true;
      child.killed = true;
      server.close();
      server.closeAllConnections?.();
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    };
    child.server = server;
    calls.push({ cmd, args, options, child, port });
    if (!opts.neverListen) server.listen(port, '127.0.0.1');
    return child;
  };
  fake.calls = calls;
  return fake;
}

describe('AgyWorkerPool', () => {
  let dir, store, account, spawn, pool;
  const make = (extra = {}) => {
    pool = new AgyWorkerPool({
      store, baseDir: path.join(dir, 'homes'), command: 'agybridge', spawn,
      portFrom: 18800 + Math.floor(Math.random() * 2000), pollMs: 10, ...extra,
    });
    return pool;
  };
  const tokenFile = () => path.join(accountHome(path.join(dir, 'homes'), account.id), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-workers-'));
    let t = 1000;
    store = new AgyAccountStore(path.join(dir, 'accounts.json'), () => ++t);
    account = store.upsert(agyToken('a@example.com'));
    spawn = makeFakeSpawn();
  });
  afterEach(() => {
    pool?.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ensureHome seeds the account without starting a worker', () => {
    make();
    const home = pool.ensureHome(account.id);
    assert.equal(home, accountHome(path.join(dir, 'homes'), account.id));
    assert.equal(spawn.calls.length, 0);
    assert.equal(fs.statSync(tokenFile()).mode & 0o777, 0o600);
  });

  it('first acquire seeds the token file 0600 and starts one worker', async () => {
    make();
    const lease = await pool.acquire(account.id);
    assert.equal(spawn.calls.length, 1);
    const home = accountHome(path.join(dir, 'homes'), account.id);
    assert.equal(spawn.calls[0].options.env.HOME, home);
    assert.equal(spawn.calls[0].cmd, 'agybridge');
    assert.deepEqual(spawn.calls[0].args.slice(0, 5), ['serve', '--host', '127.0.0.1', '--port', String(lease.port)]);
    assert.equal(spawn.calls[0].args[5], '--token');
    assert.equal(spawn.calls[0].args[6], lease.token);
    assert.equal(fs.statSync(tokenFile()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile(), 'utf8')), agyToken('a@example.com'));
    lease.release();
  });

  it('worker env has no AGENT_LB_URL or AGENT_LB_API_KEY', async () => {
    process.env.AGENT_LB_URL = 'http://x';
    process.env.AGENT_LB_API_KEY = 'secret';
    try {
      make();
      (await pool.acquire(account.id)).release();
      const env = spawn.calls[0].env ?? spawn.calls[0].options.env;
      assert.equal(env.AGENT_LB_URL, undefined);
      assert.equal(env.AGENT_LB_API_KEY, undefined);
      assert.equal(env.PATH, process.env.PATH);
      assert.ok(env.AGYBRIDGE_CONFIG.endsWith(path.join('.config', 'agybridge', 'none.env')));
    } finally {
      delete process.env.AGENT_LB_URL;
      delete process.env.AGENT_LB_API_KEY;
    }
  });

  it('worker runs inside the account home, never in the proxy working directory', async () => {
    make();
    (await pool.acquire(account.id)).release();
    const options = spawn.calls[0].options;
    assert.equal(options.cwd, accountHome(path.join(dir, 'homes'), account.id));
    assert.equal(options.env.HOME, options.cwd);
  });

  it('does not overwrite a token file refreshed by agy', async () => {
    make();
    (await pool.acquire(account.id)).release();
    fs.writeFileSync(tokenFile(), '{"refreshed":true}');
    pool.stopAll();
    await new Promise(r => setTimeout(r, 30));
    (await pool.acquire(account.id)).release();
    assert.equal(fs.readFileSync(tokenFile(), 'utf8'), '{"refreshed":true}');
  });

  it('re-login (updatedAt > seededAt) reseeds the token', async () => {
    make();
    (await pool.acquire(account.id)).release();
    pool.stopAll();
    await new Promise(r => setTimeout(r, 30));
    store.upsert(agyToken('a@example.com', 'ya29.two'));
    (await pool.acquire(account.id)).release();
    assert.equal(JSON.parse(fs.readFileSync(tokenFile(), 'utf8')).token.access_token, 'ya29.two');
  });

  it('seededAt is persisted but never listed, and tokens never appear in list()', async () => {
    make();
    (await pool.acquire(account.id)).release();
    assert.ok(store._find(account.id).seededAt);
    const listed = JSON.stringify(store.list());
    assert.ok(!listed.includes('seededAt'));
    assert.ok(!listed.includes('ya29'));
    assert.ok(JSON.parse(fs.readFileSync(store.path, 'utf8')).accounts[0].seededAt);
  });

  it('concurrent first requests share one worker', async () => {
    make();
    const [a, b] = await Promise.all([pool.acquire(account.id), pool.acquire(account.id)]);
    assert.equal(spawn.calls.length, 1);
    assert.equal(a.port, b.port);
    assert.equal(a.token, b.token);
    assert.equal(pool.busy(account.id), 2);
    a.release(); b.release();
    assert.equal(pool.busy(account.id), 0);
  });

  it('restarts a worker that exited', async () => {
    make();
    const a = await pool.acquire(account.id);
    a.release();
    spawn.calls[0].child.kill();
    await new Promise(r => setTimeout(r, 30));
    const b = await pool.acquire(account.id);
    assert.equal(spawn.calls.length, 2);
    assert.notEqual(b.token, a.token);
    b.release();
  });

  it('more than maxPerAccount waits until release', async () => {
    make({ maxPerAccount: 2 });
    const a = await pool.acquire(account.id);
    await pool.acquire(account.id);
    let third = false;
    const p = pool.acquire(account.id).then(l => { third = true; return l; });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(third, false);
    a.release();
    const lease = await p;
    assert.equal(third, true);
    assert.equal(pool.busy(account.id), 2);
    lease.release();
  });

  it('release is idempotent', async () => {
    make();
    const a = await pool.acquire(account.id);
    a.release(); a.release();
    assert.equal(pool.busy(account.id), 0);
  });

  it('idle worker is stopped after idleMs', async () => {
    const timers = [];
    make({
      idleMs: 5000,
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (t) => { t.cleared = true; },
    });
    const a = await pool.acquire(account.id);
    a.release();
    const idle = timers.filter(t => t.ms === 5000 && !t.cleared);
    assert.equal(idle.length, 1);
    idle[0].fn();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(spawn.calls[0].child.killed, true);
  });

  it('a new acquire cancels the pending idle stop', async () => {
    const timers = [];
    make({
      idleMs: 5000,
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (t) => { t.cleared = true; },
    });
    (await pool.acquire(account.id)).release();
    const b = await pool.acquire(account.id);
    assert.ok(timers.filter(t => t.ms === 5000).every(t => t.cleared));
    b.release();
  });

  it('two accounts get distinct ports', async () => {
    const other = store.upsert(agyToken('b@example.com'));
    make();
    const [a, b] = await Promise.all([pool.acquire(account.id), pool.acquire(other.id)]);
    assert.notEqual(a.port, b.port);
    assert.equal(spawn.calls.length, 2);
    a.release(); b.release();
  });

  it('skips a port that is already taken', async () => {
    const blocker = http.createServer();
    await new Promise(r => blocker.listen(0, '127.0.0.1', r));
    const taken = blocker.address().port;
    try {
      make({ portFrom: taken });
      const a = await pool.acquire(account.id);
      assert.ok(a.port > taken);
      a.release();
    } finally {
      blocker.close();
    }
  });

  it('rejects for an unknown account', async () => {
    make();
    await assert.rejects(() => pool.acquire('agy-nope'), /unknown/i);
  });

  it('rejects all waiters when the worker never becomes ready, and recovers afterwards', async () => {
    spawn = makeFakeSpawn({ neverListen: true });
    make({ readyMs: 150 });
    const results = await Promise.allSettled([pool.acquire(account.id), pool.acquire(account.id)]);
    assert.ok(results.every(r => r.status === 'rejected'));
    assert.equal(pool.busy(account.id), 0);
    assert.equal(spawn.calls[0].child.killed, true);
    spawn = makeFakeSpawn();
    pool.spawn = spawn;
    const ok = await pool.acquire(account.id);
    ok.release();
  });

  it('rejects when the worker exits before it is ready', async () => {
    spawn = makeFakeSpawn({ neverListen: true });
    make({ readyMs: 2000 });
    const p = pool.acquire(account.id);
    await new Promise(r => setTimeout(r, 40));
    spawn.calls[0].child.kill();
    await assert.rejects(p, /exited/i);
  });
});
