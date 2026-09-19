import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  translateChatCompletionsToCodexResponses,
  createCodexResponsesToOpenAITransformStream,
  translateCodexResponsesToOpenAIResponse,
  resolveTargetModel,
} from '../src/provider-translator.js';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

describe('Codex Responses <-> OpenAI Chat Completions Translation', () => {
  it('translates OpenAI Chat Completions body to Codex Responses input format', () => {
    const openAIBody = {
      model: 'codex',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: 'I need to check',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: { name: 'calc', arguments: '{"expr":"2+2"}' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: '4'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calc',
            description: 'Calculator tool',
            parameters: { type: 'object', properties: { expr: { type: 'string' } } }
          }
        }
      ],
      reasoning_effort: 'medium'
    };

    const codexBuffer = translateChatCompletionsToCodexResponses(openAIBody, resolveTargetModel('codex', 'codex'));
    const codexJson = JSON.parse(codexBuffer.toString('utf8'));

    assert.equal(codexJson.model, 'gpt-5.6-sol');
    assert.equal(codexJson.store, false);
    assert.equal(codexJson.stream, true);
    assert.equal(codexJson.reasoning.effort, 'medium');

    assert.equal(codexJson.input.length, 5);
    assert.deepEqual(codexJson.input[0], {
      role: 'system',
      content: [{ type: 'input_text', text: 'You are helpful.' }]
    });
    assert.deepEqual(codexJson.input[1], {
      role: 'user',
      content: [{ type: 'input_text', text: 'What is 2+2?' }]
    });
    assert.deepEqual(codexJson.input[2], {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I need to check' }]
    });
    assert.deepEqual(codexJson.input[3], {
      type: 'function_call',
      call_id: 'call_123',
      name: 'calc',
      arguments: '{"expr":"2+2"}'
    });
    assert.deepEqual(codexJson.input[4], {
      type: 'function_call_output',
      call_id: 'call_123',
      output: '4'
    });

    assert.equal(codexJson.tools.length, 1);
    assert.equal(codexJson.tools[0].name, 'calc');
  });

  it('translates streaming Codex Responses SSE into OpenAI Chat Completion chunks', async () => {
    const sseLines = [
      'data: {"type":"response.created","response":{"id":"resp_111","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"world!"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_111","usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
    ];

    let usageRecorded = null;
    const transform = createCodexResponsesToOpenAITransformStream('codex', (usage) => {
      usageRecorded = usage;
    });

    const readable = Readable.from(sseLines);
    let output = '';
    readable.pipe(transform);

    for await (const chunk of transform) {
      output += chunk.toString('utf8');
    }

    assert.ok(output.includes('data: {"id":"chatcmpl-111","object":"chat.completion.chunk"'));
    assert.ok(output.includes('"role":"assistant","content":"Hello "'));
    assert.ok(output.includes('"content":"world!"'));
    assert.ok(output.includes('"finish_reason":"stop"'));
    assert.ok(output.includes('"prompt_tokens":10'));
    assert.ok(output.includes('data: [DONE]'));
    assert.deepEqual(usageRecorded, { input_tokens: 10, output_tokens: 5 });
  });

  it('translates non-streaming Codex Responses SSE into OpenAI Chat Completion response', () => {
    const sseRaw = [
      'data: {"type":"response.created","response":{"id":"resp_222","created_at":1700000000}}',
      'data: {"type":"response.output_text.delta","delta":"Answer is 42"}',
      'data: {"type":"response.completed","response":{"id":"resp_222","usage":{"input_tokens":8,"output_tokens":4}}}'
    ].join('\n');

    const res = translateCodexResponsesToOpenAIResponse(Buffer.from(sseRaw), 'codex');
    assert.equal(res.id, 'chatcmpl-222');
    assert.equal(res.object, 'chat.completion');
    assert.equal(res.model, 'codex');
    assert.equal(res.choices[0].message.role, 'assistant');
    assert.equal(res.choices[0].message.content, 'Answer is 42');
    assert.equal(res.choices[0].finish_reason, 'stop');
    assert.equal(res.usage.prompt_tokens, 8);
    assert.equal(res.usage.completion_tokens, 4);
  });

  it('translates streaming function calls into OpenAI tool_calls chunks', async () => {
    const sseLines = [
      'data: {"type":"response.created","response":{"id":"resp_333","created_at":1700000000}}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_abc","name":"get_weather"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"city\\":\\"Warsaw\\"}"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_333","usage":{"input_tokens":12,"output_tokens":15}}}\n\n'
    ];

    const transform = createCodexResponsesToOpenAITransformStream('gpt-5.6-sol');
    const readable = Readable.from(sseLines);
    let output = '';
    readable.pipe(transform);

    for await (const chunk of transform) {
      output += chunk.toString('utf8');
    }

    assert.ok(output.includes('"name":"get_weather"'));
    assert.ok(output.includes('"arguments":"{\\"city\\":\\"Warsaw\\"}"'));
    assert.ok(output.includes('"finish_reason":"tool_calls"'));
    assert.ok(output.includes('data: [DONE]'));
  });

  it('end-to-end: serves /v1/chat/completions by routing to Codex Responses API (both streaming & non-streaming)', async () => {
    let receivedUrl = null;
    let receivedHeaders = null;
    let receivedBody = null;

    const mockUpstream = http.createServer(async (req, res) => {
      receivedUrl = req.url;
      receivedHeaders = req.headers;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      if (req.url === '/backend-api/codex/responses') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.write('data: {"type":"response.created","response":{"id":"resp_e2e","created_at":1700000000}}\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"Hermes is connected!"}\n\n');
        res.write('data: {"type":"response.completed","response":{"id":"resp_e2e","usage":{"input_tokens":20,"output_tokens":8}}}\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      {
        name: 'codex-oauth-account',
        provider: 'codex',
        type: 'oauth',
        credential: 'mock-oauth-token',
        accountId: 'acc-uuid-1',
        upstream: upstreamUrl
      }
    ];

    const am = new AccountManager(accounts, 0.98);
    const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test-key' } }, {}, null, null, null);
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxy.address().port;

    try {
      // 1. Non-streaming test
      const resNonStream = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer tc-test-key'
        },
        body: JSON.stringify({
          model: 'codex',
          messages: [{ role: 'user', content: 'zainstaluj serwer' }],
          stream: false
        })
      });

      assert.equal(resNonStream.status, 200);
      assert.ok(resNonStream.headers.get('content-type').includes('application/json'));
      assert.equal(receivedUrl, '/backend-api/codex/responses');
      assert.equal(receivedHeaders['authorization'], 'Bearer mock-oauth-token');
      assert.equal(receivedHeaders['chatgpt-account-id'], 'acc-uuid-1');
      assert.equal(receivedHeaders['user-agent'], 'codex-cli/0.1.0');
      assert.equal(receivedBody.model, 'gpt-5.6-sol');
      assert.equal(receivedBody.input[0].content[0].text, 'zainstaluj serwer');

      const jsonResp = await resNonStream.json();
      assert.equal(jsonResp.object, 'chat.completion');
      assert.equal(jsonResp.model, 'codex');
      assert.equal(jsonResp.choices[0].message.content, 'Hermes is connected!');
      assert.equal(jsonResp.usage.prompt_tokens, 20);
      assert.equal(jsonResp.usage.completion_tokens, 8);

      // 2. Streaming test
      const resStream = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer tc-test-key'
        },
        body: JSON.stringify({
          model: 'codex',
          messages: [{ role: 'user', content: 'ping' }],
          stream: true
        })
      });

      assert.equal(resStream.status, 200);
      assert.ok(resStream.headers.get('content-type').includes('text/event-stream'));
      const sseText = await resStream.text();
      assert.ok(sseText.includes('data: {"id":"chatcmpl-e2e"'));
      assert.ok(sseText.includes('"content":"Hermes is connected!"'));
      assert.ok(sseText.includes('data: [DONE]'));

    } finally {
      await new Promise(resolve => proxy.close(resolve));
      await new Promise(resolve => mockUpstream.close(resolve));
    }
  });

  it('end-to-end: serves /v1/messages cross-provider to Codex OAuth Responses API (streaming & non-streaming)', async () => {
    let receivedUrl = null;
    let receivedBody = null;

    const mockUpstream = http.createServer(async (req, res) => {
      receivedUrl = req.url;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      if (req.url === '/backend-api/codex/responses') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.write('data: {"type":"response.created","response":{"id":"resp_claude","created_at":1700000000}}\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"Hello Claude user from Codex!"}\n\n');
        res.write('data: {"type":"response.completed","response":{"id":"resp_claude","usage":{"input_tokens":14,"output_tokens":6}}}\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      {
        name: 'codex-oauth-account',
        provider: 'codex',
        type: 'oauth',
        credential: 'mock-oauth-token',
        accountId: 'acc-uuid-1',
        upstream: upstreamUrl
      }
    ];

    const am = new AccountManager(accounts, 0.98, { crossProviderFallback: true });
    const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test-key' } }, {}, null, null, null);
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxy.address().port;

    try {
      // 1. Non-streaming
      const resNonStream = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer tc-test-key',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'hello from claude client' }]
        })
      });

      assert.equal(resNonStream.status, 200);
      assert.ok(resNonStream.headers.get('content-type').includes('application/json'));
      assert.equal(receivedUrl, '/backend-api/codex/responses');
      assert.equal(receivedBody.model, 'gpt-5.6-sol');

      const jsonResp = await resNonStream.json();
      assert.equal(jsonResp.type, 'message');
      assert.equal(jsonResp.content[0].type, 'text');
      assert.equal(jsonResp.content[0].text, 'Hello Claude user from Codex!');
      assert.equal(jsonResp.usage.input_tokens, 14);
      assert.equal(jsonResp.usage.output_tokens, 6);

      // 2. Streaming
      const resStream = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer tc-test-key',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'streaming ping' }],
          stream: true
        })
      });

      assert.equal(resStream.status, 200);
      assert.ok(resStream.headers.get('content-type').includes('text/event-stream'));
      const sseText = await resStream.text();
      assert.ok(sseText.includes('event: content_block_delta'));
      assert.ok(sseText.includes('"text":"Hello Claude user from Codex!"'));
      assert.ok(sseText.includes('event: message_stop'));

    } finally {
      await new Promise(resolve => proxy.close(resolve));
      await new Promise(resolve => mockUpstream.close(resolve));
    }
  });
});
