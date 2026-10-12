import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideSessionBurn, normalizeSessionBurn } from '../src/band-decision.js';

const NOW = 1_000_000_000_000;
const config = normalizeSessionBurn({});
const acc = (index, over = {}) => ({
  index, priority: 0, sessionUtilization: 0.38, sessionResetAt: NOW + 60 * 60_000, weeklyUtilization: 0.05, ...over,
});
const decide = accounts => decideSessionBurn({ now: NOW, config, accounts });

describe('decideSessionBurn', () => {
  it('picks an account whose session resets soon with quota left', () => {
    assert.deepEqual(decide([acc(0)]).index, 0);
  });
  it('ignores a session that resets later than the horizon', () => {
    assert.equal(decide([acc(0, { sessionResetAt: NOW + 3 * 3600_000 })]).kind, 'none');
  });
  it('ignores a nearly spent session', () => {
    assert.equal(decide([acc(0, { sessionUtilization: 0.9 })]).kind, 'none');
  });
  it('does not burn an account whose week is nearly spent', () => {
    assert.equal(decide([acc(0, { weeklyUtilization: 0.95 })]).kind, 'none');
  });
  it('ignores unknown readings and passed resets', () => {
    assert.equal(decide([acc(0, { sessionResetAt: null })]).kind, 'none');
    assert.equal(decide([acc(0, { weeklyUtilization: null })]).kind, 'none');
    assert.equal(decide([acc(0, { sessionUtilization: null })]).kind, 'none');
    assert.equal(decide([acc(0, { sessionResetAt: NOW - 1 })]).kind, 'none');
  });
  it('prefers the highest unspent-per-second among qualifiers', () => {
    const a = acc(0, { sessionResetAt: NOW + 80 * 60_000 });
    const b = acc(1, { sessionResetAt: NOW + 20 * 60_000 });
    assert.equal(decide([a, b]).index, 1);
  });
  it('is off when disabled', () => {
    const r = decideSessionBurn({ now: NOW, config: { ...config, enabled: false }, accounts: [acc(0)] });
    assert.equal(r.kind, 'none');
  });
  it('normalizes bad config to defaults', () => {
    const c = normalizeSessionBurn({ withinMin: 'x', minSpendable: 5 });
    assert.equal(c.withinMin, 90);
    assert.equal(c.minSpendable, 0.25);
    assert.equal(c.enabled, true);
  });
});

import { decideWeeklyBurn, normalizeWeeklyBurn } from '../src/band-decision.js';

describe('decideWeeklyBurn', () => {
  const wcfg = normalizeWeeklyBurn({});
  const w = (index, util, hoursLeft) => ({ index, weeklyUtilization: util, weeklyResetAt: NOW + hoursLeft * 3600_000 });
  const run = accounts => decideWeeklyBurn({ now: NOW, config: wcfg, accounts });

  it('picks the account whose week expires soon with quota left (the 1.8d / 47% case)', () => {
    assert.equal(run([w(0, 0.05, 6.7 * 24), w(1, 0.53, 43)]).index, 1);
  });
  it('ignores a week that resets beyond the horizon or is nearly spent', () => {
    assert.equal(run([w(0, 0.05, 6.7 * 24)]).kind, 'none');
    assert.equal(run([w(0, 0.95, 10)]).kind, 'none');
  });
  it('ignores unknown readings and passed resets', () => {
    assert.equal(run([{ index: 0, weeklyUtilization: null, weeklyResetAt: NOW + 1000 }]).kind, 'none');
    assert.equal(run([{ index: 0, weeklyUtilization: 0.1, weeklyResetAt: null }]).kind, 'none');
    assert.equal(run([w(0, 0.1, -1)]).kind, 'none');
  });
  it('prefers the larger unspent-per-second among qualifiers', () => {
    assert.equal(run([w(0, 0.5, 60), w(1, 0.5, 20)]).index, 1);
  });
  it('is off when disabled and normalizes bad config', () => {
    assert.equal(decideWeeklyBurn({ now: NOW, config: { ...wcfg, enabled: false }, accounts: [w(0, 0.1, 10)] }).kind, 'none');
    const c = normalizeWeeklyBurn({ withinHours: 'x', preemptPinned: false });
    assert.equal(c.withinHours, 72);
    assert.equal(c.preemptPinned, false);
  });
});
