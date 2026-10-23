import { probeAgyAccount } from './agy-diagnostics.js';

const HOUR = 60 * 60 * 1000;
const RESTRICTED = new Set(['forbidden', 'validation_required', 'subscription_required', 'auth_invalid', 'tos_violation']);
const ERRORS = new Set(['error', 'configuration_error']);

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// Only exhausted, fresh observations may bring the next check forward. An old
// reset stops triggering checks as soon as a check has observed that reset.
function quotaReset(diagnostics, after) {
  let reset = Infinity;
  for (const name of ['models', 'quotaSummary']) {
    const category = diagnostics?.telemetry?.[name];
    if (category?.stale || !Array.isArray(category?.data)) continue;
    for (const bucket of category.data) {
      const at = timestamp(bucket?.resetAt);
      if (bucket?.remainingFraction === 0 && at && at > after) reset = Math.min(reset, at);
    }
  }
  return reset;
}

export class AgyCheckScheduler {
  constructor({ store, probe = probeAgyAccount, now = () => Date.now(), intervalMs = 6 * HOUR, tickMs = 60_000, maxAccounts = 5 }) {
    if (!store || typeof probe !== 'function') throw new Error('invalid AGY scheduler configuration');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(tickMs) || tickMs <= 0 || !Number.isInteger(maxAccounts) || maxAccounts < 1) {
      throw new Error('invalid AGY scheduler timing');
    }
    Object.assign(this, { store, probe, now, intervalMs, tickMs, maxAccounts });
    this.timer = null;
    this.started = false;
    this.running = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._schedule();
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule() {
    if (!this.started) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.run({ source: 'scheduled' });
      } catch { /* A failed storage operation must not terminate the timer. */ }
      this._schedule();
    }, Math.round(this.tickMs * (1 + Math.random() * 0.15)));
    this.timer.unref?.();
  }

  _dueAt(account) {
    const diagnostics = account.diagnostics;
    const checkedAt = timestamp(diagnostics?.checkedAt) || 0;
    let due = timestamp(account.nextCheckAt) || (checkedAt ? checkedAt + this.intervalMs : 0);
    if (!RESTRICTED.has(diagnostics?.status) && !ERRORS.has(diagnostics?.status)) {
      due = Math.min(due, quotaReset(diagnostics, checkedAt));
    }
    return Math.max(due, timestamp(diagnostics?.retryAt) || 0);
  }

  _scheduleResult(account, result) {
    const checkedAt = this.now();
    const error = ERRORS.has(result.status);
    const failures = error ? Math.min(30, (Number.isInteger(account.failures) ? account.failures : 0) + 1) : 0;
    const delay = error ? Math.min(6 * HOUR, 15 * 60_000 * (2 ** (failures - 1)))
      : RESTRICTED.has(result.status) ? Math.max(24 * HOUR, this.intervalMs) : this.intervalMs;
    let nextCheckAt = checkedAt + delay;
    if (!error && !RESTRICTED.has(result.status)) nextCheckAt = Math.min(nextCheckAt, quotaReset(result, checkedAt));
    nextCheckAt = Math.max(nextCheckAt, Math.min(checkedAt + 24 * HOUR, timestamp(result.retryAt) || 0));
    return { ...result, checkedAt, failures, nextCheckAt };
  }

  /** A batch lock is separate from short credential locks, so network I/O never
   * blocks account operations. Token version CAS rejects rotated/deleted logins. */
  async run({ id = null, force = false, source = 'manual' } = {}) {
    if (this.running) return { busy: true, checked: 0, discarded: 0, failed: 0 };
    this.running = true;
    let batch;
    const summary = { busy: false, checked: 0, discarded: 0, failed: 0 };
    try {
      batch = await this.store.beginBatch(source === 'scheduled' ? 'scheduled' : 'manual');
      if (!batch) return { ...summary, busy: true };
      const accounts = await this.store.list();
      let selected = accounts.filter(a => (!id || a.id === id) && (a.enabled !== false || (id && force))
        && (force || this._dueAt(a) <= this.now()));
      selected.sort((a, b) => this._dueAt(a) - this._dueAt(b));
      if (!force) selected = selected.slice(0, this.maxAccounts);
      for (const account of selected) {
        const snapshot = await this.store.snapshot(account.id);
        if (!snapshot) {
          summary.discarded++;
          continue;
        }
        let result;
        try {
          result = await this.probe(snapshot.token);
          if (!result || typeof result.status !== 'string') throw new Error('invalid probe result');
        } catch {
          // Never persist exception messages: OAuth transports can include tokens.
          result = { status: 'error', reason: 'probe_failed', checkedAt: this.now(), checks: {}, telemetry: {} };
        }
        summary.checked++;
        if (ERRORS.has(result.status)) summary.failed++;
        const accepted = await this.store.applyDiagnostics(account.id, snapshot.version, this._scheduleResult(account, result));
        if (!accepted) summary.discarded++;
      }
      return summary;
    } catch (error) {
      summary.error = 'batch_failed';
      throw error;
    } finally {
      try {
        if (batch) await this.store.finishBatch(batch, summary);
      } finally {
        this.running = false;
      }
    }
  }
}
