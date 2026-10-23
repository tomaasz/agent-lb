// Idle deadline for the RESPONSE BODY, complementing the headers timeout in
// upstream-fetch.js. The headers guard only covers time-to-first-byte; once
// headers arrive it is disarmed, so a network drop AFTER the stream starts would
// otherwise hang the read forever (the SSE completion just goes silent mid-way).
// This watchdog resets on every chunk, so a long but healthy stream is never
// cut — it fires only when the socket produces nothing for the whole window,
// converting a mid-stream hang into a fast failure that evicts the dead socket
// (reader.cancel destroys the underlying connection on both the direct-fetch and
// the sx-tunnel path, since both hand back a web ReadableStream). Override with
// AGENT_LB_UPSTREAM_BODY_TIMEOUT_MS.
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 120_000;

export function resolveBodyIdleTimeout() {
  const env = Number(process.env.AGENT_LB_UPSTREAM_BODY_TIMEOUT_MS);
  return env > 0 ? env : DEFAULT_BODY_IDLE_TIMEOUT_MS;
}

// Race a single reader.read() against an inactivity deadline. Resolves to the
// read result, or rejects with a transient AGENTLB_BODY_TIMEOUT if no chunk
// arrives within `ms`. The pending read is abandoned on timeout; the caller
// cancels the reader (evicting the socket) in its finally block.
export function readWithIdleTimeout(reader, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`upstream stream idle for ${ms}ms`);
      err.code = 'AGENTLB_BODY_TIMEOUT';
      reject(err);
    }, ms);
    timer.unref?.();
  });
  const read = reader.read();
  // If the timeout wins the race, `read` is abandoned; swallow any later
  // rejection so it can't surface as an unhandledRejection.
  read.catch(() => {});
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

export async function* idleBody(body, timeoutMs = resolveBodyIdleTimeout()) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, timeoutMs);
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function collectIdleBody(body) {
  const chunks = [];
  for await (const chunk of idleBody(body)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}


// Events that say nothing about whether the response will succeed.
const NEUTRAL_SSE_EVENTS = new Set(['response.created', 'response.in_progress']);

function hasDecisiveEvent(text) {
  const blocks = text.split('\n\n');
  blocks.pop(); // the last block may be incomplete
  return blocks.some((block) => {
    const m = /^data:\s*(\{.*\})\s*$/m.exec(block);
    if (!m) return false;
    try { return !NEUTRAL_SSE_EVENTS.has(JSON.parse(m[1]).type); } catch { return false; }
  });
}

/**
 * Read the head of an SSE body until the first event that is not a neutral
 * start-up one (or `maxBytes`, or `waitMs`), WITHOUT consuming it: the returned
 * `body` replays what was read and then the rest. This lets the caller look at
 * how a 200 stream begins before committing response headers to the client.
 */
export async function peekSseHead(body, { maxBytes = 16384, waitMs = 3000 } = {}) {
  const reader = body.getReader();
  const chunks = [];
  let pending = null;
  let finished = false;
  let bytes = 0;
  const deadline = Date.now() + waitMs;
  for (;;) {
    pending ??= reader.read();
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), left); });
    const settled = pending.then((r) => r, () => 'error');
    const outcome = await Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
    if (outcome === 'timeout' || outcome === 'error') break;
    pending = null;
    if (outcome.done) { finished = true; break; }
    chunks.push(Buffer.from(outcome.value));
    bytes += outcome.value.length;
    if (bytes >= maxBytes || hasDecisiveEvent(Buffer.concat(chunks).toString('utf8'))) break;
  }
  const head = Buffer.concat(chunks).toString('utf8');
  let i = 0;
  const replay = new ReadableStream({
    async pull(controller) {
      if (i < chunks.length) { controller.enqueue(chunks[i++]); return; }
      if (finished) { controller.close(); return; }
      const read = pending ?? reader.read();
      pending = null;
      try {
        const r = await read;
        if (r.done) controller.close(); else controller.enqueue(r.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { head, body: replay };
}
