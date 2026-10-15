import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { renderDashboardHtml } from '../src/dashboard.js';

describe('dashboard views have their own addresses', () => {
  let server, base;
  before(async () => {
    server = createProxyServer(new AccountManager([], 0.98), { proxy: { apiKey: 'tc-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise(resolve => server.close(resolve)); });

  it('serves the dashboard page for every view address', async () => {
    for (const path of ['/dashboard', '/dashboard/accounts', '/dashboard/accounts/agy', '/dashboard/workstations', '/dashboard/workstations/new', '/dashboard/usage', '/dashboard/chat', '/agent-lb/dashboard/workstations', '/dashboard/workstations/']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/html/, path);
      assert.ok((await res.text()).includes('id="mainNavTabs"'), path);
    }
  });

  it('does not turn arbitrary paths into the page', async () => {
    for (const path of ['/dashboard/a/b/c', '/dashboard/UPPER', '/dashboard/a..b', '/dashboard/x.js']) {
      const res = await fetch(base + path);
      assert.ok(!(res.headers.get('content-type') || '').includes('text/html') || res.status !== 200, path);
    }
  });

  it('knows every view in the page script', () => {
    const html = renderDashboardHtml();
    for (const view of ['accounts', 'accounts/agy', 'accounts/add', 'workstations', 'workstations/new', 'usage', 'chat']) {
      assert.ok(html.includes(`'${view}': {`), view);
    }
    assert.ok(html.includes("window.addEventListener('popstate'"));
  });
});

describe('dashboard AGY column (same card vocabulary as Claude and Codex)', () => {
  const html = renderDashboardHtml();
  const grid = html.slice(html.indexOf('id="accountsGrid"'), html.indexOf('id="tabWorkstations"'));

  it('puts AGY in the accounts grid next to Claude and Codex', () => {
    assert.ok(grid.includes('id="colClaude"') && grid.includes('id="colCodex"') && grid.includes('id="colAgy"'));
    assert.ok(grid.indexOf('id="colCodex"') < grid.indexOf('id="colAgy"'));
    assert.match(grid, /<div class="account-col" id="colAgy">/);
    assert.match(grid, /<div class="account-list" id="listAgy" data-provider="agy"><\/div>/);
    // The login button lives in the column header, like "Dodaj konto" of the other columns.
    const col = grid.slice(grid.indexOf('id="colAgy"'));
    assert.ok(col.indexOf('id="btnAgyLogin"') > 0 && col.indexOf('id="btnAgyLogin"') < col.indexOf('id="listAgy"'));
    assert.match(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.ok(!html.includes('class="agy-section"'), 'no separate narrow section any more');
  });

  it('has the card controls, the Test call and PL/EN strings', () => {
    assert.ok(html.includes("'/agent-lb/api/agy/accounts/test'"));
    for (const key of ['agyTest', 'agyTestRunning', 'agyTestOk', 'agyBusy', 'agyResetsIn', 'agyHealthy', 'agyLimitSpent']) {
      assert.equal((html.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 2, `${key} in PL and EN`);
    }
    for (const action of ['accounts/pin', 'accounts/enable', 'accounts/clear-quota', 'accounts/remove', 'accounts/reorder']) {
      assert.ok(html.includes(`'${action}'`), action);
    }
    const agyJs = html.slice(html.indexOf('function renderAgyAccounts'), html.indexOf('function agyEl'));
    assert.ok(agyJs.length > 0 && !agyJs.includes('innerHTML'));
  });

  it('shows a Gemini row in the routing table from AGY data', () => {
    const routes = html.slice(html.indexOf('function renderRoutes'), html.indexOf('function renderProblems'));
    assert.ok(routes.includes('agyRouteRow'));
    const row = html.slice(html.indexOf('function agyRouteRow'), html.indexOf('function agyEl'));
    assert.ok(row.includes("'Gemini '") && row.includes("'gemini-*'") && row.includes('agyData.models') && row.includes('agyAvailable'));
    assert.equal((html.match(/\bagyRouteOf:/g) || []).length, 2, 'N of M word in PL and EN');
  });

  it('saves a drag in the AGY list through the AGY reorder action', () => {
    const save = html.slice(html.indexOf('function saveReorderedList'), html.indexOf('function moveToTop'));
    assert.ok(save.includes("dataset.provider === 'agy'") && save.includes('agyReorder'));
  });
});

describe('dashboard t() placeholder substitution', () => {
  it('inserts parameters literally, even when they contain replacement patterns', () => {
    const html = renderDashboardHtml();
    const src = html.slice(html.indexOf('function t(key, params)'), html.indexOf('function updateI18nDOM'));
    assert.ok(src.length > 0);
    const t = new Function('I18N', 'currentLang', `${src}; return t;`)({ pl: { x: 'blad: {error}' }, en: {} }, 'pl');
    assert.equal(t('x', { error: "$& $' $` $$ done" }), "blad: $& $' $` $$ done");
  });
});
