import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgyAccountModelCatalog } from '../src/agy-models.js';

const flash = 'gemini-flash-low\tFlash Low\ngemini-flash-high\tFlash High\n';
const ultra = 'gemini-argon-low\tArgon Low\n' + flash;
function fixture() {
  let time = 0;
  const accounts = [{ id: 'pro', enabled: true, subscription: { id: 'pro' }, credentialVersion: 'a' },
    { id: 'ultra', enabled: true, subscription: { id: 'ultra' }, credentialVersion: 'b' }];
  const output = { pro: flash, ultra };
  const calls = [];
  const catalog = new AgyAccountModelCatalog({ accounts: () => accounts, homeFor: id => id,
    run: async id => { calls.push(id); if (output[id] instanceof Error) throw output[id]; return output[id]; },
    now: () => time, ttlMs: 100, maxAgeMs: 300, retryMs: 10 });
  return { accounts, output, calls, catalog, tick: ms => { time += ms; } };
}

test('discovers each account and advertises their union without borrowing Ultra entitlements for Pro', async () => {
  const { catalog, calls } = fixture();
  assert.deepEqual((await catalog.list()).map(m => m.id), ['gemini-flash-low', 'gemini-flash-high', 'gemini-argon-low']);
  assert.deepEqual(calls.sort(), ['pro', 'ultra']);
  assert.equal(catalog.supportsAccount('pro', 'gemini-argon-low'), false);
  assert.equal(catalog.supportsAccount('ultra', 'gemini-argon-low'), true);
  assert.equal(catalog.supportsAccount('pro', 'gemini-flash-low'), true);
  assert.deepEqual((await catalog.listForAccount('pro')).map(m => m.id), ['gemini-flash-low', 'gemini-flash-high']);
  assert.equal(catalog.forAccount('pro').models.length, 2);
});

test('model availability follows provider output rather than a hard-coded subscription name', async () => {
  const f = fixture();
  f.output.pro = ultra;
  await f.catalog.list();
  assert.equal(f.catalog.supportsAccount('pro', 'gemini-argon-low'), true);
});

test('changes of credentials or subscription invalidate an account catalog immediately', async () => {
  const f = fixture(); await f.catalog.list();
  f.accounts[1].subscription.id = 'pro'; f.output.ultra = flash;
  assert.equal(f.catalog.supportsAccount('ultra', 'gemini-argon-low'), false);
  assert.equal((await f.catalog.listForAccount('ultra')).length, 2);
  f.accounts[0].credentialVersion = 'new-token';
  assert.equal(f.catalog.forAccount('pro').available, false);
  await f.catalog.listForAccount('pro');
  assert.equal(f.calls.filter(id => id === 'pro').length, 2);
});

test('disabled or removed accounts immediately lose their unique models', async () => {
  const f = fixture(); await f.catalog.list();
  f.accounts[1].enabled = false;
  assert.equal(f.catalog.models.some(m => m.id === 'gemini-argon-low'), false);
  assert.deepEqual(await f.catalog.listForAccount('ultra'), []);
  f.accounts.splice(0);
  assert.deepEqual(f.catalog.models, []);
});

test('failures are isolated per account and stale entries expire rather than granting old access forever', async () => {
  const f = fixture(); await f.catalog.list(); f.tick(101); f.output.ultra = new Error('unavailable');
  await f.catalog.list();
  await f.catalog.catalogs.get('ultra').catalog.inflight;
  assert.equal(f.catalog.forAccount('ultra').stale, true);
  assert.equal(f.catalog.supportsAccount('ultra', 'gemini-argon-low'), true);
  f.tick(200); await f.catalog.list();
  assert.equal(f.catalog.supportsAccount('ultra', 'gemini-argon-low'), false);
  assert.equal(f.catalog.forAccount('pro').available, true);
});

test('downgrading an account during in-flight discovery does not publish the old result', async () => {
  const f = fixture();
  let finish;
  f.catalog.run = id => id === 'ultra' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(flash);
  const pending = f.catalog.listForAccount('ultra');
  f.accounts[1].subscription.id = 'pro';
  finish(ultra);
  assert.deepEqual(await pending, []);
  assert.equal(f.catalog.supportsAccount('ultra', 'gemini-argon-low'), false);
});

test('an account home failure does not hide healthy account models and respects retry backoff', async () => {
  const f = fixture(); let calls = 0;
  f.catalog.homeFor = id => { if (id === 'ultra') { calls++; throw new Error('storage unavailable'); } return id; };
  assert.deepEqual((await f.catalog.list()).map(m => m.id), ['gemini-flash-low', 'gemini-flash-high']);
  assert.equal(f.catalog.forAccount('ultra').available, false);
  assert.deepEqual(await f.catalog.listForAccount('ultra'), []);
  assert.equal(calls, 1);
  assert.equal(f.catalog.accountCatalogs().get('pro').models.length, 2);
});
