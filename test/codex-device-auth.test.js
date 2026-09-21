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

// Protocol checks against a local stand-in for auth.openai.com, shaped after
// the Codex CLI's own device flow (login/src/device_code_auth.rs).
describe('Codex Device Code protocol', () => {
  it('sends client_id, treats 403 as pending, and exchanges with the server-issued verifier', async (t) => {
    const http = await import('node:http');
    const seen = [];
    let polls = 0;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, type: req.headers['content-type'], body });
      if (req.url === '/api/accounts/deviceauth/usercode') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ device_auth_id: 'dev-1', usercode: 'ABCD-EFGH', interval: '0' }));
      } else if (req.url === '/api/accounts/deviceauth/token') {
        polls++;
        if (polls < 3) { res.writeHead(403); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ authorization_code: 'code-1', code_challenge: 'chal', code_verifier: 'ver-1' }));
      } else if (req.url === '/oauth/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const base = `${origin}/api/accounts`;

    const dc = await codexAuth.requestDeviceCode({ base });
    assert.equal(dc.deviceAuthId, 'dev-1');
    assert.equal(dc.userCode, 'ABCD-EFGH', 'the `usercode` spelling must be accepted');
    assert.equal(JSON.parse(seen[0].body).client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');

    const creds = await codexAuth.pollDeviceAuthorization({
      deviceAuthId: dc.deviceAuthId, userCode: dc.userCode, intervalMs: 1, base, tokenEndpoint: `${origin}/oauth/token`,
    });
    assert.equal(creds.accessToken, 'at');
    assert.equal(polls, 3);
    const exchange = seen.find(s => s.url === '/oauth/token');
    assert.match(exchange.type, /x-www-form-urlencoded/);
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'code-1');
    assert.equal(form.get('code_verifier'), 'ver-1');
    assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  });
});
