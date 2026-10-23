import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAgyAccount, safeAgyLink } from '../src/agy-diagnostics.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const token = { token: { refresh_token: 'private-refresh', access_token: 'private-access', expiry: '2026-10-23T13:00:00Z' } };
const models = { models: { 'gemini-test': { displayName: 'Gemini', quotaInfo: { remainingFraction: 0.25, resetTime: '2026-10-23T13:00:00Z' } } } };
function harness(responses, options = {}) {
  const calls = [];
  const probe = raw => probeAgyAccount(raw || token, { now: () => NOW, clientSecret: '', ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected HTTP request');
    return new Response(JSON.stringify(response.data), { status: response.status || 200, headers: response.headers || {} });
  } });
  return { calls, probe };
}

test('cached access token gives separately observed plan/models/windows with millisecond times', async () => {
  const { probe, calls } = harness([
    { data: { paidTier: { id: 'g1-pro-tier', availableCredits: [{ creditType: 'test', creditAmount: '2.5' }] }, currentTier: { id: 'free-tier', usesGcpTos: true }, cloudaicompanionProject: 'test-project' } },
    { data: models },
    { data: { groups: [{ buckets: [{ bucketId: 'daily', remainingFraction: 0, resetTime: '2026-10-23T14:00:00+01:00' }] }] } },
  ]);
  const result = await probe();
  assert.equal(result.status, 'available');
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.telemetry.plan.data.label, 'pro');
  assert.equal(result.telemetry.models.observedAt, NOW);
  assert.equal(result.telemetry.models.data[0].resetAt, NOW + 3600_000);
  assert.equal(result.telemetry.quotaSummary.data[0].remainingFraction, 0);
  assert.ok(calls[1].url.startsWith('https://cloudcode-pa.googleapis.com/'));
  assert.deepEqual(JSON.parse(calls[1].init.body), { project: 'test-project' });
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('refreshes expired tokens without returning OAuth credentials', async () => {
  const { probe, calls } = harness([
    { data: { access_token: 'new-private-access', refresh_token: 'new-private-refresh' } },
    { data: { currentTier: { id: 'new-unknown-tier' } } }, { data: models }, { data: { groups: [] } },
  ], { clientSecret: 'private-secret' });
  const result = await probe({ token: { refresh_token: 'private-refresh', expiry: '2000-01-01T00:00:00Z' } });
  assert.equal(result.telemetry.plan.data.label, 'unknown');
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(calls[0].init.body).get('client_secret'), 'private-secret');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer new-private-access');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('requires secret for expired cached token and distinguishes invalid grant/client', async () => {
  assert.equal((await harness([]).probe({ token: { refresh_token: 'x' } })).reason, 'missing_client_secret');
  for (const [error, status] of [['invalid_grant', 'auth_invalid'], ['invalid_client', 'configuration_error'], ['unauthorized_client', 'configuration_error']]) {
    const result = await harness([{ status: 400, data: { error } }], { clientSecret: 'x' }).probe();
    assert.equal(result.status, status);
  }
});

test('metadata forbidden does not suppress independent model access', async () => {
  const { probe, calls } = harness([{ status: 403, data: {} }, { data: models }, { status: 403, data: {} }]);
  const result = await probe();
  assert.equal(result.status, 'available');
  assert.equal(result.checks.metadata.status, 'forbidden');
  assert.equal(result.checks.models.status, 'available');
  assert.equal(result.checks.quotaSummary.status, 'forbidden');
  assert.equal(calls.length, 3);
});

test('explicit validation remains visible despite available model listing', async () => {
  const data = { error: { details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.google.com/verify' } }] } };
  const result = await harness([{ status: 403, data }, { data: models }, { data: { groups: [] } }]).probe();
  assert.equal(result.status, 'validation_required');
  assert.equal(result.validationUrl, 'https://accounts.google.com/verify');
  assert.equal(result.telemetry.models.data.length, 1);
});

test('subscription and TOS reasons preserved without copying unsafe error text', async () => {
  for (const reason of ['SUBSCRIPTION_REQUIRED', 'TOS_VIOLATION']) {
    const result = await harness([{ data: {} }, { data: models }, { status: 403, data: { error: { message: 'private-access', details: [{ reason, metadata: { appeal_url: 'https://support.google.com/appeal' } }] } } }]).probe();
    assert.equal(result.status, reason.toLowerCase());
    assert.equal(result.appealUrl, reason === 'TOS_VIOLATION' ? 'https://support.google.com/appeal' : null);
    assert.equal(JSON.stringify(result).includes('private-access'), false);
  }
});

test('quota summary transport failure/malformed response does not invalidate model access', async () => {
  for (const response of [new Error('private-access'), { data: {} }, { data: { groups: [{ buckets: [{ bucketId: 'test', remainingFraction: true }] }] } }]) {
    const result = await harness([{ data: {} }, { data: models }, response]).probe();
    assert.equal(result.status, 'available');
    assert.equal(result.checks.quotaSummary.status, 'error');
    assert.equal(result.telemetry.quotaSummary, undefined);
  }
});

test('valid empty quota summary accepted while malformed models rejected', async () => {
  const valid = await harness([{ data: {} }, { data: models }, { data: { groups: [] } }]).probe();
  assert.deepEqual(valid.telemetry.quotaSummary.data, []);
  for (const data of [{}, { models: [] }, { models: {} }]) {
    const result = await harness([{ data: {} }, { data }]).probe();
    assert.equal(result.reason, 'invalid_models_response');
  }
});

test('normalization rejects bogus fractions/reset timestamps and bounds model count', async () => {
  const data = { models: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`gemini-${i}`, { quotaInfo: { remainingFraction: i === 0 ? true : -1, resetTime: '2026-10-23T13:00:00' } }])) };
  const result = await harness([{ data: {} }, { data }, { data: { groups: [] } }]).probe();
  assert.equal(result.telemetry.models.data.length, 100);
  assert.ok(result.telemetry.models.data.every(m => m.remainingFraction === null && m.resetAt === null));
});

test('long retry-after defers without retry; short delay retries at most once', async () => {
  const deferred = harness([{ status: 429, data: {}, headers: { 'retry-after': '120' } }]);
  const result = await deferred.probe();
  assert.equal(result.retryAt, NOW + 120_000);
  assert.equal(deferred.calls.length, 1);
  const retried = harness([{ status: 503, data: {}, headers: { 'retry-after': '0' } }, { status: 503, data: {}, headers: { 'retry-after': '60' } }]);
  assert.equal((await retried.probe()).retryAt, NOW + 60_000);
  assert.equal(retried.calls.length, 2);
});

test('rejects oversized API body without exposing content', async () => {
  const result = await harness([{ data: { secret: 'x'.repeat(4 * 1024 * 1024) } }]).probe();
  assert.equal(result.reason, 'network_or_response_error');
  assert.equal(result.checks.metadata.status, 'error');
});

test('safe links accept only exact Google HTTPS hosts without credentials, ports or controls', () => {
  assert.equal(safeAgyLink('https://myaccount.google.com/verify'), 'https://myaccount.google.com/verify');
  assert.equal(safeAgyLink('https://support.google.com/appeal', true), 'https://support.google.com/appeal');
  for (const link of ['https://support.google.com/appeal', 'https://accounts.google.com.evil.test/', 'https://evil.test/', 'http://accounts.google.com/', 'https://user@accounts.google.com/', 'https://accounts.google.com:444/', 'https://accounts.google.com/\n', 'https://accounts.google.com\\@evil.test/']) assert.equal(safeAgyLink(link), null);
});
