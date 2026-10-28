// Availability comes from each enabled account, never from compatibility metadata.
import { createHash } from 'node:crypto';
import { applyAuthHeaders, providerOf, upstreamFor } from './provider.js';
import { upstreamFetch } from './upstream-fetch.js';

const TTL_MS = 5 * 60_000;
const MAX_STALE_MS = 15 * 60_000;
const RETRY_MS = 30_000;
const TIMEOUT_MS = 10_000;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,40})?$/;
export const DEFAULT_CODEX_MODEL_CLIENT_VERSION = '0.165.0';

export function codexModelClientVersion(req, query, config) {
  const agentVersion = /codex_cli_rs\/(\d+\.\d+\.\d+)/.exec(req.headers['user-agent'] || '')?.[1];
  return [query.get('client_version'), agentVersion, config.models?.codexClientVersion]
    .find(v => typeof v === 'string' && VERSION.test(v)) || DEFAULT_CODEX_MODEL_CLIENT_VERSION;
}

function identity(account, config, version) {
  // A rotated credential or a changed upstream must not inherit old entitlements.
  return createHash('sha256').update(JSON.stringify([
    providerOf(account), upstreamFor(account, config.upstream), account.id || account.name,
    account.accountId, account.type, account.credential, providerOf(account) === 'codex' ? version : '',
  ])).digest('hex');
}

export class ProviderModelCatalog {
  constructor({ accounts, config = {}, sx = null, fetch = upstreamFetch, now = Date.now,
    ttlMs = TTL_MS, maxStaleMs = MAX_STALE_MS, retryMs = RETRY_MS, timeoutMs = TIMEOUT_MS,
    waitMs = 2000 } = {}) {
    Object.assign(this, { accounts, config, sx, fetch, now, ttlMs, maxStaleMs, retryMs, timeoutMs, waitMs });
    this.cache = new Map();
  }

  entries(version) {
    const accounts = this.accounts().filter(a => !a.disabled && a.credential && ['anthropic', 'codex'].includes(providerOf(a)));
    // Remove old credentials and disabled accounts before reserving cache slots.
    for (const [key, entry] of this.cache) {
      if (!accounts.some(a => identity(a, this.config, entry.version) === key)) this.cache.delete(key);
    }
    const keys = new Set(accounts.map(a => identity(a, this.config, version)));
    const limit = Math.max(64, accounts.length);
    const entries = accounts.map(account => {
      const key = identity(account, this.config, version);
      let entry = this.cache.get(key);
      if (!entry) {
        // Evict an idle old version. If every slot is busy, leave this version
        // unavailable until a later request rather than creating more work.
        if (this.cache.size >= limit) {
          const idle = [...this.cache].find(([k, e]) => !keys.has(k) && !e.inflight);
          if (idle) this.cache.delete(idle[0]);
          else return { account, version, models: [], fetchedAt: null, failedAt: this.now(), inflight: null };
        }
        entry = { account, version, models: [], fetchedAt: null, failedAt: null, inflight: null };
        this.cache.set(key, entry);
      }
      entry.account = account;
      return entry;
    });
    return entries;
  }

  async load(account, version) {
    const provider = providerOf(account);
    const subscription = provider === 'codex' && account.type !== 'api-key';
    const base = upstreamFor(account, this.config.upstream).replace(/\/$/, '');
    const url = new URL(base + (subscription ? '/backend-api/codex/models' : '/v1/models'));
    if (subscription) url.searchParams.set('client_version', version);
    if (provider === 'anthropic') url.searchParams.set('limit', '100');
    const headers = { accept: 'application/json' };
    applyAuthHeaders(headers, account);
    if (provider === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (account.type === 'oauth') headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else if (subscription) {
      headers.originator = 'codex_cli_rs';
      headers['user-agent'] = `codex_cli_rs/${version}`;
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const models = new Map();
    const cursors = new Set();
    for (let page = 0; page < 20; page++) {
      const response = await this.fetch(url.toString(), { method: 'GET', headers, signal, redirect: 'error' },
        this.sx, !!this.sx?.useByDefault?.());
      if (response.status !== 200) {
        await response.body?.cancel?.().catch(() => {});
        const err = new Error('Model catalog request failed');
        err.status = response.status;
        throw err;
      }
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('Model catalog response too large');
      const data = JSON.parse(text);
      const rows = subscription ? data.models : data.data;
      if (!Array.isArray(rows)) throw new Error('Invalid model catalog response');
      for (const row of rows) {
        const id = row?.id || row?.slug;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(id)) throw new Error('Invalid model ID');
        // Preserve model capabilities and visibility returned by Codex. API model
        // lists have little metadata, so the formatter enriches known IDs only.
        const model = subscription ? { ...row } : {};
        models.set(id, { ...model, id, name: row.display_name || row.name || id,
          display_name: row.display_name || row.name || id, provider, owned_by: row.owned_by || provider });
      }
      if (provider !== 'anthropic' || !data.has_more) return [...models.values()];
      if (typeof data.last_id !== 'string' || !data.last_id || cursors.has(data.last_id)) throw new Error('Invalid model catalog pagination');
      cursors.add(data.last_id);
      url.searchParams.set('after_id', data.last_id);
    }
    throw new Error('Model catalog pagination limit exceeded');
  }

  refresh(entry) {
    const now = this.now();
    if (entry.inflight || (entry.fetchedAt !== null && now - entry.fetchedAt < this.ttlMs) ||
      (entry.failedAt !== null && now - entry.failedAt < this.retryMs)) return entry.inflight;
    entry.inflight = this.load(entry.account, entry.version).then(models => {
      entry.models = models; // An empty successful list also removes old models.
      entry.fetchedAt = this.now();
      entry.failedAt = null;
    }).catch(err => {
      entry.failedAt = this.now();
      if (err.status === 401 || err.status === 403) {
        entry.models = [];
        entry.fetchedAt = null;
      }
    }).finally(() => { entry.inflight = null; });
    return entry.inflight;
  }

  async list(version = DEFAULT_CODEX_MODEL_CLIENT_VERSION) {
    const entries = this.entries(version);
    const pending = entries.map(entry => this.refresh(entry)).filter(Boolean);
    // Await refreshes within a bounded budget, including warm refreshes: healthy
    // upstreams can remove retired models on this very request.
    let timer;
    if (pending.length) {
      try {
        await Promise.race([Promise.all(pending), new Promise(resolve => {
          timer = setTimeout(resolve, this.waitMs);
          timer.unref?.();
        })]);
      } finally { clearTimeout(timer); }
    }
    const result = new Map();
    // Re-read enabled accounts after awaiting network I/O; disabling an account
    // while its request was in flight must take effect immediately.
    for (const entry of this.entries(version)) {
      if (entry.fetchedAt === null || this.now() - entry.fetchedAt >= this.maxStaleMs) continue;
      for (const model of entry.models) if (!result.has(model.id)) result.set(model.id, model);
    }
    return [...result.values()];
  }

  status(version = DEFAULT_CODEX_MODEL_CLIENT_VERSION) {
    const result = {};
    for (const provider of ['anthropic', 'codex']) {
      const entries = this.entries(version).filter(e => providerOf(e.account) === provider);
      result[provider] = {
        stale: entries.some(e => e.fetchedAt !== null && this.now() - e.fetchedAt >= this.ttlMs),
        unavailable: entries.some(e => e.fetchedAt === null || this.now() - e.fetchedAt >= this.maxStaleMs),
      };
    }
    return result;
  }
}
