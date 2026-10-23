// Read-only Google diagnostics. Never return raw upstream responses or credentials.
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://daily-cloudcode-pa.googleapis.com/v1internal:';
const PRODUCTION_API = 'https://cloudcode-pa.googleapis.com/v1internal:';
const MAX_BYTES = 4 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : null;
const displayName = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f-\x9f]/.test(value) ? value : null;
const fraction = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const timestamp = value => {
  if (typeof value !== 'string' || value.length > 64 || !/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < Date.UTC(2201, 0) ? parsed : null;
};

export function safeAgyLink(value, appeal = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const hosts = ['accounts.google.com', 'myaccount.google.com', ...(appeal ? ['support.google.com'] : [])];
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') ? value : null;
  } catch { return null; }
}

function planOf(data) {
  const paid = object(data.paidTier) ? data.paidTier : {};
  const current = object(data.currentTier) ? data.currentTier : {};
  const paidTierId = identifier(paid.id);
  const currentTierId = identifier(current.id);
  const tierId = paidTierId || currentTierId;
  let projectId = object(data.cloudaicompanionProject) ? data.cloudaicompanionProject.id : data.cloudaicompanionProject;
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) || projectId === 'aicode-consumers') projectId = null;
  let usesGcpTos = typeof current.usesGcpTos === 'boolean' ? current.usesGcpTos : null;
  if (usesGcpTos === null && Array.isArray(data.allowedTiers)) {
    const tier = data.allowedTiers.slice(0, 100).find(t => object(t) && t.isDefault === true && typeof t.usesGcpTos === 'boolean');
    if (tier) usesGcpTos = tier.usesGcpTos;
  }
  if (!tierId && !projectId && usesGcpTos === null) return null;
  const credits = [];
  const amount = value => typeof value === 'string' && /^[0-9]{1,24}(?:\.[0-9]{1,12})?$/.test(value);
  for (const entry of Array.isArray(paid.availableCredits) ? paid.availableCredits.slice(0, 100) : []) {
    if (object(entry) && identifier(entry.creditType) && amount(entry.creditAmount)) {
      credits.push({ type: entry.creditType, amount: entry.creditAmount, minimum: amount(entry.minimumCreditAmountForUsage) ? entry.minimumCreditAmountForUsage : null });
    }
  }
  return { paidTierId, currentTierId, tierId, label: ({ 'free-tier': 'free', 'g1-pro-tier': 'pro', 'g1-ultra-tier': 'ultra' })[tierId] || 'unknown', projectId, usesGcpTos, credits };
}

const quotaItem = (id, data) => ({ id, displayName: displayName(data.displayName), remainingFraction: fraction(data.remainingFraction), resetAt: timestamp(data.resetTime) });
function modelsOf(data) {
  return Object.entries(data.models).filter(([id, model]) => identifier(id) && /gemini|claude/i.test(id) && object(model)).slice(0, 100)
    .map(([id, model]) => quotaItem(id, { ...(object(model.quotaInfo) ? model.quotaInfo : {}), displayName: model.displayName }));
}
function summaryOf(data) {
  if (!Array.isArray(data.groups) || data.groups.length > 100) return null;
  const normalized = [];
  for (const group of data.groups) {
    if (!object(group) || !Array.isArray(group.buckets)) return null;
    for (const bucket of group.buckets) {
      if (!object(bucket) || !identifier(bucket.bucketId) || fraction(bucket.remainingFraction) === null || normalized.length >= 100) return null;
      normalized.push(quotaItem(bucket.bucketId, bucket));
    }
  }
  return normalized;
}
function failure(status, data) {
  const error = object(data.error) ? data.error : {};
  const reasons = new Set();
  let validationUrl = null;
  let appealUrl = null;
  for (const detail of Array.isArray(error.details) ? error.details.slice(0, 100) : []) {
    if (!object(detail)) continue;
    reasons.add(detail.reason);
    if (object(detail.metadata)) {
      validationUrl ||= safeAgyLink(detail.metadata.validation_url);
      appealUrl ||= safeAgyLink(detail.metadata.appeal_url, true);
    }
  }
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (status === 429 || status >= 500) return { status: 'error', reason: status === 429 ? 'rate_limited' : 'upstream_error' };
  if (reasons.has('TOS_VIOLATION')) return { status: 'tos_violation', reason: 'tos_violation', appealUrl };
  if (reasons.has('VALIDATION_REQUIRED') || validationUrl || message.includes('verify your account')) return { status: 'validation_required', reason: 'validation_required', validationUrl };
  if (reasons.has('SUBSCRIPTION_REQUIRED') || message.includes('subscription required')) return { status: 'subscription_required', reason: 'subscription_required' };
  if (status === 401) return { status: 'auth_invalid', reason: 'unauthorized' };
  if (status === 403) return { status: 'forbidden', reason: 'access_forbidden' };
  return { status: 'error', reason: 'upstream_error' };
}

/** All times are epoch milliseconds, matching the AGY account store. */
export async function probeAgyAccount(rawToken, {
  fetchImpl = globalThis.fetch, now = () => Date.now(),
  clientId = process.env.AGY_GOOGLE_CLIENT_ID || CLIENT_ID,
  clientSecret = process.env.AGY_GOOGLE_CLIENT_SECRET || '',
} = {}) {
  const checks = {};
  const telemetry = {};
  let retryAt = null;
  let stage = null;
  const result = (state, httpStatus = null) => ({ validationUrl: null, appealUrl: null, ...state, checkedAt: now(), httpStatus, retryAt, checks, telemetry });
  const record = (name, state, httpStatus) => { checks[name] = { status: state.status, reason: state.reason, httpStatus }; };
  const observe = (name, data) => { telemetry[name] = { observedAt: now(), data }; };
  const post = async (url, payload, accessToken = null) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      // The signal remains active until the bounded body has been read.
      const signal = AbortSignal.timeout(15_000);
      const headers = { Accept: 'application/json', 'User-Agent': 'antigravity/1.20.5 linux/amd64 google-api-nodejs-client/10.3.0', 'Content-Type': accessToken ? 'application/json' : 'application/x-www-form-urlencoded' };
      if (accessToken) { headers.Authorization = `Bearer ${accessToken}`; headers['x-goog-api-client'] = 'gl-node/22.21.1'; }
      const response = await fetchImpl(url, { method: 'POST', headers, body: accessToken ? JSON.stringify(payload) : new URLSearchParams(payload).toString(), redirect: 'error', signal });
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('response_too_large');
            chunks.push(Buffer.from(value));
          }
          text = Buffer.concat(chunks).toString('utf8');
        } finally { await reader.cancel().catch(() => {}); }
      } else {
        text = await response.text();
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('response_too_large');
      }
      let data;
      try { data = JSON.parse(text); } catch { if (response.status >= 200 && response.status < 300) throw new Error('invalid_response'); data = {}; }
      if (!object(data)) { if (response.status >= 200 && response.status < 300) throw new Error('invalid_response'); data = {}; }
      if (response.status === 429 || response.status >= 500) {
        const header = response.headers?.get('retry-after');
        let delay = header === null || header === undefined ? 500 : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now();
        if (!Number.isFinite(delay)) delay = 500;
        delay = Math.max(0, delay);
        if (delay > 2000 || attempt === 1) {
          retryAt = Math.max(retryAt || 0, now() + Math.min(delay, 86400_000));
        } else { await new Promise(resolve => setTimeout(resolve, delay)); continue; }
      }
      return { status: response.status, data };
    }
  };
  const token = object(rawToken?.token) ? rawToken.token : rawToken;
  if (!object(token)) return result({ status: 'auth_invalid', reason: 'missing_refresh_token' });
  try {
    let accessToken;
    const expiry = timestamp(token.expiry) ?? (Number.isFinite(token.expiry_date) ? token.expiry_date : null);
    if (!clientSecret && typeof token.access_token === 'string' && token.access_token && expiry > now() + 30_000) {
      accessToken = token.access_token;
      record('oauth', { status: 'available', reason: 'cached_access_token' }, null);
    } else {
      if (!clientSecret) return result({ status: 'configuration_error', reason: 'missing_client_secret' });
      if (typeof token.refresh_token !== 'string' || !token.refresh_token.trim()) return result({ status: 'auth_invalid', reason: 'missing_refresh_token' });
      stage = 'oauth';
      const response = await post(TOKEN_URL, { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: token.refresh_token });
      const { status, data } = response;
      if (status < 200 || status >= 300) {
        const state = { status: 'error', reason: 'token_refresh_failed' };
        if (data.error === 'invalid_grant' && status < 500 && status !== 429) Object.assign(state, { status: 'auth_invalid', reason: 'invalid_grant' });
        if (['invalid_client', 'unauthorized_client'].includes(data.error) && status < 500 && status !== 429) Object.assign(state, { status: 'configuration_error', reason: 'invalid_client' });
        record(stage, state, status);
        return result(state, status);
      }
      if (typeof data.access_token !== 'string' || !data.access_token) return result({ status: 'error', reason: 'invalid_token_response' }, status);
      accessToken = data.access_token;
      record(stage, { status: 'available', reason: 'token_refreshed' }, status);
    }
    stage = 'metadata';
    let response = await post(API + 'loadCodeAssist', { mode: 'FULL_ELIGIBILITY_CHECK', metadata: { ideName: 'antigravity', ideType: 'ANTIGRAVITY', ideVersion: '1.20.5', platform: 'LINUX_AMD64' } }, accessToken);
    let restriction = null;
    if (response.status < 200 || response.status >= 300) {
      const state = failure(response.status, response.data);
      record(stage, state, response.status);
      if (response.status !== 403) return result(state, response.status);
      if (['validation_required', 'subscription_required', 'tos_violation'].includes(state.status)) restriction = { state, httpStatus: response.status };
    } else {
      record(stage, { status: 'available', reason: 'metadata_available' }, response.status);
      const plan = planOf(response.data);
      if (plan) observe('plan', plan);
    }
    const plan = telemetry.plan?.data;
    const payload = plan?.projectId ? { project: plan.projectId } : {};
    const api = plan?.projectId && plan.usesGcpTos === true ? PRODUCTION_API : API;
    stage = 'models';
    response = await post(api + 'fetchAvailableModels', payload, accessToken);
    if (response.status < 200 || response.status >= 300) {
      const state = failure(response.status, response.data);
      record(stage, state, response.status);
      return result(state, response.status);
    }
    if (!object(response.data.models) || !Object.keys(response.data.models).length) {
      record(stage, { status: 'error', reason: 'invalid_models_response' }, response.status);
      return result({ status: 'error', reason: 'invalid_models_response' }, response.status);
    }
    const modelsStatus = response.status;
    record(stage, { status: 'available', reason: 'access_available' }, modelsStatus);
    observe('models', modelsOf(response.data));
    stage = 'quotaSummary';
    try {
      response = await post(api + 'retrieveUserQuotaSummary', payload, accessToken);
      if (response.status >= 200 && response.status < 300) {
        const summary = summaryOf(response.data);
        if (summary === null) record(stage, { status: 'error', reason: 'invalid_quota_summary_response' }, response.status);
        else { record(stage, { status: 'available', reason: 'quota_summary_available' }, response.status); observe(stage, summary); }
      } else {
        const state = failure(response.status, response.data);
        record(stage, state, response.status);
        if (['validation_required', 'subscription_required', 'tos_violation'].includes(state.status) && (!restriction || state.status === 'tos_violation')) restriction = { state, httpStatus: response.status };
      }
    } catch { record(stage, { status: 'error', reason: 'network_or_response_error' }, null); }
    return restriction ? result(restriction.state, restriction.httpStatus) : result({ status: 'available', reason: 'access_available' }, modelsStatus);
  } catch {
    if (stage) record(stage, { status: 'error', reason: 'network_or_response_error' }, null);
    return result({ status: 'error', reason: 'network_or_response_error' });
  }
}
