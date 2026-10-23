// Google accounts for AGY (Antigravity CLI), kept by the proxy and handed to
// the agybridge running on each workstation.
//
// AGY stores its whole login in ~/.gemini/antigravity-cli/antigravity-oauth-token (a
// Google OAuth token: access/refresh token + id_token). The proxy keeps one
// such file per Google account, lets the operator log accounts in from the
// dashboard, and picks the account a station should use: the pinned one, else
// the station's current one, else the first enabled account whose quota is not
// spent. A station that hits a spent quota reports it and gets the next one.
//
// Logging in drives AGY itself (it owns the OAuth client and PKCE exchange):
// `agy --print` in a throwaway HOME prints Google's consent URL and then
// accepts the authorization code on stdin for 60 s. AGY refuses to log in
// without a terminal, so it runs under `script`, which gives it a pty.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfigPath } from './config.js';
import { readControlBody } from './control-body.js';
import { relayPolicyAllowed } from './access-control.js';
import { readAgyStorage, writeAgyStorage } from './agy-storage.js';

export const TOKEN_FILE = 'antigravity-oauth-token';
// Relative to HOME. (~/.gemini/jetski-standalone-oauth-token has the same
// format but belongs to the IDE; the CLI does not read it.)
export const TOKEN_PATH = ['.gemini', 'antigravity-cli', TOKEN_FILE];
const LOGIN_WINDOW_MS = 58_000; // AGY gives up after 60 s
const SUBMIT_WAIT_MS = 30_000;
const MAX_LOGINS = 2;
const DEFAULT_COOLDOWN_S = 900;
const MIN_COOLDOWN_S = 60;
const MAX_COOLDOWN_S = 7 * 24 * 3600;
// Google authorization codes are URL-safe; anything else is refused before it
// reaches AGY's terminal.
const CODE_RE = /^[A-Za-z0-9/_.~%-]{10,512}$/;

export function getAgyAccountsPath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.agy-accounts.json') : cfg + '.agy-accounts';
}

function jwtPayload(token) {
  if (typeof token !== 'string') return {};
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** Validate an AGY token file and return its identity, or throw. */
export function parseAgyToken(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || !data.token || typeof data.token !== 'object') {
    throw new Error('not an AGY token file');
  }
  if (typeof data.token.refresh_token !== 'string' || !data.token.refresh_token) {
    throw new Error('AGY token has no refresh token');
  }
  const claims = jwtPayload(data.id_token);
  const claimEmail = typeof claims?.email === 'string' ? claims.email.trim().toLowerCase() : '';
  // AGY 1.4.6 remembers the identity separately and may omit the original JWT.
  const rememberedEmail = typeof data.id_token_email === 'string' ? data.id_token_email.trim().toLowerCase() : '';
  if (claimEmail && rememberedEmail && claimEmail !== rememberedEmail) throw new Error('AGY token identity mismatch');
  const email = claimEmail || rememberedEmail;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('AGY token has no valid e-mail in id_token or id_token_email');
  return { data, email, sub: typeof claims?.sub === 'string' ? claims.sub : null };
}

export function accountIdFor(email, sub) {
  return 'agy-' + createHash('sha256').update(sub || email).digest('hex').slice(0, 12);
}

function clampCooldown(seconds) {
  const s = Number(seconds);
  const value = Number.isFinite(s) && s > 0 ? s : DEFAULT_COOLDOWN_S;
  return Math.min(MAX_COOLDOWN_S, Math.max(MIN_COOLDOWN_S, value));
}

export function normalizeAgySubscription(tier) {
  if (!tier || typeof tier !== 'object') return null;
  const id = typeof tier.id === 'string' ? tier.id.trim().slice(0, 100) : '';
  const name = typeof tier.name === 'string' ? tier.name.trim().slice(0, 100) : '';
  return id || name ? { id: id || null, name: name || id } : null;
}

export class AgyAccountStore {
  constructor(path = getAgyAccountsPath(), now = () => Date.now(), { encryptionKeyPath = null, quotaGroups = {} } = {}) {
    this.path = path;
    this.now = now;
    this.encryptionKeyPath = encryptionKeyPath;
    this.quotaGroups = Object.fromEntries(Object.entries(quotaGroups || {}).filter(([k, v]) => /^[a-zA-Z0-9._:-]{1,100}$/.test(k) && typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(v)));
    this.stations = new Map(); // client name -> { accountId, at }
    this.data = this._load();
    this.lastStatsSaveAt = 0;
    this.statsSaveTimer = null;
    if (encryptionKeyPath) this._save();
  }

  _load() {
    const data = readAgyStorage(this.path, this.encryptionKeyPath);
    if (data === undefined) return { pinned: null, accounts: [], events: [] };
    if (!data || !Array.isArray(data.accounts) || data.accounts.length > 1000) throw new Error('Invalid AGY account storage');
    const ids = new Set();
    for (const a of data.accounts) {
      if (!a || typeof a.id !== 'string' || !/^agy-[a-f0-9]{12}$/.test(a.id) || ids.has(a.id) || parseAgyToken(a.token).email !== a.email) throw new Error('Invalid AGY stored account');
      a.health = a.health && ['auth_required', 'access_denied', 'transport', 'timeout', 'bridge_auth', 'overloaded'].includes(a.health.reason)
        ? { reason: a.health.reason, failures: Math.max(1, Math.min(6, Number(a.health.failures) || 1)),
          until: Number.isFinite(a.health.until) ? a.health.until : null,
          requiresReview: ['auth_required', 'access_denied'].includes(a.health.reason) } : null;
      a.modelQuotas = Object.fromEntries(Object.entries(a.modelQuotas || {}).filter(([k, v]) => /^[a-zA-Z0-9._:-]{1,100}$/.test(k) && Number.isFinite(v) && v > this.now()).slice(-100));
      ids.add(a.id);
    }
    return { pinned: data.pinned || null, accounts: data.accounts, events: this._safeEvents(data.events) };
  }

  _save() {
    writeAgyStorage(this.path, this.data, this.encryptionKeyPath);
  }

  _safeEvents(events) {
    return (Array.isArray(events) ? events : []).slice(-100).map(e => {
      const row = {};
      for (const k of ['accountId', 'client', 'model', 'outcome']) {
        if (typeof e?.[k] === 'string' && /^[a-zA-Z0-9@._:() -]{1,100}$/.test(e[k])) row[k] = e[k];
      }
      for (const k of ['at', 'durationMs', 'status', 'retryAt']) {
        if (typeof e?.[k] === 'number' && Number.isFinite(e[k]) && e[k] >= 0) row[k] = e[k];
      }
      return row;
    });
  }

  recordEvent(event) {
    this.data.events = this._safeEvents([...(this.data.events || []), { ...event, at: this.now() }]);
    this._save();
  }

  quotaKey(model) {
    return Object.hasOwn(this.quotaGroups, model) ? this.quotaGroups[model] : model;
  }

  markFailure(id, reason, seconds = 60) {
    const a = this._find(id);
    if (!a || !['auth_required', 'access_denied', 'transport', 'timeout', 'bridge_auth', 'overloaded'].includes(reason)) return;
    const failures = Math.min(6, (a.health?.failures || 0) + 1);
    const until = ['auth_required', 'access_denied'].includes(reason) ? null : this.now() + Math.max(seconds, Math.min(900, 30 * 2 ** (failures - 1))) * 1000;
    a.health = { reason, failures, until, requiresReview: until === null };
    this._save();
  }

  recordSuccess(id) {
    const a = this._find(id);
    if (a) { a.health = null; this._save(); }
  }

  clearHealth(id) {
    const a = this._find(id);
    if (!a) return false;
    a.health = null;
    this._save();
    return true;
  }

  _find(id) {
    return this.data.accounts.find(a => a.id === id) || null;
  }

  /** Accounts without their tokens, in priority order, for the dashboard. */
  list() {
    const now = this.now();
    const usedBy = {};
    for (const [client, s] of this.stations) (usedBy[s.accountId] ||= []).push(client);
    return this.data.accounts.map((a, index) => ({
      id: a.id,
      email: a.email,
      name: typeof a.name === 'string' ? a.name : null,
      order: index,
      enabled: a.enabled !== false,
      pinned: this.data.pinned === a.id,
      quotaUntil: a.quotaUntil && a.quotaUntil > now ? a.quotaUntil : null,
      quotaMessage: a.quotaUntil && a.quotaUntil > now ? a.quotaMessage || null : null,
      addedAt: a.addedAt || null,
      lastUsedAt: a.lastUsedAt || null,
      usage: a.usage || null,
      health: a.health ? { ...a.health } : null,
      modelQuotas: a.modelQuotas || {},
      subscription: a.subscription ? { ...normalizeAgySubscription(a.subscription), updatedAt: a.subscription.updatedAt || null } : null,
      stats: a.stats || { requests: 0, inputTokens: 0, outputTokens: 0, lastAt: null },
      usedBy: (usedBy[a.id] || []).sort(),
    }));
  }

  /** Add or refresh an account from an AGY token file; returns its public view. */
  upsert(rawToken) {
    const { data, email, sub } = parseAgyToken(rawToken);
    const id = accountIdFor(email, sub);
    // New tokens may omit sub; preserve the established id and worker home.
    const byEmail = this.data.accounts.filter(a => a.email === email);
    const existing = this._find(id) || (byEmail.length === 1 ? byEmail[0] : null);
    if (!existing && byEmail.length > 1) throw new Error('AGY account identity is ambiguous');
    if (existing) {
      const previousSub = parseAgyToken(existing.token).sub;
      if (sub && previousSub && sub !== previousSub) throw new Error('AGY account subject mismatch');
      existing.token = data;
      existing.email = email;
      existing.quotaUntil = null;
      existing.quotaMessage = null;
      existing.health = null;
      existing.modelQuotas = {};
      existing.updatedAt = this.now();
    } else {
      this.data.accounts.push({ id, email, enabled: true, token: data, addedAt: this.now() });
    }
    this._save();
    return this.list().find(a => a.id === (existing?.id || id));
  }

  remove(id) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter(a => a.id !== id);
    if (this.data.pinned === id) this.data.pinned = null;
    if (this.data.accounts.length === before) return false;
    this._save();
    return true;
  }

  setEnabled(id, enabled) {
    const a = this._find(id);
    if (!a) return false;
    a.enabled = !!enabled;
    this._save();
    return true;
  }

  rename(id, name) {
    const a = this._find(id);
    if (!a || typeof name !== 'string' || name.trim().length > 100) return false;
    a.name = name.trim() || null;
    this._save();
    return true;
  }

  pin(id) {
    if (id !== null && !this._find(id)) return false;
    this.data.pinned = id;
    this._save();
    return true;
  }

  reorder(ids) {
    if (!Array.isArray(ids)) return false;
    const rank = new Map(ids.map((id, i) => [id, i]));
    this.data.accounts.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    this._save();
    return true;
  }

  /** Remember that the account's token was copied into its worker HOME (never listed). */
  markSeeded(id) {
    const a = this._find(id);
    if (!a) return false;
    a.seededAt = this.now();
    this._save();
    return true;
  }

  clearQuota(id) {
    const a = this._find(id);
    if (!a) return false;
    a.quotaUntil = null;
    a.quotaMessage = null;
    a.modelQuotas = {};
    this._save();
    return true;
  }

  markQuota(id, resetSeconds, message, model = null) {
    const a = this._find(id);
    if (!a) return false;
    const until = this.now() + clampCooldown(resetSeconds) * 1000;
    if (model) {
      const key = this.quotaKey(model);
      a.modelQuotas = Object.fromEntries(Object.entries(a.modelQuotas || {}).filter(([, value]) => value > this.now()).slice(-99));
      a.modelQuotas[key] = until;
      this._save();
      return true;
    }
    a.quotaUntil = until;
    a.quotaMessage = typeof message === 'string' ? message.slice(0, 300) : null;
    this._save();
    return true;
  }

  /**
   * Per-model quota as reported by a station (Google's fetchAvailableModels).
   * Matched by account id or e-mail; returns false for an unknown account.
   */
  setUsage(who, models, subscription) {
    const key = typeof who === 'string' ? who.trim().toLowerCase() : '';
    const a = key && this.data.accounts.find(x => x.id === who || x.email === key);
    if (!a || !Array.isArray(models)) return false;
    const seen = new Map();
    for (const m of models.slice(0, 200)) {
      const label = typeof m?.label === 'string' ? m.label.trim().slice(0, 80) : '';
      const remaining = Number(m?.remaining);
      if (!label || !Number.isFinite(remaining)) continue;
      const resetAt = Number(m.resetAt);
      const entry = {
        label,
        remaining: Math.min(1, Math.max(0, remaining)),
        resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : null,
      };
      // Several model ids share one label: keep the most spent one.
      const prev = seen.get(label);
      if (!prev || entry.remaining < prev.remaining) seen.set(label, entry);
    }
    a.usage = { models: [...seen.values()].slice(0, 40), updatedAt: this.now() };
    const tier = normalizeAgySubscription(subscription);
    if (tier) a.subscription = { ...tier, updatedAt: this.now() };
    this._save();
    return true;
  }

  setSubscription(id, subscription) {
    const a = this._find(id);
    const tier = normalizeAgySubscription(subscription);
    if (!a || !tier) return false;
    a.subscription = { ...tier, updatedAt: this.now() };
    this._save();
    return true;
  }

  _available(a, model = null) {
    return a.enabled !== false && !(a.quotaUntil && a.quotaUntil > this.now()) &&
      !(a.health?.requiresReview || a.health?.until > this.now()) &&
      !(model && a.modelQuotas?.[this.quotaKey(model)] > this.now());
  }

  retryAfter(model) {
    const waits = this.data.accounts.filter(a => a.enabled !== false && !a.health?.requiresReview).map(a => Math.max(
      a.quotaUntil || 0, a.health?.until || 0, a.modelQuotas?.[this.quotaKey(model)] || 0));
    return Math.max(1, Math.ceil((Math.min(...waits, this.now() + 3600000) - this.now()) / 1000));
  }

  /** Pick for proxy routing: pinned first, then the free account whose model resets soonest. */
  pick(exclude = new Set(), model = null, busy = () => 0) {
    const pinned = this.data.pinned && this._find(this.data.pinned);
    if (pinned && this._available(pinned, model) && !exclude.has(pinned.id)) return pinned;
    return this.data.accounts
      .map((account, index) => ({ account, index, resetAt: Math.min(...(account.usage?.models || []).map(m => Number(m.resetAt)).filter(Number.isFinite), Infinity) }))
      .filter(x => this._available(x.account, model) && !exclude.has(x.account.id))
      .sort((a, b) => busy(a.account.id) - busy(b.account.id) || a.resetAt - b.resetAt || a.index - b.index)[0]?.account || null;
  }

  /** Persist aggregate request stats, with disk writes throttled to at most once per 10 seconds. */
  recordRequest(id, { inputTokens = 0, outputTokens = 0 } = {}) {
    const account = this._find(id);
    if (!account) return false;
    const stats = account.stats ||= { requests: 0, inputTokens: 0, outputTokens: 0, lastAt: null };
    stats.requests++;
    stats.inputTokens += Number(inputTokens) || 0;
    stats.outputTokens += Number(outputTokens) || 0;
    stats.lastAt = this.now();
    const elapsed = stats.lastAt - this.lastStatsSaveAt;
    if (elapsed >= 10_000) {
      this._save();
      this.lastStatsSaveAt = stats.lastAt;
    } else if (!this.statsSaveTimer) {
      this.statsSaveTimer = setTimeout(() => {
        this.statsSaveTimer = null;
        // A timer callback has no caller: a throw here (disk full, directory
        // gone) would be an uncaught exception and take the whole proxy down.
        try {
          this._save();
          this.lastStatsSaveAt = this.now();
        } catch (err) {
          console.warn('[AgentLB] AGY stats save failed:', err?.code || 'error');
        }
      }, 10_000 - elapsed);
      this.statsSaveTimer.unref?.();
    }
    return true;
  }

  /** The account a station should use: pinned, else its current one, else the first free. */
  select(current = null) {
    const pinned = this.data.pinned && this._find(this.data.pinned);
    if (pinned && this._available(pinned)) return pinned;
    const mine = current && this._find(current);
    if (mine && this._available(mine)) return mine;
    return this.data.accounts.find(a => this._available(a)) || null;
  }

  /** Hand a station its account; records who uses what for the dashboard. */
  credentialFor(client, current = null) {
    const account = this.select(current);
    if (!account) return null;
    this.stations.set(client || 'anonymous', { accountId: account.id, at: this.now() });
    account.lastUsedAt = this.now();
    return { account: { id: account.id, email: account.email }, token: account.token };
  }

  /** A station found its account's quota spent: record it and pick the next one. */
  reportQuota(client, accountId, resetSeconds, message) {
    if (accountId) this.markQuota(accountId, resetSeconds, message);
    return this.credentialFor(client, null);
  }
}

// `script` starts AGY in a session of its own, so killing `script` (or its
// process group) leaves AGY running, reparented to init. Walk the tree.
function descendants(pid) {
  const found = [];
  const stack = [pid];
  while (stack.length) {
    const current = stack.pop();
    let tasks = [];
    try { tasks = readdirSync(`/proc/${current}/task`); } catch { continue; }
    for (const task of tasks) {
      let children = '';
      try { children = readFileSync(`/proc/${current}/task/${task}/children`, 'utf8'); } catch { continue; }
      for (const child of children.split(/\s+/).filter(Boolean).map(Number)) {
        found.push(child);
        stack.push(child);
      }
    }
  }
  return found;
}

function killTree(child) {
  if (!child.pid) return;
  for (const pid of [...descendants(child.pid).reverse(), child.pid]) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// Where AGY put its token in the throwaway HOME. Normally
// ~/.gemini/antigravity-cli/antigravity-oauth-token, but look further down in case a
// release moves it.
function findTokenFile(home) {
  const expected = join(home, ...TOKEN_PATH);
  if (existsSync(expected)) return expected;
  const stack = [[home, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === TOKEN_FILE) return full;
      if (entry.isDirectory() && depth < 4 && entry.name !== 'log' && entry.name !== 'bin') stack.push([full, depth + 1]);
    }
  }
  return null;
}

// Text safe to show and log: no URLs, codes or long credential-like strings.
function redactDiagnostics(text, code) {
  let out = text;
  if (code) out = out.split(code).join('[code]');
  return out
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/[A-Za-z0-9_\-./+=]{40,}/g, '[redacted]');
}

// What AGY said about the login: the end of its terminal output and the
// OAuth/error lines from its own log in the throwaway HOME.
function loginDiagnostics(login, outputBefore, code) {
  const lines = login.output.slice(outputBefore).split('\n')
    .map(l => l.trim())
    .filter(l => l && l !== code && !/^Or, paste|^Waiting for authentication/.test(l));
  const logDir = join(login.home, '.gemini', 'antigravity-cli', 'log');
  let logLines = [];
  try {
    for (const name of readdirSync(logDir)) {
      const text = readFileSync(join(logDir, name), 'utf8');
      logLines.push(...text.split('\n').filter(l => /OAuth|keyring|token|onboard|not logged|ERROR|^E\d{4}/i.test(l) && !/file_watcher/.test(l)));
    }
  } catch { /* AGY wrote no log */ }
  logLines = logLines.slice(-6).map(l => l.replace(/^[IWEF]\d{4} [\d:.]+\s+\d+ /, ''));
  const files = [];
  const stack = [[join(login.home, '.gemini'), '']];
  while (stack.length && files.length < 40) {
    const [dir, rel] = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (['log', 'bin', 'crashes', 'updater'].includes(entry.name)) continue;
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && name.split('/').length < 4) stack.push([join(dir, entry.name), name]);
      else if (entry.isFile()) files.push(name);
    }
  }
  // File names only (never contents), so a token stored under a new name shows up.
  const fileNote = files.length ? `files: ${files.sort().join(', ')}` : '';
  const said = redactDiagnostics([...lines.slice(-3), ...logLines].join(' | '), code);
  return { short: redactDiagnostics(lines.slice(-2).join(' | '), code).slice(0, 300), full: [said, fileNote].filter(Boolean).join(' | ').slice(0, 2000) };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function resolveAgyCommand(config) {
  const configured = config?.agy?.command || process.env.AGY_CLI_PATH;
  if (configured) return configured;
  const local = join(homedir(), '.local', 'bin', 'agy');
  return existsSync(local) ? local : 'agy';
}

function stripTerminal(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

/** Ask Google for the account chooser, so the operator picks which account to add. */
export function withAccountChooser(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('prompt', 'select_account consent');
    return u.toString();
  } catch {
    return url;
  }
}

export class AgyLoginManager {
  constructor({ command, store, usePty = true, now = () => Date.now() } = {}) {
    this.command = command;
    this.store = store;
    this.usePty = usePty;
    this.now = now;
    this.logins = new Map();
  }

  _cleanup(login) {
    if (login.done) return;
    login.done = true;
    clearTimeout(login.timer);
    killTree(login.child);
    try { rmSync(login.home, { recursive: true, force: true }); } catch { /* best effort */ }
    setTimeout(() => this.logins.delete(login.id), 5 * 60_000).unref?.();
  }

  /** Start AGY's login; resolves with Google's consent URL. */
  start() {
    for (const login of this.logins.values()) {
      if (!login.done && login.expiresAt <= this.now()) this._cleanup(login);
    }
    const active = [...this.logins.values()].filter(l => !l.done).length;
    if (active >= MAX_LOGINS) return Promise.reject(new Error('another AGY login is already in progress'));

    const id = randomBytes(12).toString('hex');
    const home = mkdtempSync(join(tmpdir(), 'agy-login-'));
    const env = {
      HOME: home,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: process.env.LANG || 'C.UTF-8',
      TERM: 'dumb',
    };
    const agyArgs = ['--print', 'ok'];
    const child = this.usePty
      ? spawn('script', ['-qfec', [this.command, ...agyArgs].map(shellQuote).join(' '), '/dev/null'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(this.command, agyArgs, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const login = {
      id, home, child, output: '', url: null, done: false, error: null,
      startedAt: this.now(), expiresAt: this.now() + LOGIN_WINDOW_MS, waiters: [],
    };
    this.logins.set(id, login);
    const onData = chunk => {
      login.output = (login.output + stripTerminal(chunk.toString('utf8'))).slice(-16_384);
      for (const w of login.waiters.splice(0)) w();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => { login.error = err.message; for (const w of login.waiters.splice(0)) w(); });
    child.on('exit', () => { login.exited = true; for (const w of login.waiters.splice(0)) w(); });
    login.timer = setTimeout(() => this._cleanup(login), LOGIN_WINDOW_MS + SUBMIT_WAIT_MS);
    login.timer.unref?.();

    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => finish(new Error('AGY did not print a login URL')), 20_000);
      const finish = (err) => {
        clearTimeout(deadline);
        if (err) { this._cleanup(login); reject(err); return; }
        resolve({ loginId: id, url: withAccountChooser(login.url), expiresAt: login.expiresAt, expiresInMs: Math.max(0, login.expiresAt - this.now()) });
      };
      const check = () => {
        const m = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"']+/.exec(login.output);
        if (m) { login.url = m[0]; finish(); return; }
        if (login.error) { finish(new Error(`AGY could not be started: ${login.error}`)); return; }
        if (existsSync(join(home, ...TOKEN_PATH))) { finish(new Error('AGY did not ask for a login')); return; }
        if (login.exited) { finish(new Error(`AGY exited without a login URL: ${login.output.trim().split('\n').pop() || 'no output'}`)); return; }
        login.waiters.push(check);
      };
      check();
    });
  }

  /** Hand AGY the authorization code; resolves with the stored account. */
  submit(loginId, code) {
    const login = this.logins.get(loginId);
    if (!login || login.done) return Promise.reject(new Error('this login has ended; start a new one'));
    if (login.expiresAt <= this.now()) {
      this._cleanup(login);
      return Promise.reject(new Error('the login link expired (AGY waits 60 s); start a new one'));
    }
    if (login.submitting) return Promise.reject(new Error('a code for this login is already being checked'));
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (!CODE_RE.test(trimmed)) return Promise.reject(new Error('that does not look like an authorization code'));
    login.submitting = true;
    const outputBefore = login.output.length;
    login.child.stdin.write(trimmed + '\n');

    return new Promise((resolve, reject) => {
      // Poll fast: once the token is written AGY goes on to run its prompt,
      // which would spend a request on the new account.
      const poll = setInterval(() => check(), 50);
      const deadline = setTimeout(() => finish(new Error('AGY did not finish the login in time')), SUBMIT_WAIT_MS);
      const finish = (err, account) => {
        clearInterval(poll);
        clearTimeout(deadline);
        if (err) {
          // Read AGY's own account of the failure before its HOME is removed.
          const detail = loginDiagnostics(login, outputBefore, trimmed);
          console.warn(`[AgentLB] AGY login failed: ${err.message} — ${detail.full || 'no output'}`);
          if (detail.short && !err.message.includes(detail.short) && !detail.short.includes(err.message)) {
            err.message += ` (AGY: ${detail.short})`;
          }
        }
        this._cleanup(login);
        if (err) reject(err); else resolve(account);
      };
      const check = () => {
        if (login.done) return;
        const tokenPath = findTokenFile(login.home);
        if (tokenPath) {
          let raw;
          try { raw = readFileSync(tokenPath, 'utf8'); } catch { return; }
          try {
            finish(null, this.store.upsert(raw));
          } catch (err) {
            // AGY may still be writing the file; retry until the deadline.
            if (!(err instanceof SyntaxError)) finish(err);
          }
          return;
        }
        const tail = login.output.slice(outputBefore);
        const failed = /Error: (authentication[^\n]*)/.exec(tail);
        if (failed) { finish(new Error(failed[1].trim())); return; }
        if (login.exited) {
          const said = /(?:^|\n)\s*(?:Error|error): ([^\n]+)/.exec(tail);
          finish(new Error(said ? `AGY stopped: ${said[1].trim()}` : 'AGY exited before saving the login'));
        }
      };
      login.waiters.push(check);
    });
  }

  cancel(loginId) {
    const login = this.logins.get(loginId);
    if (!login) return false;
    this._cleanup(login);
    return true;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, res) {
  try {
    return JSON.parse((await readControlBody(req)) || '{}');
  } catch (err) {
    sendJson(res, err.message === 'body too large' ? 413 : 400, { ok: false, error: 'invalid request body' });
    return null;
  }
}

/**
 * Routes for AGY accounts. `/api/agy/*` is the dashboard (the caller has
 * already been checked as administrator); `/agy/*` is for agybridge on the
 * stations and needs an unrestricted station key, since it hands out a
 * Google refresh token.
 */
const MODEL_LIST_WAIT_MS = 2000;

/** Model ids for the dashboard; never blocks the account list on a slow `agy models`. */
async function catalogIds(catalog) {
  if (!catalog) return [];
  let timer;
  try {
    const models = await Promise.race([
      catalog.list(),
      new Promise(resolve => { timer = setTimeout(() => resolve(catalog.models || []), MODEL_LIST_WAIT_MS); timer.unref?.(); }),
    ]);
    return (models || []).map(m => m.id).filter(id => typeof id === 'string');
  } catch {
    return [];
  } finally { clearTimeout(timer); }
}

export async function handleAgyRoute(req, res, { normApiPath, auth, clientKey, clientUsage, store, logins, pool = null, catalog = null, testAccount = null, refreshSubscription = null }) {
  if (normApiPath === '/agy/credential' || normApiPath === '/agy/quota' || normApiPath === '/agy/usage') {
    if (!clientKey || !auth?.ok || !relayPolicyAllowed(auth, clientUsage) || !(auth.primary || auth.entry?.allowCredentialRelay === true)) {
      sendJson(res, 403, { ok: false, error: 'an unrestricted station key is required for AGY accounts' });
      return true;
    }
    const client = auth.client || 'admin';
    if (normApiPath === '/agy/credential' && req.method === 'GET') {
      const current = new URL(req.url, 'http://x').searchParams.get('current');
      const cred = store.credentialFor(client, current);
      if (!cred) { sendJson(res, 404, { ok: false, error: 'no AGY account with free quota' }); return true; }
      sendJson(res, 200, { ok: true, ...cred });
      return true;
    }
    if (normApiPath === '/agy/usage' && req.method === 'POST') {
      const body = await readJson(req, res);
      if (!body) return true;
      const who = typeof body.accountId === 'string' ? body.accountId : body.email;
      const done = store.setUsage(who, body.models, body.subscription);
      sendJson(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'no such AGY account' });
      return true;
    }
    if (normApiPath === '/agy/quota' && req.method === 'POST') {
      const body = await readJson(req, res);
      if (!body) return true;
      const cred = store.reportQuota(client, typeof body.accountId === 'string' ? body.accountId : null, body.resetSeconds, body.message);
      console.log(`[AgentLB] AGY quota spent on ${body.accountId || '?'} (reported by ${client}); next: ${cred?.account.email || 'none'}`);
      if (!cred) { sendJson(res, 404, { ok: false, error: 'no AGY account with free quota' }); return true; }
      sendJson(res, 200, { ok: true, ...cred });
      return true;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }

  if (!normApiPath.startsWith('/api/agy/')) return false;
  const action = normApiPath.slice('/api/agy/'.length);

  if (action === 'accounts' && req.method === 'GET') {
    const accounts = store.list().map(a => ({ ...a, busy: Number(pool?.busy?.(a.id)) || 0 }));
    sendJson(res, 200, { ok: true, pinned: store.data.pinned, accounts, models: await catalogIds(catalog), events: store.data.events || [], queue: pool?.snapshot?.() || [] });
    return true;
  }
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return true; }
  const body = await readJson(req, res);
  if (!body) return true;

  try {
    switch (action) {
      case 'login/start': {
        const started = await logins.start();
        sendJson(res, 200, { ok: true, ...started });
        return true;
      }
      case 'login/submit': {
        const account = await logins.submit(body.loginId, body.code);
        console.log(`[AgentLB] AGY account ${account.email} logged in (web control)`);
        sendJson(res, 200, { ok: true, account });
        return true;
      }
      case 'login/cancel':
        sendJson(res, 200, { ok: logins.cancel(body.loginId) });
        return true;
      case 'accounts/remove':
        { const done = store.remove(body.id); sendJson(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'no such AGY account' }); }
        return true;
      case 'accounts/enable':
        { const done = store.setEnabled(body.id, body.enabled); sendJson(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'no such AGY account' }); }
        return true;
      case 'accounts/rename':
        if (typeof body.id !== 'string' || !store._find(body.id)) { sendJson(res, 404, { ok: false, error: 'no such AGY account' }); return true; }
        { const done = store.rename(body.id, body.name); sendJson(res, done ? 200 : 400, done ? { ok: true } : { ok: false, error: 'name must be a string of at most 100 characters' }); }
        return true;
      case 'accounts/pin':
        { const done = store.pin(typeof body.id === 'string' ? body.id : null); sendJson(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'no such AGY account' }); }
        return true;
      case 'accounts/reorder':
        { const done = store.reorder(body.ids); sendJson(res, done ? 200 : 400, done ? { ok: true } : { ok: false, error: '"ids" must be a list' }); }
        return true;
      case 'accounts/test': {
        if (typeof body.id !== 'string' || !body.id) { sendJson(res, 400, { ok: false, error: '"id" is required' }); return true; }
        if (!store.list().some(a => a.id === body.id)) { sendJson(res, 404, { ok: false, error: 'no such AGY account' }); return true; }
        if (!testAccount) { sendJson(res, 501, { ok: false, error: 'AGY test is not available' }); return true; }
        const result = await testAccount(body.id);
        store.recordEvent({ accountId: body.id, client: 'dashboard-test', model: result.model,
          outcome: result.ok ? 'success' : 'test_failed', durationMs: result.ms || 0 });
        sendJson(res, 200, result.ok ? { ok: true, ms: result.ms, model: result.model } : { ok: false, error: result.error, ...(result.ms != null ? { ms: result.ms } : {}) });
        return true;
      }
      case 'accounts/subscription': {
        if (typeof body.id !== 'string' || !store._find(body.id)) { sendJson(res, 404, { ok: false, error: 'no such AGY account' }); return true; }
        if (!refreshSubscription) { sendJson(res, 501, { ok: false, error: 'AGY subscription refresh is not available' }); return true; }
        sendJson(res, 200, await refreshSubscription(body.id));
        return true;
      }
      case 'accounts/clear-health':
        { const done = store.clearHealth(body.id); sendJson(res, done ? 200 : 404, { ok: done }); }
        return true;
      case 'accounts/clear-quota':
        { const done = store.clearQuota(body.id); sendJson(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: 'no such AGY account' }); }
        return true;
      default:
        sendJson(res, 404, { ok: false, error: 'unknown AGY action' });
        return true;
    }
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return true;
  }
}
