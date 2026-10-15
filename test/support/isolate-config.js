// Preloaded into every test process (`node --import ./test/support/isolate-config.js --test`).
//
// agent-lb keeps its config, its AGY accounts file and the AGY worker homes
// next to each other, and finds them from AGENT_LB_CONFIG or, failing that,
// from the real ~/.config. A test that builds a proxy server without an
// explicit AGY path therefore reaches the operator's real accounts file, and
// on a host with a live service that means the real Google account, its quota
// and a real `agy` process. So every test process gets a throw-away config
// location unless the caller (CI) pinned one outside the real config dir.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertIsolatedConfig } from './config-guard.js';

const AUTO = 'AGENT_LB_TEST_CONFIG_AUTO';

// A value inherited from our own parent (npm test -> each test file's process)
// is the parent's temp dir and is reused; a value the caller set is theirs and
// is only checked.
if (!process.env.AGENT_LB_CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-lb-test-'));
  process.env.AGENT_LB_CONFIG = join(dir, 'agent-lb.json');
  process.env[AUTO] = dir;
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}

const configPath = process.env.AGENT_LB_CONFIG;
assertIsolatedConfig({
  AGENT_LB_CONFIG: configPath,
  'AGY accounts file': configPath.endsWith('.json') ? configPath.replace(/\.json$/, '.agy-accounts.json') : `${configPath}.agy-accounts`,
});
