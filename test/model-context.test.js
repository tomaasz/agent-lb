import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { modelFamily, weeklyBucketForModel } from '../src/model.js';
import {
  createProxyServer,
  DEFAULT_MAX_BODY_BYTES,
  isOAuthIdentityVerificationRequired,
  resolveMaxBodyBytes,
  rewriteRequestBody,
} from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

test('Claude 5 family ids route to their dedicated quota semantics', () => {
  assert.equal(modelFamily('claude-opus-5'), 'opus');
  assert.equal(modelFamily('claude-sonnet-5'), 'sonnet');
  assert.equal(weeklyBucketForModel('claude-opus-5'), 'unified7d');
  assert.equal(weeklyBucketForModel('claude-sonnet-5'), 'unified7dSonnet');
});

test('proxy body cap is a byte safety limit, not a token or max_tokens limit', () => {
  assert.equal(DEFAULT_MAX_BODY_BYTES, 64 * 1024 * 1024);
  assert.equal(resolveMaxBodyBytes({}), DEFAULT_MAX_BODY_BYTES);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: '134217728' } }), 128 * 1024 * 1024);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: 0 } }), Infinity);

  const body = Buffer.from(JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 32768,
    messages: [{ role: 'user', content: 'keep the complete context' }],
  }));
  const rewritten = rewriteRequestBody(body, { type: 'oauth', provider: 'anthropic' }, '/v1/messages', 'application/json');
  assert.deepEqual(JSON.parse(rewritten.toString()), JSON.parse(body.toString()));
});

test('only the explicit Anthropic identity-verification 400 is account-scoped', () => {
  assert.equal(isOAuthIdentityVerificationRequired(Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Identity verification is required to continue.' },
  }))), true);
  assert.equal(isOAuthIdentityVerificationRequired(Buffer.from('Identity verification is required to continue.')), true);
  assert.equal(isOAuthIdentityVerificationRequired(Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Prompt is too long' },
  }))), false);
  assert.equal(isOAuthIdentityVerificationRequired(Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Malformed request' },
    echoed_input: 'Identity verification is required to continue.',
  }))), false);
});

test('identity verification cooldown removes only the affected account from rotation', () => {
  const am = new AccountManager([
    { name: 'verify-me', type: 'oauth', accessToken: 'token-a' },
    { name: 'healthy', type: 'oauth', accessToken: 'token-b' },
  ]);
  am.markIdentityVerificationRequired(0, 300);
  assert.equal(am.unavailableReason(am.accounts[0], 'claude-opus-5'), 'identity-verification');
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'healthy');
  assert.match(am.getStatus().accounts[0].identityVerificationUntil, /^\d{4}-/);

  am.accounts[1].status = 'error';
  assert.equal(am.getActiveAccount(null, 'claude-opus-5'), null, 'exhausted-fleet probes must respect identity cooldown');
});

test('proxy retries compaction on a healthy OAuth account after identity-verification 400', async () => {
  const seen = [];
  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const requestBody = Buffer.concat(chunks).toString('utf8');
      seen.push({ authorization: req.headers.authorization, proxyKey: req.headers['x-api-key'], body: requestBody });
      res.setHeader('content-type', 'application/json');
      if (JSON.parse(requestBody).messages[0].content === 'ordinary invalid request') {
        res.writeHead(400);
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Prompt is too long' },
        }));
        return;
      }
      if (req.headers.authorization === 'Bearer oauth-needs-verification') {
        res.writeHead(400);
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Identity verification is required to continue.' },
        }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        id: 'msg_compacted',
        type: 'message',
        content: [{ type: 'text', text: 'compacted' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      }));
    });
  });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;

  const am = new AccountManager([
    { name: 'verify-me', type: 'oauth', accessToken: 'oauth-needs-verification', upstream: upstreamUrl, priority: 0 },
    { name: 'healthy', type: 'oauth', accessToken: 'oauth-healthy', upstream: upstreamUrl, priority: 1 },
  ]);
  const proxyServer = createProxyServer(am, {
    upstream: upstreamUrl,
    proxy: { apiKey: 'proxy-client-key', trustLoopback: false, trustTailnet: false },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));

  try {
    const requestBody = JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 32768,
      messages: [{ role: 'user', content: 'compact the complete conversation' }],
    });
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'proxy-client-key',
        'x-claude-code-session-id': 'compaction-test',
      },
      body: requestBody,
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'msg_compacted');
    assert.deepEqual(seen.map(entry => entry.authorization), [
      'Bearer oauth-needs-verification',
      'Bearer oauth-healthy',
    ]);
    assert.deepEqual(seen.map(entry => entry.proxyKey), [undefined, undefined], 'proxy client key must not reach Anthropic');
    assert.deepEqual(seen.map(entry => JSON.parse(entry.body)), [JSON.parse(requestBody), JSON.parse(requestBody)]);
    assert.equal(am.unavailableReason(am.accounts[0], 'claude-opus-5'), 'identity-verification');

    const ordinaryError = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Prompt is too long' },
    });
    const ordinaryResponse = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-client-key' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'ordinary invalid request' }] }),
    });
    assert.equal(ordinaryResponse.status, 400);
    assert.equal(await ordinaryResponse.text(), ordinaryError);
    assert.equal(seen.length, 3, 'ordinary 400 must not rotate accounts');
    assert.equal(seen[2].authorization, 'Bearer oauth-healthy');
  } finally {
    await Promise.all([
      new Promise(resolve => proxyServer.close(resolve)),
      new Promise(resolve => upstreamServer.close(resolve)),
    ]);
  }
});

test('all-identity response ignores unrelated Codex accounts and reports a clear 502', async () => {
  const seen = [];
  const upstreamServer = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Identity verification is required to continue.' },
    }));
  });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  const am = new AccountManager([
    { name: 'claude-a', provider: 'anthropic', type: 'oauth', accessToken: 'claude-a', upstream: upstreamUrl },
    { name: 'claude-b', provider: 'anthropic', type: 'oauth', accessToken: 'claude-b', upstream: upstreamUrl },
    { name: 'codex-unrelated', provider: 'codex', type: 'oauth', accessToken: 'codex-token', upstream: upstreamUrl },
  ]);
  const proxyServer = createProxyServer(am, {
    upstream: upstreamUrl,
    proxy: { apiKey: 'proxy-client-key', trustLoopback: false, trustTailnet: false },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-client-key' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'compact' }] }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(payload.error.message, /claude-a/);
    assert.match(payload.error.message, /claude-b/);
    assert.doesNotMatch(payload.error.message, /codex-unrelated/);
    assert.deepEqual(new Set(seen), new Set(['Bearer claude-a', 'Bearer claude-b']));
  } finally {
    await Promise.all([
      new Promise(resolve => proxyServer.close(resolve)),
      new Promise(resolve => upstreamServer.close(resolve)),
    ]);
  }
});

test('all-identity response ignores disabled accounts and reports 502', async () => {
  const upstreamServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Identity verification is required to continue.' },
    }));
  });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  const am = new AccountManager([
    { name: 'claude-active', provider: 'anthropic', type: 'oauth', accessToken: 'token-active', upstream: upstreamUrl },
    { name: 'claude-disabled', provider: 'anthropic', type: 'oauth', accessToken: 'token-disabled', upstream: upstreamUrl, disabled: true },
  ]);
  const proxyServer = createProxyServer(am, {
    upstream: upstreamUrl,
    proxy: { apiKey: 'proxy-client-key', trustLoopback: false, trustTailnet: false },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-client-key' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'test' }] }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(payload.error.message, /claude-active/);
    assert.doesNotMatch(payload.error.message, /claude-disabled/);
  } finally {
    await Promise.all([
      new Promise(resolve => proxyServer.close(resolve)),
      new Promise(resolve => upstreamServer.close(resolve)),
    ]);
  }
});

test('successful response clears identityVerification cooldown', async () => {
  let requestNum = 0;
  const upstreamServer = http.createServer((req, res) => {
    req.resume();
    requestNum++;
    if (requestNum === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Identity verification is required to continue.' },
      }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_ok', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
  });
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  const am = new AccountManager([
    { name: 'claude-test', provider: 'anthropic', type: 'oauth', accessToken: 'token-test', upstream: upstreamUrl },
  ]);
  const proxyServer = createProxyServer(am, {
    upstream: upstreamUrl,
    proxy: { apiKey: 'proxy-client-key', trustLoopback: false, trustTailnet: false },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));

  try {
    // 1st request fails with identity verification -> sets cooldown
    const r1 = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-client-key' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'req1' }] }),
    });
    assert.equal(r1.status, 502);
    assert.equal(am.unavailableReason(am.accounts[0]), 'identity-verification');

    // 2nd request pinned to the account succeeds (e.g. user verified) -> clears cooldown
    const r2 = await fetch(`http://127.0.0.1:${proxyServer.address().port}/tc-acct/claude-test/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-client-key' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'req2' }] }),
    });
    assert.equal(r2.status, 200);
    assert.equal(am.accounts[0].identityVerificationUntil, null);
    assert.equal(am.unavailableReason(am.accounts[0]), null);
  } finally {
    await Promise.all([
      new Promise(resolve => proxyServer.close(resolve)),
      new Promise(resolve => upstreamServer.close(resolve)),
    ]);
  }
});
