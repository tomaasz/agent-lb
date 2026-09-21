// A non-streaming request only gets its response headers once the whole answer
// is generated, so the short time-to-first-byte guard meant for streams must
// not cut it off. Streams keep the short guard.
//
// Runs in its own process (node --test isolates files), so the env overrides
// below do not leak into other suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

process.env.AGENT_LB_UPSTREAM_HEADERS_TIMEOUT_MS = '300';
process.env.AGENT_LB_UPSTREAM_NONSTREAM_HEADERS_TIMEOUT_MS = '5000';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

const MESSAGE = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'long answer' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } });

async function slowProxy(t, delayMs) {
  const up = await serve(t, http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      const streaming = req.headers.accept?.includes('text/event-stream');
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(MESSAGE);
      }
    }, delayMs);
  }));
  const am = new AccountManager([{ name: 'A', type: 'api-key', apiKey: 'k' }]);
  return serve(t, createProxyServer(am, { upstream: up, proxy: {}, autoHealthCheck: { enabled: false } }));
}

const send = (base, stream) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64000, stream, messages: [{ role: 'user', content: 'write a lot' }] }),
});

test('a non-streaming request outlives the stream time-to-first-byte guard', async t => {
  const base = await slowProxy(t, 1200);
  const res = await send(base, false);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, 'long answer');
});

test('a streaming request keeps the short headers guard', async t => {
  const base = await slowProxy(t, 1200);
  await assert.rejects(async () => { const res = await send(base, true); await res.text(); });
});
