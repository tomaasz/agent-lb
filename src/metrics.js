const instances = new WeakMap();
const buckets = [0.05, 0.1, 0.5, 1, 5, 15, 60, 180, 600];
export function metricsFor(config) {
  let value = instances.get(config);
  if (!value) { value = new ProxyMetrics(); instances.set(config, value); }
  return value;
}
export class ProxyMetrics {
  constructor() {
    this.active = 0;
    this.recent = [];
    this.firstToken = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
    this.responses = new Map();
    this.duration = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
    this.headers = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
  }
  start(res) {
    const started = performance.now(); this.active++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; this.active--;
      const status = res.writableFinished ? String(res.statusCode) : '499';
      this.recent.push({ at: Date.now(), failed: /^5/.test(status) || status === '499' });
      this.prune();
      this.responses.set(status, (this.responses.get(status) || 0) + 1);
      observe(this.duration, (performance.now() - started) / 1000);
      res.off('finish', finish); res.off('close', finish);
    };
    res.once('finish', finish); res.once('close', finish);
    let tokenObserved = false;
    return () => {
      if (tokenObserved) return;
      tokenObserved = true;
      observe(this.firstToken, (performance.now() - started) / 1000);
    };
  }
  observeHeaders(seconds) { observe(this.headers, seconds); }
  prune() {
    const cutoff = Date.now() - 5 * 60_000;
    while (this.recent.length && this.recent[0].at < cutoff) this.recent.shift();
    if (this.recent.length > 10000) this.recent.splice(0, this.recent.length - 10000);
  }
  alerts() {
    this.prune();
    const failures = this.recent.filter(r => r.failed).length;
    return [{ name: 'high_error_rate', firing: this.recent.length >= 20 && failures / this.recent.length > 0.1,
      requests: this.recent.length, failures, windowSeconds: 300 }];
  }
  render() {
    const lines = ['# TYPE agentlb_active_requests gauge', `agentlb_active_requests ${this.active}`, '# TYPE agentlb_responses_total counter'];
    for (const [status, count] of this.responses) lines.push(`agentlb_responses_total{status="${status}"} ${count}`);
    for (const [name, hist] of [['request_duration_seconds', this.duration], ['upstream_headers_seconds', this.headers], ['time_to_first_token_seconds', this.firstToken]]) {
      const metric = `agentlb_${name}`;
      lines.push(`# TYPE ${metric} histogram`);
      buckets.forEach((boundary, i) => lines.push(`${metric}_bucket{le="${boundary}"} ${hist.buckets[i]}`));
      lines.push(`${metric}_bucket{le="+Inf"} ${hist.count}`, `${metric}_count ${hist.count}`, `${metric}_sum ${hist.sum}`);
    }
    lines.push('# TYPE agentlb_alert gauge');
    for (const alert of this.alerts()) lines.push(`agentlb_alert{name="${alert.name}"} ${Number(alert.firing)}`);
    return lines.join('\n') + '\n';
  }
}
function observe(hist, seconds) {
  hist.count++; hist.sum += seconds;
  buckets.forEach((boundary, i) => { if (seconds <= boundary) hist.buckets[i]++; });
}
