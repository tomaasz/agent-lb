// Gemini model catalog read from the real `agy` CLI (`agy models`).
// Output: a banner line, then tab-separated rows `<id>\t<display name>`.

import { execFile } from 'node:child_process';
import { resolveAgyCommand } from './agy-accounts.js';

export const AGY_CONTEXT_WINDOW = 1_000_000;
export const AGY_MAX_TOKENS = 65_536;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const AGY_RETRY_BACKOFF_MS = 30_000;
export const AGY_RETRY_BACKOFF_MAX_MS = 15 * 60 * 1000;
export const AGY_LIST_WAIT_MS = 2000;
const LIST_TIMEOUT_MS = 60_000;

export function parseAgyModels(stdout) {
  const models = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (id.startsWith('gemini-')) models.push({ id, name: name || id });
  }
  return models;
}

export function isAgyModelName(model) {
  return model === 'agy' || model === 'agy-fast' || (typeof model === 'string' && model.startsWith('gemini-'));
}

/** Default `run`: `agy models` with a minimal environment, never touching token files. */
export function createAgyModelsRunner(config) {
  return (homeDir) => new Promise((resolve, reject) => {
    execFile(
      resolveAgyCommand(config),
      ['models'],
      { env: { PATH: process.env.PATH, HOME: homeDir }, timeout: LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/**
 * The catalog's models without ever stalling the caller: Claude/Codex model
 * discovery shares its response with the AGY catalog, and a hung `agy models`
 * (60 s exec timeout) must not hold that response. Past `waitMs` the models
 * known so far are returned and the refresh keeps running in the background.
 */
export async function listAgyModelsBounded(catalog, waitMs = AGY_LIST_WAIT_MS) {
  let timer;
  try {
    return await Promise.race([
      catalog.list(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(catalog.models || []), waitMs); timer.unref?.(); }),
    ]);
  } finally { clearTimeout(timer); }
}

export class AgyModelCatalog {
  constructor({ run, homeFor, ttlMs = DEFAULT_TTL_MS, retryMs = AGY_RETRY_BACKOFF_MS, maxRetryMs = AGY_RETRY_BACKOFF_MAX_MS, now = Date.now }) {
    this.run = run;
    this.homeFor = homeFor;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.maxRetryMs = maxRetryMs;
    this.failures = 0;
    this.failedAt = null;
    this.now = now;
    this.models = [];
    this.fetchedAt = null;
    this.inflight = null;
  }

  async list() {
    const t = this.now();
    const fresh = this.fetchedAt !== null && t - this.fetchedAt < this.ttlMs;
    // Consecutive failures double the wait (30 s, 1 min, 2 min ... 15 min):
    // every retry starts a language server and calls Google from this account.
    const delay = Math.min(this.retryMs * 2 ** Math.max(0, this.failures - 1), this.maxRetryMs);
    const backingOff = this.failedAt !== null && t - this.failedAt < delay;
    if (fresh || backingOff) return this.models;
    let home;
    try { home = this.homeFor(); }
    catch {
      this.failedAt = this.now();
      this.failures++;
      return this.models;
    }
    if (!home) return this.models;
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const models = parseAgyModels(await this.run(home));
          if (models.length) {
            this.models = models;
            this.fetchedAt = this.now();
            this.failedAt = null;
            this.failures = 0;
          } else {
            this.failedAt = this.now(); // empty result counts as a failure
            this.failures++;
          }
        } catch {
          this.failedAt = this.now(); // keep last known models, retry after backoff
          this.failures++;
        } finally {
          this.inflight = null;
        }
      })();
    }
    // A previous list is served immediately; the refresh continues in the background.
    if (this.models.length) return this.models;
    await this.inflight;
    return this.models;
  }

  resolveAlias(model) {
    const ids = this.models.map((m) => m.id);
    if (model === 'agy') return ids.find((id) => id.endsWith('-high')) ?? ids[0] ?? null;
    if (model === 'agy-fast') return ids.find((id) => id.endsWith('-low')) ?? ids[0] ?? null;
    if (typeof model === 'string' && model.startsWith('gemini-') && ids.includes(model)) return model;
    return null;
  }
}

/** Account entitlements can differ even within the same named subscription.
 * Keep discovery in each account's HOME and combine only the public model IDs.
 */
export class AgyAccountModelCatalog {
  constructor({ accounts, homeFor, run, now = Date.now, ttlMs = 5 * 60_000,
    maxAgeMs = 15 * 60_000, ...options }) {
    Object.assign(this, { accounts, homeFor, run, now, ttlMs, maxAgeMs, options });
    this.catalogs = new Map();
  }

  entries() {
    const accounts = this.accounts().filter(a => a.enabled !== false);
    const active = new Set(accounts.map(a => a.id));
    for (const id of this.catalogs.keys()) if (!active.has(id)) this.catalogs.delete(id);
    return accounts.map(account => {
      const key = JSON.stringify([account.credentialVersion, account.subscription?.id]);
      let entry = this.catalogs.get(account.id);
      if (!entry || entry.key !== key) {
        entry = { key, catalog: new AgyModelCatalog({ ...this.options, run: this.run,
          homeFor: () => this.homeFor(account.id), now: this.now, ttlMs: this.ttlMs }) };
        this.catalogs.set(account.id, entry);
      }
      return { id: account.id, ...entry };
    });
  }

  current(catalog) {
    return catalog.fetchedAt !== null && this.now() - catalog.fetchedAt < this.maxAgeMs ? catalog.models : [];
  }

  get models() {
    const models = new Map();
    for (const { catalog } of this.entries()) for (const m of this.current(catalog)) if (!models.has(m.id)) models.set(m.id, m);
    return [...models.values()];
  }

  async list() {
    await Promise.all(this.entries().map(({ catalog }) => catalog.list()));
    return this.models;
  }

  async listForAccount(id) {
    const entry = this.entries().find(e => e.id === id);
    if (!entry) return [];
    await entry.catalog.list();
    // Account removal, token rotation and subscription changes during discovery
    // must invalidate the result before it can be used for a test or routing.
    const current = this.entries().find(e => e.id === id);
    return current?.catalog === entry.catalog ? this.current(entry.catalog) : [];
  }

  accountCatalogs() {
    return new Map(this.entries().map(({ id, catalog }) => [id, this.state(catalog)]));
  }

  forAccount(id) {
    return this.state(this.entries().find(e => e.id === id)?.catalog);
  }

  state(catalog) {
    const models = catalog ? this.current(catalog) : [];
    return { models: models.map(m => m.id), updatedAt: catalog?.fetchedAt ?? null,
      stale: !!catalog && catalog.fetchedAt !== null && this.now() - catalog.fetchedAt >= this.ttlMs,
      available: !!catalog && catalog.fetchedAt !== null && this.now() - catalog.fetchedAt < this.maxAgeMs };
  }

  supportsAccount(id, model) {
    return this.forAccount(id).models.includes(model);
  }

  resolveAlias(model) {
    return AgyModelCatalog.prototype.resolveAlias.call(this, model);
  }
}
