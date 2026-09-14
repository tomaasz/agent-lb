import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/server.js';
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
      // Wait, prober line 158 checks !account.lastError || account.lastError.reason !== 'identity-verification'
      assert.equal(am.unavailableReason(acc), 'identity-verification');
    } finally {
      server.close();
      mockUpstream.close();
    }
  });
});

