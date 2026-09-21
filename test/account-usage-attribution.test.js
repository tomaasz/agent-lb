import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { renderDashboardHtml } from '../src/dashboard.js';

describe('Account Limit Usage Attribution & Inspector', () => {
  function makeMockAccount(name = 'acc-1', quotaReset = null) {
    return {
      name,
      token: 'sk-ant-mock-token',
      provider: 'anthropic',
      quotaReset,
    };
  }

  it('records token usage broken down by client, model, and session', () => {
    const mgr = new AccountManager([makeMockAccount('work-account')]);

    mgr.recordTokenUsage(0, 'sess-123', 'claude-3-7-sonnet-20250219', {
      inputTokens: 100,
      outputTokens: 50,
      cacheTokens: 25,
      totalTokens: 175,
    }, {
      client: 'MacBook-Tom',
      project: 'agent-lb',
      sessionTitle: 'Refactor Usage Inspector',
    });

    // Record second request for same session & client
    mgr.recordTokenUsage(0, 'sess-123', 'claude-3-7-sonnet-20250219', {
      inputTokens: 200,
      outputTokens: 100,
      cacheTokens: 50,
      totalTokens: 350,
    }, {
      client: 'MacBook-Tom',
      project: 'agent-lb',
      sessionTitle: 'Refactor Usage Inspector',
    });

    // Record third request with different client and session
    mgr.recordTokenUsage(0, 'sess-456', 'claude-3-5-haiku-20241022', {
      inputTokens: 30,
      outputTokens: 10,
      cacheTokens: 0,
      totalTokens: 40,
    }, {
      client: 'CI-Runner',
      project: 'mobile-app',
      sessionTitle: 'Lint check',
    });

    const status = mgr.getStatus();
    const acc = status.accounts[0];
    assert.equal(acc.name, 'work-account');

    // byClient breakdown
    assert.ok(acc.usage.byClient['MacBook-Tom']);
    assert.equal(acc.usage.byClient['MacBook-Tom'].requests, 2);
    assert.equal(acc.usage.byClient['MacBook-Tom'].totalTokens, 525);
    assert.equal(acc.usage.byClient['MacBook-Tom'].inputTokens, 300);
    assert.equal(acc.usage.byClient['MacBook-Tom'].outputTokens, 150);
    assert.equal(acc.usage.byClient['MacBook-Tom'].cacheCreationTokens, 75);

    assert.ok(acc.usage.byClient['CI-Runner']);
    assert.equal(acc.usage.byClient['CI-Runner'].requests, 1);
    assert.equal(acc.usage.byClient['CI-Runner'].totalTokens, 40);

    // byModel breakdown
    assert.ok(acc.usage.byModel['claude-3-7-sonnet-20250219']);
    assert.equal(acc.usage.byModel['claude-3-7-sonnet-20250219'].requests, 2);
    assert.equal(acc.usage.byModel['claude-3-7-sonnet-20250219'].totalTokens, 525);

    assert.ok(acc.usage.byModel['claude-3-5-haiku-20241022']);
    assert.equal(acc.usage.byModel['claude-3-5-haiku-20241022'].requests, 1);
    assert.equal(acc.usage.byModel['claude-3-5-haiku-20241022'].totalTokens, 40);

    // bySession breakdown
    assert.ok(acc.usage.bySession['sess-123']);
    assert.equal(acc.usage.bySession['sess-123'].requests, 2);
    assert.equal(acc.usage.bySession['sess-123'].totalTokens, 525);
    assert.equal(acc.usage.bySession['sess-123'].title, 'Refactor Usage Inspector');
    assert.equal(acc.usage.bySession['sess-123'].project, 'agent-lb');
    assert.equal(acc.usage.bySession['sess-123'].client, 'MacBook-Tom');
    assert.equal(acc.usage.bySession['sess-123'].model, 'claude-3-7-sonnet-20250219');

    // recent history buffer
    assert.equal(acc.usage.recent.length, 3);
    assert.equal(acc.usage.recent[0].client, 'CI-Runner'); // newest first
    assert.equal(acc.usage.recent[0].totalTokens, 40);
    assert.equal(acc.usage.recent[1].client, 'MacBook-Tom');
    assert.equal(acc.usage.recent[1].totalTokens, 350);
  });

  it('enforces maximum boundary limits on sessions and recent items', () => {
    const mgr = new AccountManager([makeMockAccount('capped-account')]);

    // Push 120 sessions
    for (let i = 0; i < 120; i++) {
      mgr.recordTokenUsage(0, `session-${i}`, 'gpt-5.6', {
        inputTokens: 10,
        outputTokens: 5,
        cacheTokens: 0,
        totalTokens: 15,
      }, {
        client: `client-${i % 5}`,
      });
    }

    const status = mgr.getStatus();
    const acc = status.accounts[0];

    // MAX_SESSIONS_PER_ACCOUNT is 100
    const sessionKeys = Object.keys(acc.usage.bySession);
    assert.equal(sessionKeys.length, 100);
    // Oldest sessions should be pruned, newest should remain
    assert.ok(!sessionKeys.includes('session-0'));
    assert.ok(sessionKeys.includes('session-119'));

    // MAX_RECENT_USAGE_PER_ACCOUNT is 50
    assert.equal(acc.usage.recent.length, 50);
    assert.equal(acc.usage.recent[0].sessionId, 'session-119');
  });

  it('exports and restores usage attribution in quota state', () => {
    const mgr1 = new AccountManager([makeMockAccount('persist-acc')]);
    mgr1.recordTokenUsage(0, 'sess-abc', 'claude-3-7-sonnet', {
      inputTokens: 500,
      outputTokens: 200,
      cacheTokens: 100,
      totalTokens: 800,
    }, {
      client: 'DevBox',
      project: 'portal',
      sessionTitle: 'Fix OAuth',
    });

    const exported = mgr1.exportQuotaState();
    assert.ok(Array.isArray(exported));
    const savedAcc = exported.find(e => e.name === 'persist-acc');
    assert.ok(savedAcc);
    assert.ok(savedAcc.usage);
    assert.ok(savedAcc.usage.byClient['DevBox']);
    assert.equal(savedAcc.usage.byClient['DevBox'].totalTokens, 800);

    // Restore into a fresh AccountManager
    const mgr2 = new AccountManager([makeMockAccount('persist-acc')]);
    mgr2.restoreQuotaState(exported);

    const status2 = mgr2.getStatus();
    const restoredUsage = status2.accounts[0].usage;
    assert.ok(restoredUsage.byClient['DevBox']);
    assert.equal(restoredUsage.byClient['DevBox'].totalTokens, 800);
    assert.equal(restoredUsage.bySession['sess-abc'].title, 'Fix OAuth');
    assert.equal(restoredUsage.recent.length, 1);
    assert.equal(restoredUsage.recent[0].project, 'portal');
  });

  it('returns breakdown and supports resetting usage via AccountManager methods', () => {
    const mgr = new AccountManager([
      makeMockAccount('acc-one'),
      makeMockAccount('acc-two'),
    ]);

    mgr.recordTokenUsage(0, 'sess-1', 'm1', { totalTokens: 100 }, { client: 'Alice' });
    mgr.recordTokenUsage(1, 'sess-2', 'm2', { totalTokens: 200 }, { client: 'Bob' });

    const breakdown = mgr.getUsageBreakdown();
    assert.equal(breakdown.accounts.length, 2);
    assert.equal(breakdown.fleet.totalTokens, 300);
    assert.equal(breakdown.fleet.totalRequests, 2);
    assert.equal(breakdown.fleet.byClient['Alice'].totalTokens, 100);
    assert.equal(breakdown.fleet.byClient['Bob'].totalTokens, 200);

    // Reset only acc-one
    const resetOne = mgr.resetUsage('acc-one');
    assert.equal(resetOne, true);
    assert.equal(mgr.getUsageBreakdown().accounts[0].usage.totalTokens, 0);
    assert.equal(mgr.getUsageBreakdown().accounts[1].usage.totalTokens, 200);

    // Reset all accounts
    mgr.resetUsage(null);
    assert.equal(mgr.getUsageBreakdown().accounts[1].usage.totalTokens, 0);
    assert.equal(mgr.getUsageBreakdown().fleet.totalTokens, 0);
  });

  it('isolates internal usage object when retrieved via getStatus()', () => {
    const mgr = new AccountManager([makeMockAccount('acc-mut')]);
    mgr.recordTokenUsage(0, 'sess-1', 'm1', { totalTokens: 100 }, { client: 'Alice' });

    const status = mgr.getStatus();
    // Attempt mutating returned object
    status.accounts[0].usage.byClient['Alice'].totalTokens = 999999;
    status.accounts[0].usage.recent.length = 0;

    // Internal state should be untouched
    const freshStatus = mgr.getStatus();
    assert.equal(freshStatus.accounts[0].usage.byClient['Alice'].totalTokens, 100);
    assert.equal(freshStatus.accounts[0].usage.recent.length, 1);
  });

  it('serves /api/accounts/usage and /api/accounts/usage/reset via proxy server', async (t) => {
    const mgr = new AccountManager([
      makeMockAccount('test-srv-acc'),
    ]);
    mgr.recordTokenUsage(0, 'srv-sess', 'claude-3-7-sonnet', {
      inputTokens: 50,
      outputTokens: 25,
      cacheTokens: 0,
      totalTokens: 75,
    }, {
      client: 'Workstation-1',
      project: 'backend',
      sessionTitle: 'API test',
    });

    const config = {
      proxy: { apiKey: 'test-master-key' },
      accounts: [],
      autoHealthCheck: { enabled: false },
    };

    const server = createProxyServer(mgr, config);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });

    const base = 'http://127.0.0.1:' + server.address().port;

    // 1. GET /agent-lb/api/accounts/usage
    const resGet = await fetch(base + '/agent-lb/api/accounts/usage', {
      headers: { authorization: 'Bearer test-master-key' },
    });
    assert.equal(resGet.status, 200);
    const dataGet = await resGet.json();
    assert.equal(dataGet.ok, true);
    assert.equal(dataGet.accounts.length, 1);
    assert.equal(dataGet.accounts[0].name, 'test-srv-acc');
    assert.equal(dataGet.accounts[0].usage.totalTokens, 75);
    assert.equal(dataGet.fleet.byClient['Workstation-1'].totalTokens, 75);

    // 2. POST /agent-lb/api/accounts/usage/reset (for test-srv-acc)
    const resReset = await fetch(base + '/agent-lb/api/accounts/usage/reset', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-master-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ account: 'test-srv-acc' }),
    });
    assert.equal(resReset.status, 200);
    const dataReset = await resReset.json();
    assert.equal(dataReset.ok, true);

    // 3. Verify usage is 0 after reset
    const resAfter = await fetch(base + '/agent-lb/api/accounts/usage', {
      headers: { authorization: 'Bearer test-master-key' },
    });
    const dataAfter = await resAfter.json();
    assert.equal(dataAfter.accounts[0].usage.totalTokens, 0);
  });

  it('renders modal elements and usage action buttons in dashboard HTML', () => {
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="btnOpenFleetUsage"'), 'Fleet usage button must be in dashboard HTML');
    assert.ok(html.includes('id="modalAccountUsage"'), 'Account usage modal must be in dashboard HTML');
    assert.ok(html.includes('id="modalFleetUsage"'), 'Fleet usage modal must be in dashboard HTML');
    assert.ok(html.includes('id="tabBtnUsageClients"'), 'Clients tab button must be in modal');
    assert.ok(html.includes('id="tabBtnUsageSessions"'), 'Sessions tab button must be in modal');
    assert.ok(html.includes('id="tabBtnUsageRecent"'), 'Recent tab button must be in modal');
    assert.ok(html.includes('id="tblUsageClients"'), 'Clients table must be in modal');
    assert.ok(html.includes('id="tblUsageSessions"'), 'Sessions table must be in modal');
    assert.ok(html.includes('id="tblUsageRecent"'), 'Recent table must be in modal');
  });
});
