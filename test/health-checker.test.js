import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { FleetHealthChecker } from '../src/health-checker.js';
import { createProxyServer } from '../src/server.js';

describe('FleetHealthChecker Intelligent Auto Diagnostics', () => {
  it('correctly evaluates skip rules to preserve tokens', () => {
    const am = new AccountManager([], 0.98);
    const hc = new FleetHealthChecker(am, {
      trafficGracePeriodMs: 15 * 60 * 1000,
      errorBackoffMs: 60 * 60 * 1000,
    });
    const now = 1000000;

    // 1. Disabled account -> skip
    const accDisabled = { name: 'acc1', disabled: true };
    assert.deepEqual(hc.evaluateAccount(accDisabled, now), { shouldProbe: false, reason: 'disabled' });

    // 2. Recent user traffic -> skip (0 tokens)
    const accActive = { name: 'acc2', lastSuccess: now - (5 * 60 * 1000) };
    const evalActive = hc.evaluateAccount(accActive, now);
    assert.equal(evalActive.shouldProbe, false);
    assert.equal(evalActive.reason, 'recent_traffic');

    // 3. Active quota 5h reset in future -> skip (0 tokens)
    const accQuota = { name: 'acc3', quota: { unified5hReset: now + (60 * 60 * 1000) } };
    const evalQuota = hc.evaluateAccount(accQuota, now);
    assert.equal(evalQuota.shouldProbe, false);
    assert.equal(evalQuota.reason, 'quota_hold_active');

    // 4. Rate limited until future -> skip (0 tokens)
    const accThrottled = { name: 'acc4', rateLimitedUntil: now + 30000 };
    const evalThrottled = hc.evaluateAccount(accThrottled, now);
    assert.equal(evalThrottled.shouldProbe, false);
    assert.equal(evalThrottled.reason, 'rate_limited');

    // 5. Hard error backoff (403 entitlement) -> skip
    const acc403 = {
      name: 'acc5',
      lastError: { reason: 'entitlement', timestamp: now - (10 * 60 * 1000) }
    };
    const eval403 = hc.evaluateAccount(acc403, now);
    assert.equal(eval403.shouldProbe, false);
    assert.equal(eval403.reason, 'error_backoff');

    // 6. Hard error backoff expired -> needs probe
    const acc403Expired = {
      name: 'acc6',
      lastError: { reason: 'entitlement', timestamp: now - (70 * 60 * 1000) }
    };
    const evalExpired = hc.evaluateAccount(acc403Expired, now);
    assert.equal(evalExpired.shouldProbe, true);
    assert.equal(evalExpired.reason, 'needs_probe');

    // 7. Idle account with no recent traffic and no hold -> needs probe
    const accIdle = { name: 'acc7' };
    const evalIdle = hc.evaluateAccount(accIdle, now);
    assert.equal(evalIdle.shouldProbe, true);
    assert.equal(evalIdle.reason, 'needs_probe');
  });

  it('runs micro-ping with max_tokens: 1 and updates account state', async () => {
    let capturedBody = null;
    let mockServerHit = 0;

    const mockUpstream = http.createServer(async (req, res) => {
      mockServerHit++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: '1' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'acc-haiku', provider: 'anthropic', type: 'oauth', accessToken: 'token-h', upstream: upstreamUrl }
    ];
    const am = new AccountManager(accounts, 0.98);
    const hc = new FleetHealthChecker(am, {
      enabled: false, // manual check
      staggerMs: 0
    });

    try {
      const summary = await hc.runCheckCycle();
      assert.equal(summary.totalAccounts, 1);
      assert.equal(summary.probed, 1);
      assert.equal(summary.ok, 1);
      assert.equal(summary.tokensUsed, 2, 'Burned minimal 2 tokens (1 input, 1 output)');
      assert.equal(mockServerHit, 1);

      // Verify captured body has max_tokens: 1
      assert.equal(capturedBody.max_tokens, 1);
      assert.equal(capturedBody.model, 'claude-haiku-4-5-20251001');

      // Verify account state
      const acc = am.accounts[0];
      assert.equal(acc.lastTest?.ok, true);
      assert.equal(acc.lastTest?.source, 'auto-health-check');
      assert.equal(acc.lastTest?.tokensUsed, 2);
      assert.ok(acc.lastSuccess > 0, 'Recorded lastSuccess timestamp');
    } finally {
      mockUpstream.close();
      hc.stop();
    }
  });

  it('skips accounts with recent traffic and only checks idle accounts during cycle', async () => {
    let mockHits = 0;
    const mockUpstream = http.createServer((req, res) => {
      mockHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: '1' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'acc-active', provider: 'anthropic', type: 'oauth', accessToken: 'tok1', upstream: upstreamUrl, lastSuccess: Date.now() },
      { name: 'acc-idle', provider: 'anthropic', type: 'oauth', accessToken: 'tok2', upstream: upstreamUrl, lastSuccess: 0 }
    ];
    const am = new AccountManager(accounts, 0.98);
    const hc = new FleetHealthChecker(am, {
      enabled: false,
      staggerMs: 0,
      trafficGracePeriodMs: 15 * 60 * 1000
    });

    try {
      const summary = await hc.runCheckCycle();
      assert.equal(summary.totalAccounts, 2);
      assert.equal(summary.skipped, 1, 'Active account skipped with 0 tokens');
      assert.equal(summary.probed, 1, 'Idle account probed');
      assert.equal(summary.ok, 1);
      assert.equal(mockHits, 1, 'Only 1 HTTP request made to upstream');
    } finally {
      mockUpstream.close();
      hc.stop();
    }
  });

  it('exposes /api/health-check/status, /run, and /config endpoints via proxy server', async () => {
    const accounts = [
      { name: 'acc-srv', provider: 'anthropic', type: 'oauth', accessToken: 'token-s', lastSuccess: Date.now() }
    ];
    const am = new AccountManager(accounts, 0.98);
    const server = createProxyServer(am, {
      proxy: { apiKey: 'tc-test-admin' },
      autoHealthCheck: { enabled: true, intervalSeconds: 600 }
    }, {}, null, null, null);

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      // 1. GET /api/health-check/status
      const resStatus = await fetch(`http://127.0.0.1:${port}/api/health-check/status`, {
        headers: { 'x-api-key': 'tc-test-admin' }
      });
      assert.equal(resStatus.status, 200);
      const jsonStatus = await resStatus.json();
      assert.equal(jsonStatus.ok, true);
      assert.equal(jsonStatus.healthCheck.enabled, true);
      assert.equal(jsonStatus.healthCheck.intervalSeconds, 600);

      // 2. POST /api/health-check/run (force: false)
      const resRun = await fetch(`http://127.0.0.1:${port}/api/health-check/run`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ force: false })
      });
      assert.equal(resRun.status, 200);
      const jsonRun = await resRun.json();
      assert.equal(jsonRun.ok, true);
      assert.equal(jsonRun.summary.totalAccounts, 1);
      assert.equal(jsonRun.summary.skipped, 1, 'Skipped due to recent traffic');
      assert.equal(jsonRun.summary.probed, 0);
      assert.equal(jsonRun.summary.tokensUsed, 0);

      // 2b. POST /api/health-check/run (force: true)
      const resRunForce = await fetch(`http://127.0.0.1:${port}/api/health-check/run`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ force: true })
      });
      assert.equal(resRunForce.status, 200);
      const jsonRunForce = await resRunForce.json();
      assert.equal(jsonRunForce.ok, true);
      assert.equal(jsonRunForce.summary.totalAccounts, 1);
      assert.equal(jsonRunForce.summary.probed, 1, 'Probed because force was true');
      assert.equal(jsonRunForce.summary.skipped, 0);

      // 3. POST /api/health-check/config
      const resConfig = await fetch(`http://127.0.0.1:${port}/api/health-check/config`, {
        method: 'POST',
        headers: { 'x-api-key': 'tc-test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, intervalSeconds: 1200 })
      });
      assert.equal(resConfig.status, 200);
      const jsonConfig = await resConfig.json();
      assert.equal(jsonConfig.ok, true);
      assert.equal(jsonConfig.healthCheck.enabled, false);
      assert.equal(jsonConfig.healthCheck.intervalSeconds, 1200);

      // 4. Verify /api/status contains autoHealthCheck
      const resOverall = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'x-api-key': 'tc-test-admin' }
      });
      const jsonOverall = await resOverall.json();
      assert.ok(jsonOverall.autoHealthCheck, 'autoHealthCheck is present in /api/status');
      assert.equal(jsonOverall.autoHealthCheck.enabled, false);
    } finally {
      server.close();
    }
  });

  it('correctly executes health check for Codex OAuth accounts with store: false and stream: true', async () => {
    let capturedBody = null;
    const mockUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('/backend-api/codex/responses')) {
        let buf = '';
        req.on('data', c => { buf += c; });
        req.on('end', () => {
          capturedBody = JSON.parse(buf);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"prompt_tokens":1,"completion_tokens":1}}}\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${mockUpstream.address().port}`;

    const accounts = [
      { name: 'codex-hc-test', provider: 'codex', type: 'oauth', accessToken: 'token-hc', upstream: upstreamUrl }
    ];
    const am = new AccountManager(accounts, 0.98);
    const hc = new FleetHealthChecker(am, { enabled: false, staggerMs: 0 });

    try {
      const summary = await hc.runCheckCycle();
      assert.equal(summary.totalAccounts, 1);
      assert.equal(summary.probed, 1);
      assert.equal(summary.ok, 1);
      assert.equal(summary.errors, 0);

      assert.equal(capturedBody.model, 'gpt-5.6-sol');
      assert.equal(capturedBody.store, false, 'store must be false for Codex OAuth');
      assert.equal(capturedBody.stream, true, 'stream must be true for Codex OAuth');
      assert.deepEqual(capturedBody.input, [{ role: 'user', content: [{ type: 'input_text', text: '1' }] }]);

      const acc = am.accounts[0];
      assert.equal(acc.lastTest?.ok, true);
      assert.equal(acc.lastTest?.source, 'auto-health-check');
      assert.equal(acc.lastError, null);
      assert.equal(acc.status, 'active');
    } finally {
      mockUpstream.close();
      hc.stop();
    }
  });
});

