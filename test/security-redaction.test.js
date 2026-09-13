import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeaders, maskSecret, parseSSEUsage } from '../src/server.js';

describe('credential redaction', () => {
  it('masks client keys in status-shaped values', () => {
    assert.equal(maskSecret('tc-secret-key-12345'), 'tc-s...2345');
    assert.equal(maskSecret('short'), '***');
    assert.equal(maskSecret(null), '');
  });

  it('redacts credentials and cookies from request log headers', () => {
    const rendered = formatHeaders({
      authorization: 'Bearer oauth-secret',
      'x-api-key': 'tc-secret-key',
      cookie: 'session=secret',
      'set-cookie': 'sid=secret; HttpOnly',
      'content-type': 'application/json',
    });
    assert.ok(!rendered.includes('oauth-secret'));
    assert.ok(!rendered.includes('tc-secret-key'));
    assert.ok(!rendered.includes('session=secret'));
    assert.match(rendered, /content-type: application\/json/);
    assert.equal((rendered.match(/\[redacted\]/g) || []).length, 4);
  });

  it('parses usage events with RFC-compliant CRLF delimiters', () => {
    const calls = [];
    const manager = {
      updateUsage(index, input, output) { calls.push([index, input, output]); },
    };
    const merged = {};
    parseSSEUsage('event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\r\n', 2, manager, null, merged);
    assert.deepEqual(calls, [[2, 7, 0]]);
    assert.equal(merged.input_tokens, 7);
  });
});
