// Automated Rate Limit Reset Support for OpenAI Codex CLI
//
// Handles automated consumption of OpenAI WHAM RateLimitResetCredit when
// remaining quota drops below 10% (utilization >= 90% or status === 'exhausted').
//
// Includes:
// 1. Threshold detection (<10% headroom / >=90% utilization).
// 2. Concurrency locking per account (_resetInProgress).
// 3. Error handling and exponential/staged backoff to prevent reset loops.
// 4. Zero-credit detection cooldown.
// 5. In-memory audit trail of reset events.
// 6. Configurable feature flag (autoResetCredits / codexReset).

export const DEFAULT_CODEX_RESET_THRESHOLD = 0.90; // Remaining headroom < 10%
export const DEFAULT_RESET_COOLDOWN_MS = 60_000; // 60s cooldown on transient failure
export const DEFAULT_SUCCESS_COOLDOWN_MS = 30_000; // 30s guard after success
export const MAX_CONSECUTIVE_RESET_FAILURES = 3;
export const EXTENDED_RESET_COOLDOWN_MS = 15 * 60_000; // 15 min cooldown after 3 consecutive failures
export const NO_CREDITS_COOLDOWN_MS = 5 * 60_000; // 5 min cooldown when 0 credits are available

/**
 * Determine if auto-reset is enabled by config, options, or environment.
 */
export function isAutoResetConfigured(setting, env = process.env) {
  if (env.AGENTLB_AUTO_RESET_CREDITS === 'false' || env.AGENTLB_AUTO_RESET_CREDITS === '0') return false;
  if (env.AGENTLB_AUTO_RESET_CREDITS === 'true' || env.AGENTLB_AUTO_RESET_CREDITS === '1') return true;

  if (typeof setting === 'boolean') return setting;
  if (setting && typeof setting === 'object') {
    return setting.enabled !== false;
  }
  return true;
}

/**
 * Resolve effective utilization threshold (default 0.90 = headroom < 10%).
 */
export function resolveResetThreshold(setting, env = process.env) {
  if (env.AGENTLB_AUTO_RESET_THRESHOLD) {
    const val = parseFloat(env.AGENTLB_AUTO_RESET_THRESHOLD);
    if (Number.isFinite(val) && val > 0 && val <= 1) return val;
  }
  if (typeof setting === 'object' && setting && Number.isFinite(setting.threshold)) {
    return Math.min(Math.max(setting.threshold, 0.01), 1.0);
  }
  return DEFAULT_CODEX_RESET_THRESHOLD;
}

/**
 * Check if a Codex account has remaining limit < 10% (utilization >= threshold).
 */
export function isCodexAccountNearLimit(account, threshold = DEFAULT_CODEX_RESET_THRESHOLD) {
  if (!account || account.disabled) return false;
  if (account.provider !== 'codex') return false;
  if (account.type !== 'oauth') return false;

  const isExhausted = account.status === 'exhausted';
  if (isExhausted) return true;

  const u5h = account.quota?.unified5h;
  if (u5h != null && u5h >= threshold) return true;

  const u7d = account.quota?.unified7d;
  if (u7d != null && u7d >= threshold) return true;

  return false;
}

/**
 * Check if account is currently eligible for an auto-reset attempt.
 */
export function isCodexResetEligible(account, {
  threshold = DEFAULT_CODEX_RESET_THRESHOLD,
  enabled = true,
  now = Date.now(),
} = {}) {
  if (!enabled) return { eligible: false, reason: 'disabled' };
  if (!account || account.disabled) return { eligible: false, reason: 'account_disabled_or_missing' };
  if (account.provider !== 'codex') return { eligible: false, reason: 'not_codex_account' };
  if (account.type !== 'oauth') return { eligible: false, reason: 'not_oauth_account' };

  if (account._resetInProgress) {
    return { eligible: false, reason: 'reset_in_progress' };
  }

  if (account._resetCooldownUntil && now < account._resetCooldownUntil) {
    return {
      eligible: false,
      reason: 'cooldown_active',
      cooldownRemainingMs: account._resetCooldownUntil - now,
    };
  }

  // If known available credits is 0 and checked recently, skip
  if (account.quota?.resetCredits?.available === 0) {
    const lastChecked = account.quota.resetCredits.lastChecked || 0;
    if (now - lastChecked < NO_CREDITS_COOLDOWN_MS) {
      return { eligible: false, reason: 'no_credits_available' };
    }
  }

  if (!isCodexAccountNearLimit(account, threshold)) {
    return { eligible: false, reason: 'headroom_sufficient' };
  }

  return { eligible: true };
}

/**
 * Perform auto-reset for a Codex account.
 */
export async function triggerCodexAutoReset(accountManager, accountIndex, {
  reason = 'threshold_reached',
  threshold = DEFAULT_CODEX_RESET_THRESHOLD,
  enabled = true,
  consumeFn = null,
  log = console.log,
  warn = console.warn,
} = {}) {
  const account = accountManager.accounts[accountIndex];
  if (!account) return { ok: false, error: 'No such account' };

  const eligibility = isCodexResetEligible(account, { threshold, enabled });
  if (!eligibility.eligible) {
    return { ok: false, skipped: true, reason: eligibility.reason };
  }

  // Acquire concurrency lock
  account._resetInProgress = true;
  account._lastResetAttemptAt = Date.now();

  const prev5h = account.quota?.unified5h ?? (account.status === 'exhausted' ? 1.0 : 0);
  const pct = Math.round(prev5h * 100);

  log(`[AgentLB] [AutoReset] Account "${account.name}" reached critical quota (5h utilization: ${pct}%, headroom <10%, trigger: ${reason}). Initiating automated Codex reset...`);

  try {
    let res;
    if (consumeFn) {
      res = await consumeFn(accountIndex);
    } else {
      res = await accountManager.consumeResetCredit(accountIndex);
    }

    if (res && res.ok) {
      account._resetFailures = 0;
      account._lastResetSuccessAt = Date.now();
      account._lastResetError = null;
      account._resetCooldownUntil = Date.now() + DEFAULT_SUCCESS_COOLDOWN_MS;

      if (account.status === 'exhausted') {
        account.status = 'active';
        account.exhaustedUntil = null;
      }
      if (account.lastError?.reason === 'quota' || account.lastError?.reason === 'usage-limit') {
        account.lastError = null;
      }
      account.rateLimitedUntil = null;

      const new5h = account.quota?.unified5h ?? 0;
      const newPct = Math.round(new5h * 100);
      const creditId = res.creditId || res.data?.id || 'redeemed';
      const remainingCredits = account.quota?.resetCredits?.available;

      const logMsg = `[AgentLB] [AutoReset] Successfully consumed reset credit (${creditId}) for account "${account.name}". 5h utilization: ${pct}% -> ${newPct}%.${remainingCredits != null ? ` Credits remaining: ${remainingCredits}.` : ''}`;
      log(logMsg);

      recordResetAudit(accountManager, {
        timestamp: new Date().toISOString(),
        account: account.name,
        trigger: reason,
        previous5h: prev5h,
        new5h,
        creditId,
        success: true,
      });

      return {
        ok: true,
        account: account.name,
        previous5h: prev5h,
        new5h,
        creditId,
        remainingCredits,
      };
    } else {
      const errMsg = res?.error || 'Unknown reset consumption error';
      account._resetFailures = (account._resetFailures || 0) + 1;
      account._lastResetError = errMsg;

      const isNoCredits = typeof errMsg === 'string' &&
        (errMsg.includes('Brak dostępnych kredytów') || errMsg.includes('no available credits'));
      const cooldownMs = isNoCredits
        ? NO_CREDITS_COOLDOWN_MS
        : (account._resetFailures >= MAX_CONSECUTIVE_RESET_FAILURES
            ? EXTENDED_RESET_COOLDOWN_MS
            : DEFAULT_RESET_COOLDOWN_MS);

      account._resetCooldownUntil = Date.now() + cooldownMs;
      if (isNoCredits && account.quota) {
        account.quota.resetCredits = {
          available: 0,
          credits: [],
          lastChecked: Date.now(),
        };
      }

      warn(`[AgentLB] [AutoReset] Failed to consume reset credit for account "${account.name}": ${errMsg}. Cooldown active for ${Math.round(cooldownMs / 1000)}s (failure count: ${account._resetFailures}).`);

      recordResetAudit(accountManager, {
        timestamp: new Date().toISOString(),
        account: account.name,
        trigger: reason,
        previous5h: prev5h,
        success: false,
        error: errMsg,
      });

      return {
        ok: false,
        error: errMsg,
        cooldownMs,
      };
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    account._resetFailures = (account._resetFailures || 0) + 1;
    account._lastResetError = errMsg;

    const cooldownMs = account._resetFailures >= MAX_CONSECUTIVE_RESET_FAILURES
      ? EXTENDED_RESET_COOLDOWN_MS
      : DEFAULT_RESET_COOLDOWN_MS;
    account._resetCooldownUntil = Date.now() + cooldownMs;

    warn(`[AgentLB] [AutoReset] Exception during reset for account "${account.name}": ${errMsg}. Cooldown active for ${Math.round(cooldownMs / 1000)}s.`);

    recordResetAudit(accountManager, {
      timestamp: new Date().toISOString(),
      account: account.name,
      trigger: reason,
      previous5h: prev5h,
      success: false,
      error: errMsg,
    });

    return { ok: false, error: errMsg, cooldownMs };
  } finally {
    account._resetInProgress = false;
  }
}

export function recordResetAudit(accountManager, entry) {
  if (!accountManager) return;
  accountManager.resetAuditLog = accountManager.resetAuditLog || [];
  accountManager.resetAuditLog.unshift(entry);
  if (accountManager.resetAuditLog.length > 50) {
    accountManager.resetAuditLog.length = 50;
  }
}
