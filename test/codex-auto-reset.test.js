import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CODEX_RESET_THRESHOLD,
  isAutoResetConfigured,
  resolveResetThreshold,
  isCodexAccountNearLimit,
  isCodexResetEligible,
  triggerCodexAutoReset,
} from '../src/codex-reset.js';
import { AccountManager } from '../src/account-manager.js';

describe('Codex Auto-Reset Mechanism (R205)', () => {
  describe('Threshold detection (<10% limit / >=90% utilization)', () => {
    it('detects <10% remaining limit based on 5h utilization', () => {
      const acctBelow = {
        name: 'codex-1',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.89 },
      };
      assert.equal(isCodexAccountNearLimit(acctBelow, 0.90), false);

      const acctAtThreshold = {
        name: 'codex-1',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.90 },
      };
      assert.equal(isCodexAccountNearLimit(acctAtThreshold, 0.90), true);

      const acctCritical = {
        name: 'codex-1',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.96 },
      };
      assert.equal(isCodexAccountNearLimit(acctCritical, 0.90), true);
    });

    it('detects exhausted account status as critical quota', () => {
      const acctExhausted = {
        name: 'codex-1',
        provider: 'codex',
        type: 'oauth',
        status: 'exhausted',
        quota: { unified5h: null },
      };
      assert.equal(isCodexAccountNearLimit(acctExhausted, 0.90), true);
    });

    it('detects weekly window critical quota', () => {
      const acctWeeklyCritical = {
        name: 'codex-1',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.50, unified7d: 0.92 },
      };
      assert.equal(isCodexAccountNearLimit(acctWeeklyCritical, 0.90), true);
    });

    it('rejects non-Codex or non-OAuth accounts', () => {
      const claudeAcct = {
        name: 'claude-1',
        provider: 'anthropic',
        type: 'oauth',
        quota: { unified5h: 0.95 },
      };
      assert.equal(isCodexAccountNearLimit(claudeAcct, 0.90), false);

      const apiKeyAcct = {
        name: 'codex-key',
        provider: 'codex',
        type: 'api-key',
        quota: { unified5h: 0.95 },
      };
      assert.equal(isCodexAccountNearLimit(apiKeyAcct, 0.90), false);

      const disabledAcct = {
        name: 'codex-disabled',
        provider: 'codex',
        type: 'oauth',
        disabled: true,
        quota: { unified5h: 0.95 },
      };
      assert.equal(isCodexAccountNearLimit(disabledAcct, 0.90), false);
    });

    it('evaluates eligibility via isCodexResetEligible', () => {
      const eligibleAcct = {
        name: 'codex-elig',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.95 },
      };
      assert.deepEqual(isCodexResetEligible(eligibleAcct, { threshold: 0.90 }), { eligible: true });

      assert.equal(isCodexResetEligible(eligibleAcct, { enabled: false }).eligible, false);
      assert.equal(isCodexResetEligible({ ...eligibleAcct, _resetInProgress: true }).eligible, false);
      assert.equal(isCodexResetEligible({ ...eligibleAcct, _resetCooldownUntil: Date.now() + 10000 }).eligible, false);
      assert.equal(isCodexResetEligible({ ...eligibleAcct, quota: { unified5h: 0.50 } }).eligible, false);
    });
  });

  describe('Feature flag and configuration', () => {
    it('resolves feature flag status correctly', () => {
      assert.equal(isAutoResetConfigured(true), true);
      assert.equal(isAutoResetConfigured(false), false);
      assert.equal(isAutoResetConfigured({ enabled: true }), true);
      assert.equal(isAutoResetConfigured({ enabled: false }), false);
      assert.equal(isAutoResetConfigured(undefined, { AGENTLB_AUTO_RESET_CREDITS: 'false' }), false);
      assert.equal(isAutoResetConfigured(false, { AGENTLB_AUTO_RESET_CREDITS: 'true' }), true);
    });

    it('resolves threshold from options or environment', () => {
      assert.equal(resolveResetThreshold(undefined, {}), DEFAULT_CODEX_RESET_THRESHOLD);
      assert.equal(resolveResetThreshold({ threshold: 0.85 }, {}), 0.85);
      assert.equal(resolveResetThreshold(undefined, { AGENTLB_AUTO_RESET_THRESHOLD: '0.80' }), 0.80);
    });

    it('AccountManager respects autoResetCredits flag', () => {
      const amEnabled = new AccountManager([], 0.98, { autoResetCredits: true });
      assert.equal(amEnabled.isAutoResetEnabled(), true);

      const amDisabled = new AccountManager([], 0.98, { autoResetCredits: false });
      assert.equal(amDisabled.isAutoResetEnabled(), false);

      const amAccountOverride = new AccountManager([
        { name: 'acct-off', provider: 'codex', type: 'oauth', autoResetCredits: false },
        { name: 'acct-on', provider: 'codex', type: 'oauth' },
      ], 0.98, { autoResetCredits: true });

      assert.equal(amAccountOverride.isAutoResetEnabled(amAccountOverride.accounts[0]), false);
      assert.equal(amAccountOverride.isAutoResetEnabled(amAccountOverride.accounts[1]), true);
    });
  });

  describe('Concurrency protection and mutex', () => {
    it('skips auto-reset if another reset is already in progress', async () => {
      const acct = {
        name: 'codex-concurrent',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.95 },
        _resetInProgress: true,
      };
      const am = { accounts: [acct] };

      const res = await triggerCodexAutoReset(am, 0, { enabled: true });
      assert.equal(res.ok, false);
      assert.equal(res.skipped, true);
      assert.equal(res.reason, 'reset_in_progress');
    });

    it('releases _resetInProgress lock even when consume throws', async () => {
      const acct = {
        name: 'codex-throw',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.95 },
      };
      const am = { accounts: [acct] };

      const res = await triggerCodexAutoReset(am, 0, {
        consumeFn: async () => { throw new Error('Network timeout'); },
      });

      assert.equal(res.ok, false);
      assert.equal(acct._resetInProgress, false);
      assert.equal(acct._resetFailures, 1);
      assert.match(acct._lastResetError, /Network timeout/);
    });
  });

  describe('Loop prevention and error cooldown backoff', () => {
    it('applies cooldown after failed reset attempt', async () => {
      const acct = {
        name: 'codex-fail',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.95 },
      };
      const am = { accounts: [acct] };

      const res = await triggerCodexAutoReset(am, 0, {
        consumeFn: async () => ({ ok: false, error: 'ChatGPT API 500' }),
      });

      assert.equal(res.ok, false);
      assert.equal(acct._resetFailures, 1);
      assert.ok(acct._resetCooldownUntil > Date.now());

      // Second attempt immediately afterwards is blocked by cooldown
      const retryRes = await triggerCodexAutoReset(am, 0, {});
      assert.equal(retryRes.ok, false);
      assert.equal(retryRes.skipped, true);
      assert.equal(retryRes.reason, 'cooldown_active');
    });

    it('escalates to extended cooldown after 3 consecutive failures', async () => {
      const acct = {
        name: 'codex-repeated-fail',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.95 },
        _resetFailures: 2,
      };
      const am = { accounts: [acct] };

      const res = await triggerCodexAutoReset(am, 0, {
        consumeFn: async () => ({ ok: false, error: 'Rate limit error' }),
      });

      assert.equal(res.ok, false);
      assert.equal(acct._resetFailures, 3);
      // Cooldown should be around 15 minutes (900,000 ms)
      assert.ok(res.cooldownMs >= 15 * 60 * 1000);
    });

    it('applies 5-minute cooldown when zero credits are available', async () => {
      const acct = {
        name: 'codex-no-credits',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.95 },
      };
      const am = { accounts: [acct] };

      const res = await triggerCodexAutoReset(am, 0, {
        consumeFn: async () => ({ ok: false, error: 'Brak dostępnych kredytów resetu dla tego konta.' }),
      });

      assert.equal(res.ok, false);
      assert.equal(acct.quota.resetCredits.available, 0);
      assert.ok(res.cooldownMs >= 5 * 60 * 1000);
    });
  });

  describe('Successful reset and status recovery', () => {
    it('resets quota, clears exhausted status, and updates audit log', async () => {
      const acct = {
        name: 'codex-success',
        provider: 'codex',
        type: 'oauth',
      };
      const am = new AccountManager([acct], 0.98, { autoResetCredits: true });
      am.accounts[0].status = 'exhausted';
      am.accounts[0].exhaustedUntil = Date.now() + 3600_000;
      am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
      am.accounts[0].lastError = { reason: 'quota', status: 429 };
      am.accounts[0].quota.unified5h = 1.0;
      am.accounts[0].quota.resetCredits = { available: 2 };

      const res = await triggerCodexAutoReset(am, 0, {
        consumeFn: async () => {
          // Simulate successful consume
          am.accounts[0].quota.unified5h = 0.0;
          am.accounts[0].quota.resetCredits.available = 1;
          return { ok: true, creditId: 'credit-uuid-xyz', data: { success: true } };
        },
      });

      assert.equal(res.ok, true);
      assert.equal(res.creditId, 'credit-uuid-xyz');
      assert.equal(am.accounts[0].status, 'active');
      assert.equal(am.accounts[0].exhaustedUntil, null);
      assert.equal(am.accounts[0].rateLimitedUntil, null);
      assert.equal(am.accounts[0].lastError, null);
      assert.equal(am.accounts[0]._resetFailures, 0);
      assert.ok(am.accounts[0]._lastResetSuccessAt > 0);

      // Verify audit log
      const audit = am.getResetAuditLog();
      assert.equal(audit.length, 1);
      assert.equal(audit[0].account, 'codex-success');
      assert.equal(audit[0].creditId, 'credit-uuid-xyz');
      assert.equal(audit[0].success, true);
      assert.equal(audit[0].previous5h, 1.0);
      assert.equal(audit[0].new5h, 0.0);

      // Status output check
      const status = am.getStatus();
      assert.equal(status.autoReset.enabled, true);
      assert.equal(status.autoReset.threshold, 0.90);
      assert.equal(status.autoReset.history.length, 1);
      assert.equal(status.accounts[0].resetInProgress, false);
      assert.ok(status.accounts[0].lastResetSuccessAt != null);
    });
  });

  describe('End-to-end trigger integration', () => {
    it('automatically triggers reset when response headers report >=90% utilization', async () => {
      const acct = {
        name: 'codex-live',
        provider: 'codex',
        type: 'oauth',
        quota: { unified5h: 0.20, resetCredits: { available: 1 } },
      };
      const am = new AccountManager([acct], 0.98, { autoResetCredits: true });

      let consumeCalled = false;
      am.consumeResetCredit = async () => {
        consumeCalled = true;
        am.accounts[0].quota.unified5h = 0.0;
        return { ok: true, creditId: 'auto-credit-1' };
      };

      // Upstream response with 94% utilization (<10% limit remaining)
      const headers = {
        'x-codex-primary-used-percent': '94',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
      };

      am.updateQuota(0, headers);

      // Allow async auto-reset promise tick
      await new Promise(r => setTimeout(r, 20));

      assert.equal(consumeCalled, true);
      assert.equal(am.accounts[0].quota.unified5h, 0.0);
      assert.equal(am.getResetAuditLog()[0].success, true);
    });
  });
});
