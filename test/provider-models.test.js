import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ProviderModelCatalog, codexModelClientVersion } from '../src/provider-models.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const claude = { name: 'claude', provider: 'anthropic', type: 'oauth', credential: 'claude-secret' };
const codex = { name: 'codex', provider: 'codex', type: 'oauth', credential: 'codex-secret', accountId: 'account-scope' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(accounts = [claude], options = {}) {
  let now = 0;
  let data = { data: [{ id: 'claude-live', display_name: 'Claude Live' }] };
  let status = 200;
  const calls = [];
  const catalog = new ProviderModelCatalog({ accounts: () => accounts, now: () => now,
    ttlMs: 100, maxStaleMs: 300, retryMs: 20,
    fetch: async (...args) => { calls.push(args); return response(data, status); }, ...options });
  return { catalog, accounts, calls, setData: d => { data = d; }, setStatus: s => { status = s; }, tick: t => { now += t; } };
}

test('client version follows query, client user-agent, configured default; invalid input is ignored', () => {
  const req = { headers: { 'user-agent': 'codex_cli_rs/0.170.0 (Linux)' } };
  assert.equal(codexModelClientVersion(req, new URLSearchParams('client_version=0.171.0'), {}), '0.171.0');
  assert.equal(codexModelClientVersion(req, new URLSearchParams('client_version=invalid'), {}), '0.170.0');
  assert.equal(codexModelClientVersion({ headers: {} }, new URLSearchParams(), { models: { codexClientVersion: '0.172.0' } }), '0.172.0');
});

test('TTL refresh replaces the list, discovers new models and removes retired ones without restart', async () => {
  const f = fixture();
  assert.deepEqual((await f.catalog.list()).map(m => m.id), ['claude-live']);
  f.setData({ data: [{ id: 'claude-future' }] });
  await f.catalog.list();
  assert.equal(f.calls.length, 1);
  f.tick(101);
  assert.deepEqual((await f.catalog.list()).map(m => m.id), ['claude-future']);
  assert.equal(f.calls.length, 2);
  f.setData({ data: [] }); f.tick(101);
  assert.deepEqual(await f.catalog.list(), [], 'an empty successful response clears old models');
});

test('provider-specific authentication, pagination and per-version Codex caching', async () => {
  const calls = [];
  const catalog = new ProviderModelCatalog({ accounts: () => [claude, codex,
    { name: 'api', provider: 'codex', type: 'api-key', credential: 'api-secret' }],
    fetch: async (url, opts) => {
      calls.push({ url: new URL(url), headers: opts.headers });
      if (url.includes('anthropic')) return response({ data: [{ id: url.includes('after_id') ? 'claude-second' : 'claude-first' }],
        has_more: !url.includes('after_id'), last_id: 'claude-first' });
      if (url.includes('api.openai')) return response({ data: [{ id: 'gpt-api-only' }] });
      return response({ models: [{ slug: 'gpt-future', context_window: 1234567, visibility: 'hide', default_reasoning_level: 'high' }] });
    } });
  const models = await catalog.list('0.170.0');
  assert.deepEqual(models.map(m => m.id).sort(), ['claude-first', 'claude-second', 'gpt-api-only', 'gpt-future']);
  const anth = calls.find(c => c.url.hostname === 'api.anthropic.com');
  assert.equal(anth.headers.authorization, 'Bearer claude-secret');
  assert.equal(anth.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(anth.headers['anthropic-version'], '2023-06-01');
  assert.equal(anth.url.searchParams.get('limit'), '100');
  const subscription = calls.find(c => c.url.hostname === 'chatgpt.com');
  assert.equal(subscription.url.pathname, '/backend-api/codex/models');
  assert.equal(subscription.url.searchParams.get('client_version'), '0.170.0');
  assert.equal(subscription.headers['chatgpt-account-id'], 'account-scope');
  assert.equal(subscription.headers.authorization, 'Bearer codex-secret');
  assert.equal(subscription.headers.originator, 'codex_cli_rs');
  assert.equal(models.find(m => m.id === 'gpt-future').visibility, 'hide');
  assert.equal(calls.find(c => c.url.hostname === 'api.openai.com').headers.authorization, 'Bearer api-secret');
  await catalog.list('0.171.0');
  assert.equal(calls.filter(c => c.url.hostname === 'chatgpt.com').length, 2);
  assert.equal(calls.filter(c => c.url.hostname === 'api.anthropic.com').length, 2, 'Claude cache is independent of Codex version');
});

test('combines account entitlements, deduplicates IDs and isolates failed accounts', async () => {
  const catalog = new ProviderModelCatalog({ accounts: () => [claude, codex, { ...codex, name: 'revoked', credential: 'revoked' }],
    fetch: async (_url, opts) => {
      if (opts.headers.authorization === 'Bearer revoked') return response({}, 401);
      return response(opts.headers.authorization === 'Bearer claude-secret' ? { data: [{ id: 'claude-live' }] }
        : { models: [{ slug: 'gpt-new' }, { slug: 'gpt-new' }] });
    } });
  assert.deepEqual((await catalog.list()).map(m => m.id), ['claude-live', 'gpt-new']);
  assert.equal(catalog.status().codex.unavailable, true);
});

test('transient failure retains bounded stale data, backs off and never falls back to static IDs', async () => {
  const f = fixture(); await f.catalog.list();
  f.tick(101); f.setStatus(500);
  assert.equal((await f.catalog.list()).length, 1);
  assert.equal(f.catalog.status().anthropic.stale, true);
  await f.catalog.list(); assert.equal(f.calls.length, 2, 'failed refresh is backed off');
  f.tick(201);
  assert.deepEqual(await f.catalog.list(), [], 'expired data is no longer advertised');
  assert.equal(f.catalog.status().anthropic.unavailable, true);
});

for (const status of [401, 403]) test(`HTTP ${status} removes previously cached entitlements immediately`, async () => {
  const f = fixture(); await f.catalog.list(); f.tick(101); f.setStatus(status);
  assert.deepEqual(await f.catalog.list(), []);
});

test('disabled, removed and recredentialed accounts cannot inherit old entitlements', async () => {
  const accounts = [{ ...claude }];
  const f = fixture(accounts); await f.catalog.list();
  accounts[0].disabled = true;
  assert.deepEqual(await f.catalog.list(), []);
  accounts[0].disabled = false; accounts[0].credential = 'rotated'; f.setStatus(401);
  assert.deepEqual(await f.catalog.list(), []);
  assert.equal(f.calls[1][1].headers.authorization, 'Bearer rotated');
  accounts.splice(0);
  assert.deepEqual(await f.catalog.list(), []);
  assert.equal(f.catalog.cache.size, 0);
});

test('malformed pagination keeps last complete catalog instead of publishing a partial list', async () => {
  const f = fixture(); await f.catalog.list(); f.tick(101);
  f.setData({ data: [{ id: 'partial' }], has_more: true, last_id: 'repeated' });
  assert.deepEqual((await f.catalog.list()).map(m => m.id), ['claude-live']);
  assert.equal(f.catalog.status().anthropic.stale, true);
});

test('cold discovery is bounded and concurrent requests share the same fetch', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  let finish;
  const f = fixture([claude], { waitMs: 20, fetch: () => new Promise(resolve => { finish = resolve; }) });
  assert.deepEqual(await f.catalog.list(), []);
  assert.deepEqual(await f.catalog.list(), []);
  finish(response({ data: [{ id: 'claude-after-delay' }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await f.catalog.list()).map(m => m.id), ['claude-after-delay']);
});

test('disabling an account during a catalog fetch prevents its models from leaking into the result', async () => {
  let finish;
  const accounts = [{ ...claude }];
  const f = fixture(accounts, { fetch: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.catalog.list();
  accounts[0].disabled = true;
  finish(response({ data: [{ id: 'claude-disabled' }] }));
  assert.deepEqual(await pending, []);
});

test('HTTP integration: authenticates discovery, respects upstream override, refreshes IDs and preserves live Codex metadata', async t => {
  let ids = ['gpt-6.1-sol', 'gpt-6.1-terra'];
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits++;
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    assert.equal(new URL(req.url, 'http://fixture').pathname, '/gateway/backend-api/codex/models');
    assert.equal(new URL(req.url, 'http://fixture').searchParams.get('client_version'), '0.170.0');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: ids.map(slug => ({ slug, context_window: 777777,
      max_output_tokens: 55555, default_reasoning_level: 'low', visibility: 'list', custom_live_field: true })) }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const am = new AccountManager([{ ...codex, accessToken: 'synthetic-token', credential: 'synthetic-token',
    upstream: `http://127.0.0.1:${upstream.address().port}/gateway` }]);
  const catalog = new ProviderModelCatalog({ accounts: () => am.accounts, ttlMs: 0 });
  const server = createProxyServer(am, { proxy: { apiKey: 'synthetic-admin' } }, {
    providerModels: catalog, agyModels: { list: async () => [] },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/models?client_version=0.170.0`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(hits, 0);
  const get = async () => (await fetch(url, { headers: { 'x-api-key': 'synthetic-admin' } })).json();
  const body = await get();
  assert.deepEqual(body.data.map(m => m.id), ids);
  assert.equal(body.data[0].context_window, 777777);
  assert.equal(body.data[0].max_input_tokens, 777777);
  assert.equal(body.data[0].max_output_tokens, 55555);
  assert.equal(body.data[0].default_reasoning_level, 'low');
  assert.equal(body.data[0].custom_live_field, true);
  ids = ['gpt-brand-new'];
  assert.deepEqual((await get()).data.map(m => m.id), ids);
  am.accounts[0].disabled = true;
  assert.deepEqual((await get()).data, []);
});

test('concurrent client-version changes cannot exceed the discovery cache or active fetch limit', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const finish = [];
  const catalog = new ProviderModelCatalog({ accounts: () => [codex], waitMs: 5,
    fetch: () => new Promise(resolve => { finish.push(resolve); }) });
  await Promise.all(Array.from({ length: 100 }, (_, i) => catalog.list(`0.${i}.0`)));
  assert.equal(catalog.cache.size, 64);
  assert.equal(finish.length, 64, 'extra client versions do not start upstream work');
  assert.equal(catalog.status('0.999.0').codex.unavailable, true);
  for (const resolve of finish) resolve(response({ models: [] }));
  await new Promise(resolve => setImmediate(resolve));
  const result = catalog.list('0.999.0');
  finish.at(-1)(response({ models: [{ slug: 'gpt-after-slot-freed' }] }));
  assert.deepEqual((await result).map(m => m.id), ['gpt-after-slot-freed']);
});
