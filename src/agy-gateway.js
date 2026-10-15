import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

const QUOTA_PREFIX = 'AGY quota exhausted';
const MAX_ERROR_BYTES = 1024 * 1024;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

function sendError(res, status, error) {
  if (res.headersSent) {
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

export function parseQuotaResetSeconds(message, retryAfter) {
  const match = String(message || '').match(/Resets in\s+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (match) return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  const retry = Number.parseInt(String(retryAfter || ''), 10);
  return Number.isFinite(retry) && retry > 0 ? retry : 3600;
}

function quotaMessage(text) {
  try {
    const parsed = JSON.parse(String(text).replace(/^data:\s*/, '').trim());
    const message = parsed?.error?.message;
    return typeof message === 'string' && message.startsWith(QUOTA_PREFIX) ? message : null;
  } catch { return null; }
}

function usageFrom(text) {
  try {
    const parsed = JSON.parse(String(text).replace(/^data:\s*/, '').trim());
    const u = parsed?.usage;
    if (!u) return null;
    return {
      inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
      outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
    };
  } catch { return null; }
}

function proxyHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(key) && value !== undefined) out[key] = value;
  }
  return out;
}

function attempt(req, res, lease, body, stream, onUsage, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      const err = new Error('AGY worker timed out');
      err.code = 'AGY_ATTEMPT_TIMEOUT';
      fail(err);
      upstream.destroy(err);
    }, timeoutMs);
    timeout.unref?.();
    let contentForwarded = false;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    let buffered = [];
    let bufferedBytes = 0;
    const finish = value => { if (!settled) { settled = true; cleanup(); resolve(value); } };
    const fail = err => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const upstream = http.request({ hostname: '127.0.0.1', port: lease.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json', 'content-length': body.length } });
    const abort = () => {
      const err = new Error('client disconnected');
      fail(err);
      upstream.destroy(err);
    };
    const cleanup = () => { clearTimeout(timeout); req.off?.('aborted', abort); req.off?.('close', onClose); res.off?.('close', abort); };
    const onClose = () => { if (req.destroyed) abort(); };
    req.once?.('aborted', abort); req.once?.('close', onClose); res.once?.('close', abort);
    upstream.once('error', fail);
    upstream.once('response', upstreamRes => {
      upstreamRes.once('error', fail);
      upstreamRes.once('close', () => {
        if (!upstreamRes.complete) fail(new Error('AGY worker response interrupted'));
      });
      if (upstreamRes.statusCode === 429) {
        upstreamRes.on('data', chunk => { if (bufferedBytes < MAX_ERROR_BYTES) { buffered.push(chunk); bufferedBytes += chunk.length; } });
        upstreamRes.on('end', () => { const text = Buffer.concat(buffered).toString(); finish({ quota: quotaMessage(text) || QUOTA_PREFIX, retryAfter: upstreamRes.headers['retry-after'] }); });
        return;
      }
      if (!stream) {
        upstreamRes.on('data', chunk => buffered.push(chunk));
        upstreamRes.on('end', () => {
          const data = Buffer.concat(buffered); const text = data.toString(); const quota = quotaMessage(text);
          if (quota) return finish({ quota, retryAfter: upstreamRes.headers['retry-after'] });
          if (!res.headersSent) res.writeHead(upstreamRes.statusCode || 200, proxyHeaders(upstreamRes.headers));
          res.end(data); finish({ done: true, usage: usageFrom(text) });
        });
        return;
      }
      const ensureHeaders = () => { if (!res.headersSent) res.writeHead(upstreamRes.statusCode || 200, proxyHeaders(upstreamRes.headers)); };
      const processEvent = event => {
        const isComment = event.split(/\r?\n/).every(line => !line || line.startsWith(':'));
        const quota = quotaMessage(event);
        if (quota && !contentForwarded) return { quota, retryAfter: upstreamRes.headers['retry-after'] };
        if (!isComment) contentForwarded = true;
        const usage = usageFrom(event); if (usage) onUsage(usage);
        ensureHeaders(); res.write(event); return null;
      };
      upstreamRes.on('data', chunk => {
        pending += decoder.write(chunk);
        for (;;) {
          const m = pending.match(/\r?\n\r?\n/); if (!m) break;
          const end = m.index + m[0].length; const event = pending.slice(0, end); pending = pending.slice(end);
          const result = processEvent(event); if (result) { finish(result); upstreamRes.destroy(); return; }
        }
      });
      upstreamRes.on('end', () => {
        if (settled) return;
        pending += decoder.end();
        if (pending) { const result = processEvent(pending); if (result) return finish(result); }
        if (!res.headersSent) ensureHeaders(); res.end(); finish({ done: true });
      });
    });
    upstream.end(body);
  });
}

export async function handleAgyCompletion(req, res, {
  body, model, store, pool, catalog, usageRecorder, hooks = {},
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
}) {
  let clientGone = false;
  const onClientGone = () => { clientGone = true; };
  res.once?.('close', onClientGone);
  try {
    await catalog.list?.();
    const resolved = catalog.resolveAlias(model);
    if (!resolved) { sendError(res, 404, { type: 'invalid_request_error', code: 'model_not_found', message: `Model not found: ${model}` }); return; }
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { sendError(res, 400, { type: 'invalid_request_error', message: 'Invalid JSON body' }); return; }
    parsed.model = resolved;
    const outgoing = Buffer.from(JSON.stringify(parsed));
    const excluded = new Set();
    for (;;) {
      const account = store.pick(excluded);
      if (!account) { sendError(res, 429, { type: 'rate_limit_error', code: 'insufficient_quota', message: 'Brak konta AGY z wolnym limitem' }); return; }
      excluded.add(account.id);
      let lease;
      let finalUsage = null;
      try {
        lease = await pool.acquire(account.id);
        if (clientGone) return;
        const result = await attempt(req, res, lease, outgoing, parsed.stream !== false, usage => {
          finalUsage = usage;
          usageRecorder?.onUsage?.(usage.inputTokens, usage.outputTokens);
        }, attemptTimeoutMs);
        if (result.quota) {
          store.markQuota(account.id, parseQuotaResetSeconds(result.quota, result.retryAfter), result.quota);
          hooks.onAgyQuota?.(account.id);
          continue;
        }
        finalUsage ||= result.usage;
        store.recordRequest(account.id, finalUsage || { inputTokens: 0, outputTokens: 0 });
        if (finalUsage && parsed.stream === false) usageRecorder?.onUsage?.(finalUsage.inputTokens, finalUsage.outputTokens);
        return;
      } catch (err) {
        if (clientGone) return;
        const timedOut = err?.code === 'AGY_ATTEMPT_TIMEOUT';
        sendError(res, timedOut ? 504 : 502, {
          type: 'api_error',
          message: timedOut ? 'AGY worker timed out' : 'agybridge worker failed to start',
        });
        return;
      } finally { lease?.release(); }
    }
  } finally {
    res.off?.('close', onClientGone);
  }
}

const TEST_PROMPT = 'Odpowiedz jednym słowem: OK';
const TEST_TIMEOUT_MS = 120_000;
const TEST_MAX_BYTES = 1024 * 1024;

function cleanError(message, secret) {
  let text = String(message || 'error');
  if (secret) text = text.split(secret).join('***');
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** Pick the low-effort model for the Test button; the first one when there is none. */
export function pickAgyTestModel(models) {
  const ids = (models || []).map(m => m.id);
  return ids.find(id => id.endsWith('-low')) ?? ids[0] ?? null;
}

/**
 * One tiny completion through the worker of exactly this account. It never
 * falls back to another account and never changes order, pin or quota state.
 * The worker token only goes out in the Authorization header to 127.0.0.1.
 */
export async function testAgyAccount({ store, pool, catalog, id, timeoutMs = TEST_TIMEOUT_MS }) {
  const account = store.list().find(a => a.id === id);
  if (!account) return { ok: false, error: 'no such AGY account' };
  if (!account.enabled) return { ok: false, error: 'konto wyłączone (disabled)' };
  if (account.quotaUntil) return { ok: false, error: `limit wyczerpany (quota spent)${account.quotaMessage ? `: ${cleanError(account.quotaMessage)}` : ''}` };
  let model;
  try { model = pickAgyTestModel(await catalog.list()); } catch (err) { return { ok: false, error: cleanError(`model list failed: ${err.message}`) }; }
  if (!model) return { ok: false, error: 'brak modeli Gemini w katalogu (no models)' };

  const started = Date.now();
  let lease;
  try {
    lease = await acquireWithin(pool, id, timeoutMs);
    const body = Buffer.from(JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: TEST_PROMPT }] }));
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: lease.port, path: '/v1/chat/completions', method: 'POST',
        headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json', 'content-length': body.length },
      });
      const timer = setTimeout(() => req.destroy(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      timer.unref?.();
      req.once('error', err => { clearTimeout(timer); reject(err); });
      req.once('response', upstream => {
        const chunks = []; let size = 0;
        upstream.on('data', chunk => { if (size < TEST_MAX_BYTES) { chunks.push(chunk); size += chunk.length; } });
        upstream.once('error', err => { clearTimeout(timer); reject(err); });
        upstream.once('end', () => { clearTimeout(timer); resolve({ status: upstream.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.end(body);
    });
    const outcome = inspectTestResponse(result);
    if (!outcome.ok) return { ok: false, error: cleanError(outcome.error, lease.token), ms: Date.now() - started };
    return { ok: true, ms: Date.now() - started, model };
  } catch (err) {
    return { ok: false, error: cleanError(err.message, lease?.token), ms: Date.now() - started };
  } finally { lease?.release(); }
}

/** pool.acquire bounded by the test timeout; a lease that arrives late is released at once. */
function acquireWithin(pool, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s waiting for the AGY worker`)); }, timeoutMs);
    timer.unref?.();
    Promise.resolve().then(() => pool.acquire(id)).then(
      lease => { clearTimeout(timer); if (timedOut) lease?.release?.(); else resolve(lease); },
      err => { clearTimeout(timer); if (!timedOut) reject(err); },
    );
  });
}

function inspectTestResponse({ status, text }) {
  const payloads = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) payloads.push(trimmed);
  else for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (m && m[1] && m[1] !== '[DONE]') payloads.push(m[1]);
  }
  let sawCompletion = false;
  let firstError = null;
  for (const payload of payloads) {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    if (parsed?.error) { firstError ||= typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || 'error'); continue; }
    if (Array.isArray(parsed?.choices)) sawCompletion = true;
  }
  if (firstError) return { ok: false, error: firstError };
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` };
  if (!sawCompletion) return { ok: false, error: 'pusta odpowiedź (empty response)' };
  return { ok: true };
}
