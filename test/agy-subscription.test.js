import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { AgyAccountStore, TOKEN_PATH } from '../src/agy-accounts.js';
import { agySubscriptionFrom, createAgySubscriptionRefresh } from '../src/agy-subscription.js';
import { renderDashboardHtml } from '../src/dashboard.js';
import vm from 'node:vm';

test('Google paid tier takes precedence; unknown plans are preserved without guessing', () => {
  assert.deepEqual(agySubscriptionFrom({ paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra', secret: 'hidden' }, currentTier: { id: 'free-tier' } }), { id: 'g1-ultra-tier', name: 'Google AI Ultra' });
  assert.deepEqual(agySubscriptionFrom({ currentTier: { id: 'future-tier' } }), { id: 'future-tier', name: 'future-tier' });
  assert.equal(agySubscriptionFrom({ allowedTiers: [{ id: 'g1-pro-tier' }] }), null);
  assert.equal(agySubscriptionFrom({ currentTier: { id: 123, name: {} } }), null);
});

test('refresh reads the refreshed worker token, deduplicates requests and keeps old metadata on failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-subscription-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AgyAccountStore(join(dir, 'accounts.json'), () => 1234);
  // No production credentials or files are involved.
  store.data.accounts.push({ id: 'agy-123456789abc', email: 'a@example.com', token: { token: { refresh_token: 'never-public' }, id_token: `h.${Buffer.from(JSON.stringify({email:'a@example.com'})).toString('base64url')}.s` } });
  const tokenFile = join(dir, ...TOKEN_PATH);
  let runs = 0, calls = 0, fail = false;
  const refresh = createAgySubscriptionRefresh({
    store, pool: { ensureHome: id => { assert.equal(id, 'agy-123456789abc'); return dir; } },
    run: async home => {
      assert.equal(home, dir);
      runs++;
      mkdirSync(dirname(tokenFile), { recursive: true });
      writeFileSync(tokenFile, JSON.stringify({ token: { access_token: 'fresh-secret' } }));
    },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
      assert.equal(options.headers.Authorization, 'Bearer fresh-secret');
      assert.deepEqual(JSON.parse(options.body), { metadata: { ideType: 'ANTIGRAVITY' } });
      if (fail) throw new Error('upstream leaked fresh-secret');
      return new Response(JSON.stringify({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro', token: 'hidden' } }));
    },
  });
  const first = refresh('agy-123456789abc');
  assert.equal(refresh('agy-123456789abc'), first);
  assert.deepEqual(await first, { ok: true });
  assert.equal(runs, 1);
  assert.equal(calls, 1);
  const expected = { id: 'g1-pro-tier', name: 'Google AI Pro', updatedAt: 1234 };
  assert.deepEqual(store.list()[0].subscription, expected);
  assert.deepEqual(new AgyAccountStore(store.path).list()[0].subscription, expected);
  assert.ok(!JSON.stringify(store.list()).includes('secret'));
  // An old station omits the plan; a malformed update must not erase it either.
  store.setUsage('agy-123456789abc', [], undefined);
  store.setUsage('agy-123456789abc', [], { name: {} });
  assert.deepEqual(store.list()[0].subscription, expected);
  fail = true;
  const failure = await refresh('agy-123456789abc');
  assert.equal(failure.ok, false);
  assert.ok(!failure.error.includes('fresh-secret'));
  assert.deepEqual(store.list()[0].subscription, expected);
  assert.equal((await refresh('missing')).ok, false);
});

test('a synchronous worker error does not leave refresh stuck in flight', async () => {
  let runs = 0;
  const refresh = createAgySubscriptionRefresh({
    store: { _find: () => ({}) },
    pool: { ensureHome: () => { runs++; throw new Error('secret'); } },
  });
  assert.equal((await refresh('agy-123456789abc')).ok, false);
  assert.equal((await refresh('agy-123456789abc')).ok, false);
  assert.equal(runs, 2);
});

test('account cards render Google plan names as text and expose refresh in both languages', () => {
  const html = renderDashboardHtml();
  const code = html.slice(html.indexOf('function renderAgyCard('), html.indexOf('function renderAgyAccounts('));
  function el(tag, className, textContent) {
    return { tag, className, textContent, children: [], dataset: {}, style: {},
      appendChild(node) { this.children.push(node); }, addEventListener() {} };
  }
  for (const lang of ['pl', 'en']) {
    const controls = [];
    const context = vm.createContext({
      el, t: key => key, agyT: (pl, en) => lang === 'pl' ? pl : en,
      agyData: {queue:[],events:[]}, agyTests: {}, agySubscriptionBusy: {}, attachCardDragListeners() {},
      agyIconButton: (label, title, action) => { const b = el('button', '', label); b.title = title; b.action = action; controls.push(b); return b; },
      agyUsageBlock: () => el('div'), fmtNum: String,
    });
    vm.runInContext(code, context);
    const account = { id: 'agy-123456789abc', email: 'a@example.com', enabled: true };
    const card = context.renderAgyCard(account, 0, ['agy-123456789abc']);
    const badges = card.children[0].children[0].children;
    assert.ok(badges.some(n => n.textContent === (lang === 'pl' ? 'Plan nieznany' : 'Unknown plan')));
    assert.ok(controls.some(n => n.title === (lang === 'pl' ? 'Odśwież subskrypcję Google' : 'Refresh Google subscription')));
    account.subscription = { name: '<img src=x onerror=alert(1)>', id: 'future-tier' };
    const named = context.renderAgyCard(account, 0, ['agy-123456789abc']);
    const plan = named.children[0].children[0].children.find(n => n.textContent === account.subscription.name);
    assert.ok(plan);
    assert.equal(plan.children.length, 0);
    account.name = 'Profil testowy';
    const renamed = context.renderAgyCard(account, 0, ['agy-123456789abc']);
    assert.equal(renamed.children[1].children[0].children[0].textContent, 'Profil testowy');
    assert.equal(renamed.children[2].textContent, account.email);
    assert.ok(renamed.children[1].children[0].children.some(n => n.textContent === '✏️'));
  }
});
