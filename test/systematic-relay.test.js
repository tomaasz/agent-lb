import test from 'node:test';
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

async function setup(t) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(req.headers); res.end('{}'); });
  upstream.on('upgrade', (req, socket) => {
    seen.push(req.headers);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const up = await serve(t, upstream);
  const proxy = { apiKey: 'relay-master', trustLoopback: false, clientKeys: [{ name: 'worker', key: 'relay-worker', allowCredentialRelay: true }] };
  const base = await serve(t, createProxyServer(new AccountManager([]), { upstream: up, proxy, autoHealthCheck: { enabled: false } }));
  const login = await fetch(base + '/api/auth/login', { method: 'POST', body: JSON.stringify({ key: proxy.apiKey }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await login.text();
  return { base, seen, cookie };
}

function upgrade(base, headers) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.end(`GET /v1/session_ingress/ws/fixture HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extra}\r\n`);
    });
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(response));
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('upgrade timed out')); });
  });
}

test('HTTP account-bound relays remove proxy sessions and proxy bearer keys, preserve upstream identity', async t => {
  const { base, seen, cookie } = await setup(t);
  for (const path of ['/v1/code/fixture', '/api/oauth/files/fixture']) {
    for (const bearer of ['relay-master', 'relay-worker', 'upstream-user-token']) {
      const res = await fetch(base + path, { headers: { 'x-api-key': 'relay-master', authorization: `Bearer ${bearer}`, cookie: `upstream_sid=own; ${cookie}; other=kept` } });
      assert.equal(res.status, 200); await res.text();
      const received = seen.at(-1);
      assert.equal(received.cookie, 'upstream_sid=own; other=kept');
      assert.equal(received.authorization, bearer === 'upstream-user-token' ? `Bearer ${bearer}` : undefined);
      assert.equal(received['x-api-key'], undefined);
    }
    const res = await fetch(base + path, { headers: { cookie } });
    assert.equal(res.status, 200); await res.text();
    assert.equal(seen.at(-1).cookie, undefined);
  }
});

test('WebSocket relays remove proxy sessions and proxy bearer keys, preserve upstream identity', async t => {
  const { base, seen, cookie } = await setup(t);
  for (const bearer of ['relay-master', 'relay-worker', 'upstream-user-token']) {
    const response = await upgrade(base, { 'x-api-key': 'relay-master', authorization: `Bearer ${bearer}`, cookie: `${cookie}; upstream_sid=own` });
    assert.match(response, /^HTTP\/1\.1 403/);
    const received = seen.at(-1);
    assert.equal(received.cookie, 'upstream_sid=own');
    assert.equal(received.authorization, bearer === 'upstream-user-token' ? `Bearer ${bearer}` : undefined);
    assert.equal(received['x-api-key'], undefined);
  }
});
