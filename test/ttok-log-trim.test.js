import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ttok log trimming & token counting (ttok 1.0)', () => {
  const whichCheck = spawnSync('which', ['ttok'], { encoding: 'utf-8' });
  const hasTtok = whichCheck.status === 0;

  it('verifies ttok binary availability and version if present', { skip: !hasTtok ? 'ttok not installed' : false }, () => {
    const res = spawnSync('ttok', ['--version'], { encoding: 'utf-8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /ttok, version 1\./);
  });

  it('counts tokens on input file and returns exit code 0', { skip: !hasTtok ? 'ttok not installed' : false }, () => {
    const testFile = join(tmpdir(), `test-ttok-count-${Date.now()}.txt`);
    try {
      writeFileSync(testFile, 'System verification test for ttok log trimming in agent-lb\n');
      const res = spawnSync('ttok', ['-i', testFile], { encoding: 'utf-8' });
      assert.equal(res.status, 0, 'ttok -i should exit with code 0');
      const count = parseInt(res.stdout.trim(), 10);
      assert.ok(!isNaN(count) && count > 0, `Expected token count > 0, got: ${res.stdout}`);
    } finally {
      try { unlinkSync(testFile); } catch {}
    }
  });

  it('counts tokens via stdin and returns exit code 0', { skip: !hasTtok ? 'ttok not installed' : false }, () => {
    const sample = 'Line 1: Test output log entry.\nLine 2: Another detailed debug message with metadata.\n';
    const res = spawnSync('ttok', [], { input: sample, encoding: 'utf-8' });
    assert.equal(res.status, 0, 'ttok stdin should exit with code 0');
    const tokenCount = parseInt(res.stdout.trim(), 10);
    assert.ok(!isNaN(tokenCount) && tokenCount > 0, `Expected token count > 0, got: ${res.stdout}`);
  });

  it('truncates log to specified token budget (-t) and returns exit code 0', { skip: !hasTtok ? 'ttok not installed' : false }, () => {
    const longLog = Array.from({ length: 100 }, (_, i) => `Log entry #${i + 1}: Execution completed successfully with details.`).join('\n');
    const res = spawnSync('ttok', ['-t', '50'], { input: longLog, encoding: 'utf-8' });
    assert.equal(res.status, 0, 'ttok -t should exit with code 0');
    assert.ok(res.stdout.length > 0, 'Output should not be empty');

    const countRes = spawnSync('ttok', [], { input: res.stdout, encoding: 'utf-8' });
    assert.equal(countRes.status, 0);
    const truncatedCount = parseInt(countRes.stdout.trim(), 10);
    assert.ok(truncatedCount <= 50, `Expected tokens <= 50, got ${truncatedCount}`);
  });
});
