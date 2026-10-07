import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  isLikelyRawLog,
  synthesizeAndTruncateLog,
  sanitizeContextDrop,
  measureContextDropSavings,
} from '../src/context-drop-sanitize.js';
import { rewriteRequestBody } from '../src/server.js';

describe('Context Drop Log Truncation and Synthesis', () => {
  it('estimates token count using ~4 chars per token heuristic', () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(400), 100);
    assert.equal(estimateTokens('hello world!'), 3);
  });

  it('detects likely raw command and error logs', () => {
    const normalChat = 'Proszę zaimplementuj funkcję dodawania liczb.';
    assert.equal(isLikelyRawLog(normalChat), false);

    const rawLog = [
      'Running npm test...',
      '> agent-lb@2.1.0 test',
      'TAP version 13',
      '# Subtest: Suite 1',
      '  ok 1 - test passed',
      '  not ok 2 - assertionerror: expected 1 to equal 2',
      '  exit code 1',
    ].join('\n');
    assert.equal(isLikelyRawLog(rawLog), true);
  });

  it('leaves text under maxLogChars untouched', () => {
    const shortText = 'All 15 tests passed in 120ms.';
    assert.equal(synthesizeAndTruncateLog(shortText), shortText);
  });

  it('truncates heavy log dumps to head + banner with error signals + tail', () => {
    const lines = [];
    lines.push('=== START TEST RUN ===');
    for (let i = 0; i < 500; i++) {
      if (i === 150) {
        lines.push('FATAL: TypeError: Cannot read properties of undefined');
      } else if (i === 300) {
        lines.push('npm ERR! code ELIFECYCLE');
      } else {
        lines.push('Line ' + i + ': processing item in batch chunk worker');
      }
    }
    lines.push('=== END TEST RUN (exit code 1) ===');
    const rawLog = lines.join('\n');
    assert.ok(rawLog.length > 15000);

    const truncated = synthesizeAndTruncateLog(rawLog, { maxLogChars: 6000, headChars: 1500, tailChars: 1500 });
    assert.ok(truncated.length < rawLog.length);
    assert.ok(truncated.startsWith('=== START TEST RUN ==='));
    assert.ok(truncated.endsWith('=== END TEST RUN (exit code 1) ==='));
    assert.ok(truncated.includes('[... Context Drop: truncated'));
    assert.ok(truncated.includes('TypeError: Cannot read properties of undefined'));
    assert.ok(truncated.includes('npm ERR! code ELIFECYCLE'));
  });

  it('bypasses JSON parse on short bodies returning exact Buffer reference (fast path)', () => {
    const smallBody = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'krótka wiadomość' }],
    }));
    const result = sanitizeContextDrop(smallBody);
    assert.equal(result, smallBody);
  });

  it('truncates large tool_result blocks in Anthropic /v1/messages', () => {
    const hugeLog = 'LOG ENTRY: '.repeat(2000);
    const body = Buffer.from(JSON.stringify({
      messages: [
        { role: 'user', content: 'uruchom testy' },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: hugeLog,
            },
          ],
        },
      ],
    }));

    const resultBuffer = sanitizeContextDrop(body, '/v1/messages', 'application/json', { maxLogChars: 4000 });
    assert.notEqual(resultBuffer, body);
    const parsed = JSON.parse(resultBuffer.toString('utf8'));
    const toolResultContent = parsed.messages[1].content[0].content;
    assert.ok(toolResultContent.includes('[... Context Drop: truncated'));
    assert.ok(toolResultContent.length < hugeLog.length);
  });

  it('truncates large function_call_output items in Codex Responses API', () => {
    const hugeOutput = 'compiler error at line 42: SyntaxError: unexpected token\n' + 'stack frame\n'.repeat(2000);
    const body = Buffer.from(JSON.stringify({
      input: [
        { role: 'user', content: 'zbuduj projekt' },
        {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: hugeOutput,
        },
      ],
    }));

    const resultBuffer = sanitizeContextDrop(body, '/backend-api/codex/responses', 'application/json', { maxLogChars: 3000 });
    const parsed = JSON.parse(resultBuffer.toString('utf8'));
    const output = parsed.input[1].output;
    assert.ok(output.includes('[... Context Drop: truncated'));
    assert.ok(output.includes('SyntaxError: unexpected token'));
    assert.ok(output.length < hugeOutput.length);
  });

  it('integrates seamlessly into rewriteRequestBody with account overrides', () => {
    const hugeLog = 'OUTPUT: '.repeat(3000);
    const body = Buffer.from(JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'u1', content: hugeLog }],
        },
      ],
    }));

    const defaultAccount = { name: 'claude-1', type: 'oauth' };
    const rewritten = rewriteRequestBody(body, defaultAccount, '/v1/messages', 'application/json');
    const parsedDefault = JSON.parse(rewritten.toString('utf8'));
    assert.ok(parsedDefault.messages[1].content[0].content.includes('Context Drop'));

    const disabledAccount = { name: 'claude-raw', type: 'oauth', contextDrop: false };
    const untouched = rewriteRequestBody(body, disabledAccount, '/v1/messages', 'application/json');
    const parsedDisabled = JSON.parse(untouched.toString('utf8'));
    assert.equal(parsedDisabled.messages[1].content[0].content, hugeLog);
  });

  it('Spike verification: measures token and cost savings across 30 turns', () => {
    const sample20kLog = 'INFO: step processing output data\n'.repeat(2500);
    const savings = measureContextDropSavings(sample20kLog, 30, { maxLogChars: 8000, headChars: 2000, tailChars: 2000 });

    assert.equal(savings.turns, 30);
    assert.ok(savings.rawTokens > 20000, 'Raw tokens should be >20k');
    assert.ok(savings.truncatedTokens <= 2500, 'Truncated tokens should be <= 2.5k');
    assert.ok(savings.savingsPercent > 85, 'Token savings per turn should exceed 85%');
    assert.ok(savings.cumulativeTokensSaved > 500000, 'Over 30 turns, savings should exceed 500k tokens');
    assert.ok(savings.cacheStability.includes('HIGH'));
  });
});
