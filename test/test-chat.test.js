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
});

