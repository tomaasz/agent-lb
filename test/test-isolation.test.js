import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgyAccountsPath } from '../src/agy-accounts.js';
import { assertIsolatedConfig, isUnderRealConfigDir } from './support/config-guard.js';

test('the default AGY accounts path of a test process stays outside the real config dir', () => {
  // Fails loudly when the preload is missing (running `node --test` directly
  // on a host with a real ~/.config): use `npm test`.
  assert.doesNotThrow(() => assertIsolatedConfig({ 'AGY accounts file': getAgyAccountsPath() }));
});

test('guard rejects the real-home accounts file and homes dir', () => {
  const real = join(homedir(), '.config');
  assert.ok(isUnderRealConfigDir(join(real, 'agent-lb.agy-accounts.json')));
  assert.ok(isUnderRealConfigDir(join(real, 'agy-homes', 'agy-x')));
  assert.throws(
    () => assertIsolatedConfig({ accountsPath: join(real, 'agent-lb.agy-accounts.json') }),
    /Refusing to run tests.*real config directory/,
  );
});

test('guard accepts a temp config dir', () => {
  assert.equal(isUnderRealConfigDir('/tmp/agent-lb-ci/config.json'), false);
});
