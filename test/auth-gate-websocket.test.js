// The proxy-key gate's reading of a client's own Bearer, and the refusal of
// Codex WebSocket handshakes (Codex is served over HTTP only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

const OK = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function setup(t, proxy) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null, apiKey: req.headers['x-api-key'] || null, upgrade: req.headers.upgrade || null });
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK);
  });
  const up = await serve(t, upstream);
  const am = new AccountManager([{ name: 'A', type: 'api-key', apiKey: 'pooled-key' }]);
  const base = await serve(t, createProxyServer(am, { upstream: up, proxy, autoHealthCheck: { enabled: false } }));
  return { base, seen };
}

const post = (base, headers) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});

const trusted = () => ({ apiKey: 'master-key', trustLoopback: true, clientKeys: [{ name: 'ws1', key: 'client-key' }] });

test('trusted origin: a foreign Bearer (the client\'s own login) is not a wrong proxy key', async t => {
  const { base, seen } = await setup(t, trusted());
  const res = await post(base, { authorization: 'Bearer sk-ant-oat01-the-users-own-token' });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].apiKey, 'pooled-key');
  assert.equal(seen[0].auth, null, 'the client\'s own token must not travel upstream');
});

test('trusted origin: a wrong explicit x-api-key still fails loudly', async t => {
  const { base, seen } = await setup(t, trusted());
  const res = await post(base, { 'x-api-key': 'rotated-away-key' });
  assert.equal(res.status, 401);
  await res.text();
  assert.equal(seen.length, 0);
});

test('trusted origin: a Bearer that is a client key is still honoured', async t => {
  const { base, seen } = await setup(t, trusted());
  const res = await post(base, { authorization: 'Bearer client-key' });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(seen.length, 1);
});

test('untrusted origin: a foreign Bearer is refused', async t => {
  const { base, seen } = await setup(t, { apiKey: 'master-key', trustLoopback: false });
  const res = await post(base, { authorization: 'Bearer sk-ant-oat01-the-users-own-token' });
  assert.equal(res.status, 401);
  await res.text();
  assert.equal(seen.length, 0);
});

test('trusted origin: a foreign Bearer cannot reach management endpoints', async t => {
  const { base } = await setup(t, trusted());
  const res = await fetch(`${base}/api/keys`, { headers: { authorization: 'Bearer not-a-key' } });
  assert.equal(res.status, 403);
  await res.text();
});

/** Send a raw WebSocket handshake; resolve with the status line. */
function handshake(base, path, headers = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    let data = '';
    sock.on('data', c => { data += c; });
    sock.on('close', () => resolve(data.split('\r\n')[0]));
    sock.on('error', reject);
    sock.setTimeout(3000, () => { sock.destroy(); resolve(data.split('\r\n')[0] || 'timeout'); });
  });
}

test('codex WebSocket handshakes are refused with 426 before the key gate and never relayed', async t => {
  const { base, seen } = await setup(t, { apiKey: 'master-key', trustLoopback: false });
  for (const path of ['/backend-api/codex/responses', '/v1/responses', '/backend-api/codex/../codex/responses']) {
    const status = await handshake(base, path, { authorization: 'Bearer some-codex-key' });
    assert.match(status, /^HTTP\/1\.1 426/, path);
  }
  assert.equal(seen.length, 0, 'nothing may reach the Anthropic upstream');
});

test('non-codex WebSocket handshakes still go through the key gate', async t => {
  const { base } = await setup(t, { apiKey: 'master-key', trustLoopback: false });
  const status = await handshake(base, '/v1/session_ingress/ws/abc');
  assert.match(status, /^HTTP\/1\.1 401/);
});
