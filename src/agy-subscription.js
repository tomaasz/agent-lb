// Subscription metadata only. Google credentials and raw API replies never
// leave this module or get included in errors returned to the dashboard.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOKEN_PATH, normalizeAgySubscription } from './agy-accounts.js';

export function agySubscriptionFrom(load) {
  return normalizeAgySubscription(load?.paidTier) || normalizeAgySubscription(load?.currentTier);
}

export function createAgySubscriptionRefresh({ store, pool, run, fetchImpl = fetch }) {
  const pending = new Map();
  return function refresh(id) {
    if (!store._find(id)) return Promise.resolve({ ok: false, error: 'no such AGY account' });
    if (pending.has(id)) return pending.get(id);
    const task = Promise.resolve().then(async () => {
      try {
        const home = pool.ensureHome(id);
        // The CLI refreshes OAuth in its own HOME, just as for model discovery.
        await run(home);
        const token = JSON.parse(await readFile(join(home, ...TOKEN_PATH), 'utf8'));
        const access = token?.token?.access_token;
        if (typeof access !== 'string' || !access) throw new Error('no access token');
        const response = await fetchImpl('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' },
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, error: `Google HTTP ${response.status}` };
        }
        const subscription = agySubscriptionFrom(await response.json());
        if (!subscription) return { ok: false, error: 'Google: subscription unavailable' };
        if (!store.setSubscription(id, subscription)) return { ok: false, error: 'no such AGY account' };
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not refresh Google subscription' };
      } finally { pending.delete(id); }
    });
    pending.set(id, task);
    return task;
  };
}
