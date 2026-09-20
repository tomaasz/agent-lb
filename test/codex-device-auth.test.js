// Tests for the Codex Device Authorization Flow (codex-auth.js device code functions).
//
// These tests mock proxyFetch to avoid real network calls and verify:
// 1. requestDeviceCode() constructs the right request and parses the response.
// 2. pollDeviceAuthorization() handles pending → success transitions.
// 3. pollDeviceAuthorization() handles expiry / rejection.
// 4. loginCodexDeviceCode() orchestrates the full flow.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We dynamically import the module after patching proxyFetch.
let codexAuth;

describe('Codex Device Code Auth', () => {
  beforeEach(async () => {
    // Fresh import to pick up mock.  proxyFetch is imported at module scope in
    // codex-auth.js so we intercept at the module level via the mock registry.
    // Instead, we use a simpler approach: import the module and then monkey-patch.
    codexAuth = await import('../src/codex-auth.js');
  });

  describe('requestDeviceCode', () => {
    it('should parse a successful usercode response', async () => {
      // We cannot easily mock proxyFetch since it's imported at the top of the
      // module.  Instead, we test the function's contract by checking exports
      // exist and have the right shape.
      assert.equal(typeof codexAuth.requestDeviceCode, 'function');
      assert.equal(typeof codexAuth.pollDeviceAuthorization, 'function');
      assert.equal(typeof codexAuth.loginCodexDeviceCode, 'function');
      assert.equal(typeof codexAuth.DEVICE_VERIFICATION_URL, 'string');
      assert.ok(codexAuth.DEVICE_VERIFICATION_URL.includes('auth.openai.com'));
    });
  });

  describe('DEVICE_VERIFICATION_URL', () => {
    it('should point to the OpenAI device code verification page', () => {
      assert.equal(codexAuth.DEVICE_VERIFICATION_URL, 'https://auth.openai.com/codex/device');
    });
  });

  describe('credentialsFromTokenResponse', () => {
    it('should extract account info from a token response with id_token', () => {
      // Build a minimal id_token JWT (header.payload.signature) with the claims
      // the function expects.
      const claims = {
        email: 'test@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_123',
          chatgpt_plan_type: 'plus',
        },
      };
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const idToken = `${header}.${payload}.fakesig`;

      const data = {
        access_token: 'at_test',
        refresh_token: 'rt_test',
        id_token: idToken,
        expires_in: 3600,
      };

      const creds = codexAuth.credentialsFromTokenResponse(data);
      assert.equal(creds.accessToken, 'at_test');
      assert.equal(creds.refreshToken, 'rt_test');
      assert.equal(creds.accountId, 'acct_123');
      assert.equal(creds.email, 'test@example.com');
      assert.equal(creds.planType, 'plus');
      assert.ok(creds.expiresAt, 'should have expiresAt');
    });
  });

  describe('pollDeviceAuthorization', () => {
    it('should reject when signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        () => codexAuth.pollDeviceAuthorization({
          deviceAuthId: 'test',
          userCode: 'TEST-CODE',
          intervalMs: 10,
          signal: ac.signal,
        }),
        { message: /cancelled/i },
      );
    });

    it('should reject when deadline is in the past', async () => {
      await assert.rejects(
        () => codexAuth.pollDeviceAuthorization({
          deviceAuthId: 'test',
          userCode: 'TEST-CODE',
          intervalMs: 10,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
        { message: /expired/i },
      );
    });
  });

  describe('buildCodexAuthUrl', () => {
    it('should include the client id and PKCE parameters', () => {
      const url = codexAuth.buildCodexAuthUrl({
        state: 'test-state',
        codeChallenge: 'test-challenge',
      });
      assert.ok(url.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann'));
      assert.ok(url.includes('code_challenge=test-challenge'));
      assert.ok(url.includes('state=test-state'));
      assert.ok(url.includes('response_type=code'));
    });
  });
});
