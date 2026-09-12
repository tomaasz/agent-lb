import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFairShare, FairShareController } from '../src/fair-share.js';

describe('Fair Share Stream Admission', () => {
  it('admits all requests when pool is uncongested', () => {
    const res = evaluateFairShare({
      keyStreams: 5,
      totalActiveStreams: 10,
      activeKeyCount: 2,
      poolCapacity: 30,
      congestionThreshold: 0.75, // trigger at 22
    });
    assert.equal(res.admitted, true);
    assert.equal(res.congested, false);
  });

  it('throttles a key that exceeds its fair share during congestion', () => {
    const res = evaluateFairShare({
      keyStreams: 15,
      totalActiveStreams: 25,
      activeKeyCount: 2,
      poolCapacity: 30, // fair share is 30 / 2 = 15
      congestionThreshold: 0.75, // trigger at 22 -> 25 is congested
    });
    assert.equal(res.congested, true);
    assert.equal(res.fairShare, 15);
    // key already holds 15, so next request is denied
    assert.equal(res.admitted, false);
  });

  it('guarantees min streams for interactive sessions even under heavy congestion', () => {
    const res = evaluateFairShare({
      keyStreams: 0,
      totalActiveStreams: 30,
      activeKeyCount: 15,
      poolCapacity: 30,
      minGuarantee: 2,
    });
    assert.equal(res.congested, true);
    assert.equal(res.fairShare >= 2, true);
    assert.equal(res.admitted, true);
  });

  it('FairShareController correctly tracks and releases key streams', () => {
    const controller = new FairShareController({ poolCapacity: 10, congestionThreshold: 0.5 });
    assert.equal(controller.totalStreams, 0);

    controller.acquire('key-a');
    controller.acquire('key-a');
    controller.acquire('key-b');

    assert.equal(controller.totalStreams, 3);
    assert.equal(controller.getKeyStreams('key-a'), 2);
    assert.equal(controller.getKeyStreams('key-b'), 1);

    controller.release('key-a');
    assert.equal(controller.getKeyStreams('key-a'), 1);
    assert.equal(controller.totalStreams, 2);

    controller.release('key-a');
    assert.equal(controller.getKeyStreams('key-a'), 0);
    assert.equal(controller.totalStreams, 1);
  });
});

