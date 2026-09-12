import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSideEffectTool, ToolCallDedupeCache } from '../src/tool-call-dedupe.js';

describe('Tool Call Deduplication & Replay Safety', () => {
  it('correctly classifies side-effect vs idempotent tools', () => {
    assert.equal(isSideEffectTool('apply_patch'), true);
    assert.equal(isSideEffectTool('edit_file'), true);
    assert.equal(isSideEffectTool('bash'), true);
    assert.equal(isSideEffectTool('execute_command'), true);
    assert.equal(isSideEffectTool('read_file'), false);
    assert.equal(isSideEffectTool('grep_search'), false);
    assert.equal(isSideEffectTool('view_file'), false);
  });

  it('records and detects duplicate side-effect calls within TTL', () => {
    const cache = new ToolCallDedupeCache({ ttlMs: 5000 });
    const sessionId = 'session-123';
    const toolId = 'toolu_abc123';
    const toolName = 'apply_patch';
    const args = { file: 'index.js', patch: 'diff...' };

    assert.equal(cache.isDuplicate(sessionId, toolId, toolName, args), false);

    cache.record(sessionId, toolId, toolName, args);

    assert.equal(cache.isDuplicate(sessionId, toolId, toolName, args), true);

    // Different toolId is not duplicate
    assert.equal(cache.isDuplicate(sessionId, 'toolu_xyz789', toolName, args), false);

    // After TTL expires
    const future = Date.now() + 6000;
    assert.equal(cache.isDuplicate(sessionId, toolId, toolName, args, future), false);
  });

  it('inspects Anthropic request bodies for replayed tool_use', () => {
    const cache = new ToolCallDedupeCache();
    const sessionId = 'session-456';
    const toolId = 'toolu_write_01';

    cache.record(sessionId, toolId, 'write_file', { path: '/tmp/foo.txt' });

    const reqBody = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Writing file...' },
            { type: 'tool_use', id: toolId, name: 'write_file', input: { path: '/tmp/foo.txt' } },
          ],
        },
      ],
    };

    const result = cache.inspectRequest(reqBody, sessionId);
    assert.equal(result.hasDuplicate, true);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].id, toolId);
  });
});

