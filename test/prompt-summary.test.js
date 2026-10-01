import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPromptSummary } from '../src/server.js';

const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

describe('extractPromptSummary', () => {
  it('reads the last user message of a Chat/Anthropic body', () => {
    assert.equal(
      extractPromptSummary({ messages: [{ role: 'user', content: 'pierwszy' }, { role: 'user', content: 'napraw' }] }),
      'napraw',
    );
  });

  it('reads the last user message of a Codex Responses body (input array)', () => {
    const body = { instructions: 'x', input: [user('stary prompt'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, user('napraw')] };
    assert.equal(extractPromptSummary(body), 'napraw');
  });

  it('skips tool output items after the prompt in a Responses tool loop', () => {
    const body = { input: [user('napraw'), { type: 'function_call', name: 'shell', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'done' }] };
    assert.equal(extractPromptSummary(body), 'napraw');
  });

  it('accepts a plain string input', () => {
    assert.equal(extractPromptSummary({ input: 'napraw' }), 'napraw');
  });

  it('truncates long Responses prompts to one short line', () => {
    const out = extractPromptSummary({ input: [user('a  b\n' + 'x'.repeat(200))] });
    assert.equal(out.length, 80);
    assert.ok(out.endsWith('...'));
    assert.ok(!out.includes('\n'));
  });

  it('returns null when there is no user text', () => {
    assert.equal(extractPromptSummary({ input: [] }), null);
    assert.equal(extractPromptSummary(null), null);
  });
});
