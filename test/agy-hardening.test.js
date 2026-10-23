import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgyAccountStore } from '../src/agy-accounts.js';
import { AgyWorkerPool } from '../src/agy-workers.js';
import { classifyAgyFailure } from '../src/agy-failures.js';
import { relayPolicyAllowed } from '../src/access-control.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hardening-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'accounts'));
  return { file: path.join(dir, 'accounts', 'data.json'), key: path.join(dir, 'keys', 'key'), dir };
}
function token(email) {
  return { token: { refresh_token: 'secret-refresh-marker', access_token: 'secret-access-marker' },
    id_token: `h.${Buffer.from(JSON.stringify({ email, sub: email })).toString('base64url')}.s` };
}

test('encrypted account migration, randomized writes and restart preserve accounts', t => {
  const { file, key } = fixture(t);
  const original = new AgyAccountStore(file);
  const account = original.upsert(token('one@example.com'));
  const store = new AgyAccountStore(file, Date.now, { encryptionKeyPath: key });
  const first = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(first).format, 'agentlb-agy-encrypted');
  assert.doesNotMatch(first, /secret-|one@example/);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(key)).mode & 0o777, 0o700);
  store.rename(account.id, 'Profile');
  assert.notEqual(JSON.parse(first).iv, JSON.parse(fs.readFileSync(file)).iv);
  const restored = new AgyAccountStore(file, Date.now, { encryptionKeyPath: key });
  assert.equal(restored.list()[0].name, 'Profile');
  assert.equal(restored._find(account.id).token.token.refresh_token, 'secret-refresh-marker');
});

test('AGY remembered identity survives encrypted persistence without exposing credentials', t => {
  const { file, key } = fixture(t);
  const store = new AgyAccountStore(file, Date.now, { encryptionKeyPath: key });
  const account = store.upsert({ token: { refresh_token: 'secret-refresh-marker' }, id_token_email: 'one@example.com' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret-|one@example/);
  const restored = new AgyAccountStore(file, Date.now, { encryptionKeyPath: key });
  assert.equal(restored.list()[0].id, account.id);
  assert.equal(restored.list()[0].email, 'one@example.com');
  assert.equal(restored._find(account.id).token.token.refresh_token, 'secret-refresh-marker');
});

test('corruption, null, missing/wrong keys fail closed without overwriting accounts', t => {
  const { file, key } = fixture(t);
  for (const bad of ['null', '{}', '{broken', '{"accounts":[{"id":"bad"}]}']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => new AgyAccountStore(file, Date.now, { encryptionKeyPath: key }));
    assert.equal(fs.readFileSync(file, 'utf8'), bad);
    assert.equal(fs.existsSync(key), false);
  }
  fs.unlinkSync(file);
  const store = new AgyAccountStore(file, Date.now, { encryptionKeyPath: key });
  store.upsert(token('one@example.com'));
  const encrypted = fs.readFileSync(file, 'utf8');
  const goodKey = fs.readFileSync(key);
  fs.unlinkSync(key);
  assert.throws(() => new AgyAccountStore(file, Date.now, { encryptionKeyPath: key }));
  assert.equal(fs.existsSync(key), false);
  fs.writeFileSync(key, Buffer.alloc(32, 9), { mode: 0o600 });
  assert.throws(() => new AgyAccountStore(file, Date.now, { encryptionKeyPath: key }));
  assert.equal(fs.readFileSync(file, 'utf8'), encrypted);
  fs.writeFileSync(key, goodKey);
  const damaged = JSON.parse(encrypted);
  damaged.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(file, JSON.stringify(damaged));
  assert.throws(() => new AgyAccountStore(file, Date.now, { encryptionKeyPath: key }));
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(damaged));
});

test('encryption refuses nested and symlinked key placement in account directory', t => {
  const { file, dir } = fixture(t);
  const store = new AgyAccountStore(file);
  store.upsert(token('one@example.com'));
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => new AgyAccountStore(file, Date.now, { encryptionKeyPath: path.join(dir, 'accounts', 'nested', 'key') }));
  fs.symlinkSync(path.join(dir, 'accounts'), path.join(dir, 'alias'));
  assert.throws(() => new AgyAccountStore(file, Date.now, { encryptionKeyPath: path.join(dir, 'alias', 'key') }));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('exact model cooldown and explicit quota groups filter pinned accounts independently', t => {
  const { file } = fixture(t);
  let now = 1000;
  const store = new AgyAccountStore(file, () => now, { quotaGroups: { high: 'pro', low: 'pro' } });
  const a = store.upsert(token('one@example.com'));
  const b = store.upsert(token('two@example.com'));
  store.pin(a.id);
  store.markQuota(a.id, 60, 'private message', 'high');
  assert.equal(store.pick(new Set(), 'low').id, b.id);
  assert.equal(store.pick(new Set(), 'flash').id, a.id);
  now += 61_000;
  assert.equal(store.pick(new Set(), 'low').id, a.id);
  store.markFailure(a.id, 'auth_required');
  now += 86400_000;
  assert.equal(store.pick(new Set(), 'flash').id, b.id);
  store.upsert(token('one@example.com'));
  assert.equal(store.pick(new Set(), 'flash').id, a.id);
});

test('failure classification separates local status from explicit upstream quota and auth', () => {
  const classify = (status, error, retry) => classifyAgyFailure(status, JSON.stringify({ error }), retry);
  assert.equal(classify(429, { message: 'busy' }).reason, 'overloaded');
  assert.equal(classify(401, { message: 'unauthorized' }).reason, 'bridge_auth');
  assert.equal(classify(403, { message: 'forbidden' }).reason, 'bridge_auth');
  assert.equal(classify(502, { message: 'AGY run failed: invalid_grant' }).reason, 'auth_required');
  assert.equal(classify(502, { code: 'upstream_access_denied' }).reason, 'access_denied');
  assert.equal(classify(429, { code: 'insufficient_quota' }).retrySeconds, 3600);
  assert.equal(classify(429, { code: 'insufficient_quota' }, '15').retrySeconds, 15);
  assert.equal(classify(200, undefined), null);
});

test('diagnostic ring persists only bounded allowlisted fields', t => {
  const { file } = fixture(t);
  const store = new AgyAccountStore(file);
  for (let i = 0; i < 110; i++) store.recordEvent({ outcome: 'success', model: 'gemini-pro', client: 'hermes',
    status: 200, durationMs: i, prompt: 'secret-prompt', token: 'secret-token', message: 'secret-message' });
  const restored = new AgyAccountStore(file);
  assert.equal(restored.data.events.length, 100);
  assert.equal(restored.data.events[0].durationMs, 10);
  assert.doesNotMatch(JSON.stringify(restored.data.events), /secret-/);
});

test('credential relay requires a real explicit boolean and remains restricted by policies', () => {
  const auth = entry => ({ ok: true, client: 'hermes', entry });
  assert.equal(relayPolicyAllowed(auth({})), false);
  assert.equal(relayPolicyAllowed(auth({ allowCredentialRelay: 'true' })), false);
  assert.equal(relayPolicyAllowed(auth({ allowCredentialRelay: true })), true);
  assert.equal(relayPolicyAllowed(auth({ allowCredentialRelay: true, allowedProviders: ['agy'] })), false);
});

test('queue is bounded, round-robin across three clients, cancellable and leak free', async t => {
  // Real requests keep a socket alive; the in-memory fixture needs its own
  // referenced handle while waiting on an intentionally unref'ed queue timer.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const pool = new AgyWorkerPool({ store: { _find: id => ({ id }) }, maxPerAccount: 1, maxQueued: 8, maxQueuedPerClient: 3 });
  t.after(() => pool.stopAll());
  pool._start = () => ({ ready: Promise.resolve(), port: 1, token: 'test', dead: false });
  let lease = await pool.acquire('one', { client: 'A' });
  const order = [];
  const pending = ['A', 'A', 'A', 'B', 'B', 'B', 'C'].map(client => pool.acquire('one', { client }).then(next => { order.push(client); next.release(); }));
  await assert.rejects(pool.acquire('one', { client: 'A' }), { code: 'AGY_QUEUE_FULL' });
  const controller = new AbortController();
  const cancelled = pool.acquire('one', { client: 'D', signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { code: 'AGY_CANCELLED' });
  assert.equal(pool.queued, 7);
  lease.release(); lease.release();
  await Promise.all(pending);
  assert.deepEqual(order.slice(0, 3), ['A', 'B', 'C']);
  assert.equal(pool.busy('one'), 0);
  assert.equal(pool.queued, 0);
  assert.equal(pool.queuedClients.size, 0);
  lease = await pool.acquire('one', { client: 'A' });
  await assert.rejects(pool.acquire('one', { client: 'B', timeoutMs: 10 }), { code: 'AGY_QUEUE_TIMEOUT' });
  lease.release();
  assert.equal(pool.busy('one'), 0);
});

test('shutdown between admission and startup never issues a late lease', async () => {
  const pool = new AgyWorkerPool({ store: { _find: id => ({ id }) }, maxPerAccount: 1 });
  let starts = 0;
  pool._start = () => { starts++; return { ready: Promise.resolve(), port: 1, token: 'test' }; };
  pool._kill = w => { w.dead = true; };
  const first = await pool.acquire('one');
  const next = pool.acquire('one');
  first.release();
  pool.stopAll();
  await assert.rejects(next, { code: 'AGY_POOL_STOPPED' });
  assert.equal(starts, 1);
  assert.equal(pool.busy('one'), 0);
  assert.equal(pool.queued, 0);
});
