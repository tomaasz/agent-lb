// Codex (OpenAI) credentials.
//
// The Codex CLI keeps its ChatGPT login in ~/.codex/auth.json, shaped much
// like Claude Code's own credentials file: an access/refresh pair plus the id
// of the account the token is scoped to. That last field is the part with no
// Anthropic analogue in the body — OpenAI carries it in the ChatGPT-Account-Id
// header instead, which is why the Codex path needs no request-body rewrite.
//
// Token refresh is a plain OAuth refresh_token grant against auth.openai.com
// using the Codex CLI's own client id, so a pooled account stays live the same
// way an Anthropic one does.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import http from 'node:http';
import { proxyFetch } from './upstream-fetch.js';
import { tokenPairFromResponse } from './oauth.js';


export const DEFAULT_CODEX_CREDENTIALS_PATH = '~/.codex/auth.json';

const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
// Confirmed by a live authorization attempt: adding `api` is rejected with
// invalid_scope ("The OAuth 2.0 Client is not allowed to request scope 'api'").
// The token this client issues is a ChatGPT credential, not an API-platform
// one, which is the same reason the upstream is chatgpt.com.
const SCOPES = 'openid profile email offline_access';
// OpenAI registered a single fixed redirect for this client, so the callback
// server cannot take an ephemeral port the way the Anthropic flow does — the
// authorization request is rejected unless the URI matches exactly.
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
// The Codex CLI's OAuth client. It is the `aud` claim of the id_token the CLI
// itself stores, i.e. this is the client the user already consented to — we
// refresh their existing grant rather than minting a new one.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Decode a JWT payload without verifying it. Claims are used for labelling only. */
function decodeJwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a Codex login from disk.
 *
 * Returns the credential fields the account manager needs, plus `email` and
 * `planType` when the id_token carries them — those are cosmetic (they name
 * the account in status output) and their absence is never fatal.
 */
export async function importCodexCredentials(filePath = DEFAULT_CODEX_CREDENTIALS_PATH, { home = homedir() } = {}) {
  const resolvedPath = filePath.replace(/^~/, home);
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));
  const tokens = raw.tokens || {};

  const claims = decodeJwtClaims(tokens.id_token) || {};
  const auth = claims['https://api.openai.com/auth'] || {};

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    // Scopes the token to one ChatGPT account. Prefer the id_token claim and
    // fall back to the stored value: they agree in practice, but the claim is
    // the one the server itself issued.
    accountId: auth.chatgpt_account_id || tokens.account_id,
    email: claims.email,
    planType: auth.chatgpt_plan_type,
  };
}

/**
 * Exchange a Codex refresh token for a fresh access token.
 *
 * Mirrors the Anthropic refresh contract (`{ accessToken, refreshToken,
 * expiresAt }`) so the account manager can treat both the same. A rotated
 * refresh token is returned when the server issues one, and the old one is
 * kept when it does not.
 */
export async function refreshCodexToken(refreshToken, endpoint = TOKEN_ENDPOINT) {
  const timeoutMs = Number(process.env.AGENT_LB_REFRESH_TIMEOUT_MS) || 30_000;
  const res = await proxyFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Codex token refresh failed (${res.status}): ${text}`);
    // Surfaced so callers can tell a dead refresh token (re-login needed) from
    // a transient server error, exactly as the Anthropic path does.
    err.status = res.status;
    throw err;
  }

  // Same checks as the Anthropic path: a 200 without an access token is an
  // error, not a `Bearer undefined` waiting to happen.
  return tokenPairFromResponse(await res.json(), { previousRefreshToken: refreshToken });
}

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export function parseCodexWhamUsage(data) {
  if (!data) return null;
  const out = {};
  if (data.plan_type) out.planType = data.plan_type;
  const rl = data.rate_limit || {};
  const pw = rl.primary_window;
  const sw = rl.secondary_window;
  if (pw && typeof pw.used_percent === 'number') {
    out.fiveHour = {
      utilization: pw.used_percent / 100,
      resetAt: pw.reset_at ? pw.reset_at * 1000 : null,
    };
  }
  if (sw && typeof sw.used_percent === 'number') {
    out.sevenDay = {
      utilization: sw.used_percent / 100,
      resetAt: sw.reset_at ? sw.reset_at * 1000 : null,
    };
  }
  const credits = data.credits || {};
  const balance = credits.balance || '0';
  const hasCredits = Boolean(credits.has_credits && balance !== '0');
  const plan = data.plan_type ? data.plan_type.toUpperCase() : 'PLUS';
  out.backend = {
    label: 'Saldo',
    text: hasCredits
      ? `${balance} kredytów`
      : `Abonament ChatGPT ${plan} (nielimitowany kwotowo)`,
  };
  return out;
}

export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
export const CODEX_RESET_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';

export function parseCodexResetCredits(data) {
  if (!data) return { available: 0, nearestExpiresAt: null, credits: [] };
  const available = typeof data.available_count === 'number' ? data.available_count : (data.credits?.length || 0);
  const credits = Array.isArray(data.credits) ? data.credits : [];
  let nearestExpiresAt = null;
  for (const c of credits) {
    if (c.status === 'available' && c.expires_at) {
      const ts = typeof c.expires_at === 'string' ? new Date(c.expires_at).getTime() : (c.expires_at * 1000);
      if (!Number.isNaN(ts) && (nearestExpiresAt == null || ts < nearestExpiresAt)) {
        nearestExpiresAt = ts;
      }
    }
  }
  return { available, nearestExpiresAt, credits };
}

/**
 * Fetch available rate limit reset credits for a Codex account.
 */
export async function fetchCodexResetCredits(account) {
  const timeoutMs = Number(process.env.AGENT_LB_PROBE_TIMEOUT_MS) || 10_000;
  const token = account.credential || account.accessToken;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json',
  };
  if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
  try {
    const res = await proxyFetch(CODEX_RESET_CREDITS_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { status: 401, error: 'Unauthorized' };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: res.status, error: `Codex reset credits fetch failed (${res.status}): ${text}` };
    }
    const data = await res.json();
    return parseCodexResetCredits(data);
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Consume / redeem one available rate limit reset credit on OpenAI ChatGPT.
 */
export async function consumeCodexResetCredit(account, creditId = null) {
  const timeoutMs = Number(process.env.AGENT_LB_PROBE_TIMEOUT_MS) || 15_000;
  const token = account.credential || account.accessToken;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (account.accountId) headers['chatgpt-account-id'] = account.accountId;

  let targetCreditId = creditId;
  if (!targetCreditId) {
    const listRes = await fetchCodexResetCredits(account);
    const available = listRes?.credits?.find(c => c.status === 'available');
    if (!available) {
      return { ok: false, error: 'Brak dostępnych kredytów resetu dla tego konta.' };
    }
    targetCreditId = available.id;
  }

  const redeemRequestId = randomUUID();
  try {
    const res = await proxyFetch(CODEX_RESET_CONSUME_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        credit_id: targetCreditId,
        redeem_request_id: redeemRequestId,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `Konsumpcja kredytu resetu nie powiodła się (${res.status}): ${text}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Read account usage and rate limits from ChatGPT backend.
 */
export async function fetchCodexUsage(account) {
  const timeoutMs = Number(process.env.AGENT_LB_PROBE_TIMEOUT_MS) || 10_000;
  const token = account.credential || account.accessToken;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json',
  };
  if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
  try {
    const res = await proxyFetch(CODEX_USAGE_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { status: 401, error: 'Unauthorized' };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: res.status, error: `Codex usage fetch failed (${res.status}): ${text}` };
    }
    const data = await res.json();
    const usage = parseCodexWhamUsage(data);
    try {
      const rc = await fetchCodexResetCredits(account);
      if (rc && !rc.error) {
        usage.resetCredits = rc;
      }
    } catch {
      // non-fatal
    }
    return usage;
  } catch (err) {
    return { error: err.message };
  }
}

// ── Browser login ───────────────────────────────────────────────────────────

/**
 * Build the authorization URL for a Codex login.
 *
 * Pure, so the parameters can be asserted without opening a browser. PKCE is
 * mandatory here: the client is public, so the code exchange is bound to a
 * verifier this process holds rather than to a client secret.
 */
export function buildCodexAuthUrl({ state, codeChallenge, redirectUri = REDIRECT_URI }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // Codex asks for organization claims in the id_token; the account id we need
  // for ChatGPT-Account-Id rides in that same claim set.
  url.searchParams.set('id_token_add_organizations', 'true');
  // Sent by the Codex CLI itself alongside the above. Kept so this request
  // looks like the client it is impersonating rather than a novel variant.
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

/** Exchange an authorization code for tokens, completing the PKCE handshake. */
export async function exchangeCodexCode({ code, codeVerifier, redirectUri = REDIRECT_URI, endpoint = TOKEN_ENDPOINT, form = false }) {
  const fields = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  };
  const res = await proxyFetch(endpoint, {
    method: 'POST',
    // The Codex CLI posts this grant form-encoded (RFC 6749 §4.1.3); the
    // device flow uses that encoding to match it exactly.
    headers: form
      ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }
      : { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: form ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
  });
  if (!res.ok) {
    throw new Error(`Codex token exchange failed (${res.status}): ${await res.text()}`);
  }
  return credentialsFromTokenResponse(await res.json());
}

/**
 * Turn a token response into the same credential shape `importCodexCredentials`
 * returns, so login and import are interchangeable to every caller.
 */
export function credentialsFromTokenResponse(data) {
  const claims = decodeJwtClaims(data.id_token) || {};
  const auth = claims['https://api.openai.com/auth'] || {};
  return {
    ...tokenPairFromResponse(data),
    accountId: auth.chatgpt_account_id,
    email: claims.email,
    planType: auth.chatgpt_plan_type,
  };
}

function openBrowser(url) {
  // `start` takes its first quoted argument as the window title, so the URL
  // needs an empty title in front of it or the browser never opens.
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
      : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}

/**
 * Run a browser OAuth login against OpenAI and return the new credentials.
 *
 * The listener must bind port 1455 because that is the only redirect OpenAI
 * accepts for this client. If the Codex CLI is mid-login it already holds that
 * port, which is why the bind failure is reported as such rather than as a
 * generic error.
 */
/**
 * The request handler for the login callback, settling `resolve`/`reject` with
 * the authorization code or the failure.
 *
 * The state is checked FIRST, and a request without the expected state gets a
 * 400 and settles nothing: port 1455 is open while the user is in the browser,
 * and a stray GET — a drive-by page probing localhost, a scanner, a stale tab —
 * used to abort the whole login by arriving with `?error=` or with no state.
 * Exported for tests, which run it on an ephemeral port instead of 1455.
 */
export function codexCallbackHandler(expectedState, { resolve, reject }) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }

    const returnedState = url.searchParams.get('state');
    if (!returnedState || returnedState !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Invalid request</h2><p>State mismatch. You can close this tab.</p></body></html>');
      return;
    }

    const err = url.searchParams.get('error');
    const returnedCode = url.searchParams.get('code');
    const fail = (message) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
      reject(new Error(message));
    };

    if (err) return fail(`OAuth error: ${err} ${url.searchParams.get('error_description') || ''}`.trim());
    if (!returnedCode) return fail('OAuth callback carried no code');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Signed in</h2><p>You can close this tab and return to the terminal.</p></body></html>');
    resolve(returnedCode);
  };
}

export async function loginCodex({ noBrowser = false, timeoutMs = 120_000 } = {}) {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const authUrl = buildCodexAuthUrl({ state, codeChallenge });

  let server;
  const code = await new Promise((resolve, reject) => {
    server = http.createServer(codexCallbackHandler(state, { resolve, reject }));

    server.on('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${CALLBACK_PORT} is in use. OpenAI only accepts ${REDIRECT_URI} for this client, so close whatever holds it (a running \`codex login\`) and retry.`)
      : e));

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      if (noBrowser) {
        console.log(`Open this URL to sign in:\n${authUrl}`);
      } else {
        console.log('Opening browser for OpenAI sign-in...');
        openBrowser(authUrl);
        console.log(`If it did not open, visit:\n${authUrl}`);
      }
    });

    const timer = setTimeout(() => { reject(new Error('Login timed out after 2 minutes')); server.close(); }, timeoutMs);
    timer.unref();
    // Bind 127.0.0.1 rather than all interfaces: this listener briefly accepts
    // an authorization code, and nothing off this machine should reach it.
  }).finally(() => { server?.close(); });

  return exchangeCodexCode({ code, codeVerifier });
}

// ── Device Code Flow ────────────────────────────────────────────────────────

// OpenAI's private device-auth backend, used by `codex login --device-auth`.
// Not RFC 8628: the shapes below are the ones the Codex CLI itself uses
// (login/src/device_code_auth.rs) —
//   POST {base}/deviceauth/usercode  { client_id }
//        → { device_auth_id, user_code | usercode, interval }
//   POST {base}/deviceauth/token     { device_auth_id, user_code }
//        → 403/404 while the user has not approved yet,
//          200 { authorization_code, code_challenge, code_verifier } once approved
//   POST {issuer}/oauth/token        authorization_code grant, form-encoded, with
//        redirect_uri {issuer}/deviceauth/callback and the code_verifier the
//        server handed back (the server generated the PKCE pair, not us).
// CODEX_AUTHAPI_BASE_URL has the Codex CLI's meaning: the `/api/accounts` base.
const AUTH_ISSUER = 'https://auth.openai.com';
const deviceAuthBase = () => (process.env.CODEX_AUTHAPI_BASE_URL || `${AUTH_ISSUER}/api/accounts`).replace(/\/+$/, '');
export const DEVICE_VERIFICATION_URL = `${AUTH_ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_ISSUER}/deviceauth/callback`;

/**
 * Request a new device code from OpenAI.
 *
 * Returns `{ deviceAuthId, userCode, interval, expiresAt }`.  The caller
 * shows `userCode` to the human and directs them to `DEVICE_VERIFICATION_URL`.
 */
export async function requestDeviceCode({ base = deviceAuthBase() } = {}) {
  const timeoutMs = Number(process.env.AGENT_LB_REFRESH_TIMEOUT_MS) || 30_000;
  const res = await proxyFetch(`${base}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) {
    throw new Error('Device code login is not enabled for this account/server — use the browser login');
  }
  if (!res.ok) {
    throw new Error(`Device code request failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const userCode = data.user_code || data.usercode;
  if (!data.device_auth_id || !userCode) throw new Error('Device code response is missing device_auth_id/user_code');
  return {
    deviceAuthId: data.device_auth_id,
    userCode,
    interval:     Number(data.interval) || 5,
    expiresAt:    data.expires_at || null,
  };
}

/**
 * One poll of the device-auth token endpoint.
 *
 * Resolves `{ status: 'pending' }` while the user has not approved the code,
 * or `{ status: 'complete', credentials }` once they have (the authorization
 * code already exchanged for tokens). Rejects on a terminal error. The
 * dashboard calls this once per browser poll; the CLI loops over it.
 */
export async function pollDeviceCodeOnce({ deviceAuthId, userCode, signal, base = deviceAuthBase(), tokenEndpoint = TOKEN_ENDPOINT }) {
  const res = await proxyFetch(`${base}/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: signal || AbortSignal.timeout(30_000),
  });

  // Pending is signalled by status, as the Codex CLI reads it. A 400 carrying
  // an RFC 8628-style `authorization_pending` is accepted too.
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel?.();
    return { status: 'pending' };
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    const code = body.error?.code || body.error || body.code || '';
    if (code === 'deviceauth_authorization_pending' || code === 'authorization_pending') return { status: 'pending' };
    throw new Error(`Device code rejected: ${typeof code === 'string' ? code : JSON.stringify(code)} ${body.error_description || body.message || ''}`.trim());
  }
  if (!res.ok) {
    throw new Error(`Device code poll failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  if (data.access_token) return { status: 'complete', credentials: credentialsFromTokenResponse(data) };
  const code = data.authorization_code || data.code;
  if (!code) throw new Error('Device code approval carried no authorization_code');
  if (!data.code_verifier) throw new Error('Device code approval carried no code_verifier');
  const credentials = await exchangeCodexCode({
    code,
    codeVerifier: data.code_verifier,
    redirectUri: DEVICE_REDIRECT_URI,
    endpoint: tokenEndpoint,
    form: true,
  });
  return { status: 'complete', credentials };
}

/**
 * Poll OpenAI until the user approves the device code, then exchange for tokens.
 *
 * Resolves with credentials in the same shape `loginCodex` returns.  Rejects
 * when the code expires or the server reports a terminal error.
 *
 * @param {{ deviceAuthId: string, userCode: string, intervalMs?: number, expiresAt?: string, signal?: AbortSignal, base?: string, tokenEndpoint?: string }} opts
 */
export async function pollDeviceAuthorization({ deviceAuthId, userCode, intervalMs = 5000, expiresAt, signal, base, tokenEndpoint }) {
  const deadline = expiresAt ? new Date(expiresAt).getTime() : (Date.now() + 15 * 60 * 1000);

  while (true) {
    if (signal?.aborted) throw new Error('Device code login cancelled');
    if (Date.now() >= deadline) throw new Error('Device code expired');

    await new Promise(r => setTimeout(r, intervalMs));

    const result = await pollDeviceCodeOnce({ deviceAuthId, userCode, signal, base, tokenEndpoint });
    if (result.status === 'complete') return result.credentials;
  }
}

/**
 * Run a full device-code login against OpenAI and return credentials.
 *
 * Interactive: prints the code + URL to stdout so a human on a headless
 * machine can complete the flow from any device with a browser.
 */
export async function loginCodexDeviceCode({ timeoutMs = 15 * 60 * 1000 } = {}) {
  const { deviceAuthId, userCode, interval, expiresAt } = await requestDeviceCode();

  console.log('');
  console.log('  Zaloguj się kodem urządzenia:');
  console.log('');
  console.log(`  1. Otwórz w przeglądarce:  ${DEVICE_VERIFICATION_URL}`);
  console.log(`  2. Wpisz kod:              ${userCode}`);
  console.log('');
  console.log(`  Kod wygasa za 15 minut.`);
  console.log('');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref();
  try {
    return await pollDeviceAuthorization({
      deviceAuthId,
      userCode,
      intervalMs: interval * 1000,
      expiresAt,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
