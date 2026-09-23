import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isFableModel, modelFamily, weeklyBucketForModel } from '../src/model.js';
import {
  createProxyServer,
  DEFAULT_MAX_BODY_BYTES,
  exhaustedMessage,
  isOAuthIdentityVerificationRequired,
  normalizeAnthropicModelForOAuth,
  resolveMaxBodyBytes,
  rewriteRequestBody,
} from '../src/server.js';
import { resolveTargetModel } from '../src/provider-translator.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { formatAccountStatus, UNAVAILABLE_TEXT } from '../src/status-renderer.js';

test('Claude 5 family ids route to their dedicated quota semantics', () => {
  assert.equal(modelFamily('claude-opus-5'), 'opus');
  assert.equal(modelFamily('claude-sonnet-5'), 'sonnet');
  assert.equal(weeklyBucketForModel('claude-opus-5'), 'unified7d');
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(weeklyBucketForModel('claude-opus-5-5'), 'unified7d');
  assert.equal(weeklyBucketForModel('claude-sonnet-5'), 'unified7dSonnet');
  assert.equal(modelFamily('claude-fable-5-1'), 'fable');
  assert.equal(weeklyBucketForModel('claude-fable-5-1'), 'unified7dFable');
  assert.equal(isFableModel('claude-fable-5-1'), true);
  assert.equal(modelFamily('claude-mythos-5-1'), 'fable');
  assert.equal(weeklyBucketForModel('claude-mythos-5-1'), 'unified7dFable');
  assert.equal(isFableModel('claude-mythos-5-1'), true);
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(weeklyBucketForModel('claude-haiku-4-5-20251001'), 'unified7d');
});

test('proxy body cap is a byte safety limit, not a token or max_tokens limit', () => {
  assert.equal(DEFAULT_MAX_BODY_BYTES, 64 * 1024 * 1024);
  assert.equal(resolveMaxBodyBytes({}), DEFAULT_MAX_BODY_BYTES);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: '134217728' } }), 128 * 1024 * 1024);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: 0 } }), Infinity);

  const body = Buffer.from(JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 32768,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.80a; cc_entrypoint=sdk-cli;' }],
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
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.80a; cc_entrypoint=sdk-cli;' }],
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

test('exhaustedMessage formats clear errors for disabled, partitioned and identity-blocked fleets', () => {
  // 1. Empty fleet
  const emptyAm = new AccountManager([]);
  assert.match(exhaustedMessage(emptyAm, null, 0), /No accounts configured in (?:AgentLB|Agent-LB)/);

  // 2. All disabled accounts
  const disabled1 = new AccountManager([{ name: 'a', disabled: true }]);
  assert.equal(exhaustedMessage(disabled1, null, 0), 'No account can serve this request: all 1 account is disabled.');

  const disabled2 = new AccountManager([{ name: 'a', disabled: true }, { name: 'b', disabled: true }]);
  assert.equal(exhaustedMessage(disabled2, 'claude-sonnet-5', 0), 'No account can serve this request for claude-sonnet-5: all 2 accounts are disabled.');

  // 3. Single eligible vs multiple eligible account grammar
  const singleAm = new AccountManager([{ name: 'a' }]);
  assert.equal(exhaustedMessage(singleAm, null, 30), 'No account can serve this request: 1 account is at its quota or rate limit. Quota resets in 30s.');

  const singlePlusDisabled = new AccountManager([{ name: 'a' }, { name: 'b', disabled: true }]);
  assert.equal(exhaustedMessage(singlePlusDisabled, null, 30), 'No account can serve this request: 1 account is (1 more disabled) at its quota or rate limit. Quota resets in 30s.');

  const multiAm = new AccountManager([{ name: 'a' }, { name: 'b' }]);
  assert.equal(exhaustedMessage(multiAm, null, 30), 'No account can serve this request: all 2 accounts are at their quota or rate limit. Quota resets in 30s.');

  // 4. Provider partitioning
  const mixedAm = new AccountManager([
    { name: 'claude-1', provider: 'anthropic' },
    { name: 'codex-1', provider: 'codex' },
  ]);
  assert.equal(exhaustedMessage(mixedAm, null, 30, 'anthropic'), 'No account can serve this request: 1 account is at its quota or rate limit. Quota resets in 30s.');
  assert.equal(exhaustedMessage(mixedAm, null, 30, 'codex'), 'No account can serve this request: 1 account is at its quota or rate limit. Quota resets in 30s.');

  const onlyClaude = new AccountManager([{ name: 'claude-1', provider: 'anthropic' }]);
  assert.equal(exhaustedMessage(onlyClaude, null, 30, 'codex'), 'No codex accounts configured in AgentLB. Please add a codex account via the Web Dashboard or CLI.');

  // 5. Identity verification note
  const idAm = new AccountManager([
    { name: 'claude-1', provider: 'anthropic' },
    { name: 'claude-2', provider: 'anthropic' },
  ]);
  idAm.markIdentityVerificationRequired(0, 300);
  assert.equal(
    exhaustedMessage(idAm, null, 45, 'anthropic'),
    'No account can serve this request: all 2 accounts are at their quota or rate limit (1 requires identity verification in browser). Quota resets in 45s.',
  );
});

test('eligibility reports identity verification and entitlement cooldown reasons', () => {
  const am = new AccountManager([
    { name: 'verify-me', type: 'oauth', accessToken: 'tok-1' },
    { name: 'entitled', type: 'oauth', accessToken: 'tok-2' },
  ]);
  am.markIdentityVerificationRequired(0, 300);
  am.markEntitlementDenied(1, 300);

  assert.deepEqual(am.eligibility(0), { eligible: false, reason: 'requires identity verification' });
  assert.deepEqual(am.eligibility(1), { eligible: false, reason: 'in OAuth entitlement cooldown' });
});

test('prober clears identity verification cooldown upon successful probe', async () => {
  const am = new AccountManager([{ name: 'acct-1', type: 'oauth', accessToken: 'tok-1' }]);
  am.markIdentityVerificationRequired(0, 300);
  assert.equal(am.unavailableReason(am.accounts[0]), 'identity-verification');

  const prober = new Prober(am, {
    probeFn: async () => ({ five_hour: { utilization: 0.1 } }),
  });
  await prober.probeAccount(am.accounts[0]);

  assert.equal(am.accounts[0].identityVerificationUntil, null);
  assert.equal(am.unavailableReason(am.accounts[0]), null);
});

test('formatAccountStatus and UNAVAILABLE_TEXT clearly distinguish identity verification from active status', () => {
  assert.equal(UNAVAILABLE_TEXT['identity-verification'], 'upstream requires identity verification (action needed in browser)');

  const paint = {
    green: s => `[green]${s}[/green]`,
    yellow: s => `[yellow]${s}[/yellow]`,
    red: s => `[red]${s}[/red]`,
    gray: s => `[gray]${s}[/gray]`,
    bold: s => `[bold]${s}[/bold]`,
    dim: s => `[dim]${s}[/dim]`,
  };

  const activeAcct = { name: 'a1', status: 'active' };
  assert.match(formatAccountStatus(activeAcct, Date.now(), paint), /\[green\]active\[\/green\]/);

  const idAcct = {
    name: 'a2',
    status: 'active',
    identityVerificationUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const idFormatted = formatAccountStatus(idAcct, Date.now(), paint);
  assert.doesNotMatch(idFormatted, /\[green\]/);
  assert.match(idFormatted, /\[red\]active\[\/red\]/);
  assert.match(idFormatted, /\[red\]identity-verification cooldown/);

  const entAcct = {
    name: 'a3',
    status: 'active',
    entitlementDeniedUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const entFormatted = formatAccountStatus(entAcct, Date.now(), paint);
  assert.doesNotMatch(entFormatted, /\[green\]/);
  assert.match(entFormatted, /\[yellow\]active\[\/yellow\]/);
  assert.match(entFormatted, /\[yellow\]entitlement cooldown/);
});

test('Claude models endpoint exposes accurate parameters matching documentation', async () => {
  const am = new AccountManager([]);
  const proxyServer = createProxyServer(am, {
    upstream: 'http://127.0.0.1:9',
    proxy: { apiKey: 'test-key', trustLoopback: false, trustTailnet: false },
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${proxyServer.address().port}/v1/models`, {
      headers: { 'x-api-key': 'test-key' }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));

    const findModel = id => body.data.find(m => m.id === id);

    // Fable 5.1
    const fable = findModel('claude-fable-5-1');
    assert.ok(fable, 'claude-fable-5-1 is present in catalog');
    assert.equal(fable.context_window, 1000000);
    assert.equal(fable.max_output_tokens, 128000);
    assert.equal(fable.latency, 'slower');
    assert.equal(fable.default_reasoning_level, 'high');
    assert.equal(fable.reliable_knowledge_cutoff, '2026-06');
    assert.equal(fable.pricing.input_per_mtok, 10);
    assert.equal(fable.pricing.output_per_mtok, 50);
    assert.equal(fable.capabilities.thinking.supported, true);

    // Opus 5.5
    const opus55 = findModel('claude-opus-5-5');
    assert.ok(opus55, 'claude-opus-5-5 is present in catalog');
    assert.equal(opus55.context_window, 1000000);
    assert.equal(opus55.max_output_tokens, 128000);
    assert.equal(opus55.latency, 'moderate');
    assert.equal(opus55.default_reasoning_level, 'medium');
    assert.equal(opus55.reliable_knowledge_cutoff, '2026-06');
    assert.equal(opus55.pricing.input_per_mtok, 4);
    assert.equal(opus55.pricing.output_per_mtok, 20);

    // Sonnet 5
    const sonnet5 = findModel('claude-sonnet-5');
    assert.ok(sonnet5, 'claude-sonnet-5 is present in catalog');
    assert.equal(sonnet5.context_window, 1000000);
    assert.equal(sonnet5.max_output_tokens, 128000);
    assert.equal(sonnet5.latency, 'fast');
    assert.equal(sonnet5.default_reasoning_level, 'high');
    assert.equal(sonnet5.reliable_knowledge_cutoff, '2026-01');
    assert.equal(sonnet5.pricing.input_per_mtok, 2);
    assert.equal(sonnet5.pricing.output_per_mtok, 10);

    // Haiku 4.5
    const haiku = findModel('claude-haiku-4-5-20251001');
    assert.ok(haiku, 'claude-haiku-4-5-20251001 is present in catalog');
    assert.equal(haiku.context_window, 200000);
    assert.equal(haiku.max_output_tokens, 64000);
    assert.equal(haiku.latency, 'fastest');
    assert.equal(haiku.reliable_knowledge_cutoff, '2025-02');
    assert.equal(haiku.pricing.input_per_mtok, 1);
    assert.equal(haiku.pricing.output_per_mtok, 5);

    // Specialized & Legacy
    assert.ok(findModel('claude-mythos-5-1'), 'claude-mythos-5-1 is present');
    assert.ok(findModel('claude-mythos-5'), 'claude-mythos-5 is present');
    assert.ok(findModel('claude-opus-5'), 'claude-opus-5 is present');
    assert.ok(findModel('claude-haiku-4-5'), 'claude-haiku-4-5 alias is present');
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
  }
});

test('normalizeAnthropicModelForOAuth normalizes modern aliases to canonical IDs', () => {
  const normHaiku = normalizeAnthropicModelForOAuth(Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5' })));
  assert.equal(JSON.parse(normHaiku.toString()).model, 'claude-haiku-4-5-20251001');

  const normOpus55 = normalizeAnthropicModelForOAuth(Buffer.from(JSON.stringify({ model: 'claude-opus-5.5' })));
  assert.equal(JSON.parse(normOpus55.toString()).model, 'claude-opus-5-5');

  const normOpus45 = normalizeAnthropicModelForOAuth(Buffer.from(JSON.stringify({ model: 'claude-opus-4-5' })));
  assert.equal(JSON.parse(normOpus45.toString()).model, 'claude-opus-4-5-20251101');

  const normSonnet45 = normalizeAnthropicModelForOAuth(Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-5' })));
  assert.equal(JSON.parse(normSonnet45.toString()).model, 'claude-sonnet-4-5-20250929');
});

test('resolveTargetModel handles Fable, Mythos, and current Opus 5.5 fallbacks', () => {
  assert.equal(resolveTargetModel('claude-fable-5-1', 'codex'), 'gpt-6-astra');
  assert.equal(resolveTargetModel('claude-mythos-5-1', 'codex'), 'gpt-6-astra');
  assert.equal(resolveTargetModel('gpt-6-astra', 'anthropic'), 'claude-opus-5-5');
  assert.equal(resolveTargetModel('claude-haiku-4-5', 'codex'), 'gpt-5.6-terra');
});
