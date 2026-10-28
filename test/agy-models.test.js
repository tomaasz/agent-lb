import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgyModels, AgyModelCatalog, isAgyModelName } from '../src/agy-models.js';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

const OUT = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';

function catalog(overrides = {}) {
  let t = 0;
  const calls = [];
  const cat = new AgyModelCatalog({
    run: async (home) => { calls.push(home); return OUT; },
    homeFor: () => '/h',
    ttlMs: 1000,
    now: () => t,
    ...overrides,
  });
  return { cat, calls, tick: (ms) => { t += ms; } };
}

describe('agy models', () => {
  it('parseAgyModels keeps only gemini rows in agy order', () => {
    const out = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n';
    assert.deepEqual(parseAgyModels(out), [
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    ]);
  });

  it('parseAgyModels ignores the banner', () => {
    assert.equal(parseAgyModels('Fetching available models...\n').length, 0);
    assert.equal(parseAgyModels(OUT).length, 3);
  });

  it('aliases resolve to high and low variants', async () => {
    const { cat } = catalog();
    await cat.list();
    assert.equal(cat.resolveAlias('agy'), 'gemini-3.8-flash-high');
    assert.equal(cat.resolveAlias('agy-fast'), 'gemini-3.8-flash-low');
    assert.equal(cat.resolveAlias('gemini-3.8-flash-medium'), 'gemini-3.8-flash-medium');
    assert.equal(cat.resolveAlias('gpt-5'), null);
  });

  it('isAgyModelName', () => {
    assert.ok(isAgyModelName('agy') && isAgyModelName('agy-fast') && isAgyModelName('gemini-x'));
    assert.ok(!isAgyModelName('gpt-5'));
  });

  it('list() is cached for ttlMs and refreshed after', async () => {
    const { cat, calls, tick } = catalog();
    await cat.list(); await cat.list();
    assert.equal(calls.length, 1);
    tick(1500);
    await cat.list();
    assert.equal(calls.length, 2);
  });

  it('listing failure keeps last known models', async () => {
    let fail = false;
    const { cat, tick } = catalog({ run: async () => { if (fail) throw new Error('boom'); return OUT; } });
    await cat.list();
    fail = true; tick(1500);
    const again = await cat.list();
    await cat.inflight;
    assert.equal(again.length, 3);
    assert.equal((await cat.list()).length, 3);
  });

  it('first failure does not cache an empty list for the full TTL', async () => {
    let n = 0;
    const { cat, tick } = catalog({ run: async () => { n++; if (n === 1) throw new Error('cold'); return OUT; }, retryMs: 30000, ttlMs: 900000 });
    assert.deepEqual(await cat.list(), []);
    tick(31000);
    assert.equal((await cat.list()).length, 3);
    assert.equal(n, 2);
  });

  it('failure backoff doubles from its base to 15 minutes and resets after success', async () => {
    let n = 0;
    const { cat, tick } = catalog({
      run: async () => { n++; if (n <= 2 || n === 4) throw new Error('down'); return OUT; },
      retryMs: 30000,
    });
    await cat.list();
    tick(30000); await cat.list();
    tick(30000); await cat.list();
    assert.equal(n, 2, 'second failure waits 60 seconds');
    tick(30000); await cat.list();
    assert.equal(n, 3, 'retry after doubled delay succeeds');
    tick(1100); await cat.list(); await cat.inflight;
    assert.equal(n, 4, 'later refresh can fail again');
    tick(30000); await cat.list();
    assert.equal(n, 5, 'success reset backoff to its 30 second base');
  });

  it('failure backoff is capped at 15 minutes', async () => {
    let n = 0;
    const { cat, tick } = catalog({ run: async () => { n++; throw new Error('down'); }, retryMs: 30000 });
    for (const wait of [0, 30000, 60000, 120000, 240000, 480000, 900000]) {
      if (wait) tick(wait);
      await cat.list();
    }
    assert.equal(n, 7);
    tick(899999); await cat.list(); assert.equal(n, 7);
    tick(1); await cat.list(); assert.equal(n, 8);
  });

  it('empty or banner-only result keeps last known models and retries after backoff', async () => {
    let banner = false;
    let n = 0;
    const { cat, tick } = catalog({ run: async () => { n++; return banner ? 'Fetching available models...\n' : OUT; }, ttlMs: 1000, retryMs: 30000 });
    await cat.list();
    banner = true; tick(1500);
    assert.equal((await cat.list()).length, 3);
    await cat.inflight;
    assert.equal((await cat.list()).length, 3);
    assert.equal(n, 2);
    tick(31000);
    await cat.list(); await cat.inflight;
    assert.equal(n, 3);
    assert.equal((await cat.list()).length, 3);
  });

  it('no account home gives empty list and run is not called', async () => {
    const { cat, calls } = catalog({ homeFor: () => null });
    assert.deepEqual(await cat.list(), []);
    assert.equal(calls.length, 0);
  });
});

describe('GET /v1/models with agy catalog', () => {
  let server, base;
  before(async () => {
    const { cat } = catalog();
    // Temp AGY paths: never the real accounts file or ~/.config/agy-homes.
    const agyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-test-'));
    server = createProxyServer(new AccountManager([], 0.98), { proxy: { apiKey: 'tc-admin' }, agy: { accountsPath: path.join(agyDir, 'agy.json') } }, { agyModels: cat }, null, null, null);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((r) => server.close(r)); });

  it('GET /v1/models answers within 2.5 seconds when a cold AGY catalog never resolves', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-hung-'));
    const hung = new AgyModelCatalog({ run: async () => new Promise(() => {}), homeFor: () => dir });
    const slowServer = createProxyServer(new AccountManager([], 0.98), {
      proxy: { apiKey: 'tc-admin' }, agy: { accountsPath: path.join(dir, 'agy.json') },
    }, { agyModels: hung }, null, null, null);
    await new Promise(r => slowServer.listen(0, '127.0.0.1', r));
    const started = Date.now();
    try {
      const res = await fetch(`http://127.0.0.1:${slowServer.address().port}/v1/models`, { headers: { authorization: 'Bearer tc-admin' } });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(Date.now() - started < 2500, `response took ${Date.now() - started}ms`);
      assert.deepEqual(body.data, [], 'no provider models are fabricated without configured accounts');
    } finally {
      await new Promise(r => slowServer.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /v1/models lists gemini ids and hides agy aliases', async () => {
    const res = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer tc-admin' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const items = body.data || body.models;
    const ids = items.map((m) => m.id);
    assert.ok(ids.includes('gemini-3.8-flash-high'));
    assert.ok(!ids.includes('agy') && !ids.includes('agy-fast'));
    assert.ok(!ids.includes('claude-sonnet-4-6-thinking'));
    const g = items.find((m) => m.id === 'gemini-3.8-flash-high');
    assert.equal(g.context_window, 1000000);
    assert.equal(g.max_tokens, 65536);
  });
});
