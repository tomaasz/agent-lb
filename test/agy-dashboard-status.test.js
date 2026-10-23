import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboardHtml } from '../src/dashboard.js';

const html = renderDashboardHtml();
const source = html.match(/ {2}function agyAccountStatus\([\s\S]*?(?= {2}function renderAgyCard)/)[0];
const status = vm.runInNewContext(source + '\nagyAccountStatus');
const now = 2000000;
const account = { id: 'a', enabled: true };
const success = [{ accountId: 'a', at: now - 1, outcome: 'success' }];

test('AGY never claims an untested or stale account is healthy', () => {
  assert.equal(status(account, [], null, now), 'unknown');
  assert.equal(status(account, success, null, now), 'verified');
  assert.equal(status(account, [{ ...success[0], at: now - 900001 }], null, now), 'unknown');
  assert.equal(status(account, [{ ...success[0], accountId: 'other' }], null, now), 'unknown');
});
test('AGY known failures and model quotas override recent success before Test is pressed', () => {
  assert.equal(status({ ...account, quotaUntil: now + 10 }, success, null, now), 'quota');
  assert.equal(status({ ...account, modelQuotas: { gemini: now + 10 } }, success, null, now), 'modelQuota');
  assert.equal(status({ ...account, modelQuotas: { gemini: now - 10 } }, success, null, now), 'verified');
  assert.equal(status({ ...account, health: { requiresReview: true } }, success, null, now), 'error');
  assert.equal(status({ ...account, health: { until: now + 10 } }, success, null, now), 'error');
  assert.equal(status({ ...account, enabled: false }, success, null, now), 'disabled');
  assert.equal(status({ ...account, usage: { models: [{ remaining: 0, resetAt: now + 1 }] } }, success, null, now), 'modelQuota');
});
test('AGY uses latest test or traffic outcome and expires verification', () => {
  assert.equal(status(account, success, { ok: false, at: now }, now), 'error');
  assert.equal(status(account, success, { ok: false, at: now - 10 }, now), 'verified');
  assert.equal(status(account, [{ ...success[0], outcome: 'test_failed' }], null, now), 'error');
  assert.equal(status(account, [], { ok: true, at: now }, now), 'verified');
  assert.equal(status(account, [], { ok: true, at: now - 900001 }, now), 'unknown');
});
