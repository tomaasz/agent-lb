import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer, normalizeCodexModelForOAuth, rewriteRequestBody } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { renderDashboardHtml } from '../src/dashboard.js';

describe('Test Chat & Playground Support', () => {
  it('renders test chat button and modal in dashboard HTML', () => {
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="btnOpenTestChat"'), 'contains test chat button in header');
    assert.ok(html.includes('id="modalTestChat"'), 'contains modalTestChat modal container');
    assert.ok(html.includes('id="selTestProvider"'), 'contains provider selector');
    assert.ok(html.includes('id="selTestModel"'), 'contains model selector');
    assert.ok(html.includes('id="selTestAccount"'), 'contains account selector');
    assert.ok(html.includes('id="testChatHistory"'), 'contains chat history box');
    assert.ok(html.includes('id="testChatMessage"'), 'contains message textarea');
    assert.ok(html.includes('id="btnTestChatSend"'), 'contains send button');
    assert.ok(html.includes('id="btnTestChatCopy"'), 'contains copy chat button in footer');
    assert.ok(html.includes('id="btnTestChatHeaderCopy"'), 'contains copy chat button in header');
  });

  it('handles POST /api/test/chat for Anthropic and Codex accounts', async () => {
    let mockAnthropicHit = false;
    let mockCodexHit = false;

    // Upstream mock server
    const mockUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('/v1/messages')) {
        mockAnthropicHit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'Cześć! Jestem Claude Sonnet 5 i połączenie działa prawidłowo.' }],
          usage: { input_tokens: 15, output_tokens: 28 }
        }));
        return;
      }
      if (req.url.endsWith('/backend-api/codex/responses')) {
        mockCodexHit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'gpt-5.6-sol',
          output: [{ content: [{ type: 'text', text: 'Hello from Codex (GPT 5.6 Sol)!' }] }],
          usage: { prompt_tokens: 12, completion_tokens: 18 }
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'claude-mock', provider: 'anthropic', type: 'oauth', accessToken: 'token-c', upstream: upstreamUrl },
      { name: 'codex-mock', provider: 'codex', type: 'oauth', accessToken: 'token-x', upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      // 1. Test Anthropic chat
      const resClaude = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: {
          'x-api-key': 'tc-test-admin',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          message: 'Cześć Claude!'
        })
      });

      assert.equal(resClaude.status, 200);
      const jsonClaude = await resClaude.json();
      assert.equal(jsonClaude.ok, true);
      assert.equal(jsonClaude.account, 'claude-mock');
      assert.equal(jsonClaude.model, 'claude-sonnet-5');
      assert.match(jsonClaude.reply, /Claude Sonnet 5/);
      assert.ok(mockAnthropicHit, 'Anthropic upstream endpoint was called');

      // 2. Test Codex chat
      const resCodex = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: {
          'x-api-key': 'tc-test-admin',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'codex',
          model: 'gpt-5.6-sol',
          message: 'Hello Codex!'
        })
      });

      assert.equal(resCodex.status, 200);
      const jsonCodex = await resCodex.json();
      assert.equal(jsonCodex.ok, true);
      assert.equal(jsonCodex.account, 'codex-mock');
      assert.equal(jsonCodex.model, 'gpt-5.6-sol');
      assert.match(jsonCodex.reply, /GPT 5\.6 Sol/);
      assert.ok(mockCodexHit, 'Codex upstream endpoint was called');

      // 3. Test non-existent account pinning
      const resNonExistent = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          account: 'ghost-account',
          message: 'ping'
        })
      });
      assert.equal(resNonExistent.status, 404);
      const jsonNonExistent = await resNonExistent.json();
      assert.equal(jsonNonExistent.ok, false);
      assert.match(jsonNonExistent.error, /ghost-account/);

    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('automatically falls over to healthy account when first candidate fails', async () => {
    // Upstream mock server
    const mockUpstream = http.createServer((req, res) => {
      const authHeader = req.headers.authorization || '';
      if (authHeader.includes('token-failing')) {
        // Failing account returns 403 Org Block
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'OAuth authentication is currently not allowed for this organization' } }));
        return;
      }
      if (authHeader.includes('token-healthy')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'Success from healthy account!' }]
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'acc-broken', provider: 'anthropic', type: 'oauth', accessToken: 'token-failing', priority: 0, upstream: upstreamUrl },
      { name: 'acc-healthy', provider: 'anthropic', type: 'oauth', accessToken: 'token-healthy', priority: 1, upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      // Send test chat without specifying account (Auto mode)
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: {
          'x-api-key': 'tc-test-admin',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          message: 'Hello Auto'
        })
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true, 'Auto mode succeeded despite first account 403');
      assert.equal(json.account, 'acc-healthy', 'Failed over to healthy account');
      assert.match(json.reply, /Success from healthy account!/);
      assert.ok(json.triedAccounts?.includes('acc-broken'), 'Recorded acc-broken as tried');

      const accBroken = am.accounts.find(a => a.name === 'acc-broken');
      assert.equal(accBroken.lastError?.reason, 'entitlement', 'Recorded lastError reason as entitlement');
      assert.equal(accBroken.lastError?.status, 403, 'Recorded lastError status 403');
      assert.equal(accBroken.lastTest?.ok, false, 'Recorded lastTest as failed');
      assert.equal(am.unavailableReason(accBroken), 'entitlement', 'Account is marked unavailable due to entitlement');

      const accHealthy = am.accounts.find(a => a.name === 'acc-healthy');
      assert.equal(accHealthy.lastTest?.ok, true, 'Healthy account recorded lastTest as ok');
      assert.equal(am.unavailableReason(accHealthy), null, 'Healthy account is available');
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('maintains identity-verification error state without prober clearing it', async () => {
    const mockUpstream = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Identity verification required before proceeding' } }));
    });
    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'acc-sms', provider: 'anthropic', type: 'oauth', accessToken: 'token-sms', upstream: upstreamUrl }
    ];
    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          account: 'acc-sms',
          model: 'claude-sonnet-5',
          message: 'ping'
        })
      });

      const json = await res.json();
      assert.equal(json.ok, false);
      const acc = am.accounts[0];
      assert.equal(acc.lastError?.reason, 'identity-verification');
      assert.equal(am.unavailableReason(acc), 'identity-verification');

      // Prober should NOT clear identity verification while lastError is identity-verification
      am.clearIdentityVerification?.(0);
      assert.equal(am.unavailableReason(acc), 'identity-verification');
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('marks account throttled and records lastError when upstream returns 429 Rate Limit', async () => {
    let return429 = true;
    const mockUpstream = http.createServer((req, res) => {
      if (return429) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after': '45',
          'anthropic-ratelimit-unified-5h-utilization': '0.15',
          'anthropic-ratelimit-unified-5h-status': 'allowed'
        });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limit exceeded' }
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'OK' }]
        }));
      }
    });
    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'nathan-petit', provider: 'anthropic', type: 'oauth', accessToken: 'token-np', upstream: upstreamUrl }
    ];
    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      // 1. Send test chat that returns 429
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          account: 'nathan-petit',
          model: 'claude-sonnet-5',
          message: 'ping'
        })
      });

      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.status, 429);
      assert.match(json.error, /429 Rate Limit/);

      const acc = am.accounts[0];
      assert.equal(acc.status, 'throttled');
      assert.equal(acc.lastError?.reason, 'rate-limit');
      assert.equal(acc.lastError?.status, 429);
      assert.equal(acc.lastTest?.ok, false);
      assert.equal(acc.lastTest?.reason, 'rate-limit');
      assert.ok(acc.rateLimitedUntil > Date.now(), 'rateLimitedUntil should be in the future');
      assert.equal(am.unavailableReason(acc), 'throttled', 'unavailableReason returns throttled');

      // 2. Recovery on subsequent successful request
      return429 = false;
      const res2 = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          account: 'nathan-petit',
          model: 'claude-sonnet-5',
          message: 'ping'
        })
      });

      const json2 = await res2.json();
      assert.equal(json2.ok, true);
      assert.equal(acc.status, 'active');
      assert.equal(acc.lastError, null);
      assert.equal(acc.lastTest?.ok, true);
      assert.equal(acc.rateLimitedUntil, null);
      assert.equal(am.unavailableReason(acc), null, 'unavailableReason is null once recovered');
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('correctly parses Codex SSE responses even when Content-Type is text/plain or not event-stream', async () => {
    const mockUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('/backend-api/codex/responses')) {
        // Return SSE formatted text with non-event-stream Content-Type (e.g. text/plain or application/json)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123"}}\n\nevent: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"content":[{"type":"text","text":"Odpowiedź z Codex SSE!"}]}}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'codex-sse-test', provider: 'codex', type: 'oauth', accessToken: 'token-codex-sse', upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'codex',
          account: 'codex-sse-test',
          model: 'gpt-5.6-sol',
          message: 'Test Codex SSE parsing'
        })
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.account, 'codex-sse-test');
      assert.match(json.reply, /Odpowiedź z Codex SSE!/);
      assert.equal(am.accounts[0].status, 'active');
      assert.equal(am.accounts[0].lastError, null);
      assert.equal(am.accounts[0].lastTest?.ok, true);
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('correctly parses Codex response.output_text.delta streaming events', async () => {
    const mockUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('/backend-api/codex/responses')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Cześć! "}\n\n');
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"W czym mogę pomóc?"}\n\n');
        res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"prompt_tokens":8,"completion_tokens":15}}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'codex-delta-test', provider: 'codex', type: 'oauth', accessToken: 'token-codex-delta', upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'codex',
          account: 'codex-delta-test',
          model: 'gpt-5.6-sol',
          message: 'cześć'
        })
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.reply, 'Cześć! W czym mogę pomóc?');
      assert.notEqual(json.reply, '(Odpowiedź strumieniowa zakończona pomyślnie)');
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('sends Claude Code billing header, modern headers, and filters thinking blocks in Anthropic test chat', async () => {
    let capturedHeaders = null;
    let capturedBody = null;

    const mockUpstream = http.createServer(async (req, res) => {
      capturedHeaders = req.headers;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'claude-sonnet-5',
        content: [
          { type: 'thinking', thinking: 'Hmm, let me think about this response...' },
          { type: 'text', text: 'To jest właściwa odpowiedź tekstowa.' }
        ],
        usage: { input_tokens: 25, output_tokens: 40 }
      }));
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'claude-sonnet-user', provider: 'anthropic', type: 'oauth', accessToken: 'token-sonnet', upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          account: 'claude-sonnet-user',
          model: 'claude-sonnet-5',
          message: 'Cześć'
        })
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.reply, 'To jest właściwa odpowiedź tekstowa.');
      assert.ok(!json.reply.includes('thinking'), 'Thinking block was not leaked into reply');

      // Verify billing header in body
      assert.ok(Array.isArray(capturedBody.system), 'body.system is an array');
      assert.ok(capturedBody.system.some(s => s.text?.includes('x-anthropic-billing-header')), 'system contains billing header');

      // Verify modern headers
      assert.match(capturedHeaders['user-agent'], /^claude-cli\//, 'user-agent starts with claude-cli/');
      assert.equal(capturedHeaders['x-app'], 'cli');
      assert.ok(capturedHeaders['anthropic-beta'].includes('claude-code-20250219'));
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('does not mark account throttled when receiving a request-scoped 429 without rate limit headers', async () => {
    const mockUpstream = http.createServer((req, res) => {
      // 429 without retry-after or anthropic-ratelimit-* headers (upstream request refusal)
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Error' }
      }));
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'acc-unthrottled', provider: 'anthropic', type: 'oauth', accessToken: 'token-un', upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          account: 'acc-unthrottled',
          model: 'claude-sonnet-5',
          message: 'ping'
        })
      });

      const json = await res.json();
      assert.equal(json.ok, false);
      assert.match(json.error, /429 Request Refusal/);

      const acc = am.accounts[0];
      // Account should NOT be marked throttled or given rateLimitedUntil
      assert.notEqual(acc.status, 'throttled', 'Account status should not be throttled');
      assert.equal(acc.rateLimitedUntil, null, 'rateLimitedUntil should remain null');
      assert.equal(am.unavailableReason(acc), null, 'unavailableReason should be null');
      assert.equal(acc.lastError?.reason, 'upstream-refusal');
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('normalizes gpt-5.6 and gpt-5 model aliases to gpt-5.6-sol for Codex OAuth accounts', () => {
    // 1. normalizeCodexModelForOAuth directly
    const body1 = Buffer.from(JSON.stringify({ model: 'gpt-5.6', messages: [] }));
    const norm1 = normalizeCodexModelForOAuth(body1);
    assert.equal(JSON.parse(norm1.toString()).model, 'gpt-5.6-sol');

    const bodyGpt6 = Buffer.from(JSON.stringify({ model: 'gpt-6', messages: [] }));
    const normGpt6 = normalizeCodexModelForOAuth(bodyGpt6);
    assert.equal(JSON.parse(normGpt6.toString()).model, 'gpt-6-astra');

    const body2 = Buffer.from(JSON.stringify({ model: 'gpt-5', messages: [] }));
    const norm2 = normalizeCodexModelForOAuth(body2);
    assert.equal(JSON.parse(norm2.toString()).model, 'gpt-5.6-sol');

    const body3 = Buffer.from(JSON.stringify({ model: 'codex', messages: [] }));
    const norm3 = normalizeCodexModelForOAuth(body3);
    assert.equal(JSON.parse(norm3.toString()).model, 'gpt-5.6-sol');

    const body4 = Buffer.from(JSON.stringify({ model: 'o3-mini', messages: [] }));
    const norm4 = normalizeCodexModelForOAuth(body4);
    assert.equal(JSON.parse(norm4.toString()).model, 'o3-mini');

    // 2. rewriteRequestBody integration
    const codexOAuthAcct = { name: 'codex-sub', provider: 'codex', type: 'oauth' };
    const rewritten = rewriteRequestBody(body1, codexOAuthAcct, '/backend-api/codex/responses', 'application/json');
    assert.equal(JSON.parse(rewritten.toString()).model, 'gpt-5.6-sol');

    // Non-oauth codex account (e.g. apikey) should not be rewritten
    const codexApiKeyAcct = { name: 'codex-key', provider: 'codex', type: 'apikey' };
    const untouched = rewriteRequestBody(body1, codexApiKeyAcct, '/v1/chat/completions', 'application/json');
    assert.equal(JSON.parse(untouched.toString()).model, 'gpt-5.6');
  });

  it('maps gpt-5.6 to gpt-5.6-sol in test-chat for Codex OAuth accounts', async () => {
    let capturedPayload = null;

    const mockUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('/backend-api/codex/responses')) {
        let buf = '';
        req.on('data', c => { buf += c; });
        req.on('end', () => {
          capturedPayload = JSON.parse(buf);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: capturedPayload.model,
            output: [{ content: [{ type: 'text', text: `Codex responded with model ${capturedPayload.model}` }] }],
            usage: { prompt_tokens: 10, completion_tokens: 12 }
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'codex-chatgpt', provider: 'codex', type: 'oauth', accessToken: 'token-chatgpt', upstream: upstreamUrl }
    ];

    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      // Send request with model: 'gpt-5.6'
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: {
          'x-api-key': 'tc-test-admin',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'codex',
          model: 'gpt-5.6',
          message: 'Hello'
        })
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.model, 'gpt-5.6-sol');
      assert.ok(capturedPayload, 'upstream received payload');
      // Crucial: upstream ChatGPT Codex backend MUST receive gpt-5.6-sol
      assert.equal(capturedPayload.model, 'gpt-5.6-sol');

      // Also test /backend-api/codex/models with query params (client_version)
      const resModels = await fetch(`http://127.0.0.1:${proxyPort}/backend-api/codex/models?client_version=0.1.0`, { headers: { 'x-api-key': 'tc-test-admin' } });
      assert.equal(resModels.status, 200);
      const modelsJson = await resModels.json();
      assert.ok(Array.isArray(modelsJson.data));
      assert.ok(modelsJson.data.some(m => m.id === 'gpt-5.6-sol'));
      assert.ok(modelsJson.data.some(m => m.id === 'gpt-6-astra'));
      assert.ok(modelsJson.data.some(m => m.id === 'gpt-5.6-terra'));
      assert.ok(modelsJson.data.some(m => m.id === 'gpt-5.6-luna'));
      assert.ok(modelsJson.data.some(m => m.id === 'gpt-5.5'));
      assert.ok(!modelsJson.data.some(m => m.id === 'gpt-6'), 'gpt-6 alias omitted from models list');
      assert.ok(!modelsJson.data.some(m => m.id === 'gpt-5.6'), 'gpt-5.6 alias omitted from models list');

      // Test gpt-6 alias and reasoning effort forwarding
      const resGpt6 = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: {
          'x-api-key': 'tc-test-admin',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'codex',
          model: 'gpt-6',
          effort: 'medium',
          message: 'Hello GPT-6'
        })
      });

      assert.equal(resGpt6.status, 200);
      const jsonGpt6 = await resGpt6.json();
      assert.equal(jsonGpt6.ok, true);
      assert.equal(jsonGpt6.model, 'gpt-6-astra');
      assert.equal(jsonGpt6.effort, 'medium');
      assert.equal(capturedPayload.model, 'gpt-6-astra');
      assert.deepEqual(capturedPayload.reasoning, { effort: 'medium' });
    } finally {
      server.close();
      mockUpstream.close();
    }
  });

  it('correctly handles Codex 429 quota exhaustion and recovers on subsequent success, probe headroom, and hold expiry', async () => {
    let return429Quota = true;

    const mockUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('/backend-api/codex/responses')) {
        if (return429Quota) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'x-codex-primary-used-percent': '100',
            'x-codex-primary-reset-after-seconds': '60'
          });
          res.end(JSON.stringify({
            error: { type: 'usage_limit_reached', resets_in_seconds: 60 }
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'gpt-5.6-sol',
          output: [{ content: [{ type: 'text', text: 'OK' }] }],
          usage: { prompt_tokens: 5, completion_tokens: 5 }
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'codex-exhaust-test', provider: 'codex', type: 'oauth', accessToken: 'token-cx', upstream: upstreamUrl }
    ];
    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxyPort = server.address().port;

    try {
      // 1. Send test chat that returns 429 quota exhaustion
      const res = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'codex',
          account: 'codex-exhaust-test',
          model: 'gpt-5.6',
          message: 'ping'
        })
      });

      const json = await res.json();
      assert.equal(json.ok, false);
      assert.equal(json.status, 429);
      assert.match(json.error, /Limit zapytań ChatGPT Plus wyczerpany/);

      const acc = am.accounts[0];
      assert.equal(acc.status, 'exhausted');
      assert.equal(acc.lastError?.reason, 'quota');
      assert.equal(acc.lastError?.status, 429);
      assert.equal(acc.lastTest?.ok, false);
      assert.equal(acc.lastTest?.reason, 'quota');
      assert.ok(acc.exhaustedUntil > Date.now(), 'exhaustedUntil should be set');
      assert.equal(am.unavailableReason(acc), 'exhausted');

      // 2. Recovery on subsequent successful request
      return429Quota = false;
      const res2 = await fetch(`http://127.0.0.1:${proxyPort}/api/test/chat`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'codex',
          account: 'codex-exhaust-test',
          model: 'gpt-5.6',
          message: 'ping'
        })
      });

      const json2 = await res2.json();
      assert.equal(json2.ok, true);
      assert.equal(acc.status, 'active');
      assert.equal(acc.lastError, null);
      assert.equal(acc.lastTest?.ok, true);
      assert.equal(acc.exhaustedUntil, null);
      assert.equal(am.unavailableReason(acc), null, 'unavailableReason is null after successful request');

      // 3. Re-exhaust and test probe headroom recovery
      acc.status = 'exhausted';
      acc.lastError = { reason: 'quota', status: 429, error: 'exhausted' };
      acc.exhaustedUntil = Date.now() + 3600_000;
      assert.equal(am.unavailableReason(acc), 'exhausted');

      am.applyCodexUsageData(0, {
        fiveHour: { utilization: 0, resetAt: Date.now() + 18000_000 },
        sevenDay: { utilization: 0.16, resetAt: Date.now() + 600000_000 }
      });
      assert.equal(acc.status, 'active', 'applyCodexUsageData resets exhausted status when headroom is available');
      assert.equal(acc.lastError, null);
      assert.equal(acc.exhaustedUntil, null);
      assert.equal(am.unavailableReason(acc), null);

      // 4. Re-exhaust and test hold expiry recovery
      acc.status = 'exhausted';
      acc.exhaustedUntil = Date.now() - 1000; // already expired
      assert.equal(am.unavailableReason(acc), null, 'unavailableReason automatically recovers when exhaustedUntil has passed');
      assert.equal(acc.status, 'active');
      assert.equal(acc.exhaustedUntil, null);
    } finally {
      server.close();
      mockUpstream.close();
    }
  });
});
