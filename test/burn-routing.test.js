import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const mk = (name, accessToken) => ({ name, accessToken, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

// The two accounts from the dashboard: #1 session 41% resetting in 56 min with
// the week at 5% (6.7d left); #2 session untouched with the week at 53% and
// 1.8 days left.
function fleet(config) {
  const mgr = new AccountManager([mk('one', 'a'), mk('two', 'b')], 0.98, { expiryRouting: config });
  const now = Date.now();
  const [one, two] = mgr.accounts;
  Object.assign(one.quota, {
    unified5h: 0.41, unified5hReset: now + 56 * 60_000,
    unified7d: 0.05, unified7dReset: now + 6.7 * 86400_000,
  });
  Object.assign(two.quota, {
    unified5h: 0, unified5hReset: null,
    unified7d: 0.53, unified7dReset: now + 1.8 * 86400_000,
  });
  return mgr;
}

describe('burn routing through AccountManager', () => {
  it('sends a new session to the account whose week is expiring, not the session-burn one', () => {
    const mgr = fleet({ enabled: true });
    assert.equal(mgr.getActiveAccount(null, null, null, 'new-session').name, 'two');
  });

  it('moves a session pinned to the other account (weekly burn preempts the pin)', () => {
    const mgr = fleet({ enabled: true });
    mgr.recordSession?.('s1', 0, 'unified7d');
    mgr.currentIndex = 0;
    assert.equal(mgr.getActiveAccount(null, null, null, 's1').name, 'two');
    assert.equal(mgr.getActiveAccount().name, 'two');
  });

  it('keeps the pin when preemptPinned is off', () => {
    const mgr = fleet({ enabled: true, weeklyBurn: { preemptPinned: false } });
    mgr.currentIndex = 0;
    assert.equal(mgr.getActiveAccount().name, 'one');
  });

  it('session burn still applies when no week is expiring', () => {
    const mgr = fleet({ enabled: true });
    mgr.accounts[1].quota.unified7dReset = Date.now() + 6 * 86400_000;
    mgr.accounts[1].quota.unified7d = 0.05;
    mgr.currentIndex = 1;
    assert.equal(mgr.getActiveAccount().name, 'one');
  });
});

describe('weekly burn across priority tiers', () => {
  const tiered = config => {
    const mgr = fleet(config);
    mgr.accounts[0].priority = 0;
    mgr.accounts[1].priority = 1;
    mgr.currentIndex = 0;
    return mgr;
  };
  it('spends a fallback account whose week is expiring', () => {
    assert.equal(tiered({ enabled: true }).getActiveAccount(null, null, null, 's').name, 'two');
    assert.equal(tiered({ enabled: true }).getActiveAccount().name, 'two');
  });
  it('keeps operator priority when crossPriority is off', () => {
    assert.equal(tiered({ enabled: true, weeklyBurn: { crossPriority: false } }).getActiveAccount().name, 'one');
  });
});
