// Intelligent background fleet health checker.
//
// Automatically and periodically checks account availability with strict
// token-preservation heuristics:
// 1. Zero-cost pass: Skips accounts that handled real traffic or succeeded recently.
// 2. Cooldown-aware: Skips accounts currently in a 429 / 5h quota hold until reset.
// 3. Error backoff: Avoids hammering accounts with 403 org block or 400 SMS gates.
// 4. Micro-ping: When probing is needed, uses max_tokens: 1 and the cheapest model
//    (Haiku for Anthropic, GPT-5 Sol for Codex) — exactly 1 input + 1 output token.

import { providerOf, applyAuthHeaders, upstreamFor } from './provider.js';

export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_TRAFFIC_GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_ERROR_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

export class FleetHealthChecker {
  constructor(accountManager, {
    enabled = true,
    intervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    trafficGracePeriodMs = DEFAULT_TRAFFIC_GRACE_PERIOD_MS,
    errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
    configuredUpstream = null,
    fetchFn = fetch,
    log = console.log,
    staggerMs = 1500,
  } = {}) {
    this.am = accountManager;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.trafficGracePeriodMs = trafficGracePeriodMs;
    this.errorBackoffMs = errorBackoffMs;
    this.configuredUpstream = configuredUpstream;
    this.fetchFn = fetchFn;
    this.log = log;
    this.staggerMs = staggerMs;

    this.timer = null;
    this._running = false;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = null;
    this.lastSummary = null;
  }

  start() {
    if (!this.enabled || this.intervalMs <= 0) return;
    this.reschedule({ enabled: true, intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._running = false;
    this.nextRunAt = null;
  }

  reschedule({
    enabled = this.enabled,
    intervalMs = this.intervalMs,
    trafficGracePeriodMs = this.trafficGracePeriodMs,
    errorBackoffMs = this.errorBackoffMs,
  } = {}) {
    this.stop();
    this.enabled = !!enabled;
    this.intervalMs = Math.max(0, intervalMs);
    this.trafficGracePeriodMs = Math.max(0, trafficGracePeriodMs);
    this.errorBackoffMs = Math.max(0, errorBackoffMs);

    if (this.enabled && this.intervalMs > 0) {
      this.nextRunAt = Date.now() + this.intervalMs;
      this.timer = setInterval(() => {
        this.runCheckCycle().catch(err => {
          this.log(`[HealthCheck] Unhandled cycle error: ${err.message}`);
        });
      }, this.intervalMs);
      this.timer.unref?.();
      this.log(`[HealthCheck] Auto health-check active (every ${Math.round(this.intervalMs / 1000)}s, grace period ${Math.round(this.trafficGracePeriodMs / 1000)}s)`);
    } else {
      this.log('[HealthCheck] Auto health-check disabled');
    }
  }

  /**
   * Evaluates whether an account needs an active probe or can be skipped safely (0 tokens).
   * @param {object} account
   * @param {number} [now]
   * @returns {{ shouldProbe: boolean, reason: string, details?: any }}
   */
  evaluateAccount(account, now = Date.now()) {
    if (!account) return { shouldProbe: false, reason: 'missing_account' };

    // 1. Operator disabled accounts are never probed
    if (account.disabled) {
      return { shouldProbe: false, reason: 'disabled' };
    }

    // 2. Real user traffic or successful check within grace period -> Proven Alive (0 tokens)
    const recentActivity = Math.max(
      account.lastSuccess || 0,
      account.usage?.lastUsed || 0,
      (account.lastTest?.ok ? account.lastTest.timestamp : 0)
    );
    if (recentActivity > 0 && (now - recentActivity) < this.trafficGracePeriodMs) {
      return {
        shouldProbe: false,
        reason: 'recent_traffic',
        lastActivityAgoMs: now - recentActivity
      };
    }

    // 3. Known quota hold / rate limit active in future -> Skip until reset time (0 tokens)
    if (account.quota?.unified5hReset && now < account.quota.unified5hReset) {
      return {
        shouldProbe: false,
        reason: 'quota_hold_active',
        resetAt: account.quota.unified5hReset
      };
    }
    if (account.rateLimitedUntil && now < account.rateLimitedUntil) {
      return {
        shouldProbe: false,
        reason: 'rate_limited',
        resetAt: account.rateLimitedUntil
      };
    }

    // 4. Circuit breaker active -> Wait for circuit breaker cooldown (0 tokens)
    if (account.circuitBreakerUntil && now < account.circuitBreakerUntil) {
      return {
        shouldProbe: false,
        reason: 'circuit_breaker',
        resetAt: account.circuitBreakerUntil
      };
    }

    // 5. Hard error backoff (403 Organization Block or 400 SMS Verification)
    if (account.lastError && (account.lastError.reason === 'entitlement' || account.lastError.reason === 'identity-verification')) {
      const errTime = account.lastError.timestamp || 0;
      if (now - errTime < this.errorBackoffMs) {
        return {
          shouldProbe: false,
          reason: 'error_backoff',
          errorReason: account.lastError.reason,
          backoffRemainingMs: this.errorBackoffMs - (now - errTime)
        };
      }
    }

    // Account is idle or recovering and needs verification
    return { shouldProbe: true, reason: 'needs_probe' };
  }

  /**
   * Executes a minimal 1-token micro-ping against an account.
   * @param {object} account
   * @returns {Promise<{ ok: boolean, status: number, durationMs: number, tokensUsed: number, error?: string }>}
   */
  async probeAccount(account) {
    const provider = providerOf(account);
    const startTime = Date.now();
    let tokensUsed = 0;

    try {
      if (account.type === 'oauth' && account.refreshToken) {
        await this.am.ensureTokenFresh(account.index);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = `OAuth token refresh failed: ${err.message}`;
      account.lastError = {
        reason: 'auth',
        status: 401,
        error: errorMsg,
        timestamp: Date.now()
      };
      account.lastTest = {
        ok: false,
        status: 401,
        reason: 'auth',
        error: errorMsg,
        timestamp: Date.now(),
        source: 'auto-health-check'
      };
      return { ok: false, status: 401, durationMs, tokensUsed: 0, error: errorMsg };
    }

    try {
      if (provider === 'anthropic') {
        const upstreamUrl = `${upstreamFor(account, this.configuredUpstream)}/v1/messages`;
        const model = 'claude-haiku-4-5-20251001';
        const payload = {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: '1' }]
        };
        const reqHeaders = {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': 'claude-code/0.2.29',
          'accept': 'application/json'
        };
        applyAuthHeaders(reqHeaders, account);

        const res = await this.fetchFn(upstreamUrl, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(payload)
        });

        const durationMs = Date.now() - startTime;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          tokensUsed = (data.usage?.input_tokens || 1) + (data.usage?.output_tokens || 1);
          this.am.recordAccountSuccess(account);
          account.lastTest = {
            ok: true,
            durationMs,
            model,
            tokensUsed,
            timestamp: Date.now(),
            source: 'auto-health-check'
          };
          return { ok: true, status: 200, durationMs, tokensUsed };
        } else {
          let errorMsg = `HTTP ${res.status}`;
          let errorReason = 'http_' + res.status;
          try {
            const errData = await res.json();
            errorMsg = errData.error?.message || errData.message || JSON.stringify(errData);
          } catch {
            errorMsg = await res.text().catch(() => errorMsg);
          }

          if (res.status === 429) {
            errorReason = 'rate-limit';
            errorMsg = `Limit zapytań (429 Rate Limit) w Anthropic dla konta "${account.name}".`;
          } else if (res.status === 400 && /identity\s*verification/i.test(errorMsg)) {
            errorReason = 'identity-verification';
            this.am.markIdentityVerificationRequired(account.index);
            account.lastError = {
              reason: 'identity-verification',
              status: 400,
              error: `Wymagana weryfikacja tożsamości (400 Identity Verification) na koncie "${account.name}".`,
              timestamp: Date.now()
            };
          } else if (res.status === 403) {
            errorReason = 'entitlement';
            this.am.markEntitlementDenied(account.index);
            account.lastError = {
              reason: 'entitlement',
              status: 403,
              error: `Odmowa dostępu OAuth (403 Organization Block) dla organizacji konta "${account.name}".`,
              timestamp: Date.now()
            };
          } else if (res.status >= 500) {
            errorReason = 'server_error';
            this.am.recordAccountFailure(account);
            account.lastError = {
              reason: 'server_error',
              status: res.status,
              error: `Błąd upstream (${res.status}): ${errorMsg}`,
              timestamp: Date.now()
            };
          }

          account.lastTest = {
            ok: false,
            status: res.status,
            reason: errorReason,
            error: errorMsg,
            timestamp: Date.now(),
            source: 'auto-health-check'
          };
          return { ok: false, status: res.status, durationMs, tokensUsed: 0, error: errorMsg };
        }
      } else {
        // Codex / OpenAI
        const upstreamUrl = `${account.upstream || 'https://chatgpt.com'}/backend-api/codex/responses`;
        const model = 'gpt-5.6-sol';
        const payload = {
          model,
          messages: [{ role: 'user', content: '1' }],
          stream: false
        };
        const reqHeaders = {
          'content-type': 'application/json',
          'user-agent': 'codex-cli/0.1.0',
          'accept': 'application/json'
        };
        applyAuthHeaders(reqHeaders, account);

        const res = await this.fetchFn(upstreamUrl, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(payload)
        });

        const durationMs = Date.now() - startTime;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          tokensUsed = (data.usage?.prompt_tokens || 1) + (data.usage?.completion_tokens || 1);
          this.am.recordAccountSuccess(account);
          account.lastTest = {
            ok: true,
            durationMs,
            model,
            tokensUsed,
            timestamp: Date.now(),
            source: 'auto-health-check'
          };
          return { ok: true, status: 200, durationMs, tokensUsed };
        } else {
          let errorMsg = `HTTP ${res.status}`;
          let errorReason = 'http_' + res.status;
          try {
            const errData = await res.json();
            errorMsg = errData.error?.message || errData.detail || errData.message || JSON.stringify(errData);
          } catch {
            errorMsg = await res.text().catch(() => errorMsg);
          }

          if (res.status === 429) {
            errorReason = 'rate-limit';
          } else if (res.status === 401 || res.status === 403) {
            errorReason = 'auth';
            account.lastError = {
              reason: 'auth',
              status: res.status,
              error: `Błąd autoryzacji (${res.status}): ${errorMsg}`,
              timestamp: Date.now()
            };
          } else if (res.status >= 500) {
            errorReason = 'server_error';
            this.am.recordAccountFailure(account);
            account.lastError = {
              reason: 'server_error',
              status: res.status,
              error: `Błąd upstream Codex (${res.status}): ${errorMsg}`,
              timestamp: Date.now()
            };
          }

          account.lastTest = {
            ok: false,
            status: res.status,
            reason: errorReason,
            error: errorMsg,
            timestamp: Date.now(),
            source: 'auto-health-check'
          };
          return { ok: false, status: res.status, durationMs, tokensUsed: 0, error: errorMsg };
        }
      }
    } catch (netErr) {
      const durationMs = Date.now() - startTime;
      const errorMsg = `Network error: ${netErr.message}`;
      account.lastTest = {
        ok: false,
        status: 0,
        reason: 'network_error',
        error: errorMsg,
        timestamp: Date.now(),
        source: 'auto-health-check'
      };
      return { ok: false, status: 0, durationMs, tokensUsed: 0, error: errorMsg };
    }
  }

  /**
   * Runs a complete health check cycle across all configured accounts.
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<object>} Cycle summary
   */
  async runCheckCycle(options = { force: false }) {
    if (this._running) {
      return { skipped: true, reason: 'cycle_already_in_progress' };
    }

    this._running = true;
    this.lastRunStartedAt = Date.now();
    this.nextRunAt = this.intervalMs > 0 ? this.lastRunStartedAt + this.intervalMs : null;

    const accounts = Array.isArray(this.am?.accounts) ? this.am.accounts : [];
    const results = [];
    let probedCount = 0;
    let skippedCount = 0;
    let okCount = 0;
    let errorCount = 0;
    let totalTokensUsed = 0;

    try {
      for (const account of accounts) {
        const evalResult = options.force
          ? { shouldProbe: !account.disabled, reason: 'forced' }
          : this.evaluateAccount(account);

        if (!evalResult.shouldProbe) {
          skippedCount++;
          results.push({
            name: account.name,
            provider: providerOf(account),
            action: 'skipped',
            reason: evalResult.reason,
            tokensUsed: 0
          });
          continue;
        }

        probedCount++;
        const probeRes = await this.probeAccount(account);
        totalTokensUsed += (probeRes.tokensUsed || 0);

        if (probeRes.ok) okCount++;
        else errorCount++;

        results.push({
          name: account.name,
          provider: providerOf(account),
          action: 'probed',
          ok: probeRes.ok,
          status: probeRes.status,
          durationMs: probeRes.durationMs,
          tokensUsed: probeRes.tokensUsed,
          error: probeRes.error
        });

        // Stagger checks to prevent burst requests
        if (this.staggerMs > 0 && probedCount < accounts.length) {
          await new Promise(resolve => setTimeout(resolve, this.staggerMs));
        }
      }

      this.lastRunFinishedAt = Date.now();
      this.lastSummary = {
        totalAccounts: accounts.length,
        probed: probedCount,
        skipped: skippedCount,
        ok: okCount,
        errors: errorCount,
        tokensUsed: totalTokensUsed,
        startedAt: this.lastRunStartedAt,
        finishedAt: this.lastRunFinishedAt,
        results
      };

      if (probedCount > 0) {
        this.log(`[HealthCheck] Cycle complete: ${okCount} ok, ${errorCount} err, ${skippedCount} skipped (0-token pass), ${totalTokensUsed} tokens used`);
      }
      return this.lastSummary;
    } finally {
      this._running = false;
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      trafficGracePeriodSeconds: Math.round(this.trafficGracePeriodMs / 1000),
      errorBackoffSeconds: Math.round(this.errorBackoffMs / 1000),
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      nextRunAt: this.nextRunAt,
      isRunning: this._running,
      lastSummary: this.lastSummary
    };
  }
}
