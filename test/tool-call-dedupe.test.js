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


describe('Tool Call Deduplication across conversation turns', () => {
  const turn1 = [
    { role: 'user', content: 'edit two files' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'echo a > a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: '' }] },
  ];
  const turn2 = [
    ...turn1,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'echo b > b' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: '' }] },
  ];

  it('does not flag the history every following turn re-sends', () => {
    const cache = new ToolCallDedupeCache();
    assert.equal(cache.inspectRequest({ messages: turn1 }, 's').hasDuplicate, false);
    cache.recordRequest({ messages: turn1 }, 's');
    const next = cache.inspectRequest({ messages: turn2 }, 's');
    assert.equal(next.hasDuplicate, false, 'toolu_A is history, not a replay');
  });

  it('flags a replay of the same turn', () => {
    const cache = new ToolCallDedupeCache();
    cache.recordRequest({ messages: turn1 }, 's');
    cache.recordRequest({ messages: turn2 }, 's');
    const replay = cache.inspectRequest({ messages: turn2 }, 's');
    assert.equal(replay.hasDuplicate, true);
    assert.deepEqual(replay.duplicates.map(d => d.id), ['toolu_B']);
  });

  it('records only the latest assistant turn, not the whole history', () => {
    const cache = new ToolCallDedupeCache();
    cache.recordRequest({ messages: turn2 }, 's');
    assert.equal(cache.cache.size, 1);
  });

  it('handles OpenAI tool_calls the same way', () => {
    const call = (id, cmd) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ cmd }) } }] });
    const t1 = [{ role: 'user', content: 'go' }, call('call_1', 'a'), { role: 'tool', tool_call_id: 'call_1', content: '' }];
    const t2 = [...t1, call('call_2', 'b'), { role: 'tool', tool_call_id: 'call_2', content: '' }];
    const cache = new ToolCallDedupeCache();
    cache.recordRequest({ messages: t1 }, 's');
    assert.equal(cache.inspectRequest({ messages: t2 }, 's').hasDuplicate, false);
    cache.recordRequest({ messages: t2 }, 's');
    assert.equal(cache.inspectRequest({ messages: t2 }, 's').hasDuplicate, true);
  });
});
