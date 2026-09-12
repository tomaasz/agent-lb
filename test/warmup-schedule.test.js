import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinWorkingHours } from '../src/warmup-schedule.js';

describe('Working Hours Keep-Warm Planner', () => {
  it('returns true when workingHours is disabled or omitted', () => {
    assert.equal(isWithinWorkingHours(null), true);
    assert.equal(isWithinWorkingHours({ enabled: false }), true);
  });

  it('correctly gates active working hours during work days', () => {
    const config = {
      enabled: true,
      timezone: 'UTC',
      days: [1, 2, 3, 4, 5], // Mon-Fri
      start: '09:00',
      end: '17:00',
      prewarmLeadMinutes: 30, // 08:30 - 17:00
    };

    // 2026-09-14 is Monday:
    // 08:00 UTC -> too early (before 08:30)
    const tEarly = Date.parse('2026-09-14T08:00:00Z');
    assert.equal(isWithinWorkingHours(config, tEarly), false);

    // 08:45 UTC -> within prewarm window
    const tPrewarm = Date.parse('2026-09-14T08:45:00Z');
    assert.equal(isWithinWorkingHours(config, tPrewarm), true);

    // 14:00 UTC -> during midday work
    const tWork = Date.parse('2026-09-14T14:00:00Z');
    assert.equal(isWithinWorkingHours(config, tWork), true);

    // 17:30 UTC -> after work
    const tLate = Date.parse('2026-09-14T17:30:00Z');
    assert.equal(isWithinWorkingHours(config, tLate), false);
  });

  it('blocks warm-ups on weekends', () => {
    const config = {
      enabled: true,
      timezone: 'UTC',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '17:00',
      prewarmLeadMinutes: 30,
    };

    // 2026-09-13 is Sunday
    const tSundayMidday = Date.parse('2026-09-13T12:00:00Z');
    assert.equal(isWithinWorkingHours(config, tSundayMidday), false);
  });
});

