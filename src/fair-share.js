// Congestion-aware per-client-key fair-share stream admission.
//
// Stream slots and concurrent requests are scarce resources. Without fair share,
// one bursty agent or client (e.g. background batch jobs, test loops) can occupy
// all available concurrency slots and starve interactive developer sessions.
//
// Pure max-min fair-share decision:
// - Work-conserving: while pool utilization is below the configured congestion
//   threshold (default 75%), every key is admitted unconditionally.
// - Under congestion: a key may acquire a new slot only while it holds fewer than
//   max(MIN_GUARANTEE_STREAMS, pool_capacity / active_keys) streams.
// - Keys under the minimum guarantee (2 streams) are never starved, ensuring
//   interactive typing and turns in Claude Code / Codex CLI always go through.

export const MIN_GUARANTEE_STREAMS = 2;
export const DEFAULT_CONGESTION_THRESHOLD = 0.75;
export const DEFAULT_POOL_CAPACITY = 32;

/**
 * Pure fair-share admission decision.
 *
 * @param {Object} params
 * @param {number} params.keyStreams - Currently active streams held by this key.
 * @param {number} params.totalActiveStreams - Total active streams held across all keys.
 * @param {number} params.activeKeyCount - Number of keys currently holding >= 1 active stream.
 * @param {number} [params.poolCapacity] - Estimated total concurrent capacity of the pool.
 * @param {number} [params.congestionThreshold] - Fraction of capacity at which congestion triggers (0-1).
 * @param {number} [params.minGuarantee] - Minimum stream guarantee for any single key.
 * @returns {{ admitted: boolean, congested: boolean, fairShare: number, keyStreams: number }}
 */
export function evaluateFairShare({
  keyStreams = 0,
  totalActiveStreams = 0,
  activeKeyCount = 1,
  poolCapacity = DEFAULT_POOL_CAPACITY,
  congestionThreshold = DEFAULT_CONGESTION_THRESHOLD,
  minGuarantee = MIN_GUARANTEE_STREAMS,
} = {}) {
  const cap = Math.max(1, Math.floor(poolCapacity));
  const activeKeys = Math.max(1, Math.floor(activeKeyCount));
  const currentKeyStreams = Math.max(0, Math.floor(keyStreams));
  const totalStreams = Math.max(0, Math.floor(totalActiveStreams));

  const congestionTrigger = Math.max(1, Math.floor(cap * congestionThreshold));
  const isCongested = totalStreams >= congestionTrigger;

  if (!isCongested) {
    return {
      admitted: true,
      congested: false,
      fairShare: cap,
      keyStreams: currentKeyStreams,
    };
  }

  // Under congestion: compute max-min fair share
  const fairShare = Math.max(minGuarantee, Math.floor(cap / activeKeys));
  const admitted = currentKeyStreams < fairShare;

  return {
    admitted,
    congested: true,
    fairShare,
    keyStreams: currentKeyStreams,
  };
}

/**
 * Stateful tracker for active streams per client key.
 */
export class FairShareController {
  constructor({
    poolCapacity = DEFAULT_POOL_CAPACITY,
    congestionThreshold = DEFAULT_CONGESTION_THRESHOLD,
    minGuarantee = MIN_GUARANTEE_STREAMS,
  } = {}) {
    this.poolCapacity = poolCapacity;
    this.congestionThreshold = congestionThreshold;
    this.minGuarantee = minGuarantee;
    /** @type {Map<string, number>} */
    this.activeStreams = new Map();
  }

  get totalStreams() {
    let sum = 0;
    for (const count of this.activeStreams.values()) {
      sum += count;
    }
    return sum;
  }

  get activeKeyCount() {
    let count = 0;
    for (const n of this.activeStreams.values()) {
      if (n > 0) count += 1;
    }
    return Math.max(1, count);
  }

  getKeyStreams(keyId) {
    return this.activeStreams.get(keyId) || 0;
  }

  /**
   * Check if a request from keyId is admitted.
   * @param {string} keyId
   * @param {number} [overrideCapacity]
   * @returns {{ admitted: boolean, congested: boolean, fairShare: number, keyStreams: number }}
   */
  admit(keyId, overrideCapacity) {
    const key = String(keyId || 'anonymous');
    const keyStreams = this.getKeyStreams(key);
    const totalStreams = this.totalStreams;
    // If this key has no streams yet, activeKeyCount will increase by 1
    const activeKeys = keyStreams > 0 ? this.activeKeyCount : this.activeKeyCount + 1;

    return evaluateFairShare({
      keyStreams,
      totalActiveStreams: totalStreams,
      activeKeyCount: activeKeys,
      poolCapacity: overrideCapacity || this.poolCapacity,
      congestionThreshold: this.congestionThreshold,
      minGuarantee: this.minGuarantee,
    });
  }

  /**
   * Acquire a stream slot for keyId.
   * @param {string} keyId
   */
  acquire(keyId) {
    const key = String(keyId || 'anonymous');
    const current = this.activeStreams.get(key) || 0;
    this.activeStreams.set(key, current + 1);
  }

  /**
   * Release a stream slot for keyId.
   * @param {string} keyId
   */
  release(keyId) {
    const key = String(keyId || 'anonymous');
    const current = this.activeStreams.get(key) || 0;
    if (current <= 1) {
      this.activeStreams.delete(key);
    } else {
      this.activeStreams.set(key, current - 1);
    }
  }

  /**
   * Snapshot of current fair-share state for metrics / dashboard.
   */
  status() {
    return {
      poolCapacity: this.poolCapacity,
      totalStreams: this.totalStreams,
      activeKeyCount: this.activeKeyCount,
      congested: this.totalStreams >= Math.floor(this.poolCapacity * this.congestionThreshold),
      keys: Object.fromEntries(this.activeStreams.entries()),
    };
  }
}

