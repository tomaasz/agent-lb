// Worker-local authentication/overload must not be confused with Google quota.
export function classifyAgyFailure(status, text, retryAfter) {
  let error;
  try { error = JSON.parse(String(text).replace(/^data:\s*/, '').trim())?.error; } catch { /* not an error envelope */ }
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  const quota = code === 'insufficient_quota' || message.startsWith('AGY quota exhausted');
  const googleFailure = message.startsWith('AGY run failed:');
  let reason;
  if (quota) reason = 'quota';
  else if (code === 'upstream_authentication_error' || (googleFailure && /invalid_grant|authentication required|not logged into Antigravity/i.test(message))) reason = 'auth_required';
  else if (code === 'upstream_access_denied') reason = 'access_denied';
  else if (status === 401 || status === 403) reason = 'bridge_auth';
  else if (status === 429 || status === 503 || code === 'busy') reason = 'overloaded';
  else if (status === 504 || code === 'timeout') reason = 'timeout';
  else if (status >= 500) reason = 'transport';
  else if (status >= 400 || error) reason = 'request_error';
  if (!reason) return null;
  const seconds = Number(retryAfter);
  const date = Date.parse(retryAfter);
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : Number.isFinite(date) ? (date - Date.now()) / 1000 : 0;
  return { reason, status: reason === 'quota' ? 429 : reason === 'request_error' ? 400 : reason === 'timeout' ? 504 : 503,
    retrySeconds: Math.min(86400, Math.max(1, Math.ceil(wait || (quota ? 3600 : 30)))),
    // Only the established quota message crosses into the reset parser, never diagnostics.
    quotaMessage: quota ? message : null };
}
