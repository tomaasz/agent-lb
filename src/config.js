import { readFile, open, mkdir, chmod, rename, unlink, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveUpstreamProxy, setUpstreamProxy } from './upstream-proxy.js';
import { ensureAccountIds } from './account-id.js';

export function getConfigPath() {
  if (process.env.AGENT_LB_CONFIG) return process.env.AGENT_LB_CONFIG;
  if (process.env.CLAUDE_LB_CONFIG) return process.env.CLAUDE_LB_CONFIG;
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const agentPath = join(configDir, 'agent-lb.json');
  const lbPath = join(configDir, 'claude-lb.json');
  const tcPath = join(configDir, 'teamclaude.json');
  if (existsSync(agentPath)) return agentPath;
  if (existsSync(lbPath)) return lbPath;
  if (existsSync(tcPath)) return tcPath;
  return agentPath;
}

/**
 * Path to the runtime state file (a sibling of the config). This holds volatile
 * data learned at runtime — e.g. quota utilization observed passively from
 * traffic — kept out of the hand-editable config so config stays clean and
 * isn't rewritten on every state save.
 */
export function getStatePath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.state.json') : cfg + '.state';
}

/**
 * Path to the crash log (a sibling of the config), where a fatal error is
 * recorded before the process exits.
 */
export function getCrashLogPath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '-crash.log') : cfg + '-crash.log';
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(getStatePath(), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveState(state) {
  await writeJsonAtomic(getStatePath(), state);
}

/**
 * Write a JSON document so that the file at `path` is, at every instant, either
 * the previous complete document or the new one.
 *
 * A plain writeFile truncates first and fills in afterwards. The config holds
 * every account's OAuth tokens and the proxy key; a crash or power loss in that
 * gap left an empty or half-written file, and the next start threw on
 * JSON.parse with the credentials gone. So the document goes to a sibling
 * temp file, is fsynced so it is on disk before it is named, and is renamed
 * over the target — rename replaces atomically on POSIX and, in Node, on
 * Windows too (same scheme mitm.js uses for the leaf key).
 *
 * The temp file is created 0600 and chmod'ed before the rename, so the
 * "enforce 0600 on every save" behaviour of the old code holds: a config that
 * was once world-readable becomes 0600 on the next save, and the tokens are
 * never on disk under a looser mode even for an instant.
 */
async function writeJsonAtomic(path, value) {
  // A rename replaces the NAME, so a config that is a symlink (a dotfiles
  // checkout, say) would silently become a regular file where the old in-place
  // write followed the link. Resolve it first; a dangling or absent path is
  // written where it is.
  path = await realpath(path).catch(() => path);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(value, null, 2) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // `open`'s mode is masked by the umask; make the mode exact regardless.
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, path);
  } catch (err) {
    // Never leave a half-written copy of the credentials lying beside the config.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    holdSeconds: 0,
    distributeSessions: false,
    sessionTitles: { enabled: false, width: 18 },
    eventLogging: 'hide',
    blockedModels: [],
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    const config = JSON.parse(await readFile(path, 'utf-8'));
    // A file with no `accounts` key is what an empty or hand-trimmed config
    // looks like. Every reader treats the list as always present, and the first
    // one to trip was the save path — so the failure arrived while writing,
    // long after the read that could have explained it (#330). A missing list
    // is an empty one.
    if (!Array.isArray(config.accounts)) config.accounts = [];
    // Everything downstream pairs config entries to running accounts by entry id,
    // so a config written before the field existed — or edited by hand — is given
    // ids here, before anything can read one. The next save persists them.
    ensureAccountIds(config.accounts);
    applyUpstreamProxy(config);
    return config;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Publish the config's egress proxy to the process-wide setting.
 *
 * Done here, in the one place every command loads its config, rather than at
 * each of the sixteen call sites: `login`, `import`, `accounts`, `probe` and the
 * server all reach the network, and a proxy that applied to only some of them
 * would be worse than none — the account list would refresh while logging in
 * failed, or vice versa.
 *
 * A bad value is fatal on purpose. Falling back to a direct connection on a host
 * that has no route to the internet would turn one clear error into a pile of
 * ETIMEDOUTs pointing nowhere near the typo that caused them.
 */
function applyUpstreamProxy(config) {
  try {
    setUpstreamProxy(resolveUpstreamProxy(config));
  } catch (err) {
    console.error(`[TeamClaude] Bad proxy setting in ${getConfigPath()}: ${err.message}`);
    process.exit(1);
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
    // loadConfig applies this only when a file already existed — it returns
    // early on ENOENT. Without it here, the FIRST run of a network command
    // (`login` on a fresh install) leaves the process-wide setting unset, and
    // the lazy fallback resolves it from the environment against an EMPTY
    // config. That fallback has no listener to compare against, so the
    // self-proxy guard cannot fire: an operator whose HTTPS_PROXY points at
    // their own TeamClaude gets a CONNECT back into the proxy and a timeout,
    // on the one run where there is no config to explain it.
    applyUpstreamProxy(config);
  }
  return config;
}

export async function saveConfig(config) {
  // The proxy apiKey and every account's tokens live here: see writeJsonAtomic
  // for why this is not a plain writeFile.
  await writeJsonAtomic(getConfigPath(), config);
}

export function getLockPath() {
  return `${getConfigPath()}.lock`;
}

/**
 * Acquire filesystem lock on teamclaude.json.lock to coordinate with external tools and processes.
 */
export async function acquireConfigLock(timeoutMs = 5000) {
  const lockPath = getLockPath();
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(lockPath, 'wx', 0o600);
      try {
        await fh.writeFile(`${process.pid}\n`);
      } finally {
        await fh.close();
      }
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const st = await stat(lockPath);
          if (Date.now() - st.mtimeMs > 30000) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch { /* ignore */ }
        if (Date.now() - start > timeoutMs) {
          console.warn(`[TeamClaude] Breaking stale lock on ${lockPath}`);
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise(r => setTimeout(r, 50));
      } else {
        throw err;
      }
    }
  }
}

let configUpdateChain = Promise.resolve();

/**
 * Atomically update the config: acquires file lock on teamclaude.json.lock,
 * re-reads from disk, calls updater(config), then saves atomically.
 * Returns the updated config.
 */
export function atomicConfigUpdate(updater) {
  const run = async () => {
    let release = null;
    try {
      release = await acquireConfigLock();
    } catch (e) {
      console.warn('[TeamClaude] Warning: could not acquire config lock:', e.message);
    }
    try {
      const config = await loadConfig() || createDefaultConfig();
      await updater(config);
      await saveConfig(config);
      return config;
    } finally {
      if (release) await release();
    }
  };
  const result = configUpdateChain.then(run, run);
  configUpdateChain = result.then(() => {}, () => {});
  return result;
}
