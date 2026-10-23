import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgyCheckScheduler } from '../src/agy-checks.js';

const HOUR = 3_600_000;
function fixture(accounts = [{ id: 'a', enabled: true }], probe = async () => ({ status: 'available' })) {
  let time = 1_800_000_000_000;
  const writes = [];
  const batches = [];
  let locked = false;
  const store = {
    list: () => structuredClone(accounts),
    snapshot: id => accounts.some(a => a.id === id) ? { id, version: 1, token: { secret: 'NEVER_OUTPUT' } } : null,
    beginBatch: source => {
      if (locked) return null;
      locked = true;
      return { source };
    },
    finishBatch: (batch, summary) => { locked = false; batches.push({ batch, summary: { ...summary } }); },
    applyDiagnostics: (id, version, result) => {
      const account = accounts.find(a => a.id === id);
      if (!account || version !== 1) return false;
      writes.push({ id, result });
      Object.assign(account, { diagnostics: result, nextCheckAt: result.nextCheckAt, failures: result.failures });
      return true;
    },
  };
  const scheduler = new AgyCheckScheduler({ store, probe, now: () => time });
  return { store, scheduler, writes, batches, accounts, now: () => time, advance: ms => { time += ms; } };
}

test('automatic batches select five oldest due enabled accounts, manual force checks all enabled', async () => {
  const accounts = Array.from({ length: 8 }, (_, n) => ({ id: `a${n}`, enabled: n !== 0, nextCheckAt: n }));
  const f = fixture(accounts);
  const result = await f.scheduler.run({ source: 'scheduled' });
  assert.equal(result.checked, 5);
  assert.deepEqual(f.writes.map(w => w.id), ['a1', 'a2', 'a3', 'a4', 'a5']);
  assert.equal((await f.scheduler.run({ force: true })).checked, 7);
  assert.equal((await f.scheduler.run({ id: 'a0', force: true })).checked, 1);
  assert.ok(!JSON.stringify(f.batches).includes('NEVER_OUTPUT'));
});

test('success, restricted states, errors and server waits have distinct persisted schedules', async () => {
  let result = { status: 'available' };
  const f = fixture(undefined, async () => result);
  await f.scheduler.run();
  assert.equal(f.writes.at(-1).result.nextCheckAt, f.now() + 6 * HOUR);
  assert.equal((await f.scheduler.run()).checked, 0);
  result = { status: 'subscription_required' };
  await f.scheduler.run({ force: true });
  assert.equal(f.writes.at(-1).result.nextCheckAt, f.now() + 24 * HOUR);
  result = { status: 'error', retryAt: f.now() + HOUR };
  await f.scheduler.run({ force: true });
  assert.equal(f.writes.at(-1).result.nextCheckAt, f.now() + HOUR);
  result = { status: 'error' };
  for (let n = 2; n <= 8; n++) {
    await f.scheduler.run({ force: true });
    assert.equal(f.writes.at(-1).result.nextCheckAt - f.now(), Math.min(6 * HOUR, 900_000 * 2 ** (n - 1)));
  }
  result = { status: 'available' };
  await f.scheduler.run({ force: true });
  assert.equal(f.writes.at(-1).result.failures, 0);
});

test('exhausted quota reset triggers once and stale quota never advances schedule', async () => {
  const f = fixture();
  const resetAt = f.now() + HOUR;
  f.scheduler.probe = async () => ({ status: 'available', telemetry: { models: { data: [{ remainingFraction: 0, resetAt }] } } });
  await f.scheduler.run();
  assert.equal(f.writes[0].result.nextCheckAt, resetAt);
  f.advance(HOUR);
  assert.equal((await f.scheduler.run()).checked, 1);
  assert.equal((await f.scheduler.run()).checked, 0);
  f.scheduler.probe = async () => ({ status: 'available', telemetry: { models: { stale: true, data: [{ remainingFraction: 0, resetAt: f.now() + HOUR }] } } });
  await f.scheduler.run({ force: true });
  assert.equal(f.writes.at(-1).result.nextCheckAt, f.now() + 6 * HOUR);
});

test('two scheduler instances cannot overlap scans and account token rotation discards result', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(undefined, () => pending);
  const first = f.scheduler.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.scheduler.run()).busy, true);
  const second = new AgyCheckScheduler({ store: f.store });
  assert.equal((await second.run()).busy, true);
  f.store.applyDiagnostics = () => false;
  release({ status: 'available' });
  const summary = await first;
  assert.equal(summary.checked, 1);
  assert.equal(summary.discarded, 1);
  assert.equal(f.batches.length, 1);
});

test('probe exceptions are sanitized and batch lock is released after store failures', async () => {
  const f = fixture(undefined, async () => { throw new Error('NEVER_OUTPUT'); });
  const result = await f.scheduler.run();
  assert.equal(result.failed, 1);
  assert.equal(f.writes[0].result.reason, 'probe_failed');
  assert.ok(!JSON.stringify(f.writes).includes('NEVER_OUTPUT'));
  f.store.applyDiagnostics = () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.scheduler.run({ force: true }), /storage unavailable/);
  assert.equal(f.scheduler.running, false);
  assert.equal(f.batches.length, 2);
  f.store.applyDiagnostics = () => true;
  assert.equal((await f.scheduler.run({ force: true })).checked, 1);
});

test('start and stop are idempotent and timer does not keep process alive', () => {
  const f = fixture();
  f.scheduler.start();
  const timer = f.scheduler.timer;
  assert.equal(timer.hasRef(), false);
  f.scheduler.start();
  assert.equal(f.scheduler.timer, timer);
  f.scheduler.stop();
  f.scheduler.stop();
  assert.equal(f.scheduler.timer, null);
});
