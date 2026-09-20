// Shared by all HTTP and MITM listeners belonging to one proxy configuration.
const budgets = new WeakMap();
export function requestBudgetFor(config) {
  let budget = budgets.get(config);
  if (!budget) {
    budget = new RequestBudget(config.proxy?.maxBufferedRequests, config.proxy?.maxBufferedBytes);
    budgets.set(config, budget);
  }
  return budget;
}
export class RequestBudget {
  constructor(maxRequests = 16, maxBytes = 256 * 1024 * 1024) {
    this.maxRequests = positive(maxRequests, 16);
    this.maxBytes = positive(maxBytes, 256 * 1024 * 1024);
    this.active = 0;
    this.bytes = 0;
  }
  acquire() {
    if (this.active >= this.maxRequests) return null;
    this.active++;
    let bytes = 0, released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.bytes -= bytes;
    };
    release.reserve = size => {
      // Reserve for the chunk list and its concatenated copy. Parsed objects
      // incur additional overhead; the concurrency limit bounds their fan-out.
      const charge = size * 2;
      if (released || this.bytes + charge > this.maxBytes) return false;
      this.bytes += charge;
      bytes += charge;
      return true;
    };
    return release;
  }
}
function positive(value, fallback) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}
