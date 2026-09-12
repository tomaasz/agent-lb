import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerForPath,
  providerForHost,
  upstreamFor,
  applyAuthHeaders,
} from '../src/provider.js';

describe('Codex Provider Support', () => {
  it('correctly maps Codex and OpenAI paths to codex provider', () => {
    assert.equal(providerForPath('/backend-api/codex/responses'), 'codex');
    assert.equal(providerForPath('/backend-api/wham/usage'), 'codex');
    assert.equal(providerForPath('/v1/responses'), 'codex');
    assert.equal(providerForPath('/v1/chat/completions'), 'codex');
    assert.equal(providerForPath('/v1/messages'), 'anthropic');
  });

  it('maps provider hosts correctly', () => {
    assert.equal(providerForHost('api.anthropic.com'), 'anthropic');
    assert.equal(providerForHost('chatgpt.com'), 'codex');
    assert.equal(providerForHost('api.openai.com'), 'codex');
    assert.equal(providerForHost('ab.chatgpt.com'), null); // never intercept telemetry
  });

  it('resolves correct upstream for Codex OAuth vs API key accounts', () => {
    const oauthAcct = { name: 'codex-oauth', type: 'oauth', provider: 'codex' };
    assert.equal(upstreamFor(oauthAcct), 'https://chatgpt.com');

    const apiKeyAcct = { name: 'codex-api', type: 'api-key', provider: 'codex' };
    assert.equal(upstreamFor(apiKeyAcct), 'https://api.openai.com');

    const overrideAcct = { name: 'custom', upstream: 'http://my-proxy:8080' };
    assert.equal(upstreamFor(overrideAcct), 'http://my-proxy:8080');
  });

  it('applies ChatGPT-Account-Id and Bearer header for Codex accounts', () => {
    const headers = {};
    const acct = {
      provider: 'codex',
      credential: 'test-token',
      accountId: 'chatgpt-acc-123',
    };
    applyAuthHeaders(headers, acct);
    assert.equal(headers.authorization, 'Bearer test-token');
    assert.equal(headers['chatgpt-account-id'], 'chatgpt-acc-123');
  });
});

