import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('agylb isolated account, conversation, quota and process behaviour', { timeout: 60000 }, async () => {
  const { stderr } = await promisify(execFile)('python3', ['-B', 'clients/test_agylb.py', '-v'], {
    timeout: 55000,
    maxBuffer: 128 * 1024,
  });
  assert.match(stderr, /\bOK\b/);
});
