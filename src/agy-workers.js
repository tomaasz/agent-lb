// One `agybridge serve` process per Google account. Each worker gets its own
// HOME holding that account's AGY login, so accounts never share state.
// Requests are routed through acquire()/release(); busy() lets the router
// prefer idle accounts.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { getConfigPath } from './config.js';
import { TOKEN_PATH } from './agy-accounts.js';

const READY_MS = 20_000;

export function defaultHomesDir() {
  return join(dirname(getConfigPath()), 'agy-homes');
}

/**
 * Where worker homes live: an explicit config.agy.homesDir, else beside the
 * configured accounts file (so a test or relocated install never reaches the
 * default config dir), else the default next to the config file.
 */
export function resolveAgyHomesDir(config) {
  const agy = config?.agy || {};
  if (agy.homesDir) return agy.homesDir;
  if (agy.accountsPath) return join(dirname(agy.accountsPath), 'agy-homes');
  return defaultHomesDir();
}

export function accountHome(baseDir, accountId) {
  return join(baseDir, accountId);
}

function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export class AgyWorkerPool {
  constructor({
    store, baseDir = defaultHomesDir(), command = 'agybridge', agyCommand = null,
    spawn = nodeSpawn, maxPerAccount = 2, idleMs = 600_000, portFrom = 18_800,
    readyMs = READY_MS, pollMs = 150, setTimer = setTimeout, clearTimer = clearTimeout,
  } = {}) {
    this.store = store;
    this.baseDir = baseDir;
    this.command = command;
    this.agyCommand = agyCommand;
    this.spawn = spawn;
    this.maxPerAccount = Math.max(1, maxPerAccount);
    this.idleMs = idleMs;
    this.portFrom = portFrom;
    this.readyMs = readyMs;
    this.pollMs = pollMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.states = new Map(); // accountId -> { worker, active, waiters, idleTimer }
    this.usedPorts = new Set();
    this.portChain = Promise.resolve();
  }

  _state(id) {
    let st = this.states.get(id);
    if (!st) this.states.set(id, st = { worker: null, active: 0, waiters: [], idleTimer: null });
    return st;
  }

  busy(accountId) {
    return this.states.get(accountId)?.active || 0;
  }

  ensureHome(accountId) {
    const account = this.store._find(accountId);
    if (!account) throw new Error(`unknown AGY account: ${accountId}`);
    return this._seed(account);
  }

  async acquire(accountId) {
    const account = this.store._find(accountId);
    if (!account) throw new Error(`unknown AGY account: ${accountId}`);
    const st = this._state(accountId);
    if (st.idleTimer) { this.clearTimer(st.idleTimer); st.idleTimer = null; }
    if (st.active < this.maxPerAccount) st.active++;
    else await new Promise((resolve, reject) => st.waiters.push({ resolve, reject })); // slot is handed over by release()
    try {
      if (!st.worker || st.worker.dead) st.worker = this._start(account, st);
      const w = st.worker;
      await w.ready;
      let released = false;
      return {
        port: w.port,
        token: w.token,
        release: () => {
          if (released) return;
          released = true;
          this._release(st);
        },
      };
    } catch (err) {
      this._release(st);
      throw err;
    }
  }

  _release(st) {
    const next = st.waiters.shift();
    if (next) { next.resolve(); return; }
    st.active = Math.max(0, st.active - 1);
    if (st.active === 0 && st.worker && !st.worker.dead && !st.idleTimer) {
      const w = st.worker;
      st.idleTimer = this.setTimer(() => {
        st.idleTimer = null;
        if (st.active === 0 && st.worker === w) this._kill(w);
      }, this.idleMs);
      st.idleTimer.unref?.();
    }
  }

  _kill(w) {
    try { w.child?.kill(); } catch { /* already gone */ }
    w.drop?.('stopped');
  }

  _seed(account) {
    const home = accountHome(this.baseDir, account.id);
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const file = join(home, ...TOKEN_PATH);
    if (!existsSync(file) || (account.updatedAt || 0) > (account.seededAt || 0)) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(account.token), { mode: 0o600 });
      chmodSync(file, 0o600);
      this.store.markSeeded(account.id);
    }
    mkdirSync(join(home, '.config', 'agybridge'), { recursive: true, mode: 0o700 });
    return home;
  }

  _allocPort() {
    const run = this.portChain.then(async () => {
      for (let p = this.portFrom; p < 65_535; p++) {
        if (this.usedPorts.has(p)) continue;
        if (await portFree(p)) { this.usedPorts.add(p); return p; }
      }
      throw new Error('no free port for agybridge worker');
    });
    this.portChain = run.catch(() => {});
    return run;
  }

  _start(account, st) {
    const w = { port: 0, token: randomBytes(24).toString('hex'), child: null, dead: false, ready: null };
    w.ready = (async () => {
      const home = this._seed(account);
      w.port = await this._allocPort();
      const pathDirs = [this.command, this.agyCommand]
        .filter(c => typeof c === 'string' && isAbsolute(c)).map(c => dirname(c));
      const env = {
        HOME: home,
        PATH: [process.env.PATH, ...pathDirs].filter(Boolean).join(':'),
        AGYBRIDGE_CONFIG: join(home, '.config', 'agybridge', 'none.env'),
      };
      const child = this.spawn(this.command, ['serve', '--host', '127.0.0.1', '--port', String(w.port), '--token', w.token],
        { env, cwd: home, stdio: 'ignore' });
      w.child = child;
      let onGone;
      const gone = new Promise((_, reject) => { onGone = reject; });
      gone.catch(() => {});
      const drop = (why) => {
        if (w.dead) return;
        w.dead = true;
        this.usedPorts.delete(w.port);
        if (st.worker === w) st.worker = null;
        onGone(new Error(`agybridge worker ${why}`));
      };
      w.drop = drop;
      child.once('exit', () => drop('exited'));
      child.once('error', (e) => drop(`failed to start: ${e.message}`));
      try {
        await Promise.race([gone, this._waitHealth(w)]);
      } catch (err) {
        this._kill(w);
        drop('not ready');
        throw err;
      }
    })();
    w.ready.catch(() => {});
    return w;
  }

  async _waitHealth(w) {
    const deadline = Date.now() + this.readyMs;
    while (!w.dead) {
      if (Date.now() >= deadline) throw new Error('agybridge worker not ready in time');
      try {
        const res = await fetch(`http://127.0.0.1:${w.port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) return;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, this.pollMs));
    }
  }

  stopAll() {
    for (const st of this.states.values()) {
      if (st.idleTimer) { this.clearTimer(st.idleTimer); st.idleTimer = null; }
      for (const waiter of st.waiters.splice(0)) waiter.reject(new Error('agybridge pool stopped'));
      if (st.worker) this._kill(st.worker);
    }
  }
}
