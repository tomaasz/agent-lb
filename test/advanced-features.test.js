import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ClientUsageTracker } from '../src/client-usage.js';
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  translateOpenAIToAnthropicResponse,
  createOpenAIToAnthropicTransformStream,
} from '../src/provider-translator.js';
import { Readable } from 'node:stream';

test('Faza 1: Session Affinity and Routing Policy Endpoint', async () => {
  const am = new AccountManager([
    { name: 'acct-1', provider: 'anthropic', type: 'oauth', accessToken: 'token-1', priority: 0 },
    { name: 'acct-2', provider: 'anthropic', type: 'oauth', accessToken: 'token-2', priority: 0 },
  ], 0.98, { distributeSessions: 'adaptive', expiryRouting: { enabled: true, tolerance: 1.5, preempt: true } });

  assert.equal(am.distributionMode, 'adaptive');
  assert.equal(am.distributeSessions, true);
  assert.equal(am.expiryRouting.enabled, true);

  // Pin a session to acct-1
  am.recordSession('session-abc', 0, 'claude-sonnet');
  const chosen = am.getActiveAccount(null, 'claude-sonnet', null, 'session-abc');
  assert.equal(chosen.name, 'acct-1', 'Adaptive session affinity must stick to the existing pinned account');

  // Test /api/routing endpoint
  const proxyServer = createProxyServer(am, {
    upstream: 'http://127.0.0.1:9999',
    proxy: { apiKey: 'admin-secret', trustLoopback: false },
    distributeSessions: 'adaptive',
    expiryRouting: { enabled: true, tolerance: 1.5, preempt: true },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;

  try {
    // GET /api/routing
    const getRes = await fetch(`http://127.0.0.1:${proxyPort}/api/routing`, {
      headers: { 'x-api-key': 'admin-secret' },
    });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.distributeSessions, 'adaptive');
    assert.equal(getJson.expiryRouting.enabled, true);

    // POST /api/routing
    const postRes = await fetch(`http://127.0.0.1:${proxyPort}/api/routing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'admin-secret' },
      body: JSON.stringify({
        distributeSessions: 'even',
        expiryRouting: { enabled: false, tolerance: 1.0, preempt: false },
        crossProviderFallback: true,
      }),
    });
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.distributeSessions, 'even');
    assert.equal(postJson.expiryRouting.enabled, false);
    assert.equal(postJson.crossProviderFallback, true);
    assert.equal(am.distributionMode, 'even');
    assert.equal(am.expiryRouting.enabled, false);
    assert.equal(am.crossProviderFallback, true);

    // POST /api/routing with resetDefaults: true
    const resetRes = await fetch(`http://127.0.0.1:${proxyPort}/api/routing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'admin-secret' },
      body: JSON.stringify({ resetDefaults: true }),
    });
    assert.equal(resetRes.status, 200);
    const resetJson = await resetRes.json();
    assert.equal(resetJson.distributeSessions, 'adaptive');
    assert.equal(resetJson.expiryRouting.enabled, true);
    assert.equal(resetJson.crossProviderFallback, true);
    assert.equal(am.distributionMode, 'adaptive');
    assert.equal(am.expiryRouting.enabled, true);
    assert.equal(am.crossProviderFallback, true);
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
  }
});

test('Faza 2: Client Usage Tracker Granular Quotas & Model Permissions', async () => {
  const tracker = new ClientUsageTracker();

  const keyConfig = {
    maxDailyTokens: 1000,
    maxMonthlyTokens: 5000,
    expiresAt: '2099-01-01',
    allowedModels: ['claude-3-5-sonnet*', 'gpt-4o'],
  };

  // Model allowed
  let check = tracker.checkQuota('dev-1', keyConfig, 'claude-3-5-sonnet-20241022');
  assert.equal(check.allowed, true);

  // Model not allowed
  check = tracker.checkQuota('dev-1', keyConfig, 'claude-3-haiku-20240307');
  assert.equal(check.allowed, false);
  assert.equal(check.status, 403);
  assert.match(check.error, /nie posiada uprawnień/);

  // Expiration check
  const expiredKey = { ...keyConfig, expiresAt: '2020-01-01' };
  check = tracker.checkQuota('dev-1', expiredKey, 'claude-3-5-sonnet-20241022');
  assert.equal(check.allowed, false);
  assert.equal(check.status, 403);
  assert.match(check.error, /wygasł/);

  // Record usage within limits
  tracker.recordTokens('dev-1', 400, 200); // 600 total
  check = tracker.checkQuota('dev-1', keyConfig, 'claude-3-5-sonnet-20241022');
  assert.equal(check.allowed, true);

  // Record usage exceeding daily limit
  tracker.recordTokens('dev-1', 300, 300); // 1200 total > 1000 limit
  check = tracker.checkQuota('dev-1', keyConfig, 'claude-3-5-sonnet-20241022');
  assert.equal(check.allowed, false);
  assert.equal(check.status, 429);
  assert.match(check.error, /Dzienny limit/);
  assert.ok(check.retryAfter > 0, 'Retry-After should be a positive number of seconds until midnight UTC');

  // Persistence export/restore
  const dumped = tracker.export();
  const restoredTracker = new ClientUsageTracker();
  restoredTracker.restore(dumped);
  const clientData = restoredTracker.getClient('dev-1');
  assert.equal(clientData.dailyTokens, 1200);
  assert.equal(clientData.monthlyTokens, 1200);
});

test('Faza 3: Circuit Breaker & Graceful Drain Operations', async () => {
  const am = new AccountManager([
    { name: 'flaky-acct', provider: 'anthropic', type: 'oauth', accessToken: 'token-flaky', priority: 0 },
    { name: 'backup-acct', provider: 'anthropic', type: 'oauth', accessToken: 'token-backup', priority: 1 },
  ]);

  // Record 3 consecutive failures on flaky-acct -> trips circuit breaker
  const acct = am.accounts[0];
  am.recordAccountFailure(acct);
  am.recordAccountFailure(acct);
  assert.equal(am._isAvailable(acct), true, 'Account should still be available after 2 failures');
  am.recordAccountFailure(acct); // 3rd failure trips
  assert.equal(am._isAvailable(acct), false, 'Account should be unavailable after 3 consecutive failures');
  assert.equal(am.unavailableReason(acct), 'circuit-breaker');
  assert.ok(acct.circuitBreakerUntil > Date.now());

  // Record success resets circuit breaker
  am.recordAccountSuccess(acct);
  acct.circuitBreakerUntil = null;
  assert.equal(acct.consecutiveErrors, 0);
  assert.equal(am._isAvailable(acct), true);

  // Test Drain Mode & /ready endpoint
  const proxyServer = createProxyServer(am, {
    upstream: 'http://127.0.0.1:9999',
    proxy: { apiKey: 'admin-key', trustLoopback: false },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;

  try {
    // Initial /ready probe -> 200
    let readyRes = await fetch(`http://127.0.0.1:${proxyPort}/ready`);
    assert.equal(readyRes.status, 200);
    let readyJson = await readyRes.json();
    assert.equal(readyJson.ready, true);
    assert.equal(readyJson.draining, false);

    // POST /api/drain -> initiates drain mode
    const drainRes = await fetch(`http://127.0.0.1:${proxyPort}/api/drain`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin-key' },
    });
    assert.equal(drainRes.status, 200);
    const drainJson = await drainRes.json();
    assert.equal(drainJson.draining, true);

    // /ready probe now returns 503 during drain
    readyRes = await fetch(`http://127.0.0.1:${proxyPort}/ready`);
    assert.equal(readyRes.status, 503);
    readyJson = await readyRes.json();
    assert.equal(readyJson.ready, false);
    assert.equal(readyJson.draining, true);

    // POST /api/drain/cancel -> cancels drain
    const cancelRes = await fetch(`http://127.0.0.1:${proxyPort}/api/drain/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': 'admin-key' },
    });
    assert.equal(cancelRes.status, 200);

    // /ready probe returns 200 again
    readyRes = await fetch(`http://127.0.0.1:${proxyPort}/ready`);
    assert.equal(readyRes.status, 200);
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
  }
});

test('Faza 4: Cross-Provider Fallback & Protocol Translator', async () => {
  // 1. Anthropic -> OpenAI Request Translation
  const anthropicRequest = {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    system: 'You are an autonomous AI coding assistant.',
    messages: [
      { role: 'user', content: 'What is 2 + 2?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me calculate.' },
          { type: 'tool_use', id: 'calc_1', name: 'calculate', input: { expr: '2+2' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'calc_1', content: '4' },
        ],
      },
    ],
    tools: [
      {
        name: 'calculate',
        description: 'Computes math',
        input_schema: { type: 'object', properties: { expr: { type: 'string' } } },
      },
    ],
  };

  const openAIBodyBuf = translateAnthropicToOpenAI(anthropicRequest, 'gpt-4o');
  const openAIBody = JSON.parse(openAIBodyBuf.toString('utf8'));

  assert.equal(openAIBody.model, 'gpt-4o');
  assert.equal(openAIBody.messages[0].role, 'system');
  assert.equal(openAIBody.messages[0].content, 'You are an autonomous AI coding assistant.');
  assert.equal(openAIBody.messages[1].role, 'user');
  assert.equal(openAIBody.messages[1].content, 'What is 2 + 2?');
  assert.equal(openAIBody.messages[2].role, 'assistant');
  assert.equal(openAIBody.messages[2].tool_calls[0].function.name, 'calculate');
  assert.equal(openAIBody.messages[3].role, 'tool');
  assert.equal(openAIBody.messages[3].tool_call_id, 'calc_1');
  assert.equal(openAIBody.messages[3].content, '4');
  assert.equal(openAIBody.tools[0].function.name, 'calculate');

  // 2. OpenAI -> Anthropic Response Translation (Non-streaming JSON)
  const openAIResponse = {
    id: 'chatcmpl-test-123',
    choices: [
      {
        message: {
          role: 'assistant',
          content: '2 + 2 = 4',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 25, completion_tokens: 10 },
  };

  const anthropicResp = translateOpenAIToAnthropicResponse(openAIResponse, 'claude-3-5-sonnet-20241022');
  assert.equal(anthropicResp.type, 'message');
  assert.equal(anthropicResp.role, 'assistant');
  assert.equal(anthropicResp.content[0].type, 'text');
  assert.equal(anthropicResp.content[0].text, '2 + 2 = 4');
  assert.equal(anthropicResp.stop_reason, 'end_turn');
  assert.equal(anthropicResp.usage.input_tokens, 25);
  assert.equal(anthropicResp.usage.output_tokens, 10);

  // 3. OpenAI -> Anthropic SSE Stream Translation
  const sseChunks = [
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world!"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const transform = createOpenAIToAnthropicTransformStream('claude-3-5-sonnet-20241022');
  const readable = Readable.from(sseChunks);
  const outChunks = [];
  transform.on('data', chunk => outChunks.push(chunk.toString('utf8')));
  readable.pipe(transform);

  await new Promise(resolve => transform.on('end', resolve));
  const fullOutput = outChunks.join('');
  assert.match(fullOutput, /event: message_start/);
  assert.match(fullOutput, /event: content_block_start/);
  assert.match(fullOutput, /event: content_block_delta/);
  assert.match(fullOutput, /"text":"Hello"/);
  assert.match(fullOutput, /"text":" world!"/);
  assert.match(fullOutput, /event: content_block_stop/);
  assert.match(fullOutput, /event: message_delta/);
  assert.match(fullOutput, /event: message_stop/);
});

test('OpenAI -> Anthropic request translation with tool_calls, results and coalescence', () => {
  const openAIReq = {
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'Execute some code' },
      {
        role: 'assistant',
        content: 'I will run the code now.',
        tool_calls: [
          {
            id: 'toolu_01RoTGPsyqJ5TgRqjsuFQdFj',
            type: 'function',
            function: {
              name: 'execute_code',
              arguments: JSON.stringify({ code: 'print("hello")' }),
            },
          },
          {
            id: 'toolu_02SecondCall',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"main.py"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'toolu_01RoTGPsyqJ5TgRqjsuFQdFj',
        content: 'hello\n',
      },
      {
        role: 'tool',
        tool_call_id: 'toolu_02SecondCall',
        content: 'def main(): pass',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'execute_code',
          description: 'Runs code in python',
          parameters: { type: 'object', properties: { code: { type: 'string' } } },
        },
      },
    ],
    tool_choice: 'auto',
  };

  const anthropicBuf = translateOpenAIToAnthropic(openAIReq, 'claude-opus-5');
  const anthropicJson = JSON.parse(anthropicBuf.toString('utf8'));

  assert.equal(anthropicJson.model, 'claude-opus-5');
  assert.equal(anthropicJson.messages.length, 3); // user, assistant, user (coalesced 2 tool results)

  // Message 0: user
  assert.equal(anthropicJson.messages[0].role, 'user');

  // Message 1: assistant with text and tool_use blocks
  assert.equal(anthropicJson.messages[1].role, 'assistant');
  assert.equal(Array.isArray(anthropicJson.messages[1].content), true);
  assert.equal(anthropicJson.messages[1].content[0].type, 'text');
  assert.equal(anthropicJson.messages[1].content[0].text, 'I will run the code now.');
  assert.equal(anthropicJson.messages[1].content[1].type, 'tool_use');
  assert.equal(anthropicJson.messages[1].content[1].id, 'toolu_01RoTGPsyqJ5TgRqjsuFQdFj');
  assert.equal(anthropicJson.messages[1].content[1].name, 'execute_code');
  assert.deepEqual(anthropicJson.messages[1].content[1].input, { code: 'print("hello")' });

  assert.equal(anthropicJson.messages[1].content[2].type, 'tool_use');
  assert.equal(anthropicJson.messages[1].content[2].id, 'toolu_02SecondCall');
  assert.equal(anthropicJson.messages[1].content[2].name, 'read_file');
  assert.deepEqual(anthropicJson.messages[1].content[2].input, { path: 'main.py' });

  // Message 2: user with both tool_result blocks coalesced
  assert.equal(anthropicJson.messages[2].role, 'user');
  assert.equal(Array.isArray(anthropicJson.messages[2].content), true);
  assert.equal(anthropicJson.messages[2].content.length, 2);
  assert.equal(anthropicJson.messages[2].content[0].type, 'tool_result');
  assert.equal(anthropicJson.messages[2].content[0].tool_use_id, 'toolu_01RoTGPsyqJ5TgRqjsuFQdFj');
  assert.equal(anthropicJson.messages[2].content[0].content, 'hello\n');

  assert.equal(anthropicJson.messages[2].content[1].type, 'tool_result');
  assert.equal(anthropicJson.messages[2].content[1].tool_use_id, 'toolu_02SecondCall');
  assert.equal(anthropicJson.messages[2].content[1].content, 'def main(): pass');

  // Tools definition and tool_choice
  assert.equal(anthropicJson.tools.length, 1);
  assert.equal(anthropicJson.tools[0].name, 'execute_code');
  assert.deepEqual(anthropicJson.tool_choice, { type: 'auto' });
});
