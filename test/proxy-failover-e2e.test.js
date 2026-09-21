// End-to-end checks of the real proxy listener against a scripted upstream.
//
// Each test imitates a client agent (Claude Code on /v1/messages, an OpenAI
// SDK client on /v1/chat/completions) and verifies what actually reaches the
// client: that a 429/401 on one account is absorbed by rotating to another,
// and that a tool call streamed in tiny fragments arrives with its JSON intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

/** Scripted upstream: `handler(req, body, res)` answers; every request is recorded. */
async function mockUpstream(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ url: req.url, auth: req.headers.authorization || null, apiKey: req.headers['x-api-key'] || null, body });
    await handler(req, body, res, seen.length);
  });
  return { base: await serve(t, server), seen };
}

/** Write `text` to `res` in `size`-byte fragments, yielding between writes. */
async function dribble(res, text, size = 7) {
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += size) {
    res.write(buf.subarray(i, i + size));
    await new Promise(r => setImmediate(r));
  }
  res.end();
}

const sse = (events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const codexSse = (events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');

async function proxyFor(t, accounts, upstream, amOpts = {}) {
  const am = new AccountManager(accounts, 0.98, amOpts);
  const base = await serve(t, createProxyServer(am, { upstream, proxy: {}, autoHealthCheck: { enabled: false } }));
  return { am, base };
}

const anthropicRequest = (base, extra = {}) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra }),
});

const chatRequest = (base) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});

const OK_MESSAGE = sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);

// ---------------------------------------------------------------- Anthropic

test('anthropic: quota-rejection 429 on the first account is absorbed by the second', async t => {
  const up = await mockUpstream(t, (req, _body, res) => {
    if (req.headers['x-api-key'] === 'key-A') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.0' });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_MESSAGE);
  });
  const { base } = await proxyFor(t, [
    { name: 'A', type: 'api-key', apiKey: 'key-A' },
    { name: 'B', type: 'api-key', apiKey: 'key-B' },
  ], up.base);
  const res = await anthropicRequest(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /message_stop/);
  assert.deepEqual(up.seen.map(s => s.apiKey), ['key-A', 'key-B']);
});

test('anthropic: OAuth 401 forces one refresh and the retry carries the new token', async t => {
  const up = await mockUpstream(t, (req, _body, res) => {
    if (req.headers.authorization !== 'Bearer fresh-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"revoked"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_MESSAGE);
  });
  let refreshes = 0;
  const { base } = await proxyFor(t, [
    { name: 'O', type: 'oauth', accessToken: 'stale-token', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 },
  ], up.base, { refreshFn: async () => { refreshes++; return { accessToken: 'fresh-token', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000 }; } });
  const res = await anthropicRequest(base);
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(refreshes, 1);
  assert.deepEqual(up.seen.map(s => s.auth), ['Bearer stale-token', 'Bearer fresh-token']);
});

test('anthropic: a credential upstream keeps rejecting (401) fails over instead of logging the client out', async t => {
  const up = await mockUpstream(t, (req, _body, res) => {
    if (req.headers['x-api-key'] === 'dead-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_MESSAGE);
  });
  const { am, base } = await proxyFor(t, [
    { name: 'dead', type: 'api-key', apiKey: 'dead-key' },
    { name: 'live', type: 'api-key', apiKey: 'live-key' },
  ], up.base);
  const res = await anthropicRequest(base);
  assert.equal(res.status, 200, 'the client must not see a 401 for an account it never chose');
  await res.text();
  assert.deepEqual(up.seen.map(s => s.apiKey), ['dead-key', 'live-key']);
  assert.equal(am.accounts[0].lastError?.status, 401);
});

test('anthropic: tool_use streamed in 7-byte fragments reaches the client byte-for-byte with valid JSON', async t => {
  const input = {
    file_path: '/tmp/zażółć "gęślą" jaźń.js',
    old_string: 'const a = 1;\n\tif (a) {\n\t\treturn `${a}`;\n\t}\n',
    new_string: 'const a = 2; // \u2603 \\ backslash \u0000? no: \\u0000\n'.repeat(40),
    replace_all: false,
  };
  const json = JSON.stringify(input);
  // Split the JSON into partial_json pieces at awkward places (mid-escape,
  // mid-multibyte), the way the model streams it.
  const pieces = [];
  for (let i = 0; i < json.length; i += 11) pieces.push(json.slice(i, i + 11));
  const stream = sse([
    { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} } },
    ...pieces.map(p => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 99 } },
    { type: 'message_stop' },
  ]);
  const up = await mockUpstream(t, async (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await dribble(res, stream, 7);
  });
  const { base } = await proxyFor(t, [{ name: 'A', type: 'api-key', apiKey: 'key-A' }], up.base);
  const res = await anthropicRequest(base);
  assert.equal(res.status, 200);
  const received = await res.text();
  assert.equal(received, stream, 'passthrough must be byte-identical');
  let partial = '';
  for (const block of received.split('\n\n')) {
    const data = block.split('\n').find(l => l.startsWith('data: '));
    if (!data) continue;
    const ev = JSON.parse(data.slice(6));
    if (ev.delta?.type === 'input_json_delta') partial += ev.delta.partial_json;
  }
  assert.deepEqual(JSON.parse(partial), input);
});

// -------------------------------------------------------------------- Codex

const CODEX_LIMIT_BODY = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_in_seconds: 3000 } });

function codexOk(res, extraHeaders = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...extraHeaders });
  res.end(codexSse([
    { type: 'response.created', response: { id: 'resp_1', created_at: 1 } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'ok' },
    { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 2, output_tokens: 1 } } },
  ]));
}

const codexAccounts = (upstream) => [
  { name: 'C1', type: 'oauth', provider: 'codex', accessToken: 'tok-1', accountId: 'acct-1', upstream },
  { name: 'C2', type: 'oauth', provider: 'codex', accessToken: 'tok-2', accountId: 'acct-2', upstream },
];

test('codex: usage_limit_reached 429 rotates to the next account and takes the spent one out of rotation', async t => {
  const up = await mockUpstream(t, (req, _body, res) => {
    if (req.headers.authorization === 'Bearer tok-1') {
      // What chatgpt.com actually sends: no retry-after, no anthropic-* headers.
      res.writeHead(429, { 'content-type': 'application/json', 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300' });
      res.end(CODEX_LIMIT_BODY);
      return;
    }
    codexOk(res);
  });
  const { am, base } = await proxyFor(t, codexAccounts(up.base), up.base);
  const first = await chatRequest(base);
  assert.equal(first.status, 200);
  await first.text();
  const second = await chatRequest(base);
  assert.equal(second.status, 200);
  await second.text();
  assert.deepEqual(up.seen.map(s => s.auth), ['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2'],
    'the exhausted account must not be retried by the very next request');
  assert.notEqual(am.unavailableReason(am.accounts[0], 'gpt-5.6-sol'), null);
});

test('codex: x-codex-* quota headers on live traffic update the account quota', async t => {
  const up = await mockUpstream(t, (_req, _body, res) => codexOk(res, {
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '7',
    'x-codex-secondary-window-minutes': '300',
  }));
  const { am, base } = await proxyFor(t, codexAccounts(up.base).slice(0, 1), up.base);
  const res = await chatRequest(base);
  assert.equal(res.status, 200);
  await res.text();
  const q = am.accounts[0].quota;
  assert.ok(q.unified7d != null || q.unified5h != null, 'a quota reading must have been recorded from the response headers');
});

/** Collect an OpenAI chat stream into { toolCalls, finish, errors }. */
async function readChatStream(res) {
  const text = await res.text();
  const toolCalls = [];
  let finish = null;
  const errors = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    const chunk = JSON.parse(data);
    if (chunk.error) { errors.push(chunk.error); continue; }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    for (const tc of choice?.delta?.tool_calls || []) {
      // The way the OpenAI SDKs accumulate: by `index`, into a dense array.
      toolCalls[tc.index] ??= { id: null, name: '', arguments: '' };
      if (tc.id) toolCalls[tc.index].id = tc.id;
      if (tc.function?.name) toolCalls[tc.index].name += tc.function.name;
      if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
    }
  }
  return { toolCalls, finish, errors };
}

test('codex → chat completions: tool calls after a reasoning item get dense indexes and intact JSON', async t => {
  const argsA = JSON.stringify({ command: ['bash', '-lc', 'grep -rn "TODO" src | head -n 20'], workdir: '/repo' });
  const argsB = JSON.stringify({ path: 'src/a.js', patch: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-const x = "a";\n+const x = "b";\n*** End Patch\n' });
  const frag = (s) => s.match(/[\s\S]{1,9}/g);
  const stream = codexSse([
    { type: 'response.created', response: { id: 'resp_t', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_A', name: 'shell', arguments: '' } },
    ...frag(argsA).map(d => ({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: d })),
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_A', name: 'shell', arguments: argsA } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_B', name: 'apply_patch', arguments: '' } },
    ...frag(argsB).map(d => ({ type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_2', delta: d })),
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_B', name: 'apply_patch', arguments: argsB } },
    { type: 'response.completed', response: { id: 'resp_t', usage: { input_tokens: 10, output_tokens: 20 } } },
  ]);
  const up = await mockUpstream(t, async (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await dribble(res, stream, 5);
  });
  const { base } = await proxyFor(t, codexAccounts(up.base).slice(0, 1), up.base);
  const res = await chatRequest(base);
  assert.equal(res.status, 200);
  const { toolCalls, finish } = await readChatStream(res);
  assert.equal(finish, 'tool_calls');
  assert.equal(toolCalls.length, 2, 'no phantom tool call may appear for the reasoning item');
  assert.deepEqual(toolCalls.map(c => c.id), ['call_A', 'call_B']);
  assert.deepEqual(toolCalls.map(c => c.name), ['shell', 'apply_patch']);
  assert.deepEqual(JSON.parse(toolCalls[0].arguments), JSON.parse(argsA));
  assert.deepEqual(JSON.parse(toolCalls[1].arguments), JSON.parse(argsB));
});

test('codex → chat completions: arguments sent only in output_item.done are not lost', async t => {
  const args = JSON.stringify({ query: 'x' });
  const up = await mockUpstream(t, (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(codexSse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_Z', name: 'search', arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_Z', name: 'search', arguments: args } },
      { type: 'response.completed', response: { id: 'resp_z' } },
    ]));
  });
  const { base } = await proxyFor(t, codexAccounts(up.base).slice(0, 1), up.base);
  const { toolCalls } = await readChatStream(await chatRequest(base));
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(JSON.parse(toolCalls[0].arguments), { query: 'x' });
});

test('codex → chat completions: response.failed surfaces as an error, not a silent empty answer', async t => {
  const up = await mockUpstream(t, (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(codexSse([
      { type: 'response.created', response: { id: 'resp_f', created_at: 1 } },
      { type: 'response.failed', response: { id: 'resp_f', status: 'failed', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } },
    ]));
  });
  const { base } = await proxyFor(t, codexAccounts(up.base).slice(0, 1), up.base);
  const { errors, finish } = await readChatStream(await chatRequest(base));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /context window/);
  assert.equal(finish, null);
});

test('codex → anthropic chain: text + tool blocks get distinct indexes and one terminal stop_reason', async () => {
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const { createCodexResponsesToOpenAITransformStream, createOpenAIToAnthropicTransformStream } = await import('../src/provider-translator.js');
  const args = JSON.stringify({ file_path: 'a.js', content: 'x = "y"\n' });
  const src = codexSse([
    { type: 'response.created', response: { id: 'resp_c', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Editing now.' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_W', name: 'Write', arguments: '' } },
    ...args.match(/[\s\S]{1,6}/g).map(d => ({ type: 'response.function_call_arguments.delta', output_index: 2, delta: d })),
    { type: 'response.completed', response: { id: 'resp_c', usage: { input_tokens: 1, output_tokens: 2 } } },
  ]);
  let out = '';
  await pipeline(Readable.from([src]), createCodexResponsesToOpenAITransformStream('gpt-5.6-sol'), createOpenAIToAnthropicTransformStream('claude-x'),
    new (await import('node:stream')).Writable({ write(c, _e, cb) { out += c.toString(); cb(); } }));
  const events = out.split('\n\n').filter(Boolean).map(b => JSON.parse(b.split('\n').find(l => l.startsWith('data: ')).slice(6)));
  const starts = events.filter(e => e.type === 'content_block_start');
  assert.deepEqual(starts.map(e => [e.index, e.content_block.type]), [[0, 'text'], [1, 'tool_use']]);
  assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
  const deltas = events.filter(e => e.type === 'message_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta.stop_reason, 'tool_use');
  const json = events.filter(e => e.delta?.type === 'input_json_delta' && e.index === 1).map(e => e.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), JSON.parse(args));
});

test('anthropic: when every account is rejected with 401 the client gets a proxy error, not a 401', async t => {
  const up = await mockUpstream(t, (_req, _body, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
  });
  const { base } = await proxyFor(t, [{ name: 'dead', type: 'api-key', apiKey: 'dead-key' }], up.base);
  const res = await anthropicRequest(base);
  assert.notEqual(res.status, 401);
  assert.ok(res.status >= 500, `expected a 5xx proxy error, got ${res.status}`);
  await res.text();
});

// ------------------------------------------- Codex, client not streaming

const chatRequestNonStream = (base) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-5.6-sol', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
});

async function codexNonStream(t, events) {
  const up = await mockUpstream(t, (_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(codexSse(events));
  });
  const { base } = await proxyFor(t, codexAccounts(up.base).slice(0, 1), up.base);
  const res = await chatRequestNonStream(base);
  return { status: res.status, json: await res.json() };
}

test('codex non-stream: response.failed becomes an error status, not an empty 200', async t => {
  const { status, json } = await codexNonStream(t, [
    { type: 'response.created', response: { id: 'resp_f' } },
    { type: 'response.failed', response: { id: 'resp_f', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } },
  ]);
  assert.equal(status, 400);
  assert.equal(json.error.code, 'context_length_exceeded');
  assert.match(json.error.message, /context window/);
});

test('codex non-stream: a server-side failure maps to 502', async t => {
  const { status, json } = await codexNonStream(t, [
    { type: 'response.created', response: { id: 'resp_s' } },
    { type: 'error', error: { type: 'server_error', message: 'An error occurred while processing your request.' } },
  ]);
  assert.equal(status, 502);
  assert.equal(json.error.type, 'api_error');
});

test('codex non-stream: a stream cut off before response.completed is an error', async t => {
  const { status, json } = await codexNonStream(t, [
    { type: 'response.created', response: { id: 'resp_c' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'half an ans' },
  ]);
  assert.equal(status, 502);
  assert.equal(json.error.code, 'stream_truncated');
});

test('codex non-stream: a completed answer with a tool call is translated whole', async t => {
  const args = JSON.stringify({ path: 'a.js' });
  const { status, json } = await codexNonStream(t, [
    { type: 'response.created', response: { id: 'resp_ok' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: args },
    { type: 'response.completed', response: { id: 'resp_ok', usage: { input_tokens: 3, output_tokens: 4 } } },
  ]);
  assert.equal(status, 200);
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(json.choices[0].message.tool_calls.map(c => [c.id, c.function.name, JSON.parse(c.function.arguments)]), [['call_1', 'read', { path: 'a.js' }]]);
});

test('codex non-stream: response.incomplete reports finish_reason length', async t => {
  const { status, json } = await codexNonStream(t, [
    { type: 'response.created', response: { id: 'resp_i' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
    { type: 'response.incomplete', response: { id: 'resp_i', incomplete_details: { reason: 'max_output_tokens' } } },
  ]);
  assert.equal(status, 200);
  assert.equal(json.choices[0].message.content, 'partial');
  assert.equal(json.choices[0].finish_reason, 'length');
});

test('codexResponseFailure classifies and ignores non-SSE bodies', async () => {
  const { codexResponseFailure } = await import('../src/provider-translator.js');
  assert.equal(codexResponseFailure('{"id":"x"}'), null);
  assert.equal(codexResponseFailure(codexSse([{ type: 'response.completed', response: {} }])), null);
  assert.equal(codexResponseFailure(codexSse([{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } }])).status, 429);
});
