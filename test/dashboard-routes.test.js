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
