import { observeTokenStream } from './first-token.js';
import { substitutedModel, substitutionAllowed } from './model-substitution.js';
import { handleClientKeys } from './client-key-admin.js';
import { readControlBody } from './control-body.js';
import { resolveBodyIdleTimeout, readWithIdleTimeout, idleBody, collectIdleBody } from './stream-lifecycle.js';
export { readWithIdleTimeout, idleBody } from './stream-lifecycle.js';
import { safeKeyEqual, maskSecret, isLoopbackAddr, isForwardedRequest, loopbackExempt, isTailnetAddr, isTailnetHostName, tailnetExempt, resolveClientAuth, relayPolicyAllowed, SENSITIVE_HEADER_NAMES } from './access-control.js';
export { safeKeyEqual, maskSecret, isLoopbackAddr, isForwardedRequest, loopbackExempt, isTailnetAddr, tailnetExempt, resolveClientAuth, relayPolicyAllowed, SENSITIVE_HEADER_NAMES } from './access-control.js';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeSync, existsSync, readFileSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { ensureCerts, createConnectHandler, mitmHosts } from './mitm.js';
import { patchAccountUuid } from './account-uuid-rewrite.js';
import { sanitizeToolPairs } from './tool-pair-sanitize.js';
import { sanitizeCacheControl, cacheControlSubfieldsToStrip } from './cache-control-sanitize.js';
import { parseRequestModel, parseAdvisorModel } from './account-manager.js';
import { TopLevelFieldFinder, modelGlobMatches } from './model.js';
import { BodyWriter, truncationNote } from './request-log.js';
import { upstreamFetch, upstreamPoolStatus } from './upstream-fetch.js';
import { applyAuthHeaders, upstreamFor, rewritesBody, providerForPath, providerOf, isSubscriptionAccount, DEFAULT_PROVIDER } from './provider.js';
import { tunnelTls } from './sx.js';
import { createEgressGuard } from './egress-guard.js';
import { safeLine } from './safe-text.js';
import { forwardRefusal, guardedLookup, FORBIDDEN_FORWARD } from './forward-target.js';
import { homedir } from 'node:os';
import { renderDashboardHtml, dashboardCsp } from './dashboard.js';
import { createUsageRecorder, resolveUsageDimensions, usageDimensionHeaderNames } from './client-usage.js';
import { atomicConfigUpdate } from './config.js';
import {
  fetchProfile, parseAuthCode, exchangeCodeForTokens, importCredentials,
  DEFAULT_CLIENT_ID, OAUTH_AUTHORIZE, OAUTH_SCOPES, MANUAL_LOGIN_REDIRECT_URI,
} from './oauth.js';
import {
  buildCodexAuthUrl, exchangeCodexCode, importCodexCredentials,
  requestDeviceCode, pollDeviceCodeOnce, DEVICE_VERIFICATION_URL,
} from './codex-auth.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ClientUsageTracker } from './client-usage.js';
import { metricsFor } from './metrics.js';
import { requestBudgetFor } from './request-budget.js';
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropicResponse,
  createOpenAIToAnthropicTransformStream,
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAIResponse,
  createAnthropicToOpenAITransformStream,
  translateChatCompletionsToCodexResponses,
  createCodexResponsesToOpenAITransformStream,
  translateCodexResponsesToOpenAIResponse,
  codexResponseFailure,
} from './provider-translator.js';
import { FairShareController } from './fair-share.js';
import { ToolCallDedupeCache } from './tool-call-dedupe.js';
import { sameIdentity, findUpsertTarget } from './identity.js';
import { mintAccountId } from './account-id.js';
import { FleetHealthChecker } from './health-checker.js';

const pendingOAuthStates = new Map();
function cleanExpiredOAuthStates() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [s, data] of pendingOAuthStates.entries()) {
    if (data.createdAt < cutoff) pendingOAuthStates.delete(s);
  }
}


export const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
// Path prefix for the deprecated URL-based account pin (superseded by TC_ACCT).
const PIN_PREFIX = '/tc-acct/';

/**
 * Does the request path carry a dot-segment (`.` or `..`, in any percent-encoded
 * spelling, on either slash)?
 *
 * Every path classification in the listener — the Codex pool, the
 * client-credential relay, the `/tc-acct/` pin — is a prefix test on the path
 * AS SENT, while the upstream URL is normalised afterwards by `new URL()` and
 * fetch. So `/backend-api/codex/../conversations` classifies as Codex and
 * reaches chatgpt.com as `/backend-api/conversations`, pooled token attached;
 * `/v1/messages/../../api/oauth/profile` does not start with `/api/oauth/`,
 * takes the pool path, and reaches the profile endpoint with a rotated token —
 * the exact thing the relay exists to prevent for the literal path. Backslash
 * counts because the URL parser treats it as a slash for http(s). No client of
 * ours ever sends one; refusing the request is the whole fix.
 */
export function hasDotSegment(url) {
  const path = String(url || '').split('?')[0].split('#')[0];
  for (const seg of path.split(/[/\\]/)) {
    let s = seg;
    // An undecodable segment (`%`) is compared as sent: the URL parser leaves
    // it alone too, so it cannot become a dot-segment upstream.
    try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (s === '.' || s === '..') return true;
  }
  return false;
}
const INLINE_RETRY_AFTER_MAX_SECONDS = 15;
// How long the proxy will absorb a rate-limit 429's retry-after inline (waiting
// on the SAME account) before surfacing a 429 + retry-after to the client. A
// rate-limit 429 never rotates accounts (that just moves the burst); it pauses
// the account so concurrent requests wait, then retries the same account.
const RATE_LIMIT_ABSORB_MAX_SECONDS =
  Number(process.env.AGENT_LB_RATE_LIMIT_ABSORB_MAX_SECONDS || process.env.AGENTLB_RATE_LIMIT_ABSORB_MAX_SECONDS) || 60;
const OAUTH_ENTITLEMENT_ERROR_CODE = 'oauth_not_allowed_for_organization';
const ERROR_BODY_INSPECTION_LIMIT = 64 * 1024;

// Anthropic can refuse a subscription account with a 400 when the account's
// identity verification is pending. This is account-scoped, unlike a malformed
// prompt, so it is safe for the balancer to try another OAuth account.
export function isOAuthIdentityVerificationRequired(body) {
  const text = Buffer.from(body || '').toString('utf8');
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message || '';
    return /identity verification\s+is\s+required\s+to\s+continue/i.test(String(message));
  } catch {
    return /identity verification\s+is\s+required\s+to\s+continue/i.test(text);
  }
}

/** Classify only the structured organization-policy denial observed upstream.
 * Message text and generic permission errors are deliberately not enough. */
export function isOAuthEntitlementDenied(body) {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    return parsed?.error?.details?.error_code === OAUTH_ENTITLEMENT_ERROR_CODE;
  } catch {
    return false;
  }
}

// Error payloads are normally tiny, but an alternate upstream is configurable.
// Bound the diagnostic read so a hostile chunked 403 cannot make the proxy buffer
// an arbitrary response merely to decide whether it should quarantine an account.
async function readErrorBody(body, limit = ERROR_BODY_INSPECTION_LIMIT) {
  return readBodyBuffer(body, limit);
}

// Read a web stream into a Buffer. `limit` is used only for bounded inspection;
// the normal response path passes Infinity so an already-admitted response is
// relayed completely. The caller owns the stream and can choose whether to
// cancel it after this helper returns null.
async function readBodyBuffer(body, limit = Infinity) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, resolveBodyIdleTimeout());
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
}

// Response header names that are connection-specific and thus illegal on an
// HTTP/2 response (Node's Http2ServerResponse.writeHead rejects them). Also
// hop-by-hop on h1, so stripping them is correct on both paths.
const CONNECTION_SPECIFIC_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-connection', 'te', 'trailer',
]);

export function createProxyServer(accountManager, config, hooks = {}, sx = null, clientUsage = null, dimensionUsage = null) {
  clientUsage ||= new ClientUsageTracker();
  const upstream = config.upstream || 'https://api.anthropic.com';
  const holdMs = (config.holdSeconds || 0) * 1000;
  const fairShare = new FairShareController({
    poolCapacity: config.poolCapacity || 32,
    congestionThreshold: config.congestionThreshold || 0.75,
  });
  const toolDedupe = new ToolCallDedupeCache();
  const drainState = {
    isDraining: false,
    drainStartedAt: null,
    activeRequests: 0,
  };
  const egress = createEgressGuard(config, console.error);
  const healthChecker = new FleetHealthChecker(accountManager, {
    enabled: config.autoHealthCheck?.enabled ?? true,
    intervalMs: (config.autoHealthCheck?.intervalSeconds ?? 900) * 1000,
    trafficGracePeriodMs: (config.autoHealthCheck?.trafficGracePeriodSeconds ?? 900) * 1000,
    errorBackoffMs: (config.autoHealthCheck?.errorBackoffSeconds ?? 3600) * 1000,
    configuredUpstream: upstream,
    fetchFn: async (url, opts) => {
      if (egress && !(await egress.check()).ok) throw new Error('health check refused: egress does not match pin');
      opts.signal?.throwIfAborted();
      return upstreamFetch(url, opts, sx, !!sx?.useByDefault());
    },
  });
  if (config.autoHealthCheck?.enabled !== false) {
    healthChecker.start();
  }

  // The log directory is made up front and synchronously, so a path that
  // cannot be a directory (a file sitting there, no permission) is reported
  // ONCE here and logging is switched off — instead of the server looking
  // healthy while every request discovers the failure on its own. Never fatal:
  // a broken log directory is no reason to refuse traffic. 0700 because the
  // files hold full prompts and responses; an existing directory keeps its mode.
  let logDir = config.logDir || null;
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      console.error(`[AgentLB] Request logging disabled: cannot create logDir ${logDir}: ${err.message}`);
      logDir = null;
    }
  }

  const requestHandler = async (req, res) => {
    try {
      // Dashboard page — served BEFORE the auth gate on purpose. The page is a
      // static asset containing no data: everything it shows comes from
      // /agentlb/status, which stays behind the gate and is fetched by the
      // page's own script with the key. A browser address bar cannot send
      // x-api-key, so gating the asset would just 401 every remote browser
      // without protecting anything.
      const rawPath = (req.url || '').split('?')[0];
      const normPath = rawPath.replace(/\/+$/, '') || '/';
      const reqPath = rawPath;
      const normApiPath = reqPath.replace(/^\/(?:agent-lb|agentlb|claude-lb)/, '');
      const isDashboardPath = normPath === '/' || normPath === '/dashboard' || normPath === '/agent-lb/dashboard' || normPath === '/claude-lb/dashboard' || normPath === '/agent-lb' || normPath === '/claude-lb';

      if ((req.method === 'GET' || req.method === 'HEAD') && isDashboardPath) {
        // The page keeps the proxy key in localStorage; the policy is what
        // stops any script but its own from ever running next to it.
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': dashboardCsp(),
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(renderDashboardHtml());
        return;
      }

      // Serve client setup scripts without auth (Claude Code, OpenAI Codex, OpenCode, Hermes, Claw, Orca)
      const setupScriptMatch = normPath.match(/^\/(?:agent-lb\/|agentlb\/|claude-lb\/)?(setup|claude-setup|setup-claude|codexlb-setup|codex-setup|setup-codex|agent-setup|opencode-setup|hermes-setup|claw-setup|openclaw-setup|orca-setup|aider-setup)(?:\.(sh|ps1|js))?$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && setupScriptMatch) {
        const scriptBase = setupScriptMatch[1];
        let ext = setupScriptMatch[2];
        if (!ext) {
          const ua = (req.headers['user-agent'] || '').toLowerCase();
          ext = (ua.includes('powershell') || ua.includes('pwsh')) ? 'ps1' : 'sh';
        }
        let possibleNames = [];
        if (scriptBase.includes('hermes')) {
          possibleNames = [`hermes-setup.${ext}`, `setup.${ext}`];
        } else if (scriptBase.includes('opencode')) {
          possibleNames = [`opencode-setup.${ext}`, `setup.${ext}`];
        } else if (scriptBase.includes('claw')) {
          possibleNames = [`claw-setup.${ext}`, `openclaw-setup.${ext}`, `setup.${ext}`];
        } else if (scriptBase.includes('orca')) {
          possibleNames = [`orca-setup.${ext}`, `setup.${ext}`];
        } else if (scriptBase.includes('codex')) {
          possibleNames = [`codex-setup.${ext}`, `codexlb-setup.${ext}`];
        } else {
          possibleNames = [`claude-setup.${ext}`, `setup.${ext}`, `agent-setup.${ext}`, `agent-lb-setup.${ext}`];
        }
        const scriptDirs = [
          join(__dirname, '..', 'setup'),
          join(homedir(), 'agent-lb-setup'),
          join(homedir(), 'bin'),
        ];
        let content = null;
        for (const dir of scriptDirs) {
          for (const name of possibleNames) {
            const p = join(dir, name);
            if (existsSync(p)) {
              try { content = readFileSync(p, 'utf8'); break; } catch {}
            }
          }
          if (content) break;
        }
        if (!content) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`setup script ${scriptBase}.${ext} not found on server`);
          return;
        }

        // Dynamically bake requesting server origin into script if requested over HTTP
        const reqProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
        const reqHost = req.headers['x-forwarded-host'] || req.headers.host;
        if (reqHost) {
          const currentOrigin = `${reqProto}://${reqHost}`;
          content = content.replace(/http:\/\/localhost:3456/g, currentOrigin);
          content = content.replace(/https:\/\/codexlb\.gotova\.pl/g, currentOrigin);
          content = content.replace(/https:\/\/agentlb\.gotova\.pl/g, currentOrigin);
        }

        res.writeHead(200, {
          'Content-Type': ext === 'ps1' ? 'text/plain; charset=utf-8' : (ext === 'js' ? 'application/javascript; charset=utf-8' : 'application/x-sh'),
          'Cache-Control': 'no-cache',
        });
        res.end(content);
        return;
      }

      // Friendly redirect to dashboard for legacy browser navigation
      if ((req.method === 'GET' || req.method === 'HEAD') && (normPath === '/' || normPath === '/agent-lb' || normPath === '/claude-lb')) {
        res.writeHead(307, {
          'Location': '/dashboard',
          'Content-Type': 'text/plain',
        });
        res.end('Redirecting to /dashboard');
        return;
      }

      // Auth check — skip for localhost and Tailnet connections. `config.proxy` is read per
      // request (not captured at creation) so a reload that edits clientKeys
      // applies to a running server, matching how eventLogging/blockedModels
      // are read live further down the pipeline.
      const rawAuth = req.headers['authorization'] || '';
      const bearerMatch = /^Bearer\s+(\S+)$/i.exec(rawAuth);
      const headerKey = req.headers['x-api-key'] || null;
      const bearerKey = bearerMatch ? bearerMatch[1] : null;
      let clientKey = headerKey || bearerKey;
      const isLocal = loopbackExempt(req.headers, req.socket.remoteAddress, config.proxy);
      const isTailnet = tailnetExempt(req.headers, req.socket.remoteAddress, config.proxy);
      const isTrustedOrigin = isLocal || isTailnet;
      let auth = resolveClientAuth(config.proxy, clientKey);
      // From a trusted origin, a Bearer that is not one of our keys is the
      // client's OWN upstream credential — Claude Code in OAuth mode sends its
      // claude.ai token, Codex its ChatGPT token — not a wrong proxy key. The
      // origin needs no key at all, so read it as "no key" instead of refusing
      // with a 401 that makes the client drop its login. Only the Bearer gets
      // this reading: an explicit x-api-key is meant for us, and a wrong one
      // (e.g. after a key rotation) must still fail loudly. Both credential
      // headers are stripped before anything goes upstream.
      if (!auth.ok && !headerKey && bearerKey && isTrustedOrigin) {
        clientKey = null;
        auth = { ok: false, client: null, entry: null };
      }
      if (!auth.ok && (clientKey || !isTrustedOrigin)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }
      req.clientKey = clientKey;
      req.tcClient = auth.ok ? auth.client : null;
      req.tcClientEntry = auth.entry || null;

      // Protect every management alias BEFORE dispatch (including reload,
      // switch and setup/pull). Provider identity endpoints remain data-plane.
      const managementPath = /^\/(?:api\/(?:auth|keys|accounts|routing|drain|ready|system|reboot|restart|test|chat|health-check|setup|reload|probe|switch)(?:\/|$)|accounts(?:\/|$)|client-keys(?:\/|$)|oauth(?:\/|$)|routing(?:\/|$)|drain(?:\/|$)|health-check(?:\/|$)|reload$|probe$|switch$|reboot$|restart$|metrics$|alerts$)/.test(normApiPath);
      const isAdmin = config.proxy?.apiKey
        ? safeKeyEqual(clientKey, config.proxy.apiKey)
        : (!config.proxy?.clientKeys?.length && isLoopbackAddr(req.socket.remoteAddress) && !isForwardedRequest(req.headers));
      if (managementPath && !isAdmin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'administrator key required' }));
        return;
      }
      if (managementPath && !isSameOriginControlRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'cross-origin management request refused' }));
        return;
      }
      if (managementPath) res.setHeader('Cache-Control', 'no-store');
      if (auth.entry) {
        const policy = clientUsage.checkQuota(auth.client, auth.entry);
        if (!policy.allowed) { denyClientPolicy(res, policy); return; }
      }

      // Control-plane mutations are refused when the request was issued by a web
      // page. The gate above exempts loopback from the API key, so without this
      // any site the operator happens to visit can POST here cross-origin: a
      // `fetch(..., {mode:'no-cors', body})` with a text/plain content type is a
      // CORS "simple request", so no preflight is sent and the request lands.
      // The page cannot read the reply, but the side effect is the point —
      // forcing the whole fleet onto one named account is a targeted quota
      // drain, and reload is reachable the same way.
      //
      // Origin (and Sec-Fetch-Site) are set by the browser and cannot be
      // forged from page JavaScript, while curl and the CLI send neither — so
      // this costs legitimate callers nothing. Deliberately not a content-type
      // requirement, which would also close the hole but would break the
      // documented `curl -X POST .../agentlb/reload` that sends no body.
      const crossOrigin = !isSameOriginControlRequest(req);
      if (crossOrigin && req.method === 'POST' && (req.url || '').startsWith('/agent-lb/')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'cross-origin request refused: the control plane is not reachable from a web page',
        }));
        return;
      }

      // Forward-proxy request (HTTP_PROXY): an absolute-form URL is a tool
      // proxying plain HTTP to some host. Account logic is only for hosts we
      // manage (the Anthropic upstream, which is HTTPS-only and never arrives
      // this way); forward anything else transparently instead of hijacking it.
      // Dispatched BEFORE the loopback-only checks below: a page cannot make a
      // browser emit an absolute-form request line, the relay injects no fleet
      // credential, and its Host header names the TARGET, not this proxy.
      if (/^https?:\/\//i.test(req.url || '')) {
        if (!relayPolicyAllowed(auth, clientUsage)) { denyClientPolicy(res, { error: 'restricted keys cannot use a general-purpose relay' }); return; }
        relayHttpForward(req, res); return;
      }

      // A request admitted ONLY by the loopback exemption — no valid key — is
      // held to two more conditions. Both target the same actor: a web page in
      // the operator's browser, whose requests are loopback-sourced too. A
      // caller that presented a valid key has proven itself and skips both.
      if (!auth.ok) {
        // Cross-origin, for every method and path this time. The control-plane
        // gate above covers its mutations, but the same no-cors trick reaches
        // POST /v1/messages, where the proxy injects a fleet credential (a quota
        // drain, with prompt content booked to the operator), and a GET of
        // /agentlb/status is unreadable to the page only for as long as no
        // CORS header ever leaks. Same browser-set headers, same zero cost to
        // curl, the CLI and Node clients, which send neither.
        if (crossOrigin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'permission_error', message: 'cross-origin request refused: a web page cannot use the proxy without a key' },
          }));
          return;
        }
        // DNS rebinding. A page at attacker.example whose name flips to
        // 127.0.0.1 sends requests that are loopback-sourced AND same-origin as
        // far as the browser can tell, and it can read the answers. What it
        // cannot forge is the Host header, which the browser derives from its
        // own URL bar — so a key-less loopback request must name this machine.
        if (!isLocalHostHeader(req.headers.host ?? req.headers[':authority'], config.proxy?.host, [], config.proxy)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'permission_error', message: 'request refused: the Host header does not name this proxy' },
          }));
          return;
        }
      }

      // Codex models endpoint — live verification for Codex CLI & setup scripts
      const codexPathname = req.url.split('?')[0];
      if (req.method === 'GET' && (codexPathname === '/backend-api/codex/models' || codexPathname === '/backend-api/codex/v1/models' || codexPathname === '/v1/models' || codexPathname === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'claude-fable-5-1', object: 'model', type: 'model', name: 'Claude Fable 5.1', display_name: 'Claude Fable 5.1' },
            { id: 'claude-fable-5', object: 'model', type: 'model', name: 'Claude Fable 5', display_name: 'Claude Fable 5' },
            { id: 'claude-opus-5', object: 'model', type: 'model', name: 'Claude Opus 5', display_name: 'Claude Opus 5' },
            { id: 'claude-opus-4-8', object: 'model', type: 'model', name: 'Claude Opus 4.8', display_name: 'Claude Opus 4.8' },
            { id: 'claude-opus-4-7', object: 'model', type: 'model', name: 'Claude Opus 4.7', display_name: 'Claude Opus 4.7' },
            { id: 'claude-opus-4-6', object: 'model', type: 'model', name: 'Claude Opus 4.6', display_name: 'Claude Opus 4.6' },
            { id: 'claude-sonnet-5', object: 'model', type: 'model', name: 'Claude Sonnet 5', display_name: 'Claude Sonnet 5' },
            { id: 'claude-sonnet-4-6', object: 'model', type: 'model', name: 'Claude Sonnet 4.6', display_name: 'Claude Sonnet 4.6' },
            { id: 'claude-mythos-5-1', object: 'model', type: 'model', name: 'Claude Mythos 5.1', display_name: 'Claude Mythos 5.1' },
            { id: 'claude-haiku-4-5-20251001', object: 'model', type: 'model', name: 'Claude Haiku 4.5', display_name: 'Claude Haiku 4.5' },
            { id: 'claude-3-7-sonnet-20250219', object: 'model', type: 'model', name: 'Claude 3.7 Sonnet', display_name: 'Claude 3.7 Sonnet' },
            { id: 'claude-3-5-sonnet-20241022', object: 'model', type: 'model', name: 'Claude 3.5 Sonnet', display_name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', object: 'model', type: 'model', name: 'Claude 3.5 Haiku', display_name: 'Claude 3.5 Haiku' },
            { id: 'claude-3-opus-20240229', object: 'model', type: 'model', name: 'Claude 3 Opus', display_name: 'Claude 3 Opus' },
            { id: 'gpt-5.6-sol', object: 'model', type: 'model', name: 'GPT-5.6 Sol', display_name: 'GPT-5.6 Sol' },
            { id: 'codex', object: 'model', type: 'model', name: 'Codex (GPT-5.6 Sol)', display_name: 'Codex (GPT-5.6 Sol)' },
            { id: 'gpt-6-astra', object: 'model', type: 'model', name: 'GPT-6 Astra', display_name: 'GPT-6 Astra' },
            { id: 'gpt-5.6-terra', object: 'model', type: 'model', name: 'GPT-5.6 Terra', display_name: 'GPT-5.6 Terra' },
            { id: 'codex-mini', object: 'model', type: 'model', name: 'Codex Mini (GPT-5.6 Terra)', display_name: 'Codex Mini (GPT-5.6 Terra)' },
            { id: 'gpt-5.6-luna', object: 'model', type: 'model', name: 'GPT-5.6 Luna', display_name: 'GPT-5.6 Luna' },
            { id: 'gpt-5.5', object: 'model', type: 'model', name: 'GPT-5.5', display_name: 'GPT-5.5' },
            { id: 'o3-mini', object: 'model', type: 'model', name: 'o3-mini', display_name: 'o3-mini' },
            { id: 'o1', object: 'model', type: 'model', name: 'o1', display_name: 'o1' },
            { id: 'gpt-4o', object: 'model', type: 'model', name: 'GPT-4o', display_name: 'GPT-4o' },
            { id: 'gpt-4o-mini', object: 'model', type: 'model', name: 'GPT-4o mini', display_name: 'GPT-4o mini' },
            { id: 'agy', object: 'model', type: 'model', name: 'AGY (Antigravity)', display_name: 'AGY (Antigravity)' },
            { id: 'agy-fast', object: 'model', type: 'model', name: 'AGY Fast', display_name: 'AGY Fast' },
            { id: 'gemini-3.8-flash-high', object: 'model', type: 'model', name: 'Gemini 3.8 Flash High (AGY)', display_name: 'Gemini 3.8 Flash High (AGY)' },
            { id: 'gemini-3.8-flash-low', object: 'model', type: 'model', name: 'Gemini 3.8 Flash Low (AGY Fast)', display_name: 'Gemini 3.8 Flash Low (AGY Fast)' }
          ],
          has_more: false
        }));
        return;
      }

      if (req.method === 'GET' && normApiPath === '/alerts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ alerts: metricsFor(config).alerts() })); return;
      }
      if (req.method === 'GET' && normApiPath === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(metricsFor(config).render()); return;
      }
      // Ready endpoint (liveness & drain readiness probe)
      if (req.method === 'GET' && (normApiPath === '/ready' || normApiPath === '/api/ready' || req.url === '/ready')) {
        if (drainState.isDraining) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, ready: false, draining: true, activeRequests: drainState.activeRequests }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ready: true, draining: false, activeRequests: drainState.activeRequests }));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && (req.url === '/agent-lb/status' || req.url === '/claude-lb/status' || req.url === '/status' || req.url === '/api/status')) {
        const status = accountManager.getStatus({ sessionDetail: config.proxy?.sessionDetail === true });
        const extra = hooks.getStatusExtra?.() || {};
        const clientKeys = (config.proxy?.clientKeys || []).map(k => ({
          name: k.name,
          // Never include the credential itself in a status snapshot.  The
          // administrator-only key-management endpoint returns the same
          // masked representation and is the sole place where a newly minted
          // key is returned once, at creation time.
          key: maskSecret(k.key),
          created: k.created || null,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Counters only: how full the upstream admission gate is (see
        // upstream-fetch.js), never which origins or requests.
        res.end(JSON.stringify({ ...extra, ...status, clientKeys, draining: drainState.isDraining, activeRequests: drainState.activeRequests, upstreamPool: upstreamPoolStatus(), autoHealthCheck: healthChecker.getStatus() }, null, 2));
        return;
      }

      // Tier-weighted fleet quota for lightweight consumers such as a shell or
      // Claude Code status line. Unlike /agentlb/status this omits routing,
      // usage counters and server diagnostics, and never reaches upstream.
      if (req.method === 'GET' && (req.url === '/agent-lb/quota' || req.url === '/claude-lb/quota' || req.url === '/quota' || req.url === '/api/quota')) {
        const extra = hooks.getQuotaExtra?.() || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...accountManager.getQuotaSummary(), ...extra }, null, 2));
        return;
      }

      // Reload endpoint — re-sync accounts from config without a restart. This
      // is the headless equivalent of pressing 'R' in the TUI. Local control
      // only (no upstream calls); the auth gate above already applies.
      if (req.method === 'POST' && (req.url === '/agent-lb/reload' || req.url === '/claude-lb/reload' || req.url === '/reload' || req.url === '/api/reload')) {
        if (!hooks.reload) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'reload not supported' }));
          return;
        }
        try {
          const added = await hooks.reload();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, added: added || 0 }));
        } catch (err) {
          // The reason belongs in the log, not the reply: a reload failure
          // names config paths and account details, and this endpoint is
          // reachable by anyone holding a client key.
          console.error('[AgentLB] Reload failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'reload failed; see the proxy log' }));
        }
        return;
      }

      // Probe endpoint — force a fleet-wide quota and spend probe on demand.
      if (req.method === 'POST' && (req.url === '/agent-lb/probe' || req.url === '/agent-lb/api/probe' || req.url === '/claude-lb/probe' || req.url === '/claude-lb/api/probe' || req.url === '/probe' || req.url === '/api/probe')) {
        if (!hooks.probeQuota) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'probe not supported' }));
          return;
        }
        try {
          await hooks.probeQuota();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          console.error('[AgentLB] Probe failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'probe failed; see the proxy log' }));
        }
        return;
      }

      // Pull latest agent-lb code and scripts from GitHub repo
      if (req.method === 'POST' && (req.url === '/agent-lb/api/setup/pull' || req.url === '/claude-lb/api/setup/pull' || req.url === '/api/setup/pull')) {
        const { exec } = await import('node:child_process');
        const repoDir = join(__dirname, '..');
        exec('git pull', { cwd: repoDir }, (err, stdout, stderr) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (stderr || err.message).trim() }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, output: stdout.trim() }));
          }
        });
        return;
      }

      // Switch endpoint — make one account the preferred one, the headless
      // equivalent of picking it with 's' in the TUI. Both do the same single
      // thing: move currentIndex. That is a preference, and a weak one: _select
      // abandons it as soon as the account is unavailable, and also whenever any
      // available account carries a strictly lower priority value. So the answer
      // reports whether the choice will actually take effect rather than only
      // that it was recorded. Body:
      // {"account": "<name|email|accountUuid|accountUuid/orgUuid|orgUuid>"}.
      // Local control only (no upstream calls); the auth gate above applies.
      if (req.method === 'POST' && (req.url === '/agent-lb/switch' || req.url === '/claude-lb/switch' || req.url === '/switch' || req.url === '/api/switch')) {
        const names = () => (accountManager.accounts || []).map(a => a.name);
        let target;
        try {
          const raw = await readControlBody(req);
          target = JSON.parse(raw || '{}')?.account;
        } catch (err) {
          // Say which of the two it was, but never echo the parser's own message
          // back to a caller — that is our internals, not their input.
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account"', accounts: names() }));
          return;
        }
        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"`, accounts: names() }));
          return;
        }

        const targetAcct = accountManager.accounts[index];
        const targetProv = providerOf(targetAcct);

        // Under list-order primacy, switching to an account sets it as #1 in its provider
        if (Array.isArray(accountManager.accounts)) {
          const siblings = accountManager.accounts.filter(a => providerOf(a) === targetProv);
          siblings.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          const newOrder = [targetAcct.name, ...siblings.filter(a => a.name !== targetAcct.name).map(a => a.name)];
          newOrder.forEach((n, prio) => {
            const acc = accountManager.accounts.find(a => a.name === n);
            if (acc) acc.priority = prio;
          });

          await atomicConfigUpdate(disk => {
            if (!disk.accounts) return;
            for (const dAcct of disk.accounts) {
              const idx = newOrder.indexOf(dAcct.name);
              if (idx !== -1) dAcct.priority = idx;
            }
            disk.accounts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          }).catch(() => {});

          if (config.accounts) {
            for (const cAcct of config.accounts) {
              const idx = newOrder.indexOf(cAcct.name);
              if (idx !== -1) cAcct.priority = idx;
            }
            config.accounts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          }

          accountManager.accounts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          accountManager.accounts.forEach((a, i) => { a.index = i; });
        }

        if (typeof accountManager.selectActiveAccount === 'function') {
          accountManager.routeCursors?.clear();
          accountManager.providerCursors?.clear();
          accountManager.selectActiveAccount();
        } else {
          accountManager.setCurrentAccount(0);
        }

        const newIdx = accountManager.accounts.findIndex(a => a.name === targetAcct.name);
        const effectiveIdx = newIdx !== -1 ? newIdx : index;
        const name = accountManager.accounts[effectiveIdx].name;
        const { eligible, reason } = accountManager.eligibility(effectiveIdx);
        console.log(`[AgentLB] Switched to account "${name}" (promoted to #1 in list)`
          + (eligible ? '' : ` — ${reason}, so rotation will not use it`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: name, eligible, ...(reason ? { reason } : {}) }));
        return;
      }

      // Auth verification & session endpoints for dashboard
      if (req.method === 'GET' && (normApiPath === '/api/auth/verify' || normApiPath === '/api/auth/session')) {
        const hasAdminKey = Boolean(config.proxy?.apiKey);
        if (!hasAdminKey) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, authenticated: true, passwordRequired: false, role: 'admin' }));
          return;
        }
        const isMaster = clientKey && safeKeyEqual(clientKey, config.proxy.apiKey);
        const clientAuth = clientKey ? resolveClientAuth(config.proxy, clientKey) : null;
        if (isMaster) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            authenticated: true,
            passwordRequired: true,
            role: 'admin',
            isPrimary: Boolean(isMaster),
            clientName: clientAuth?.client || (isMaster ? 'admin' : null)
          }));
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, authenticated: false, passwordRequired: true, error: 'Wymagana autoryzacja (podaj klucz administracyjny lub klucz stacji roboczej)' }));
        return;
      }

      if (req.method === 'POST' && normApiPath === '/api/auth/login') {
        let body = {};
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch {}
        const candidate = (body.key || body.password || clientKey || '').trim();
        const hasAdminKey = Boolean(config.proxy?.apiKey);
        const isMaster = candidate && hasAdminKey && safeKeyEqual(candidate, config.proxy.apiKey);
        const clientAuth = candidate ? resolveClientAuth(config.proxy, candidate) : null;
        if (!hasAdminKey || isMaster) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            authenticated: true,
            role: 'admin',
            isPrimary: Boolean(isMaster),
            clientName: clientAuth?.client || (isMaster ? 'admin' : null)
          }));
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, authenticated: false, error: 'Nieprawidłowe hasło lub klucz API' }));
        return;
      }

      if (await handleClientKeys({ req, res, normApiPath, config, hooks, clientUsage })) return;

      // Accounts: Toggle disable/enable (POST /agentlb/api/accounts/toggle & POST /agentlb/accounts/toggle)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/toggle' || normApiPath === '/accounts/toggle')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.id || body?.name || body?.account;
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "id", "name" or "account"' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const mgr = accountManager.accounts[index];
        const newDisabled = typeof body.disabled === 'boolean' ? body.disabled : !mgr.disabled;
        accountManager.setDisabled(index, newDisabled);

        await atomicConfigUpdate(disk => {
          const dAcct = (disk.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name);
          if (dAcct) {
            if (newDisabled) dAcct.disabled = true;
            else delete dAcct.disabled;
          }
        });

        const cAcct = (config.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name);
        if (cAcct) {
          if (newDisabled) cAcct.disabled = true;
          else delete cAcct.disabled;
        }

        console.log(`[AgentLB] Account "${mgr.name}" ${newDisabled ? 'disabled' : 'enabled'} (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: mgr.name, id: mgr.id, disabled: newDisabled }));
        return;
      }

      // Accounts: Set priority
      if (req.method === 'POST' && (normApiPath === '/api/accounts/priority' || normApiPath === '/accounts/priority')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.account || body?.id || body?.name;
        const prio = parseInt(body?.priority, 10);
        if (typeof target !== 'string' || !target.trim() || isNaN(prio)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account" or invalid "priority" (must be an integer)' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const mgr = accountManager.accounts[index];
        mgr.priority = prio;

        await atomicConfigUpdate(disk => {
          const dAcct = (disk.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name);
          if (dAcct) dAcct.priority = prio;
        });

        const cAcct = (config.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name);
        if (cAcct) cAcct.priority = prio;

        console.log(`[AgentLB] Set priority of "${mgr.name}" to ${prio} (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: mgr.name, id: mgr.id, priority: prio }));
        return;
      }

      // Accounts: Rename (POST /agentlb/api/accounts/rename & POST /api/accounts/rename & POST /accounts/rename)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/rename' || normApiPath === '/accounts/rename')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.oldName || body?.account || body?.id;
        const newName = typeof body?.newName === 'string' ? body.newName.trim() : (typeof body?.name === 'string' ? body.name.trim() : '');

        if (typeof target !== 'string' || !target.trim() || !newName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account" (or "oldName") or "newName"' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const mgr = accountManager.accounts[index];
        const oldName = mgr.name;

        if (oldName === newName) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, oldName, newName, unchanged: true }));
          return;
        }

        const duplicate = accountManager.accounts.find(a => a.name.toLowerCase() === newName.toLowerCase() && a !== mgr);
        if (duplicate) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `account with name "${newName}" already exists` }));
          return;
        }

        mgr.name = newName;

        await atomicConfigUpdate(disk => {
          const dAcct = (disk.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === oldName);
          if (dAcct) dAcct.name = newName;
        });

        const cAcct = (config.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === oldName);
        if (cAcct) cAcct.name = newName;

        console.log(`[Agent-LB] Renamed account "${oldName}" to "${newName}" (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, oldName, newName }));
        return;
      }

      // Accounts: Reorder and assign priorities (POST /api/accounts/reorder & POST /accounts/reorder)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/reorder' || normApiPath === '/accounts/reorder')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const order = Array.isArray(body?.order) ? body.order : null;
        if (!order || !order.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "order" array of account names' }));
          return;
        }

        const nameToPrio = new Map();
        order.forEach((name, idx) => {
          if (typeof name === 'string' && name.trim()) {
            nameToPrio.set(name.trim(), idx);
          }
        });

        // Update in-memory accountManager
        for (const acct of accountManager.accounts) {
          if (nameToPrio.has(acct.name)) {
            acct.priority = nameToPrio.get(acct.name);
          }
        }

        // Update disk config atomically
        await atomicConfigUpdate(disk => {
          if (!disk.accounts) return;
          for (const dAcct of disk.accounts) {
            if (nameToPrio.has(dAcct.name)) {
              dAcct.priority = nameToPrio.get(dAcct.name);
            }
          }
          disk.accounts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
        });

        // Update in-memory config
        if (config.accounts) {
          for (const cAcct of config.accounts) {
            if (nameToPrio.has(cAcct.name)) {
              cAcct.priority = nameToPrio.get(cAcct.name);
            }
          }
          config.accounts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
        }

        if (Array.isArray(accountManager.accounts)) {
          accountManager.accounts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          accountManager.accounts.forEach((a, i) => { a.index = i; });
        }
        if (typeof accountManager.selectActiveAccount === 'function') {
          accountManager.routeCursors?.clear();
          accountManager.providerCursors?.clear();
          accountManager.selectActiveAccount();
        }

        console.log(`[Agent-LB] Reordered ${nameToPrio.size} accounts (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reordered: Array.from(nameToPrio.keys()) }));
        return;
      }

      // Accounts: Remove (POST /agentlb/api/accounts/remove & POST /agentlb/accounts/remove)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/remove' || normApiPath === '/accounts/remove')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.id || body?.name || body?.account;
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "id", "name" or "account"' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const mgr = accountManager.accounts[index];
        const name = mgr.name;
        const id = mgr.id;

        accountManager.removeAccount(index);

        await atomicConfigUpdate(disk => {
          disk.accounts = (disk.accounts || []).filter(a => !( (id && a.id === id) || sameIdentity(a, mgr) || a.name === name ));
        });

        if (Array.isArray(config.accounts)) {
          config.accounts = config.accounts.filter(a => !( (id && a.id === id) || sameIdentity(a, mgr) || a.name === name ));
        }

        if (hooks.reload) await hooks.reload();
        console.log(`[AgentLB] Removed account "${name}" (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: name, id }));
        return;
      }

      // Accounts: Probe single account (POST /api/accounts/probe-single & POST /accounts/probe-single)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/probe-single' || normApiPath === '/accounts/probe-single')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.account || body?.id || body?.name;
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account"' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const mgr = accountManager.accounts[index];
        if (hooks.probeAccount) {
          await hooks.probeAccount(mgr);
        } else if (hooks.probeQuota) {
          await hooks.probeQuota();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });

        res.end(JSON.stringify({ ok: true, account: mgr.name, quota: mgr.quota }));
        return;
      }

      // Accounts: Consume reset credit (POST /api/accounts/consume-reset-credit & POST /accounts/consume-reset-credit)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/consume-reset-credit' || normApiPath === '/accounts/consume-reset-credit')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.account || body?.id || body?.name;
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account"' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const result = await accountManager.consumeResetCredit(index, body.credit_id);
        if (!result.ok) {
          res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: result.error || 'Nie udało się zużyć kredytu resetu' }));
          return;
        }

        console.log(`[AgentLB] Consumed reset credit for account "${accountManager.accounts[index].name}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: accountManager.accounts[index].name, result }));
        return;
      }

      // Accounts: Set routing policy (POST /api/accounts/policy & POST /accounts/policy)
      if (req.method === 'POST' && (normApiPath === '/api/accounts/policy' || normApiPath === '/accounts/policy')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const target = body?.account || body?.id || body?.name;
        const policy = body?.policy === 'burn-first' ? 'burn-first' : 'normal';
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account"' }));
          return;
        }

        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }

        const mgr = accountManager.accounts[index];
        accountManager.setRoutingPolicy(index, policy);

        await atomicConfigUpdate(disk => {
          const dAcct = (disk.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name);
          if (dAcct) {
            dAcct.routingPolicy = policy;
          }
        });

        const cAcct = (config.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name);
        if (cAcct) {
          cAcct.routingPolicy = policy;
        }

        console.log(`[AgentLB] Account "${mgr.name}" routing policy set to "${policy}" (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: mgr.name, routingPolicy: policy }));
        return;
      }

      // Fleet Policy: Routing & Sessions Configuration (GET & POST /api/routing)
      if (req.method === 'GET' && (normApiPath === '/api/routing' || normApiPath === '/routing')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          distributeSessions: accountManager.distributionMode,
          distributeSessionsEnabled: accountManager.distributeSessions,
          expiryRouting: accountManager.expiryRouting,
          crossProviderFallback: accountManager.crossProviderFallback,
        }));
        return;
      }

      if (req.method === 'POST' && (normApiPath === '/api/routing' || normApiPath === '/routing')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        if (body?.resetDefaults) {
          body.distributeSessions = 'adaptive';
          body.expiryRouting = { enabled: true, tolerance: 1.5, preempt: true };
          body.crossProviderFallback = true;
          if (healthChecker) {
            healthChecker.reschedule({ enabled: true, intervalMs: 900000, trafficGracePeriodMs: 900000, errorBackoffMs: 3600000 });
            config.autoHealthCheck = { enabled: true, intervalSeconds: 900, trafficGracePeriodSeconds: 900, errorBackoffSeconds: 3600 };
          }
        }

        if (body?.distributeSessions !== undefined) {
          accountManager.setDistributeSessions(body.distributeSessions);
          config.distributeSessions = body.distributeSessions;
        }
        if (body?.expiryRouting !== undefined) {
          accountManager.setExpiryRouting(body.expiryRouting);
          config.expiryRouting = body.expiryRouting;
        }
        if (body?.crossProviderFallback !== undefined) {
          accountManager.setCrossProviderFallback(body.crossProviderFallback);
          config.crossProviderFallback = !!body.crossProviderFallback;
        }

        await atomicConfigUpdate(disk => {
          if (body?.distributeSessions !== undefined) disk.distributeSessions = body.distributeSessions;
          if (body?.expiryRouting !== undefined) disk.expiryRouting = body.expiryRouting;
          if (body?.crossProviderFallback !== undefined) disk.crossProviderFallback = body.crossProviderFallback;
          if (body?.resetDefaults) {
            disk.autoHealthCheck = { enabled: true, intervalSeconds: 900, trafficGracePeriodSeconds: 900, errorBackoffSeconds: 3600 };
          }
        });

        console.log(`[Agent-LB] Fleet routing policy updated: distributeSessions=${accountManager.distributionMode}, expiryRouting=${accountManager.expiryRouting?.enabled}, fallback=${accountManager.crossProviderFallback}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          distributeSessions: accountManager.distributionMode,
          distributeSessionsEnabled: accountManager.distributeSessions,
          expiryRouting: accountManager.expiryRouting,
          crossProviderFallback: accountManager.crossProviderFallback,
          autoHealthCheck: healthChecker ? healthChecker.getStatus() : undefined,
        }));
        return;
      }

      // Drain control endpoints (POST /api/drain, POST /api/drain/cancel, GET /api/drain/status)
      if (req.method === 'POST' && (normApiPath === '/api/drain' || normApiPath === '/drain')) {
        drainState.isDraining = true;
        drainState.drainStartedAt = Date.now();
        accountManager.setDistributeSessions(false, { drain: true });
        console.log(`[Agent-LB] Drain initiated (web control). Active requests: ${drainState.activeRequests}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, draining: true, activeRequests: drainState.activeRequests, startedAt: drainState.drainStartedAt }));
        return;
      }

      if (req.method === 'POST' && (normApiPath === '/api/drain/cancel' || normApiPath === '/drain/cancel')) {
        drainState.isDraining = false;
        drainState.drainStartedAt = null;
        accountManager.setDistributeSessions(config.distributeSessions || 'adaptive', { drain: false });
        console.log(`[Agent-LB] Drain cancelled (web control). Active requests: ${drainState.activeRequests}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, draining: false, activeRequests: drainState.activeRequests }));
        return;
      }

      if (req.method === 'GET' && (normApiPath === '/api/drain/status' || normApiPath === '/drain/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, draining: drainState.isDraining, activeRequests: drainState.activeRequests, startedAt: drainState.drainStartedAt }));
        return;
      }

      // System Reboot / Restart endpoint (POST /api/system/reboot, POST /api/system/restart, POST /api/reboot)
      if (req.method === 'POST' && (
        normApiPath === '/api/system/reboot' ||
        normApiPath === '/api/system/restart' ||
        normApiPath === '/api/reboot' ||
        normApiPath === '/api/restart' ||
        normApiPath === '/reboot' ||
        normApiPath === '/restart'
      )) {
        console.log('[AgentLB] Server reboot requested by authorized client');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Server reboot initiated. Restarting process...' }));

        if (hooks.reboot) {
          try { hooks.reboot(); } catch (err) { console.error('[AgentLB] hooks.reboot failed:', err.message); }
          return;
        }

        setTimeout(async () => {
          try {
            const { exec } = await import('node:child_process');
            exec('systemctl --user restart agentlb.service', (err) => {
              if (err) {
                console.log('[AgentLB] systemctl restart error or not running under systemd, exiting process directly:', err.message);
                process.exit(0);
              }
            });
            setTimeout(() => { process.exit(0); }, 2500);
          } catch {
            process.exit(0);
          }
        }, 400);
        return;
      }

      // Test Chat Endpoint (POST /api/test/chat & POST /api/chat/test)
      if (req.method === 'POST' && (normApiPath === '/api/test/chat' || normApiPath === '/api/chat/test')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        let provider = (body?.provider || 'anthropic').toLowerCase();
        if (provider === 'claude') provider = 'anthropic';
        if (provider === 'openai') provider = 'codex';
        const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : (provider === 'codex' ? 'gpt-5.6-sol' : 'claude-haiku-4-5-20251001');
        const message = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : 'Test połączenia z Agent-LB. Odpowiedz krótko w jednym zdaniu kim jesteś.';
        const targetAccount = typeof body?.account === 'string' && body.account.trim() ? body.account.trim() : null;

        // Build list of candidate accounts to try
        let candidates = [];
        if (targetAccount) {
          const acc = accountManager.accounts.find(a => a.name === targetAccount);
          if (!acc) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Konto "${targetAccount}" nie zostało znalezione.` }));
            return;
          }
          candidates = [acc];
        } else {
          // Auto mode: find all non-disabled accounts matching provider
          const matching = accountManager.accounts.filter(a => !a.disabled && providerOf(a) === provider);
          // Sort:
          // 1. Healthy first (unavailableReason === null)
          // 2. Lower priority number first (0 before 1)
          // 3. Lower utilization first
          candidates = [...matching].sort((a, b) => {
            const unavailA = accountManager.unavailableReason(a, model) === null ? 0 : 1;
            const unavailB = accountManager.unavailableReason(b, model) === null ? 0 : 1;
            if (unavailA !== unavailB) return unavailA - unavailB;
            const prioA = a.priority || 0;
            const prioB = b.priority || 0;
            if (prioA !== prioB) return prioA - prioB;
            const utilA = Math.max(a.quota?.unified5hUtilization || 0, a.quota?.unified7dUtilization || 0);
            const utilB = Math.max(b.quota?.unified5hUtilization || 0, b.quota?.unified7dUtilization || 0);
            return utilA - utilB;
          });

          // Cross-provider fallback if no matching accounts
          if (candidates.length === 0 && accountManager.crossProviderFallback) {
            const fallbackMatching = accountManager.accounts.filter(a => !a.disabled && providerOf(a) !== provider);
            candidates = [...fallbackMatching].sort((a, b) => {
              const unavailA = accountManager.unavailableReason(a, model) === null ? 0 : 1;
              const unavailB = accountManager.unavailableReason(b, model) === null ? 0 : 1;
              if (unavailA !== unavailB) return unavailA - unavailB;
              return (a.priority || 0) - (b.priority || 0);
            });
          }
        }

        if (candidates.length === 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: exhaustedMessage(accountManager, model, 0, provider) || `Brak dostępnych aktywnych kont dla dostawcy ${provider}. Wszystkie konta wyczerpały limity lub są w trybie cooldown.`
          }));
          return;
        }

        let lastError = null;
        let lastStatus = 500;
        const triedAccounts = [];

        for (const account of candidates) {
          triedAccounts.push(account.name);
          const servingProvider = providerOf(account);
          const isFallback = servingProvider !== provider;
          const startTime = Date.now();

          await accountManager.ensureTokenFresh(account.index);

          try {
            let upstreamRes;
            let replyText = '';
            let usage = null;
            let responseModel = model;

            if (servingProvider === 'anthropic') {
              const upstreamUrl = `${upstreamFor(account, upstream)}/v1/messages`;
              const payload = {
                model,
                max_tokens: 512,
                system: [
                  {
                    type: 'text',
                    text: 'x-anthropic-billing-header: cc_version=2.1.251.76b; cc_entrypoint=sdk-cli;'
                  }
                ],
                messages: [{ role: 'user', content: message }]
              };
              const reqHeaders = {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31',
                'user-agent': 'claude-cli/2.1.251 (external, sdk-cli)',
                'x-app': 'cli',
                'accept': 'application/json'
              };
              applyAuthHeaders(reqHeaders, account);

              upstreamRes = await fetch(upstreamUrl, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify(payload)
              });

              const durationMs = Date.now() - startTime;
              if (upstreamRes.ok) {
                const data = await upstreamRes.json();
                responseModel = data.model || model;
                replyText = Array.isArray(data.content)
                  ? (data.content.filter(c => c.type === 'text').map(c => c.text || '').join('').trim() ||
                     data.content.map(c => c.text || c.thinking || '').join('').trim())
                  : (data.text || JSON.stringify(data));
                usage = data.usage || null;
                accountManager.clearRateLimited(account.index);
                accountManager.recordAccountSuccess(account);
                account.lastTest = { ok: true, durationMs, model: responseModel, timestamp: Date.now() };
                if (usage && auth.client) {
                  clientUsage?.record(auth.client, {
                    requests: 1,
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0
                  });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  ok: true,
                  provider,
                  servingProvider,
                  isFallback,
                  account: account.name,
                  model: responseModel,
                  reply: replyText,
                  usage,
                  durationMs,
                  triedAccounts: triedAccounts.length > 1 ? triedAccounts : undefined
                }));
                return;
              } else {
                let errorMsg = `HTTP ${upstreamRes.status}`;
                let errorReason = 'http_' + upstreamRes.status;
                try {
                  const errData = await upstreamRes.json();
                  errorMsg = errData.error?.message || errData.message || JSON.stringify(errData);
                } catch {
                  errorMsg = await upstreamRes.text().catch(() => errorMsg);
                }

                const rateLimitHeaders = {};
                for (const [key, value] of upstreamRes.headers.entries()) {
                  const k = key.toLowerCase();
                  if (k.startsWith('anthropic-ratelimit-') || k === 'retry-after') {
                    rateLimitHeaders[k] = value;
                  }
                }
                accountManager.updateQuota(account.index, rateLimitHeaders);

                if (upstreamRes.status === 429) {
                  const generalRejected = rateLimitHeaders['anthropic-ratelimit-unified-5h-status'] === 'rejected'
                    || rateLimitHeaders['anthropic-ratelimit-unified-7d-status'] === 'rejected';

                  let hold = 60;
                  const retryAfterHeader = upstreamRes.headers.get('retry-after');
                  const parsedRetryAfter = parseInt(retryAfterHeader, 10);
                  const requestScoped = retryAfterHeader == null && Object.keys(rateLimitHeaders).length === 0;
                  errorReason = requestScoped ? 'upstream-refusal' : 'rate-limit';

                  if (generalRejected) {
                    const resetTime = account?.quota?.unified5hReset || account?.quota?.unified7dReset;
                    if (resetTime && resetTime > Date.now()) {
                      hold = Math.ceil((resetTime - Date.now()) / 1000);
                    } else {
                      hold = 3600;
                    }
                    hold = Math.min(Math.max(hold, 60), 86400);
                    accountManager.markRateLimited(account.index, hold);
                    const resetTimeStr = resetTime ? new Date(resetTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
                    errorMsg = `Limit zapytań (Quota 100% / rejected) osiągnięty w Anthropic dla konta "${account.name}" (${model}). Reset ok. ${resetTimeStr || 'nieznany'}.`;
                  } else if (!requestScoped) {
                    if (!Number.isNaN(parsedRetryAfter) && parsedRetryAfter > 0) {
                      hold = parsedRetryAfter;
                    } else {
                      hold = 60;
                    }
                    hold = Math.min(Math.max(hold, 1), 300);
                    accountManager.markRateLimited(account.index, hold);
                    errorMsg = `Limit zapytań (429 Rate Limit / cooldown ${hold}s) w Anthropic dla konta "${account.name}" (${model}).`;
                  } else {
                    errorMsg = `Odmowa upstreamu (429 Request Refusal): ${errorMsg}`;
                  }

                  account.lastError = {
                    reason: errorReason,
                    status: 429,
                    error: errorMsg,
                    timestamp: Date.now()
                  };
                } else if (upstreamRes.status === 400 && /identity\s*verification/i.test(errorMsg)) {
                  errorReason = 'identity-verification';
                  accountManager.markIdentityVerificationRequired(account.index);
                  errorMsg = `Wymagana weryfikacja tożsamości (400 Identity Verification) na koncie "${account.name}". Zaloguj się na claude.ai i potwierdź numer telefonu/SMS.`;
                  account.lastError = {
                    reason: 'identity-verification',
                    status: 400,
                    error: errorMsg,
                    timestamp: Date.now()
                  };
                } else if (upstreamRes.status === 403) {
                  errorReason = 'entitlement';
                  accountManager.markEntitlementDenied(account.index);
                  errorMsg = `Odmowa dostępu OAuth (403 Organization Block). Anthropic zablokował użycie tokenów OAuth dla organizacji konta "${account.name}".`;
                  account.lastError = {
                    reason: 'entitlement',
                    status: 403,
                    error: errorMsg,
                    timestamp: Date.now()
                  };
                } else if (upstreamRes.status >= 500) {
                  errorReason = 'server_error';
                  accountManager.recordAccountFailure(account);
                  account.lastError = {
                    reason: 'server_error',
                    status: upstreamRes.status,
                    error: `Błąd serwera upstream (${upstreamRes.status}): ${errorMsg}`,
                    timestamp: Date.now()
                  };
                }
                account.lastTest = {
                  ok: false,
                  status: upstreamRes.status,
                  reason: errorReason,
                  error: errorMsg,
                  timestamp: Date.now()
                };
                lastError = errorMsg;
                lastStatus = upstreamRes.status;

                if (targetAccount) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ok: false,
                    status: upstreamRes.status,
                    provider,
                    servingProvider,
                    isFallback,
                    account: account.name,
                    model,
                    error: errorMsg,
                    durationMs
                  }));
                  return;
                }
                console.warn(`[AgentLB] Test chat failed on "${account.name}" (${upstreamRes.status}): ${errorMsg}. Sprawdzanie kolejnego konta...`);
                continue;
              }
            } else {
              // Codex / OpenAI
              const isOauth = account.type === 'oauth';
              const upstreamUrl = isOauth
                ? `${upstreamFor(account)}/backend-api/codex/responses`
                : `${upstreamFor(account)}/v1/chat/completions`;

              const reqHeaders = {
                'content-type': 'application/json',
                'accept': isOauth ? 'text/event-stream, application/json;q=0.9, */*;q=0.8' : 'application/json'
              };
              applyAuthHeaders(reqHeaders, account);

              let effectiveModel = model;
              if (isOauth) {
                if (effectiveModel === 'gpt-6') {
                  effectiveModel = 'gpt-6-astra';
                } else if (effectiveModel === 'gpt-5.6' || effectiveModel === 'gpt-5' || effectiveModel === 'codex') {
                  effectiveModel = 'gpt-5.6-sol';
                }
              }
              responseModel = effectiveModel;

              const reasoningEffort = typeof body?.effort === 'string' && body.effort.trim()
                ? body.effort.trim().toLowerCase()
                : (typeof body?.reasoningEffort === 'string' && body.reasoningEffort.trim() ? body.reasoningEffort.trim().toLowerCase() : null);

              const payload = isOauth
                ? {
                    model: effectiveModel,
                    store: false,
                    stream: true,
                    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
                    input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }]
                  }
                : {
                    model: effectiveModel,
                    messages: [{ role: 'user', content: message }]
                  };

              upstreamRes = await fetch(upstreamUrl, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify(payload)
              });

              const durationMs = Date.now() - startTime;
              if (upstreamRes.ok) {
                const cType = upstreamRes.headers.get('content-type') || '';
                if (cType.includes('text/event-stream') && upstreamRes.body && typeof upstreamRes.body.getReader === 'function') {
                  const reader = upstreamRes.body.getReader();
                  const decoder = new TextDecoder('utf-8');
                  let streamBuf = '';
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    streamBuf += decoder.decode(value, { stream: true });
                    const lines = streamBuf.split('\n');
                    streamBuf = lines.pop() || '';
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (!trimmed.startsWith('data:')) continue;
                      const dataStr = trimmed.slice(5).trim();
                      if (dataStr === '[DONE]') continue;
                      try {
                        const item = JSON.parse(dataStr);
                        const deltaText = (typeof item.delta === 'string' ? item.delta : null)
                          || (item.type === 'response.output_text.delta' && typeof item.delta === 'string' ? item.delta : null)
                          || (item.type === 'response.text.delta' && typeof item.delta === 'string' ? item.delta : null)
                          || item.delta?.text
                          || item.choices?.[0]?.delta?.content
                          || item.output?.[0]?.content?.[0]?.text
                          || (item.type === 'response.output_item.added' && item.item?.content?.[0]?.text)
                          || '';
                        if (deltaText) replyText += deltaText;
                        if (!replyText && item.text) replyText = item.text;
                        if (!replyText && item.part?.text) replyText = item.part.text;
                        if (!replyText && item.item?.content?.[0]?.text) replyText = item.item.content[0].text;
                        if (item.usage) usage = item.usage;
                        if (item.response?.usage) usage = item.response.usage;
                        if (item.model) responseModel = item.model;
                        if (item.response?.model) responseModel = item.response.model;
                      } catch { /* skip non-JSON stream lines */ }
                    }
                  }
                  if (!replyText.trim()) replyText = '(Odpowiedź strumieniowa zakończona pomyślnie)';
                } else {
                  const rawText = await upstreamRes.text();
                  if (rawText.includes('data:') || rawText.trim().startsWith('event:')) {
                    const lines = rawText.split('\n');
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (!trimmed.startsWith('data:')) continue;
                      const dataStr = trimmed.slice(5).trim();
                      if (dataStr === '[DONE]') continue;
                      try {
                        const item = JSON.parse(dataStr);
                        const deltaText = (typeof item.delta === 'string' ? item.delta : null)
                          || (item.type === 'response.output_text.delta' && typeof item.delta === 'string' ? item.delta : null)
                          || (item.type === 'response.text.delta' && typeof item.delta === 'string' ? item.delta : null)
                          || item.delta?.text
                          || item.choices?.[0]?.delta?.content
                          || item.output?.[0]?.content?.[0]?.text
                          || (item.type === 'response.output_item.added' && item.item?.content?.[0]?.text)
                          || '';
                        if (deltaText) replyText += deltaText;
                        if (!replyText && item.text) replyText = item.text;
                        if (!replyText && item.part?.text) replyText = item.part.text;
                        if (!replyText && item.item?.content?.[0]?.text) replyText = item.item.content[0].text;
                        if (item.usage) usage = item.usage;
                        if (item.response?.usage) usage = item.response.usage;
                        if (item.model) responseModel = item.model;
                        if (item.response?.model) responseModel = item.response.model;
                      } catch { /* skip non-JSON stream lines */ }
                    }
                    if (!replyText.trim()) replyText = '(Odpowiedź strumieniowa zakończona pomyślnie)';
                  } else {
                    let data = {};
                    try {
                      data = JSON.parse(rawText);
                    } catch {
                      data = { response: rawText };
                    }
                    responseModel = data.model || model;
                    if (isOauth) {
                      replyText = data.output?.[0]?.content?.[0]?.text
                        || data.message?.content?.parts?.[0]
                        || (typeof data.response === 'string' ? data.response : '')
                        || (data.choices?.[0]?.message?.content)
                        || JSON.stringify(data);
                    } else {
                      replyText = data.choices?.[0]?.message?.content || rawText;
                    }
                    usage = data.usage || null;
                  }
                }
                accountManager.clearRateLimited(account.index);
                accountManager.recordAccountSuccess(account);
                account.lastTest = { ok: true, durationMs, model: responseModel, timestamp: Date.now() };
                if (usage && auth.client) {
                  clientUsage?.record(auth.client, {
                    requests: 1,
                    inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
                    outputTokens: usage.completion_tokens || usage.output_tokens || 0
                  });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  ok: true,
                  provider,
                  servingProvider,
                  isFallback,
                  account: account.name,
                  model: responseModel,
                  effort: reasoningEffort || undefined,
                  reply: replyText,
                  usage,
                  durationMs,
                  triedAccounts: triedAccounts.length > 1 ? triedAccounts : undefined
                }));
                return;
              } else {
                let errorMsg = `HTTP ${upstreamRes.status}`;
                let errorReason = 'http_' + upstreamRes.status;
                let errData = null;
                try {
                  errData = await upstreamRes.json();
                  errorMsg = errData.error?.message || errData.detail || errData.message || JSON.stringify(errData);
                } catch {
                  errorMsg = await upstreamRes.text().catch(() => errorMsg);
                }

                if (isOauth && upstreamRes.status === 400 && typeof errorMsg === 'string' && errorMsg.includes('not supported when using Codex with a ChatGPT account')) {
                  errorMsg += ` (Wskazówka: backend ChatGPT Codex dla kont subskrypcyjnych OAuth obsługuje model 'gpt-5.6-sol' lub alias 'gpt-5.6'. Modele OpenAI API o3-mini/o1/gpt-4o wymagają konta z kluczem OpenAI API).`;
                }

                const codexRateLimitHeaders = {};
                for (const [key, value] of upstreamRes.headers.entries()) {
                  const k = key.toLowerCase();
                  if (k.startsWith('x-codex-') || k === 'retry-after') {
                    codexRateLimitHeaders[k] = value;
                  }
                }
                accountManager.updateQuota(account.index, codexRateLimitHeaders);

                if (upstreamRes.status === 429) {
                  const isUsageLimit = isOauth && (errData?.error?.type === 'usage_limit_reached' || codexRateLimitHeaders['x-codex-primary-used-percent'] === '100');
                  if (isUsageLimit) {
                    errorReason = 'quota';
                    account.status = 'exhausted';
                    const resetSec = errData?.error?.resets_in_seconds || parseInt(codexRateLimitHeaders['x-codex-primary-reset-after-seconds'], 10) || 3600;
                    account.exhaustedUntil = Date.now() + resetSec * 1000;
                    const resetMin = Math.ceil(resetSec / 60);
                    errorMsg = `Limit zapytań ChatGPT Plus wyczerpany (100% quota / reset za ok. ${resetMin} min) dla konta "${account.name}".`;
                    account.lastError = {
                      reason: 'quota',
                      status: 429,
                      error: errorMsg,
                      timestamp: Date.now()
                    };
                  } else {
                    errorReason = 'rate-limit';
                    const retryAfterHeader = upstreamRes.headers.get('retry-after');
                    let retryAfter = parseInt(retryAfterHeader, 10);
                    if (Number.isNaN(retryAfter) || retryAfter <= 0) retryAfter = 60;
                    retryAfter = Math.min(Math.max(retryAfter, 1), 300);
                    accountManager.markRateLimited(account.index, retryAfter);
                    errorMsg = `Limit zapytań (429 Rate Limit / cooldown ${retryAfter}s) w ChatGPT/Codex dla konta "${account.name}".`;
                    account.lastError = {
                      reason: 'rate-limit',
                      status: 429,
                      error: errorMsg,
                      timestamp: Date.now()
                    };
                  }
                } else if (upstreamRes.status === 401 || upstreamRes.status === 403) {
                  errorReason = 'auth';
                  account.lastError = {
                    reason: 'auth',
                    status: upstreamRes.status,
                    error: `Błąd autoryzacji (${upstreamRes.status}): ${errorMsg}`,
                    timestamp: Date.now()
                  };
                } else if (upstreamRes.status >= 500) {
                  errorReason = 'server_error';
                  accountManager.recordAccountFailure(account);
                  account.lastError = {
                    reason: 'server_error',
                    status: upstreamRes.status,
                    error: `Błąd serwera upstream Codex (${upstreamRes.status}): ${errorMsg}`,
                    timestamp: Date.now()
                  };
                }
                account.lastTest = {
                  ok: false,
                  status: upstreamRes.status,
                  reason: errorReason,
                  error: errorMsg,
                  timestamp: Date.now()
                };
                lastError = errorMsg;
                lastStatus = upstreamRes.status;

                if (targetAccount) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ok: false,
                    status: upstreamRes.status,
                    provider,
                    servingProvider,
                    isFallback,
                    account: account.name,
                    model,
                    error: errorMsg,
                    durationMs
                  }));
                  return;
                }
                console.warn(`[AgentLB] Test chat failed on "${account.name}" (${upstreamRes.status}): ${errorMsg}. Sprawdzanie kolejnego konta...`);
                continue;
              }
            }
          } catch (netErr) {
            accountManager.recordAccountFailure(account);
            lastError = `Błąd sieci podczas łączenia z kontem "${account.name}": ${netErr.message}`;
            lastStatus = 502;
            if (targetAccount) {
              const durationMs = Date.now() - startTime;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: false,
                status: 502,
                provider,
                servingProvider,
                account: account.name,
                model,
                error: lastError,
                durationMs
              }));
              return;
            }
            console.warn(`[AgentLB] Test chat network error on "${account.name}": ${netErr.message}. Sprawdzanie kolejnego konta...`);
            continue;
          }
        }

        // All candidates failed in Auto mode
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          status: lastStatus,
          provider,
          error: `Wszystkie wypróbowane konta (${triedAccounts.join(', ')}) zgłosiły błąd. Ostatni błąd: ${lastError}`,
          triedAccounts
        }));
        return;
      }

      // Health-Check: Status (GET /api/health-check/status)
      if (req.method === 'GET' && (normApiPath === '/api/health-check/status' || normApiPath === '/health-check/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, healthCheck: healthChecker.getStatus() }));
        return;
      }

      // Health-Check: Run cycle (POST /api/health-check/run)
      if (req.method === 'POST' && (normApiPath === '/api/health-check/run' || normApiPath === '/health-check/run')) {
        let bodyObj = {};
        try {
          const raw = await readControlBody(req);
          if (raw) bodyObj = JSON.parse(raw);
        } catch {}
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const force = bodyObj.force != null ? !!bodyObj.force : (urlObj.searchParams.get('force') === 'true');
        const summary = await healthChecker.runCheckCycle({ force });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, summary }));
        return;
      }

      // Health-Check: Configure (POST /api/health-check/config)
      if (req.method === 'POST' && (normApiPath === '/api/health-check/config' || normApiPath === '/health-check/config')) {
        let bodyObj = {};
        try {
          const raw = await readControlBody(req);
          if (raw) bodyObj = JSON.parse(raw);
        } catch {}
        const enabled = bodyObj.enabled != null ? !!bodyObj.enabled : healthChecker.enabled;
        const intervalMs = bodyObj.intervalSeconds != null ? Number(bodyObj.intervalSeconds) * 1000 : healthChecker.intervalMs;
        const trafficGracePeriodMs = bodyObj.trafficGracePeriodSeconds != null ? Number(bodyObj.trafficGracePeriodSeconds) * 1000 : healthChecker.trafficGracePeriodMs;
        const errorBackoffMs = bodyObj.errorBackoffSeconds != null ? Number(bodyObj.errorBackoffSeconds) * 1000 : healthChecker.errorBackoffMs;

        healthChecker.reschedule({ enabled, intervalMs, trafficGracePeriodMs, errorBackoffMs });

        config.autoHealthCheck = {
          enabled: healthChecker.enabled,
          intervalSeconds: Math.round(healthChecker.intervalMs / 1000),
          trafficGracePeriodSeconds: Math.round(healthChecker.trafficGracePeriodMs / 1000),
          errorBackoffSeconds: Math.round(healthChecker.errorBackoffMs / 1000),
        };

        atomicConfigUpdate(cfg => {
          cfg.autoHealthCheck = { ...config.autoHealthCheck };
        }).catch(() => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, healthCheck: healthChecker.getStatus() }));
        return;
      }

      // Accounts: Export (GET /api/accounts/export & GET /accounts/export)
      if (req.method === 'GET' && (normApiPath === '/api/accounts/export' || normApiPath === '/accounts/export')) {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const target = urlObj.searchParams.get('account') || urlObj.searchParams.get('name') || urlObj.searchParams.get('id');
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account" query parameter' }));
          return;
        }
        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"` }));
          return;
        }
        const mgr = accountManager.accounts[index];
        const raw = (config.accounts || []).find(a => (mgr.id && a.id === mgr.id) || sameIdentity(a, mgr) || a.name === mgr.name) || mgr;
        const exportData = {
          name: mgr.name,
          provider: mgr.provider,
          type: mgr.type,
          planType: mgr.planType,
          email: mgr.email,
          accountId: mgr.accountId,
          priority: mgr.priority,
          routingPolicy: mgr.routingPolicy || 'normal',
          accessToken: raw.accessToken || raw.credential || mgr.credential,
          refreshToken: raw.refreshToken || mgr.refreshToken,
          expiresAt: raw.expiresAt || mgr.expiresAt,
          exportedAt: new Date().toISOString(),
        };
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(mgr.name)}-export.json"`,
        });
        res.end(JSON.stringify(exportData, null, 2));
        return;
      }

      // Accounts: Add (POST /agentlb/api/accounts/add & POST /agentlb/accounts/add)

      if (req.method === 'POST' && (normApiPath === '/api/accounts/add' || normApiPath === '/accounts/add')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const rawType = (body?.type || '').toLowerCase();
        const type = rawType || (body?.importFrom ? 'import' : (body?.apiKey ? 'api' : 'oauth'));
        const priority = Number.isInteger(body?.priority) ? body.priority : (parseInt(body?.priority, 10) || 0);

        // 1. Anthropic API Key (type: "api" or "apikey")
        if (type === 'api' || type === 'apikey') {
          const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
          if (!apiKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'missing "apiKey"' }));
            return;
          }

          let name = typeof body?.name === 'string' ? body.name.trim() : '';
          if (!name) {
            const count = (config.accounts || []).filter(a => a.name.startsWith('api-')).length + 1;
            name = `api-${count}`;
          }

          const newAccount = {
            id: mintAccountId(),
            name,
            type: 'apikey',
            apiKey,
            priority,
          };

          await atomicConfigUpdate(disk => {
            if (!Array.isArray(disk.accounts)) disk.accounts = [];
            disk.accounts.push(newAccount);
          });

          if (hooks.reload) await hooks.reload();
          console.log(`[AgentLB] Added API key account "${name}" (web control)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account: name, id: newAccount.id, type: 'api' }));
          return;
        }

        // 3. Import from file path on server (importFrom or type: "import")
        if (type === 'import' || body?.importFrom) {
          const fromPath = (typeof body?.importFrom === 'string' ? body.importFrom : (body?.fromPath || '~/.claude/.credentials.json')).trim();
          const reqProvider = body?.provider || (fromPath.toLowerCase().includes('codex') ? 'codex' : 'anthropic');

          if (reqProvider === 'codex') {
            let codexCreds = null;
            try {
              codexCreds = await importCodexCredentials(fromPath);
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `Failed to import Codex credentials from "${fromPath}": ${err.message}` }));
              return;
            }

            let name = typeof body?.name === 'string' ? body.name.trim() : '';
            if (!name && codexCreds?.email) name = codexCreds.email;
            if (!name) {
              const count = (config.accounts || []).filter(a => a.provider === 'codex').length + 1;
              name = `codex-${count}`;
            }

            const newAccount = {
              id: mintAccountId(),
              name,
              type: 'oauth',
              provider: 'codex',
              importFrom: fromPath,
              source: 'import',
              accessToken: codexCreds.accessToken,
              refreshToken: codexCreds.refreshToken || null,
              accountId: codexCreds.accountId || null,
              email: codexCreds.email || null,
              planType: codexCreds.planType || null,
              priority,
            };

            await atomicConfigUpdate(disk => {
              if (!Array.isArray(disk.accounts)) disk.accounts = [];
              disk.accounts.push(newAccount);
            });

            if (hooks.reload) await hooks.reload();
            console.log(`[AgentLB] Imported Codex account "${name}" from ${fromPath} (web control)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, account: name, id: newAccount.id, type: 'oauth', provider: 'codex', importFrom: fromPath, email: codexCreds?.email }));
            return;
          }

          let creds = null;
          try {
            creds = await importCredentials(fromPath);
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Failed to import credentials from "${fromPath}": ${err.message}` }));
            return;
          }

          let profile = null;
          if (creds?.accessToken) {
            try {
              profile = await fetchProfile(creds.accessToken);
            } catch { /* best effort */ }
          }

          let name = typeof body?.name === 'string' ? body.name.trim() : '';
          if (!name && profile?.email) name = profile.email;
          if (!name) {
            const count = (config.accounts || []).filter(a => a.name.startsWith('account-')).length + 1;
            name = `account-${count}`;
          }

          const newAccount = {
            id: mintAccountId(),
            name,
            type: 'oauth',
            importFrom: fromPath,
            source: 'import',
            accessToken: creds?.accessToken,
            refreshToken: creds?.refreshToken || null,
            expiresAt: creds?.expiresAt || null,
            accountUuid: profile?.accountUuid || null,
            orgUuid: profile?.orgUuid || null,
            orgName: profile?.orgName || null,
            organizationType: profile?.organizationType || null,
            rateLimitTier: profile?.rateLimitTier || null,
            seatTier: profile?.seatTier || null,
            hasClaudeMax: profile?.hasClaudeMax ?? null,
            hasClaudePro: profile?.hasClaudePro ?? null,
            priority,
          };

          await atomicConfigUpdate(disk => {
            if (!Array.isArray(disk.accounts)) disk.accounts = [];
            disk.accounts.push(newAccount);
          });

          if (hooks.reload) await hooks.reload();
          console.log(`[AgentLB] Imported account "${name}" from ${fromPath} (web control)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account: name, id: newAccount.id, type: 'oauth', importFrom: fromPath }));
          return;
        }

        // 2. OAuth session (pasted tokens or credentials JSON)
        if (type === 'oauth') {
          let accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
          let refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : null;
          let expiresAt = typeof body?.expiresAt === 'number' ? body.expiresAt : null;
          let name = typeof body?.name === 'string' ? body.name.trim() : '';

          const jsonInput = body?.credentialsJson || body?.credentials;
          if (jsonInput) {
            try {
              const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
              const data = parsed.claudeAiOauth || parsed;
              if (data.accessToken) accessToken = data.accessToken;
              if (data.refreshToken) refreshToken = data.refreshToken;
              if (data.expiresAt) expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : (typeof data.expiresAt === 'string' ? new Date(data.expiresAt).getTime() : null);
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid credentials JSON: ' + e.message }));
              return;
            }
          }

          if (!accessToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'missing accessToken' }));
            return;
          }

          let profile = null;
          try {
            profile = await fetchProfile(accessToken);
          } catch { /* best effort */ }

          if (!name && profile?.email) name = profile.email;
          if (!name) {
            const count = (config.accounts || []).filter(a => a.name.startsWith('account-')).length + 1;
            name = `account-${count}`;
          }

          const newAccount = {
            id: mintAccountId(),
            name,
            type: 'oauth',
            source: 'web',
            accessToken,
            refreshToken,
            expiresAt,
            accountUuid: profile?.accountUuid || null,
            orgUuid: profile?.orgUuid || null,
            orgName: profile?.orgName || null,
            organizationType: profile?.organizationType || null,
            rateLimitTier: profile?.rateLimitTier || null,
            seatTier: profile?.seatTier || null,
            hasClaudeMax: profile?.hasClaudeMax ?? null,
            hasClaudePro: profile?.hasClaudePro ?? null,
            priority,
          };

          await atomicConfigUpdate(disk => {
            if (!Array.isArray(disk.accounts)) disk.accounts = [];
            const idx = findUpsertTarget(disk.accounts, newAccount);
            if (idx >= 0) {
              const prev = disk.accounts[idx];
              disk.accounts[idx] = { ...prev, ...newAccount, id: prev.id || newAccount.id, name: prev.name };
              name = prev.name;
            } else {
              disk.accounts.push(newAccount);
            }
          });

          if (hooks.reload) await hooks.reload();
          console.log(`[AgentLB] Added/updated OAuth account "${name}" (web control)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account: name, id: newAccount.id, type: 'oauth', email: profile?.email }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `unsupported account type "${type}"` }));
        return;
      }

      // OAuth Flow: Start
      if (req.method === 'GET' && (normApiPath === '/oauth/start' || reqPath === '/agent-lb/oauth/start')) {
        cleanExpiredOAuthStates();
        const reqUrl = new URL(req.url, 'http://localhost');
        const provider = reqUrl.searchParams.get('provider') || 'anthropic';
        const codeVerifier = randomBytes(32).toString('base64url');
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        const state = randomBytes(32).toString('base64url');

        if (provider === 'codex') {
          const authUrl = buildCodexAuthUrl({ state, codeChallenge });
          pendingOAuthStates.set(state, { codeVerifier, createdAt: Date.now(), provider: 'codex' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            authUrl,
            state,
            provider: 'codex',
          }));
          return;
        }

        const redirectUri = MANUAL_LOGIN_REDIRECT_URI;

        const authUrl = new URL(OAUTH_AUTHORIZE);
        authUrl.searchParams.set('code', 'true');
        authUrl.searchParams.set('client_id', DEFAULT_CLIENT_ID);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', OAUTH_SCOPES);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('state', state);

        pendingOAuthStates.set(state, { codeVerifier, createdAt: Date.now(), provider: 'anthropic' });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          authUrl: authUrl.toString(),
          state,
          provider: 'anthropic',
        }));
        return;
      }

      // Device Code Flow: Start — request a device code from OpenAI
      if (req.method === 'POST' && (normApiPath === '/oauth/device-start' || reqPath === '/agent-lb/oauth/device-start')) {
        cleanExpiredOAuthStates();
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid request body' }));
          return;
        }
        const provider = body?.provider || 'codex';
        if (provider !== 'codex') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Device code flow is only supported for the codex provider' }));
          return;
        }
        try {
          const dc = await requestDeviceCode();
          // Store the pending device auth so device-poll can look it up.
          pendingOAuthStates.set(dc.deviceAuthId, {
            createdAt: Date.now(),
            provider: 'codex',
            type: 'device-code',
            userCode: dc.userCode,
            interval: dc.interval,
            expiresAt: dc.expiresAt,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            deviceAuthId: dc.deviceAuthId,
            userCode: dc.userCode,
            verificationUrl: DEVICE_VERIFICATION_URL,
            interval: dc.interval,
            expiresAt: dc.expiresAt,
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Device code request failed: ' + err.message }));
        }
        return;
      }

      // Device Code Flow: Poll — check whether the user has approved the code
      if (req.method === 'POST' && (normApiPath === '/oauth/device-poll' || reqPath === '/agent-lb/oauth/device-poll')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid request body' }));
          return;
        }
        const deviceAuthId = body?.deviceAuthId;
        const userCode = body?.userCode;
        if (!deviceAuthId || !userCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'deviceAuthId and userCode are required' }));
          return;
        }
        const stored = pendingOAuthStates.get(deviceAuthId);
        if (!stored || stored.type !== 'device-code') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unknown or expired device auth session' }));
          return;
        }

        // Single poll attempt (no loop — the dashboard frontend re-calls every N seconds)
        try {
          let result;
          try {
            result = await pollDeviceCodeOnce({ deviceAuthId, userCode, signal: AbortSignal.timeout(15_000) });
          } catch (err) {
            pendingOAuthStates.delete(deviceAuthId);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message || 'device code rejected' }));
            return;
          }
          if (result.status === 'pending') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: 'pending' }));
            return;
          }
          const codexCreds = result.credentials;

          pendingOAuthStates.delete(deviceAuthId);

          const priority = Number.isInteger(body?.priority) ? body.priority : (parseInt(body?.priority, 10) || 0);
          let name = typeof body?.name === 'string' ? body.name.trim() : '';
          if (!name && codexCreds?.email) name = codexCreds.email;
          if (!name) {
            const count = (config.accounts || []).filter(a => a.provider === 'codex').length + 1;
            name = `codex-${count}`;
          }

          const newAccount = {
            id: mintAccountId(),
            name,
            type: 'oauth',
            provider: 'codex',
            source: 'web-device-code',
            accessToken: codexCreds.accessToken,
            refreshToken: codexCreds.refreshToken || null,
            accountId: codexCreds.accountId || null,
            email: codexCreds.email || null,
            planType: codexCreds.planType || null,
            expiresAt: codexCreds.expiresAt || null,
            priority,
          };

          await atomicConfigUpdate(disk => {
            if (!Array.isArray(disk.accounts)) disk.accounts = [];
            const idx = findUpsertTarget(disk.accounts, newAccount);
            if (idx >= 0) {
              const prev = disk.accounts[idx];
              disk.accounts[idx] = { ...prev, ...newAccount, id: prev.id || newAccount.id, name: prev.name };
              name = prev.name;
            } else {
              disk.accounts.push(newAccount);
            }
          });

          if (hooks.reload) await hooks.reload();
          console.log(`[AgentLB] Successfully authenticated Codex account "${name}" via device code (web control)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'complete', account: name, email: codexCreds?.email }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Device code poll error: ' + err.message }));
        }
        return;
      }

      // OAuth Flow: Complete
      if (req.method === 'POST' && (normApiPath === '/oauth/complete' || reqPath === '/agent-lb/oauth/complete')) {
        let body;
        try {
          const raw = await readControlBody(req);
          body = JSON.parse(raw || '{}');
        } catch (err) {
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }

        const rawCode = typeof body?.code === 'string' ? body.code.trim() : '';
        const state = typeof body?.state === 'string' ? body.state.trim() : '';
        const priority = Number.isInteger(body?.priority) ? body.priority : (parseInt(body?.priority, 10) || 0);
        let name = typeof body?.name === 'string' ? body.name.trim() : '';

        if (!state || !pendingOAuthStates.has(state)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid or expired OAuth state — please start login again' }));
          return;
        }

        const stored = pendingOAuthStates.get(state);
        const { codeVerifier } = stored;
        const provider = stored.provider || 'anthropic';
        pendingOAuthStates.delete(state);

        if (provider === 'codex') {
          let codeToExchange = rawCode;
          if (rawCode.includes('code=')) {
            try {
              const u = new URL(rawCode.startsWith('http') ? rawCode : `http://localhost/${rawCode}`);
              codeToExchange = u.searchParams.get('code') || rawCode;
            } catch {}
          }

          let codexCreds;
          try {
            codexCreds = await exchangeCodexCode({ code: codeToExchange, codeVerifier });
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Codex token exchange failed: ' + err.message }));
            return;
          }

          if (!name && codexCreds?.email) name = codexCreds.email;
          if (!name) {
            const count = (config.accounts || []).filter(a => a.provider === 'codex').length + 1;
            name = `codex-${count}`;
          }

          const newAccount = {
            id: mintAccountId(),
            name,
            type: 'oauth',
            provider: 'codex',
            source: 'web-oauth',
            accessToken: codexCreds.accessToken,
            refreshToken: codexCreds.refreshToken || null,
            accountId: codexCreds.accountId || null,
            email: codexCreds.email || null,
            planType: codexCreds.planType || null,
            expiresAt: codexCreds.expiresAt || null,
            priority,
          };

          await atomicConfigUpdate(disk => {
            if (!Array.isArray(disk.accounts)) disk.accounts = [];
            const idx = findUpsertTarget(disk.accounts, newAccount);
            if (idx >= 0) {
              const prev = disk.accounts[idx];
              disk.accounts[idx] = { ...prev, ...newAccount, id: prev.id || newAccount.id, name: prev.name };
              name = prev.name;
            } else {
              disk.accounts.push(newAccount);
            }
          });

          if (hooks.reload) await hooks.reload();
          console.log(`[AgentLB] Successfully authenticated Codex OAuth account "${name}" (web control)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account: name, provider: 'codex', email: codexCreds?.email }));
          return;
        }

        let parsed;
        try {
          parsed = parseAuthCode(rawCode, state);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'could not parse authorization code: ' + err.message }));
          return;
        }

        if (!parsed || !parsed.code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'no authorization code found in input' }));
          return;
        }

        let tokenPair;
        try {
          tokenPair = await exchangeCodeForTokens(parsed.code, parsed.state, codeVerifier, MANUAL_LOGIN_REDIRECT_URI);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'token exchange failed: ' + err.message }));
          return;
        }

        let profile = null;
        try {
          profile = await fetchProfile(tokenPair.accessToken);
        } catch { /* best effort */ }

        if (!name && profile?.email) name = profile.email;
        if (!name) {
          const count = (config.accounts || []).filter(a => a.name.startsWith('account-')).length + 1;
          name = `account-${count}`;
        }

        const newAccount = {
          id: mintAccountId(),
          name,
          type: 'oauth',
          source: 'web-oauth',
          accountUuid: profile?.accountUuid || null,
          orgUuid: profile?.orgUuid || null,
          orgName: profile?.orgName || null,
          organizationType: profile?.organizationType || null,
          rateLimitTier: profile?.rateLimitTier || null,
          seatTier: profile?.seatTier || null,
          hasClaudeMax: profile?.hasClaudeMax ?? null,
          hasClaudePro: profile?.hasClaudePro ?? null,
          accessToken: tokenPair.accessToken,
          refreshToken: tokenPair.refreshToken,
          expiresAt: tokenPair.expiresAt,
          priority,
        };

        await atomicConfigUpdate(disk => {
          if (!Array.isArray(disk.accounts)) disk.accounts = [];
          const idx = findUpsertTarget(disk.accounts, newAccount);
          if (idx >= 0) {
            const prev = disk.accounts[idx];
            disk.accounts[idx] = { ...prev, ...newAccount, id: prev.id || newAccount.id, name: prev.name };
            name = prev.name;
          } else {
            disk.accounts.push(newAccount);
          }
        });

        if (hooks.reload) await hooks.reload();
        console.log(`[AgentLB] Successfully authenticated OAuth account "${name}" (web control)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: name, email: profile?.email }));
        return;
      }

      return forward(req, res);
    } catch (err) {
      reportFailure('[AgentLB] Unhandled error:', err);
      // The window above throws for real: `getStatusExtra` is a hook the
      // application installs, and reload/switch reach the account manager.
      answerUnhandled(res);
    }
  };

  // Opt-in egress pin: null unless config.egress.pin is set, and then shared by
  // the base listener and the MITM one so both honour the same hold.
  const forward = createProxyRequestListener({ accountManager, upstream, logDir, hooks, sx, holdMs, config, egress, clientUsage, dimensionUsage, fairShare, toolDedupe, drainState });
  const server = http.createServer(requestHandler);
  server.healthChecker = healthChecker;
  server.on('close', () => {
    healthChecker.stop();
  });

  // What bounds a directory of one-shot dumps is deleting the expired ones, not
  // rotating a growing file. Swept once at startup, because a backlog is usually
  // already sitting behind the restart that enables this, then on a timer. The
  // interval is unref'd so it never holds the process open.
  if (logDir) {
    const sweep = () => {
      // The message names the setting that stops it: the proxy self-updates, so
      // the first sweep can arrive with a release the operator never read about.
      const hours = resolveLogRetentionHours(config);
      return sweepRequestLogs(logDir, hours)
        .then((n) => {
          if (n) console.log(`[AgentLB] Removed ${n} expired request log(s) from ${logDir} (logRetentionHours=${hours}, set 0 to keep them)`);
        })
        .catch(() => {});
    };
    sweep();
    const sweepTimer = setInterval(sweep, LOG_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
    server.on('close', () => clearInterval(sweepTimer));
  }

  // Forward-proxy support (always on, so multiple claude instances can use
  // either ANTHROPIC_BASE_URL or HTTPS_PROXY against the same server). A CONNECT
  // to the upstream host is a transparent MITM relay (rewrite only auth); the
  // test host is answered locally; anything else is blind-tunneled. Certs are
  // minted lazily on the first intercepted CONNECT.
  // Every host the leaf must cover, not just the Anthropic upstream: a Codex
  // account is reached on chatgpt.com, and MITM cannot intercept a host its
  // certificate does not name.
  const mitmHostList = mitmHosts(config);
  let certsPromise = null;
  const ensureLeaf = async () => {
    // Reset the memo on failure so a transient cert error doesn't wedge the MITM
    // path permanently (a cached rejected promise would re-throw on every CONNECT).
    certsPromise ||= ensureCerts(mitmHostList).catch((err) => { certsPromise = null; throw err; });
    const c = await certsPromise;
    return { key: c.leafKeyPem, cert: c.leafCertPem };
  };
  server.on('connect', createConnectHandler({ config, accountManager, ensureLeaf, logDir, hooks, log: console.error, sx, egress, clientUsage, dimensionUsage }));
  // Remote Control's real-time channel is a WebSocket, not a request/response
  // call — Node fires 'upgrade' for that handshake, never 'request', so it
  // needs its own listener (base-URL routing path; the MITM path wires the
  // same relayUpgrade onto its own terminating server in mitm.js).
  server.on('upgrade', (req, socket, head) => {
    // Checked before the key gate: the Codex CLI authenticates with a Bearer
    // only, and answering its handshake 401 would read as an auth failure
    // rather than "use HTTP". See refuseCodexWebSocket.
    if (refuseCodexWebSocket(req, socket)) return;
    // The upgrade handshake never reaches requestHandler, so it does not
    // inherit the key gate above — it has to ask for itself. Without this a
    // WebSocket handshake is an unauthenticated relay to `upstream`: the
    // handshake carries no pooled credential (relayUpgrade forwards the
    // client's own headers), so it is not a way to spend the fleet's quota,
    // but it is a way to reach the upstream on this host's address and
    // bandwidth. A deployment on a public hostname hands that to anyone.
    const auth = resolveUpgradeAuth(req, socket, config.proxy);
    if (!auth.ok || !relayPolicyAllowed(auth, clientUsage)) {
      // Logged as well as answered: a WebSocket client discards the status
      // line, so the 401 alone leaves an operator with a channel that is
      // silently dead — the same shape as the outage this gate could cause if
      // a client turns out not to send the key.
      console.log(`[AgentLB] WebSocket upgrade refused (no proxy key) from ${safeLine(socket?.remoteAddress || 'unknown')} for ${safeLine(req.url)}`);
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch { /* already gone */ }
      socket.destroy();
      return;
    }
    // The identity the gate resolved rides along, as it does on the request
    // path (req.tcClient): a handshake authenticated with a client key is
    // attributed to that client, or it is a channel the operator cannot see
    // under `clients` at all (#325).
    relayUpgrade(req, socket, head, upstream, sx, { client: auth.client, clientUsage });
  });

  return server;
}

/**
 * Whether a control-plane POST did NOT come from a web page.
 *
 * Both headers are browser-set and unforgeable from page JavaScript:
 *   - `Sec-Fetch-Site` is the explicit answer where it exists (Chrome, Safari,
 *     Firefox). Anything but `same-origin` / `none` is a page reaching across.
 *   - `Origin` is the fallback for browsers that send no Sec-Fetch-Site. Its
 *     mere presence on a POST to a local control endpoint means a page issued
 *     it; matching it against our own host would mean guessing which of
 *     localhost / 127.0.0.1 / [::1] / a LAN address the caller used, so the
 *     Origin-only fallback admits no page at all.
 *
 * The dashboard's switch button is a browser-issued same-origin call and is
 * admitted by the Sec-Fetch-Site branch alone. A browser that sends Origin
 * without Sec-Fetch-Site (or a proxy that strips it) lands in the fallback
 * and is refused — deliberately: widening the fallback to guess our own host
 * is the trade this comment declines.
 *
 * Non-browser callers (curl, the CLI, `agentlb attach`) send neither and are
 * unaffected.
 */
export function isSameOriginControlRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  return !req.headers.origin;
}

// Names a browser can reach this machine by. `::ffff:127.0.0.1` is how a
// dual-stack listener reports loopback and is accepted for symmetry with
// isLoopbackAddr, though no browser writes it in a URL.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Binding to a wildcard says nothing about what name reaches us, so it does
// not widen the set.
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '']);

// The hostname part of a Host header (or a bind address): port stripped, IPv6
// brackets removed, lowercased. null when the value cannot be one.
function hostnameOf(host) {
  const h = String(host).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? null : h.slice(1, end);
  }
  // A bare IPv6 address (how config.proxy.host spells one) has several colons
  // and no port to strip; a `name:port` has exactly one.
  const colon = h.indexOf(':');
  if (colon >= 0 && h.indexOf(':', colon + 1) >= 0) return h;
  return colon >= 0 ? h.slice(0, colon) : h;
}

/**
 * Whether a request's Host header names this proxy, for the DNS-rebinding
 * check on key-less loopback requests.
 *
 * Accepted: localhost, 127.0.0.1, ::1 (bracketed or not), and the address the
 * proxy is bound to (`config.proxy.host`) unless that is a wildcard. Port and
 * case are ignored.
 *
 * A MISSING Host header is accepted. Only an HTTP/1.0 client can omit it (Node
 * rejects an HTTP/1.1 request without one before this code runs), and no
 * browser speaks HTTP/1.0 — while a hand-rolled local tool might. Refusing it
 * would break that tool without closing anything.
 */
export function isLocalHostHeader(host, bindHost = null, allowedHosts = [], proxyConfig = null) {
  if (host == null || host === '') return true;
  const name = hostnameOf(host);
  if (name == null) return false;
  if (LOCAL_HOSTNAMES.has(name)) return true;
  // MagicDNS names: only the configured tailnets when proxy.tailnetDomains is set.
  if (isTailnetHostName(name, proxyConfig)) return true;
  if (isTailnetAddr(name)) return true;
  const rawEnvHosts = [
    process.env.AGENT_LB_HOST,
    process.env.AGENTLB_HOST,
    process.env.CLAUDE_LB_HOST,
    'agentlb.gotova.pl',
    'agent-lb.gotova.pl',
  ].filter(Boolean).flatMap(h => typeof h === 'string' ? h.split(',').map(s => s.trim()) : []);
  if (rawEnvHosts.some(h => name === hostnameOf(h) || name.endsWith('.' + hostnameOf(h)))) return true;
  if (Array.isArray(allowedHosts) && allowedHosts.some(h => name === hostnameOf(h) || name.endsWith('.' + hostnameOf(h)))) return true;
  const bound = typeof bindHost === 'string' ? hostnameOf(bindHost) : null;
  return bound != null && !WILDCARD_BINDS.has(bound) && bound === name;
}

// Read a control-endpoint body as text. Capped, unlike the proxied request path:
// these endpoints carry a couple of fields, so anything larger is a mistake or an
// attack and buffering it whole would be the wrong answer either way.

/**
 * Resolve an account pin to an index, or null.
 *
 * Accepted forms, first match wins:
 *   - `accountUuid/orgUuid` — fully qualified, the only form that distinguishes
 *     one person's accounts across several orgs
 *   - `accountUuid`
 *   - `orgUuid`
 *   - the display name (`email` or `email (Org)`), or the bare email
 *
 * UUIDs are the identity to use for anything scripted or long-lived: display
 * names are rewritten in place when an email gains a second org (see
 * accountsCommand), so a name is a convenience, not an identifier.
 *
 * The rotation index is deliberately NOT accepted. It is array position, so
 * deleting an account would silently repoint every later pin at a DIFFERENT
 * account — a wrong-account misroute rather than an honest failure.
 */
export function resolveAccountPin(accountManager, token) {
  const accounts = accountManager.accounts || [];
  const norm = (s) => (s || '').trim().toLowerCase();
  const t = norm(token);
  if (!t) return null;

  const at = (pick) => accounts.findIndex(a => norm(pick(a)) === t);
  const qualified = accounts.findIndex(a => a.accountUuid && a.orgUuid
    && `${norm(a.accountUuid)}/${norm(a.orgUuid)}` === t);

  for (const i of [
    qualified,
    at(a => a.id),
    at(a => a.accountUuid),
    at(a => a.orgUuid),
    at(a => a.name),
    at(a => (a.name || '').split(' (')[0]), // display name minus the org suffix
  ]) if (i >= 0) return i;

  return null;
}

/**
 * What actually went wrong on a failed connect, as a string worth printing.
 *
 * Node's happy-eyeballs dialer (`autoSelectFamily`, on by default across the
 * versions this package supports; `package.json` declares `node >=20`, measured
 * here on 24) reports a connect where every address failed as an AggregateError.
 * Node builds that error with an empty `message`; the per-address reasons are in
 * `.errors`. Any multi-address host reaches this, and the upstream is one, so
 * `err.message` prints nothing for the failure operators most need to read.
 *
 * Looked for one level down as well, because `AGENT_LB_UPSTREAM_GLOBAL_FETCH`
 * routes through global fetch, which wraps the same failure in a TypeError whose
 * own message is the equally unhelpful "fetch failed".
 *
 * The `err.message` fallback is required: with `autoSelectFamily` off, and on
 * every single-address failure, the reason arrives as a plain Error in
 * `message`. It also covers a wrapper whose `.cause` carries no reasons.
 */
export function describeConnectError(err) {
  const reasons = (e) => (Array.isArray(e?.errors) ? e.errors.map(c => c?.message).filter(Boolean) : []);
  const own = reasons(err);
  // A wrapper with a non-aggregated cause (global fetch's TypeError('fetch
  // failed') around a single-address connect error) still says only 'fetch
  // failed' by itself; the cause's message is the reason.
  return (own.length ? own : reasons(err?.cause)).join('; ') || err?.cause?.message || err?.message;
}

// Paths that must reach upstream with the client's own credential (never a
// rotated account token): the Remote Control channel and attachment transfers.
// agentlb applies its account logic (rotation, exhaustion, token injection)
// ONLY to hosts it manages — the Anthropic upstream. Anything else must be
// forwarded transparently, never hijacked into "all accounts exhausted". For
// HTTPS this is already true (the CONNECT tunnel in mitm.js blind-relays
// non-upstream hosts). This is the plain-HTTP counterpart: a tool honoring
// HTTP_PROXY sends an ABSOLUTE-form request (`GET http://host/path`), which
// otherwise gets misrouted to Anthropic. Blind-relay it to its target with the
// client's own headers — no account selection, no token injection,
// content-encoding passed through (a transparent forward proxy). Anthropic is
// HTTPS-only, so in practice this only ever sees third-party hosts.
export function relayHttpForward(req, res) {
  let target;
  try { target = new URL(req.url); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Malformed forward-proxy URL' } }));
    return;
  }
  // Destination policy, same as the CONNECT tunnel's (forward-target.js): a
  // relay may not target this machine's loopback, the unspecified address, or
  // link-local. `GET http://127.0.0.1:<our port>/agentlb/status` would
  // otherwise arrive at our own listener from a loopback socket and pass the
  // API-key gate as a local caller. Refused by literal name here; the guarded
  // lookup below refuses by resolved address, so a DNS alias for 127.0.0.1 does
  // not get past either. Launched clients carry NO_PROXY for loopback, so no
  // legitimate request is lost.
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const refuse = (why) => {
    console.error(`[AgentLB] HTTP forward to ${target.host} refused: ${why}`);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: `Forward to ${target.host} refused: ${why}` } }));
  };
  const refused = forwardRefusal(hostname, null, req.socket);
  if (refused) { refuse(refused); return; }

  const transport = target.protocol === 'http:' ? http : https;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // Drop hop-by-hop + proxy-control headers; `host` is reset from the target.
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'proxy-connection') continue;
    // The proxy key authenticates this hop and must never be forwarded to an
    // arbitrary absolute-form target.  A caller's Authorization header is
    // target-facing and is intentionally preserved; x-api-key is ours.
    if (lk === 'x-api-key' || lk === 'proxy-authorization') continue;
    headers[key] = value;
  }

  const upstreamReq = transport.request(target, { method: req.method, headers, lookup: guardedLookup(req.socket) }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
    // A transparent HTTP relay has no retry layer.  If the upstream socket
    // dies after headers, close the client side so callers can reconnect
    // instead of waiting forever on a half-open response.
    upstreamRes.on('aborted', () => res.destroy());
    upstreamRes.on('error', () => res.destroy());
  });
  upstreamReq.on('error', (err) => {
    if (err.code === FORBIDDEN_FORWARD) { refuse(err.message); return; }
    console.error(`[AgentLB] HTTP forward to ${target.host} failed:`, describeConnectError(err));
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  });
  res.on('close', () => upstreamReq.destroy());
  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

// Paths relayed with the CLIENT's own credential, never a rotated account token.
// Everything under /api/oauth/ is the client's identity/control plane — profile
// ("who am I"), file uploads, and whatever Claude Code adds next — not inference.
// Injecting a fleet token here makes Claude Code believe it IS the rotated
// account: the cached oauthAccount profile gets overwritten with a stranger's
// identity, the Claude-in-Chrome extension refuses to pair ("token belongs to a
// different account than the one you're logged in as"), Remote Control binds to
// the wrong account, and artifacts get published under it. Observed on a live
// fleet; the whole prefix is the fix, not a growing allowlist of sub-paths.
const CLIENT_CREDENTIAL_PATHS = ['/v1/code/', '/api/oauth/'];

// Claude Code's session id is a UUID, but other clients tag sessions too, so
// the shape is a conservative charset rather than the UUID grammar: wide enough
// that a non-UUID client keeps its session tracking, tight enough that nothing
// odd gets in. The value becomes a Map key in the session tracker (the length
// cap is what bounds that map per client) and a column in the TUI, where Node's
// header parser would otherwise let C1 control bytes through untouched.
const SESSION_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

/** The session id a request carries, or null when the header is absent or
 *  malformed — a malformed one is treated as no session, not rejected. */
export function clientSessionId(headers) {
  const raw = headers['x-claude-code-session-id'];
  return typeof raw === 'string' && SESSION_ID_SHAPE.test(raw) ? raw : null;
}

/**
 * Build the core proxy request listener — buffer the body, then forward with
 * account selection + retry (forwardRequest). Shared by the base HTTP server and
 * the MITM's terminating h2/h1 server, so both get identical buffering, model-
 * aware routing, and retry-on-quota behavior. Control endpoints (status/reload)
 * and the proxy-API-key gate live in the base server's wrapper, not here.
 */
export function createProxyRequestListener({
  accountManager, upstream, logDir = null, hooks = {}, sx = null, holdMs = 0,
  config = {}, forcedPin = null, egress = null, clientUsage = null,
  forcedClient = null, forcedCredential = null, dimensionUsage = null, fairShare: injectedFairShare = null,
  toolDedupe: injectedToolDedupe = null, drainState = null,
}) {
  const fairShare = injectedFairShare || new FairShareController({
    poolCapacity: config?.poolCapacity || 32,
    congestionThreshold: config?.congestionThreshold || 0.75,
  });
  clientUsage ||= new ClientUsageTracker();
  const requestBudget = requestBudgetFor(config);
  const toolDedupe = injectedToolDedupe || new ToolCallDedupeCache();
  const drainTracker = drainState || { activeRequests: 0, isDraining: false };
  let counter = 0;
  return async (req, res) => {
    // The activity entry this request opened, while it is still open. Every
    // consumer holds the row until it is told the request ended, so exactly one
    // path must close it. Each closing site clears this first, which is how the
    // outer catch tells an entry it still has to account for from one that is
    // already closed.
    let openEntry = null;
    let releaseBudget = null;
    let uploadTimer = null;
    let requestTimer = null;
    const onFirstToken = metricsFor(config).start(res);
    try {
      if (forcedCredential != null) {
        const currentAuth = resolveClientAuth(config.proxy, forcedCredential);
        if (!currentAuth.ok) { denyClientPolicy(res, { status: 401, error: 'proxy key revoked' }); return; }
        req.tcClient = currentAuth.client;
        req.tcClientEntry = currentAuth.entry;
      }
      const entry = req.tcClientEntry;
      const clientName = req.tcClient ?? forcedClient;
      if (entry) {
        const policy = clientUsage.checkQuota(clientName, entry);
        if (!policy.allowed) { denyClientPolicy(res, policy); return; }
      }

      // Refused before any path-prefix classification below, so each of those
      // sees the path upstream will see (see hasDotSegment). Logged like the
      // unknown-pin 404: an operator should see a client probing the boundary.
      if (hasDotSegment(req.url)) {
        const reqId = ++counter;
        const sessionId = req.headers['x-claude-code-session-id'] || null;
        hooks.onRequestEnd?.(reqId, { method: req.method, path: safeLine(req.url), account: '(refused: dot-segment in path)', status: 400, model: null, sessionId, pinned: false });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Request path must not contain dot-segments' } }));
        recordEarlyOutcome(accountManager, sessionId, req.url, true);
        return;
      }

      // Claude Code's telemetry (`/api/event_logging/*`) is high-volume noise in
      // the activity log. `config.eventLogging` (read live so the TUI toggle takes
      // effect immediately): 'show' forwards + displays; 'hide' (default) forwards
      // but suppresses the activity entry; 'block' answers 200 locally without
      // forwarding (no upstream round-trip, no account/token spent).
      const eventLogging = config?.eventLogging || 'hide';
      const isEventLog = (req.url || '').startsWith('/api/event_logging');
      if (isEventLog && eventLogging === 'block') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const hideActivity = isEventLog && eventLogging !== 'show';
      // Egress pin (opt-in): with the exit IP off the pinned one — a VPN that
      // dropped — hold rather than send. Upstream answers a request from an
      // unexpected region with a 403 that Claude Code reports as a dead session,
      // so sending it costs a re-login while waiting costs latency. Checked here
      // rather than per-account: it is a property of the connection, and this is
      // the one path every request takes, MITM included.
      if (egress?.enabled()) {
        const state = await egress.waitUntilPinned({ isAborted: () => clientGone(res) });
        if (clientGone(res)) return;
        if (!state.ok) {
          recordEarlyOutcome(accountManager, req.headers['x-claude-code-session-id'] || null, req.url, false);
          res.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '30' });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'proxy_error',
              message: `Egress is ${state.ip || 'unknown'}, not the pinned ${state.expected.join(', ')} — not sending this request. Check the VPN.`,
            },
          }));
          return;
        }
      }
      if (entry && CLIENT_CREDENTIAL_PATHS.some(p => (req.url || '').startsWith(p)) && !relayPolicyAllowed({ ok: true, entry, client: clientName }, clientUsage)) {
        denyClientPolicy(res, { error: 'restricted keys cannot use an unmetered relay' }); return;
      }
      // Client token refresh: pass through untouched (the proxy manages its own
      // tokens via ensureTokenFresh; rewriting client refreshes would conflict).
      if (req.method === 'POST' && req.url === '/v1/oauth/token') { await relayRaw(req, res, upstream, sx, Math.min(resolveMaxBodyBytes(config), 1024 * 1024), requestBudget); return; }
      // Remote Control (/v1/code/*) is bound to the session's paired claude.ai
      // identity — forward with the client's OWN credential (streamed), never a
      // rotated account token, which would 403 the worker event stream.
      // Attachment transfers (/api/oauth/files/*, /api/oauth/file_upload) are
      // likewise account-bound: files uploaded from claude.ai belong to the
      // paired identity, so fetching them with a rotated token 403s and Claude
      // Code silently drops the image from the message.
      if (CLIENT_CREDENTIAL_PATHS.some((p) => (req.url || '').startsWith(p))) { await relayStream(req, res, upstream, sx); return; }

      // Account pin: a request to `/tc-acct/<name-or-index>/...` (e.g. via
      // ANTHROPIC_BASE_URL=http://host:port/tc-acct/deepseek) is forced onto that
      // one account, bypassing rotation. Used by the keep-warm scheduler and for
      // manual per-account testing. The prefix is stripped before forwarding.
      let pinnedIndex = null;
      // DEPRECATED: the path-prefix pin. Superseded by TC_ACCT, which works in
      // MITM mode too (this form cannot — inside a CONNECT tunnel the path is
      // the real upstream one). Kept for the warmer and for direct API callers.
      // One segment only, so the fully-qualified `accountUuid/orgUuid` form is
      // not expressible here; use TC_ACCT for that.
      const url = req.url || '';
      const afterPrefix = url.startsWith(PIN_PREFIX) ? url.slice(PIN_PREFIX.length) : null;
      // The token runs to the next '/', which also begins the real request path.
      const tokenEnd = afterPrefix == null ? -1 : afterPrefix.indexOf('/');
      if (tokenEnd > 0) {
        // The escaping of this segment is the CLIENT's, so a malformed one
        // ("/tc-acct/%/v1/messages") makes decodeURIComponent throw URIError.
        // That is an ordinary bad request, not an internal error: decode
        // defensively and fall through to the unknown-pin 404 below, which is
        // what a pin nobody can resolve already means. An undecodable token is
        // reported as it arrived, since there is no decoded form to name.
        const raw = afterPrefix.slice(0, tokenEnd);
        let token = null;
        try { token = decodeURIComponent(raw); } catch { token = null; }
        pinnedIndex = token == null ? null : resolveAccountPin(accountManager, token);
        if (pinnedIndex == null) {
          // Client-supplied and already percent-decoded, so this is the one
          // value on the path that can carry raw control bytes.
          const shown = safeLine(token ?? raw);
          const reqId = ++counter;
          const sessionId = clientSessionId(req.headers);
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(unknown pin: "${shown}")`, status: 404, model: null, sessionId, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Unknown account pin "${shown}"` } }));
          recordEarlyOutcome(accountManager, sessionId, req.url, true);
          return;
        }
        req.url = afterPrefix.slice(tokenEnd);
      }

      // MITM-mode pin. A CONNECT carrying `Proxy-Authorization: Basic <acct>:…`
      // has no URL to hang a `/tc-acct/` prefix on — the path inside the tunnel
      // is the real Anthropic one — so the pin arrives as a listener bound to
      // that account (see createConnectHandler). Resolved per request rather
      // than at CONNECT time: a hot reload can renumber accounts while a tunnel
      // is open, and a name outliving an index is the safer half of that race.
      if (pinnedIndex == null && forcedPin != null) {
        pinnedIndex = resolveAccountPin(accountManager, forcedPin);
        if (pinnedIndex == null) {
          const reqId = ++counter;
          const sessionId = clientSessionId(req.headers);
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(unknown pin: "${safeLine(forcedPin)}")`, status: 404, model: null, sessionId, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Unknown account pin "${forcedPin}" (from TC_ACCT)` } }));
          recordEarlyOutcome(accountManager, sessionId, req.url, true);
          return;
        }
      }

      const reqId = ++counter;
      // Claude Code tags each session's requests with this header (present on
      // /v1/messages and count_tokens). Read from headers up front so it drives
      // session-aware routing (issue #109) and colors the TUI activity stream.
      const sessionId = clientSessionId(req.headers);
      if (!hideActivity) {
        // Marked open BEFORE the hook runs. The shipped TUI hook registers its
        // row and then renders, and the render can rethrow, so a hook that
        // throws part way through has already opened a row that something must
        // close. The cost of this order is one spurious close if the hook threw
        // before registering anything, which every consumer already tolerates.
        openEntry = { reqId, sessionId };
        hooks.onRequestStart?.(reqId, { method: req.method, path: req.url, sessionId, pinned: pinnedIndex != null, client: req.tcClient ?? forcedClient ?? null });
      }

      // Buffer request body (needed to resend on a different account after a 429).
      // Peek the top-level `model` field incrementally as chunks arrive so the
      // TUI can show it the instant it appears in the stream — usually the first
      // frame — rather than waiting for the whole body and the request to finish.
      releaseBudget = requestBudget.acquire();
      if (!releaseBudget) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Request buffer capacity exhausted' } }));
        return;
      }
      uploadTimer = setTimeout(() => req.destroy(new Error('request body deadline exceeded')), 30_000);
      uploadTimer.unref?.();
      const bodyChunks = [];
      const modelFinder = new TopLevelFieldFinder('model');
      const maxBodyBytes = resolveMaxBodyBytes(config);
      let bodyBytes = 0;
      for await (const chunk of req) {
        bodyBytes += chunk.length;
        // Buffering is what makes retry possible, and also what lets one client
        // hold as much memory as it cares to send. Past the cap, stop reading
        // and say so; the request is torn down once the answer is out.
        if (bodyBytes > maxBodyBytes || !releaseBudget.reserve(chunk.length)) {
          await refuseOversizedBody(req, res);
          openEntry = null;   // this path owns the close below; the outer catch must not repeat it
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(too large)', status: 413, model: modelFinder.done ? modelFinder.value : null, sessionId, pinned: pinnedIndex != null });
          return;
        }
        bodyChunks.push(chunk);
        if (!modelFinder.done) {
          const found = modelFinder.push(chunk);
          if (found && !hideActivity) hooks.onRequestModel?.(reqId, { model: found });
        }
      }
      clearTimeout(uploadTimer);
      const body = Buffer.concat(bodyChunks);

      const model = modelFinder.done ? modelFinder.value : parseRequestModel(body);
      if (entry?.allowedModels?.length && !model) {
        denyClientPolicy(res, { error: 'model required for a model-restricted key' }); return;
      }
      const requestedPolicy = clientUsage.checkQuota(clientName, entry, model);
      if (!requestedPolicy.allowed) { denyClientPolicy(res, requestedPolicy); return; }
      // An advisor request (Claude Code's advisor tool) carries a SECOND model
      // nested in tools[]; the advisor sub-inference runs on the selected
      // account, so selection must be eligible for it too (issue #98).
      const advisorModel = parseAdvisorModel(body);
      if (advisorModel) {
        const advisorPolicy = clientUsage.checkQuota(clientName, entry, advisorModel);
        if (!advisorPolicy.allowed) { denyClientPolicy(res, advisorPolicy); return; }
      }

      // Model blocklist (issue #116): reject a request for a blocked model right
      // here instead of forwarding it. A model no account can serve (e.g. Fable
      // once it left base plans) otherwise gets rate-limited upstream and hangs
      // the pipeline; a fast, non-retryable 400 lets the client move on. Read
      // live from the shared config so the TUI editor takes effect immediately.
      const blockedBy = model ? (config?.blockedModels || []).find((p) => modelGlobMatches(p, model)) : null;
      if (blockedBy) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Model "${model}" is blocked by agent-lb (matched "${blockedBy}").` } }));
        }
        recordEarlyOutcome(accountManager, sessionId, req.url, true);
        openEntry = null;   // this path owns the close below; the outer catch must not repeat it
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model, sessionId });
        return;
      }

      // Per-client attribution: the base server stamps req.tcClient from the
      // key that authenticated; the MITM terminating server has no per-request
      // key (auth happened at CONNECT time) and carries it as forcedClient
      // instead — the same split as the account pin. onUsage lets the usage
      // extraction deep in the response path book tokens against the client
      // without threading the name through every layer.
      //
      // Usage dimensions (proxy.usageDimensions) ride the same hook: each
      // configured header the caller sent becomes one more counter the response
      // tokens are booked against, so one CI key can still be split by project.
      const client = req.tcClient ?? forcedClient ?? null;
      const usageDimensions = resolveUsageDimensions(config.proxy, req.headers);
      const usageRecorder = createUsageRecorder({ client, clientUsage, dimensions: usageDimensions, dimensionUsage });
      usageRecorder.recordRequest();

      // The dimension headers are ours, not upstream's: they exist to label
      // traffic for this proxy. Forwarding them would leak an operator's
      // internal project and branch names to Anthropic for no benefit, so they
      // are dropped with the other proxy-control headers.
      const stripHeaders = usageDimensionHeaderNames(config.proxy);

      const requestProvider = providerForPath(req.url);
      const isClaudeModel = typeof model === 'string' && (model.startsWith('claude-') || model.startsWith('claude/'));
      const isOpenAIModel = typeof model === 'string' && (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('codex'));
      const isAgyModel = typeof model === 'string' && (model === 'agy' || model === 'agy-fast' || model.startsWith('gemini-'));
      const targetProvider = isClaudeModel
        ? 'anthropic'
        : (isOpenAIModel
            ? 'codex'
            : (isAgyModel
                ? (accountManager.getActiveCount?.('codex') > 0 ? 'codex' : (accountManager.getActiveCount?.('anthropic') > 0 ? 'anthropic' : requestProvider))
                : requestProvider));

      const ctx = { account: null, status: null, tried: new Set(), reauthed: new Set(), model, advisorModel, pinnedIndex, provider: targetProvider, requestProvider, requestedModel: model, fallbackPolicy: config.fallbackPolicy, clientEntry: req.tcClientEntry, clientUsage, metrics: metricsFor(config), onFirstToken, holdBudgetMs: holdMs, sessionId, client, delivered: false, abandoned: false, onUsage: usageRecorder.onUsage, stripHeaders, logLevel: resolveLogLevel(config), logMaxBodyBytes: resolveLogMaxBodyBytes(config) };
      // Hold the session "in flight" across the WHOLE request (incl. retries and
      // a multi-minute streaming completion) so it stays counted as active and
      // never expires mid-request.
      accountManager.beginSession(sessionId, {
        client,
        dimensions: Object.fromEntries(usageDimensions.map(d => [d.name, d.key])),
      });
      // Everything forwardRequest waits on — the upstream admission queue, the
      // upstream request itself, a quota-hold or rate-limit timer, a silent SSE
      // read — is cancelled the moment the client goes away, so a departed
      // client keeps neither an upstream slot nor a timer alive. Two closes are
      // NOT departures and must never abort: the 'close' that follows a normal
      // res.end() (writableEnded), and the one the proxy causes itself when it
      // destroys the socket on a dead stream (ctx.proxyClosed) — that is the
      // worst failure, not "the user left".
      const requestAbort = new AbortController();
      const onRequestClose = () => { if (!res.writableEnded && !ctx.proxyClosed) requestAbort.abort(clientGoneError()); };
      ctx.signal = requestAbort.signal;
      const requestSeconds = Number(config.proxy?.maxRequestSeconds) || 600;
      requestTimer = setTimeout(() => {
        ctx.proxyClosed = true;
        requestAbort.abort(new Error('request deadline exceeded'));
        res.destroy();
      }, Math.max(1, requestSeconds) * 1000);
      requestTimer.unref?.();
      res.once('close', onRequestClose);
      if (clientGone(res)) onRequestClose();

      const keyId = client || (req.clientKey ? req.clientKey.slice(0, 12) : 'anonymous');
      const fsAdmission = fairShare.admit(keyId);
      if (!fsAdmission.admitted) {
        if (!res.headersSent) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: `Stream pool congested (active: ${fairShare.totalStreams}, fair share: ${fsAdmission.fairShare}). Please retry shortly.`,
            },
          }));
        }
        accountManager.endSession(sessionId, null);
        openEntry = null;
        return;
      }
      fairShare.acquire(keyId);

      let parsedBody = null;
      try {
        if (body && body.length > 0) parsedBody = JSON.parse(body.toString('utf8'));
      } catch {}

      if (parsedBody) {
        // Whether the client asked for a stream decides how long upstream may
        // take to send headers (see nonStreamHeadersTimeout).
        ctx.clientStream = parsedBody.stream === true;
        const dedupeResult = toolDedupe.inspectRequest(parsedBody, sessionId);
        if (dedupeResult.hasDuplicate) {
          console.warn(`[AgentLB] [ToolDedupe] Warning: detected replayed side-effect tool calls in session "${sessionId}": ${dedupeResult.duplicates.map(d => d.name).join(', ')}`);
        }
        const clientEntry = req.tcClientEntry || null;
        if (parsedBody.model && clientEntry?.allowedModels && clientUsage && client) {
          const modelCheck = clientUsage.checkQuota(client, clientEntry, parsedBody.model);
          if (!modelCheck.allowed) {
            fairShare.release(keyId);
            res.off('close', onRequestClose);
            accountManager.endSession(sessionId, true);
            if (openEntry) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, status: 403, model, sessionId, client });
            openEntry = null;
            res.writeHead(modelCheck.status || 403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'permission_error', message: modelCheck.error },
            }));
            return;
          }
        }
      }

      drainTracker.activeRequests++;
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);
      } catch (err) {
        ctx.status = ctx.status || 502;
        // Same rule as the two outer catches: a recovery path does not report
        // through a console that may be the thing that failed. Here it also
        // decides which error gets reported at all, since a throw from the
        // report would carry the render failure outward in place of this one.
        reportFailure('[AgentLB] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
        }
      } finally {
        drainTracker.activeRequests = Math.max(0, drainTracker.activeRequests - 1);
        fairShare.release(keyId);
        if (parsedBody && ctx.status >= 200 && ctx.status < 300) {
          toolDedupe.recordRequest(parsedBody, sessionId);
        }
        res.off('close', onRequestClose);
        // The signal fires only for a departure (see above), so this is the
        // status of a row whose client will never read anything. It says
        // nothing about abandonment: that is still marked where it is observed.
        if (requestAbort.signal.aborted) ctx.status = 499;
        // null = record nothing: the client walked away (neither an answer nor a
        // starvation), or this was not a completion at all. Abandonment is
        // observed where it happens, never inferred here: the proxy destroys the
        // socket itself on a dead stream, so a clientGone check at this point
        // would reclassify the worst failure as "the user left".
        accountManager.endSession(sessionId,
          !isCompletionPath(req.url) ? null : (ctx.delivered ? true : (ctx.abandoned ? null : false)));
        // Cleared BEFORE the hook, because the hook can throw: leaving the entry
        // marked open would send the outer catch to call that same throwing hook
        // a second time for one request.
        openEntry = null;
        if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: ctx.account, status: ctx.status, model: ctx.model, sessionId, pinned: ctx.pinnedIndex != null, client });
      }
    } catch (err) {
      reportFailure('[AgentLB] Unhandled error:', err);
      // Close the activity entry. Only the inner path has a `finally`, so a
      // throw above it opens a row that nothing else will ever close, and every
      // consumer holds an open row indefinitely: the TUI keeps it in `active`
      // and never idles its animation, a headless consumer's in-flight count
      // grows by one. `for await (const chunk of req)` rejects when a client
      // cancels mid-body, which Ctrl+C in Claude Code does, on a daemon that
      // runs for weeks.
      if (openEntry) {
        // 499 when nothing was sent and nothing will be, either because the
        // client is gone or because the response is past the point of saying
        // anything; 502 is what the answer below is about to write.
        const status = res.headersSent || clientGone(res) ? 499 : 502;
        const entry = openEntry;
        openEntry = null;
        // Guarded, because the throw that landed here may be this hook. Escaping
        // this catch means escaping an async request listener with nothing above
        // it, which is an unhandled rejection, and crash-log.js turns that into
        // exit(1). A broken activity hook must not take the daemon down, and it
        // must not cost the socket its answer below either.
        try {
          hooks.onRequestEnd?.(entry.reqId, {
            method: req.method, path: req.url, account: null, status,
            model: null, sessionId: entry.sessionId, pinned: false,
          });
        } catch (hookErr) {
          reportFailure('[AgentLB] activity hook failed while closing a request:', hookErr);
        }
      }
      // The code above the inner try (the egress hold, the pin parsing, body
      // buffering, the activity hooks) runs outside the 502 that guards
      // forwardRequest, and the inner `finally` calls onRequestEnd after the
      // response has streamed.
      answerUnhandled(res);
    } finally {
      clearTimeout(uploadTimer);
      clearTimeout(requestTimer);
      releaseBudget?.();
    }
  };
}

/**
 * Report a failure without depending on the console to survive it.
 *
 * Under the TUI the console is the TUI: `console.error` appends to the activity
 * log and repaints, so a render that throws makes `console.error` throw. That
 * matters because these reports are the FIRST statement of the paths that
 * recover from a throw, and the throw being recovered from is often the same
 * broken render. An unguarded report there skips the whole recovery.
 *
 * Falls back to stderr rather than swallowing, so a render bug still leaves a
 * diagnostic. The TUI already does this when its own activity stream fails.
 *
 * `writeSync` rather than `process.stderr.write`, because the fallback has to
 * fail the way this function promises to. A closed stderr makes the stream
 * surface EPIPE asynchronously, as an error event no `try` around the call can
 * see, and this daemon treats an uncaught EPIPE as fatal. `writeSync` throws
 * where it is called, so the catch below is real.
 */
function reportFailure(...args) {
  try {
    console.error(...args);
  } catch {
    try {
      writeSync(2, `${args.map(a => a?.stack || String(a)).join(' ')}\n`);
    } catch { /* nothing left to report with */ }
  }
}

// A status the client can act on: upstream said something about THIS request.
// A 4xx IS an answer — it tells the client something true about what it sent,
// and a session getting legitimate 400s is working, not starving. A 429 is a
// refusal to answer and a 5xx is a failure to.
function answeredStatus(status) {
  // 401 is excluded on purpose. It is about the credential the PROXY injected,
  // which the client never sees and cannot act on — a fleet whose keys have all
  // been rotated out answers 401 to everything, forever, and that is the
  // canonical starving session rather than an answered one.
  return status < 500 && status !== 429 && status !== 401;
}

// Only a completion is something a session can starve for. Claude Code sends
// `count_tokens` under the SAME session id as the completions it is sizing up,
// and that endpoint keeps working when completions do not — so counting it
// would let a healthy trickle reset the streak of a session that is getting
// nothing. Measured before this guard: ten failed completions interleaved with
// their count_tokens calls reported a streak of one.
function isCompletionPath(url) {
  const path = String(url || '').split('?')[0];
  return path.endsWith('/v1/messages') || path.endsWith('/responses');
}

// Outcomes for the exits that return BEFORE beginSession. They never open an
// in-flight hold, so they cannot use the ctx flags, and must not go through
// endSession either: its endRequest would release a hold this request never
// took — another request's, if the session has one in flight. But a session
// that is answered promptly (a blocked model, an unknown pin) must still clear
// a stale streak, and one the proxy refuses to send at all (egress unpinned)
// must still count as getting nothing.
function recordEarlyOutcome(accountManager, sessionId, url, usable) {
  if (sessionId && isCompletionPath(url)) accountManager.recordOutcome(sessionId, usable);
}

/**
 * Has the client gone away?
 *
 * `res.destroyed` answers that on the base HTTP/1 listener and not on the MITM
 * one: `Http2ServerResponse` has no `destroyed` property at all, so the read is
 * `undefined` and the question is answered "no" for every h2 request, on the
 * path that carries most of the traffic. The h2 equivalent lives on the
 * underlying stream.
 *
 * Asked wherever the answer decides whether to spend something the client will
 * never receive. On the retry ladder that is an upstream call and a slice of an
 * account's weekly quota per rung, which is the opposite of what rotation is
 * for. In practice the ladder is cut short by the abort probe handed to
 * `admit()`, which is polled while a request waits for a concurrency slot; the
 * reads on the individual rungs are the backstop for a request that never
 * waited.
 *
 * In `streamResponse` the cost is the handler itself. Writing to a cancelled
 * stream returns false, and the backpressure wait below then listens for a
 * `drain` or a `close` that has already happened and will not happen again, so
 * the handler never returns and its activity entry never closes.
 */
// The reason a request's AbortSignal carries when the client went away. Every
// wait in forwardRequest either resolves to a clientGone check or rejects with
// this, and the catch recognises it by code.
function clientGoneError() {
  const err = new Error('client disconnected');
  err.code = 'AGENTLB_CLIENT_GONE';
  return err;
}

// A quota-hold / rate-limit sleep that a departed client does not sit out: the
// timer is cleared the moment the request's signal aborts, so the request (and
// its buffered body) is not retained for a retry nobody is waiting for.
function waitForRetry(ms, signal) {
  // Positive jitter never retries before the upstream Retry-After deadline.
  ms += Math.floor(Math.random() * Math.min(1000, ms * 0.1));
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function clientGone(res) {
  return !!res.destroyed || !!res.stream?.destroyed;
}

/**
 * The last response an outer catch can send. Three states:
 *
 *   - Nothing written yet: send a 502. Guarded on headersSent, because a second
 *     writeHead raises ERR_HTTP_HEADERS_SENT from inside the catch.
 *   - Headers sent, body unfinished: destroy. There is no status left to send,
 *     and end() would present the truncated bytes as a complete reply.
 *   - Response already ended: leave it alone, the client has its answer.
 *
 * `forwardRequest`'s own catch already carries the same pair of arms.
 */
function answerUnhandled(res) {
  if (!res.headersSent && !clientGone(res)) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
  } else if (!res.writableEnded) {
    res.destroy();
  }
}

// Per-request https.Agent tunneled through sx.org — one-shot (no keep-alive
// reuse, matching upstream-fetch.js's proxiedFetch), so a fresh sx tunnel is
// dialed for this connection only.
function sxAgent(sx, targetHost) {
  const proxy = sx.getProxy();
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, cb) => {
    tunnelTls({ proxy, targetHost, targetPort: 443, tlsOptions: sx.tlsOptions || {} })
      .then((sock) => cb(null, sock))
      .catch((err) => cb(err));
    return undefined;
  };
  return agent;
}

/**
 * Relay a request to upstream with the client's OWN headers intact (including
 * its authorization) — used for Remote Control (/v1/code/*), whose event
 * stream is a long-poll: the client keeps the request open indefinitely and
 * the upstream may withhold response headers for minutes between events. No
 * buffering, no timeout, no reconstruction — just pipe bytes both ways as they
 * arrive, exactly like a transparent proxy would.
 */
function relayStream(req, res, upstream, sx) {
  const target = new URL(`${upstream}${req.url}`);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'accept-encoding') continue;
    // The client's identity on this path is its bearer; x-api-key is how it
    // authenticated to THIS proxy, so relaying it would hand the operator's
    // proxy key to upstream.
    if (lk === 'x-api-key' || lk === 'proxy-authorization') continue;
    headers[key] = value;
  }

  const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;
  const transport = target.protocol === 'http:' ? http : https;

  const upstreamReq = transport.request(target, { method: req.method, headers, agent }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key) || key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
    // pipe() only propagates 'end'. If the upstream leg dies mid-response
    // (network blip, upstream restart), upstreamRes emits 'aborted'/'error'
    // and the pipe just stops — the client's long-poll stays open forever and
    // the CLI keeps waiting on a channel that can no longer deliver events.
    // Destroying res closes the client socket, which is the one signal its
    // reconnect logic reacts to.
    upstreamRes.on('aborted', () => res.destroy());
    upstreamRes.on('error', () => res.destroy());
  });

  upstreamReq.on('error', (err) => {
    console.error('[AgentLB] Remote Control relay error:', describeConnectError(err));
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    } else {
      // Headers already went out (the long-poll was live), so a 502 body can't
      // be written anymore. Close the client socket instead of leaving it
      // half-dead: seen in production as a `socket hang up` logged here while
      // the CLI's Remote Control stream silently waited on it for 45+ minutes.
      res.destroy();
    }
  });
  // Client disconnected (e.g. Claude Code closed the channel): tear down the
  // upstream side too instead of leaking an open connection.
  res.on('close', () => upstreamReq.destroy());

  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

/**
 * The key gate for a WebSocket upgrade, in the shape of the CONNECT one.
 *
 * Separate from `resolveClientAuth` only because the answer depends on the
 * socket's address as well as the header, and separate from the request path
 * because `server.on('upgrade')` is a different event that no part of
 * `requestHandler` runs for.
 *
 * `x-api-key` only. A browser cannot set that header on a WebSocket
 * handshake, so a browser client cannot authenticate here — deliberately.
 * The obvious alternative, reading the key out of `Sec-WebSocket-Protocol`,
 * is worse than not supporting browsers: relayUpgrade forwards that header to
 * the upstream (it strips `x-api-key`, which is the whole reason the
 * handshake carries no operator credential today), the offer list is
 * attacker-sized so it turns one guess per connection into thousands, and the
 * proxy cannot honour the negotiation anyway because it relays the handshake
 * rather than answering it.
 */
export function resolveUpgradeAuth(req, socket, proxyConfig) {
  const auth = resolveClientAuth(proxyConfig, req?.headers?.['x-api-key']);
  if (auth.ok || req?.headers?.['x-api-key']) return auth;
  // Loopback is exempt from the key requirement, exactly as the HTTP and
  // CONNECT gates are — with the request path's two conditions on top, for
  // the same actor: a web page in the operator's browser. A page can open a
  // WebSocket to 127.0.0.1 with no CORS check at all, and its handshake is
  // loopback-sourced too. What it cannot forge is `Origin`, which a browser
  // sets on every handshake and a CLI never sends, nor `Host`, which a
  // rebound name (attacker.example → 127.0.0.1) leaves naming the attacker.
  if (!loopbackExempt(req?.headers, socket?.remoteAddress, proxyConfig) &&
      !tailnetExempt(req?.headers, socket?.remoteAddress, proxyConfig)) return auth;
  const bindHost = proxyConfig?.host;
  const origin = req?.headers?.origin;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { return auth; }
    if (!isLocalHostHeader(originHost, bindHost, [], proxyConfig)) return auth;
  }
  if (!isLocalHostHeader(req?.headers?.host, bindHost, [], proxyConfig)) return auth;
  return { ok: true, client: null };
}

/**
 * Refuse a Codex WebSocket handshake (the Responses API over WS, which Codex
 * opens when its provider sets `supports_websockets = true`).
 *
 * This proxy serves Codex over HTTP only: selection, token injection, quota
 * accounting and failover all live on the request path. relayUpgrade is a
 * byte relay for Claude's Remote Control channel — it forwards the client's
 * own headers to the Anthropic upstream, so a Codex handshake sent through it
 * carried the client's Bearer to api.anthropic.com, and via MITM it reached
 * chatgpt.com on the client's own login, bypassing rotation. Answer 426 so the
 * client falls back to HTTP. Returns true when the socket was answered.
 * Exported for tests.
 */
export function refuseCodexWebSocket(req, socket, log = console.log) {
  let path;
  try { path = new URL(req?.url || '/', 'http://proxy.invalid').pathname; } catch { path = req?.url || ''; }
  if (providerForPath(path) !== 'codex') return false;
  log(`[AgentLB] Codex WebSocket ${safeLine(path)} refused (426) — Codex is served over HTTP; set supports_websockets = false`);
  try { socket.write('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* client already gone */ }
  socket.destroy();
  return true;
}

/**
 * Relay a WebSocket upgrade (e.g. Remote Control's real-time
 * `/v1/session_ingress/ws/*` channel) to upstream with the client's own
 * headers intact. An HTTP server never emits 'request' for an Upgrade
 * handshake — only 'upgrade', with a raw socket instead of a response object —
 * so this needs its own relay rather than going through relayStream/res.
 * Reuses Node's http(s) client, which already knows how to speak the Upgrade
 * handshake (emits its own 'upgrade' event on a 101); once that fires it's
 * just two raw sockets spliced together.
 */
export function relayUpgrade(req, socket, head, upstream, sx, { client = null, clientUsage = null, log = console.log } = {}) {
  const target = new URL(`${upstream}${req.url}`);
  // The channel's log lines, prefixed `[name]` like a request line when a
  // client key authenticated the handshake, so an operator reading per-client
  // activity sees the channel beside the requests. Booked only once upstream
  // accepts: a handshake it refuses opened nothing.
  const tag = client ? `[${safeLine(client, 64)}] ` : '';
  const path = safeLine(req.url);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // Unlike relayStream, do NOT strip 'upgrade'/'connection' here — they ARE
    // the handshake. Only 'host' (the client transport reconstructs it from
    // `target`), h2 pseudo-headers and the proxy's own x-api-key (the client's
    // credential to us, not to upstream) are dropped.
    if (lk.startsWith(':') || lk === 'host' || lk === 'x-api-key' || lk === 'proxy-authorization') continue;
    headers[key] = value;
  }

  const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;
  const transport = target.protocol === 'http:' ? http : https;

  const upstreamReq = transport.request(target, { method: req.method, headers, agent });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const headerLines = Object.entries(upstreamRes.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headerLines}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    clientUsage?.record(client, { connections: 1 });
    const opened = Date.now();
    log(`[AgentLB] ${tag}WebSocket ${path} connected`);
    socket.once('close', () => log(`[AgentLB] ${tag}WebSocket ${path} closed (${((Date.now() - opened) / 1000).toFixed(1)}s)`));
    // An upgraded socket defaults to half-open: the peer's FIN only ends the
    // READABLE side ('end'), it does NOT destroy the socket or fire 'close' —
    // so without this, one side hanging up (dropped wifi, killed CLI) leaves
    // the other socket open forever. destroy() is idempotent, so reacting to
    // both 'end' and 'close' on each side is a safe, redundant backstop.
    socket.on('end', () => upstreamSocket.destroy());
    upstreamSocket.on('end', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    // The 101 detaches this socket from upstreamReq, so the request's 'error'
    // listener no longer covers it. A link that flaps mid-session then raises
    // 'error' (write EPIPE / read ECONNRESET) on a socket nobody listens to,
    // which Node escalates to an uncaught exception — one dropped WebSocket
    // would kill the proxy for every other session. Close the pair instead.
    upstreamSocket.on('error', () => socket.destroy());
  });

  // Upstream answered with a plain response instead of the 101: the handshake
  // was refused (an expired credential, an unknown session). Without this the
  // client socket hung with no answer until it timed out, and nothing was
  // logged. Relay the status so the client sees the refusal it was given.
  upstreamReq.on('response', (upstreamRes) => {
    log(`[AgentLB] ${tag}WebSocket ${path} refused by upstream (${upstreamRes.statusCode})`);
    const headerLines = Object.entries(upstreamRes.headers)
      .filter(([k]) => !CONNECTION_SPECIFIC_HEADERS.has(k.toLowerCase()) && k.toLowerCase() !== 'content-length')
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
    try {
      socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headerLines}\r\nConnection: close\r\n\r\n`);
    } catch { /* already gone */ }
    upstreamRes.resume();
    socket.destroy();
  });

  upstreamReq.on('error', (err) => {
    console.error('[AgentLB] Remote Control WebSocket relay error:', describeConnectError(err));
    socket.destroy();
  });
  socket.on('error', () => upstreamReq.destroy());

  upstreamReq.end();
}

/**
 * Refuse a request whose body ran past the buffering cap.
 *
 * The 413 goes out first and the request is torn down only once it has been
 * flushed. The order matters: destroying first races the answer off the
 * socket, while merely ending the response makes Node drain (read and discard)
 * the rest of the body, which is exactly the traffic the cap exists to stop.
 * 'close' is raced against the flush so a client that has already gone away
 * cannot hold the handler open waiting for a 'finish' that never comes.
 * Mid-stream (headers already out) there is no status left to send.
 */
async function refuseOversizedBody(req, res) {
  if (!res.headersSent) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    await new Promise((resolve) => {
      res.once('close', resolve);
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Request body too large' },
      }), resolve);
    });
  }
  req.destroy();
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream, sx, maxBodyBytes, budget) {
  const release = budget.acquire();
  if (!release) { res.writeHead(503, { 'Retry-After': '1' }); res.end(); return; }
  const ctrl = new AbortController();
  const onClose = () => { if (!res.writableEnded) ctrl.abort(new Error('client disconnected')); };
  const timer = setTimeout(() => { ctrl.abort(new Error('token relay deadline')); req.destroy(); res.destroy(); }, 30_000);
  timer.unref?.(); res.once('close', onClose);
  try {
  const bodyChunks = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    bodyBytes += chunk.length;
    // Same cap as the forward path: this buffers too, and a token exchange is
    // a few hundred bytes.
    if (bodyBytes > maxBodyBytes || !release.reserve(chunk.length)) { await refuseOversizedBody(req, res); return; }
    bodyChunks.push(chunk);
  }
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await upstreamFetch(`${upstream}${req.url}`, {
      signal: ctrl.signal,
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    }, sx, sx?.useByDefault());

    const responseBody = await collectIdleBody(upstreamRes.body);
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      // `.text()` already decompressed the body, so drop content-encoding and
      // the now-stale content-length (both refer to the compressed bytes) — else
      // a gzip'd upstream response reaches the client mis-framed / truncated.
      if (key === 'transfer-encoding' || key === 'connection' ||
          key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[AgentLB] Raw relay error:', describeConnectError(err));
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
  } finally { clearTimeout(timer); res.off('close', onClose); release(); }

}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// How much of each request the `logDir` log records. 'body' is what the logger
// has always done; 'headers' drops both body sections, which is the difference
// between a kilobyte and a megabyte per request.
const LOG_LEVELS = new Set(['off', 'headers', 'body']);
const DEFAULT_LOG_LEVEL = 'body';

export function resolveLogLevel(config) {
  const level = config?.logLevel;
  return LOG_LEVELS.has(level) ? level : DEFAULT_LOG_LEVEL;
}

// Bodies are what make the log large, and a cap bounds nothing unless it
// actually applies: at 256 KiB the kept head and tail are each larger than
// anyone reads by eye, while a request log stops scaling with the context the
// request carried. 0 opts out, as with the other bounding settings.
const DEFAULT_LOG_MAX_BODY_BYTES = 262_144;

export function resolveLogMaxBodyBytes(config) {
  const raw = config?.logMaxBodyBytes;
  // A quoted number in hand-edited JSON is a common slip, so read it. A blank
  // string is not a number and means "unset", which must reach the default:
  // Number('') is 0, and 0 here would be the unbounded logging this bounds.
  // Number() on null or true would likewise read as 0 and 1 rather than junk.
  const max = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (max === 0) return 0;
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_LOG_MAX_BODY_BYTES;
}

// Cap on a buffered request body. The forward path buffers the whole body so
// it can be resent on another account after a 429; without a cap, one client
// holds as much of the proxy's memory as it cares to send. This is a transport
// safety bound, not a model context or `max_tokens` setting: the body is
// forwarded unchanged (apart from the documented per-account rewrites), and a
// normal 400k/1M-token text context is well below it. Multimodal requests can
// opt into a larger byte cap with `proxy.maxBodyBytes`; 0 opts out explicitly.
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export function resolveMaxBodyBytes(config) {
  const raw = config?.proxy?.maxBodyBytes;
  // Same reading rules as resolveLogMaxBodyBytes: a quoted number counts, a
  // blank string means unset, and 0 is the explicit opt-out.
  const max = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (max === 0) return Infinity;
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_BODY_BYTES;
}

// The names openRequestLog writes, and nothing else. Deletion keys off this
// pattern rather than off mtime so a file the logger did not create cannot
// match: the directory is one the operator named, and may hold anything.
const LOG_FILE_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(\d{3})_\d{5,}\.log$/;
const LOG_SWEEP_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LOG_RETENTION_HOURS = 72;

export function resolveLogRetentionHours(config) {
  const raw = config?.logRetentionHours;
  // Strings only, and it matters most here: this is the setting that deletes.
  // A quoted "0" must mean "keep everything" rather than falling back to the
  // default and deleting, and a quoted "720" must not silently become 72. A
  // blank string means "unset" and reaches the default, since Number('') is 0.
  // Number() on null or true would instead read as 0 and 1.
  const hours = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (hours === 0) return 0;
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOG_RETENTION_HOURS;
}

/**
 * Delete expired request logs from `logDir`, returning how many were removed.
 *
 * Candidates come from the filename, which openRequestLog stamps in local time,
 * so the scan costs one readdir and no stat for everything it skips — it has to
 * stay cheap over a directory holding tens of thousands of files. Anything that
 * is not a file, not name-matched, or inside a subdirectory is left alone.
 *
 * Only names already past the cutoff are stat'd, and mtime has to agree before
 * the unlink. The name's clock is local, so a machine that changes timezone (a
 * laptop does it by itself) can age a file by hours; mtime is absolute. Every
 * disagreement between the two therefore keeps the file, which is the bias this
 * operation needs — including for a file still being appended to, whose mtime
 * is fresh however old its name looks.
 */
export async function sweepRequestLogs(logDir, retentionHours, now = Date.now()) {
  if (!(retentionHours > 0)) return 0;
  const cutoff = now - retentionHours * 3600_000;
  let entries;
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = LOG_FILE_RE.exec(entry.name);
    if (!m) continue;
    const started = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
    // Negated so anything not definitively older than the cutoff is skipped.
    // The pattern admits only digits and Date rolls every such combination into
    // a real time, so this cannot be indeterminate today; the shape keeps the
    // bias toward skipping if the pattern is ever loosened.
    if (!(started < cutoff)) continue;
    const path = join(logDir, entry.name);
    try {
      const { mtimeMs } = await stat(path);
      if (!(mtimeMs < cutoff)) continue;
    } catch {
      continue;
    }
    try {
      await unlink(path);
      removed++;
    } catch { /* already gone, or a concurrent sweep won the race */ }
  }
  return removed;
}

// A per-request log that streams to disk as the request/response flow, instead
// of buffering the whole body in memory and writing once at the end. The file
// is opened on first write; header sections are written verbatim and bodies are
// streamed through BodyWriter (JSON pretty-printed on the fly, SSE/other raw),
// so even a ~1M-token response costs only the current chunk.
// Process-wide sequence for log file names. The per-request id is per
// listener (the base server and each MITM pin server count from zero), so two
// listeners could open the same "<ms-timestamp>_<id>" name in one millisecond
// and interleave two requests in one file. A single counter cannot collide.
let logFileSeq = 0;

function openRequestLog(logDir, _reqId, { level = DEFAULT_LOG_LEVEL, maxBodyBytes = DEFAULT_LOG_MAX_BODY_BYTES } = {}) {
  const filename = `${logTimestamp()}_${String(++logFileSeq).padStart(5, '0')}.log`;
  // 0600: the file holds the full request and response bodies.
  const ws = createWriteStream(join(logDir, filename), { flags: 'a', mode: 0o600 });
  let ended = false;
  let failed = false;
  // Whether the last write was queued rather than flushed. The streaming path
  // asks drain() so a disk that cannot keep up with upstream pauses the relay
  // instead of the body piling up in the stream's buffer — the "only the
  // current chunk in memory" promise has to hold for the socket underneath the
  // formatter too.
  let backlogged = false;
  const fail = (err) => {
    if (failed) return;
    failed = true;
    console.error(`[AgentLB] Request log ${filename} abandoned: ${err.message}`);
  };
  ws.on('error', fail);
  const write = (s) => {
    if (ended || failed || !s) return;
    backlogged = !ws.write(Buffer.from(String(s), 'latin1'));
  };
  // Logging must never fail the request it describes. The formatter runs on
  // whatever bytes the client or upstream produced, so a throw here is a log
  // problem, not a request problem: record it once and go on relaying.
  const guarded = (fn) => { try { return fn(); } catch (err) { fail(err); return undefined; } };
  const drain = () => {
    if (!backlogged || ended || failed || ws.destroyed) return null;
    return new Promise((resolve) => {
      const done = () => { ws.off('drain', done); ws.off('close', done); ws.off('error', done); backlogged = false; resolve(); };
      ws.once('drain', done);
      ws.once('close', done);
      ws.once('error', done);
    });
  };
  return {
    write,
    // Stream a complete body buffer under a section header.
    body(label, buf, contentType) { guarded(() => this._body(label, buf, contentType)); },
    _body(label, buf, contentType) {
      if (level === 'headers') return;
      if (!buf || !buf.length) { write(`\n\n=== ${label} ===\n(empty)`); return; }
      if (maxBodyBytes > 0) {
        // A complete body is already held whole, so keeping its tail costs no
        // extra memory — and the tail is where the newest message and the latest
        // tool result sit, which is usually what the log was opened for.
        const half = Math.max(1, Math.floor(maxBodyBytes / 2));
        const dropped = buf.length - 2 * half;
        if (dropped > 0) {
          // The tail goes in raw. Replaying it through the head's formatter would
          // carry that formatter's depth and in-string state across the gap: the
          // indentation would be wrong, and once the tail's closing brackets
          // outnumber the depth it throws on a negative repeat count.
          const head = new BodyWriter(write, label, contentType || '');
          head.chunk(buf.subarray(0, half));
          head.end();
          write(`\n${truncationNote(dropped)}\n`);
          write(buf.subarray(buf.length - half).toString('latin1'));
          return;
        }
      }
      const whole = new BodyWriter(write, label, contentType || '');
      whole.chunk(buf);
      whole.end();
    },
    // A BodyWriter to append chunks incrementally (e.g. an SSE response), or
    // null when the level records no bodies — streamResponse takes either.
    bodyWriter(label, contentType) {
      if (level === 'headers') return null;
      const bw = new BodyWriter(write, label, contentType || '', maxBodyBytes);
      return {
        chunk: (buf) => guarded(() => bw.chunk(buf)),
        end: () => guarded(() => bw.end()),
        drain,
      };
    },
    end() { if (!ended) { ended = true; if (!failed) ws.end('\n'); else ws.destroy(); } },
  };
}

export function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => {
      const name = String(k).toLowerCase();
      return `  ${k}: ${SENSITIVE_HEADER_NAMES.has(name) ? '[redacted]' : v}`;
    }).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => {
    const name = String(k).toLowerCase();
    return `  ${k}: ${SENSITIVE_HEADER_NAMES.has(name) ? '[redacted]' : v}`;
  }).join('\n');
}

// Failures that say nothing about the ACCOUNT, only about the socket. Retrying
// can succeed where failing over cannot, and closing fast lets Node evict the
// dead socket so the client's retry reconnects cleanly. EPIPE joins the set as
// the write-side sibling of ECONNRESET.
//
// ECONNREFUSED sits here despite being arguably a property of the host. It is
// already unconditionally transient, so making it conditional converts every gap
// in that condition into a regression instead of leaving an unfixed case. One
// such gap was measurable before the other-host scan gated on selection's own
// eligibility predicate: a disabled account carrying its own `upstream` was
// never selected, never entered `ctx.tried`, and satisfied the condition
// indefinitely — a four-account fleet spent three accounts on a refused
// connection and answered rate_limit_error. That instance is closed; keeping
// ECONNREFUSED unconditional means any future gap stays a non-regression.
// A non-streaming response sends its headers only once the whole answer is
// generated, which for a long answer (extended thinking, a large max_tokens)
// takes minutes. The stream-oriented time-to-first-byte guard (120s) cut those
// off and the client's retry paid for the generation again. Ten minutes
// matches the Anthropic SDK's own non-streaming timeout; never shorter than the
// general guard. Override: AGENT_LB_UPSTREAM_NONSTREAM_HEADERS_TIMEOUT_MS.
const DEFAULT_NONSTREAM_HEADERS_TIMEOUT_MS = 600_000;
export function nonStreamHeadersTimeout() {
  const env = Number(process.env.AGENT_LB_UPSTREAM_NONSTREAM_HEADERS_TIMEOUT_MS);
  const general = Number(process.env.AGENT_LB_UPSTREAM_HEADERS_TIMEOUT_MS);
  const base = env > 0 ? env : DEFAULT_NONSTREAM_HEADERS_TIMEOUT_MS;
  return general > base ? general : base;
}

/**
 * A Codex 429 that means the account's quota is spent (not a momentary
 * throttle): `usage_limit_reached` in the body, or a window reported at 100%.
 * Returns { resetSeconds } or null. Exported for tests.
 */
export function codexUsageLimit(body, headers = {}) {
  const err = body?.error;
  const pct = (name) => Number(headers[`x-codex-${name}-used-percent`]);
  const spent = err?.type === 'usage_limit_reached' || err?.code === 'usage_limit_reached'
    || pct('primary') >= 100 || pct('secondary') >= 100;
  if (!spent) return null;
  const fromBody = Number(err?.resets_in_seconds);
  const fromHeader = Number(headers['x-codex-primary-reset-after-seconds']);
  const resetSeconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody
    : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 3600;
  return { resetSeconds };
}

const SOCKET_TRANSIENT = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'AGENTLB_HEADERS_TIMEOUT', 'AGENTLB_BODY_TIMEOUT', 'AGENTLB_HEADERS_TIMEOUT', 'AGENTLB_BODY_TIMEOUT',
]);

// Failures that are a property of the HOST being dialled: name resolution and
// routing. The hostname has no per-account component, so every account produces
// the same failure, and walking the fleet spends an upstream call per account to
// learn the same thing. The client is then told its quota is exhausted because a
// name would not resolve.
//
// Conditional, because an account may name its own `upstream` for a third-party
// backend. Where an untried account would dial a different host, this failure
// says nothing about that one, and failing over is correct.
const HOST_TRANSIENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);

/**
 * Every error code a failure carries: its own, its `cause`'s, and its
 * children's. Node's global fetch puts the real error on `cause`, and the
 * happy-eyeballs dialer reports an all-addresses-failed connect as an
 * AggregateError that may carry no top-level code at all, with the reason
 * recorded once per address.
 */
function errorCodes(err) {
  const codes = [err?.code, err?.cause?.code];
  for (const child of err?.errors || []) codes.push(child?.code);
  for (const child of err?.cause?.errors || []) codes.push(child?.code);
  return codes.filter(Boolean);
}

/**
 * Should this upstream failure close the connection for the client to retry,
 * instead of being failed over to the next account?
 *
 * `otherHostAvailable` states whether an untried account would dial a different
 * host, which is what makes a host-scoped failure worth failing over. Exported
 * for its own tests.
 */
export function isTransientUpstreamError(err, { otherHostAvailable = false } = {}) {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const codes = errorCodes(err);
  if (codes.some(c => SOCKET_TRANSIENT.has(c))) return true;
  if (codes.some(c => HOST_TRANSIENT.has(c))) return !otherHostAvailable;
  // Read last, and only once no code has been found. Node's global fetch, which
  // `AGENT_LB_UPSTREAM_GLOBAL_FETCH` selects, reports every failure with this
  // message and the real error on `.cause`; checking it earlier would answer for
  // the whole transport before the codes above were consulted, so a host-scoped
  // failure there would never reach its conditional arm.
  if (typeof err.message === 'string' && err.message.includes('fetch failed')) return true;
  return false;
}

/**
 * The message behind the synthetic 429, when no account can serve the request.
 *
 * The old wording — `All N accounts exhausted. Retry in 60s.` — was wrong in
 * three ways at once, and each one pushed the operator somewhere unhelpful
 * (#168):
 *
 *   - N counted every configured account, including ones the operator had
 *     disabled. An account deliberately out of rotation is not capacity that
 *     ran out.
 *   - it never named the model, so a family-specific refusal (Fable spent,
 *     Opus fine) read as the whole proxy being out of capacity.
 *   - "exhausted" reads terminal while "retry in 60s" reads transient, so the
 *     operator retried by hand instead of looking at what was actually blocked.
 *
 * Counts only the accounts that were candidates, names the model when the
 * request carried one, and says plainly that the wait is until a window resets.
 */
export function exhaustedMessage(accountManager, model, retryAfter, provider = null) {
  const allAccounts = accountManager.accounts || [];
  if (allAccounts.length === 0) {
    return 'No accounts configured in AgentLB. Please add an account via the Web Dashboard or CLI.';
  }
  const accounts = provider
    ? allAccounts.filter(a => providerOf(a) === provider)
    : allAccounts;

  if (accounts.length === 0) {
    return `No ${provider} accounts configured in AgentLB. Please add a ${provider} account via the Web Dashboard or CLI.`;
  }

  const eligible = accounts.filter(a => !a.disabled);
  const disabled = accounts.length - eligible.length;
  const scope = model ? ` for ${model}` : '';

  if (eligible.length === 0) {
    const plural = disabled === 1 ? 'account is' : 'accounts are';
    return `No account can serve this request${scope}: all ${disabled} ${plural} disabled.`;
  }

  const identityCount = eligible.filter(a => accountManager._identityVerificationRequired?.(a)).length;
  const pool = eligible.length === 1 ? '1 account is' : `all ${eligible.length} accounts are`;
  const quotaWord = eligible.length === 1 ? 'at its quota or rate limit' : 'at their quota or rate limit';
  const aside = disabled ? ` (${disabled} more disabled)` : '';
  const idNote = identityCount > 0
    ? ` (${identityCount} require${identityCount === 1 ? 's' : ''} identity verification in browser)`
    : '';
  const when = retryAfter > 0
    ? ` Quota resets in ${retryAfter}s.`
    : ' Retry shortly.';

  return `No account can serve this request${scope}: ${pool}${aside} ${quotaWord}${idNote}.${when}`;
}

export async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, useSx) {
  const maxRetries = accountManager.accounts.length;
  // This function is exported, so a caller may hand us a ctx built elsewhere.
  // The 401 path reads ctx.reauthed on every response; default it here rather
  // than trusting every construction site to include it.
  ctx.reauthed ??= new Set();
  // Same reason: a ctx built by an external caller carries no log settings.
  ctx.logLevel ??= DEFAULT_LOG_LEVEL;
  ctx.logMaxBodyBytes ??= DEFAULT_LOG_MAX_BODY_BYTES;
  // Whether THIS attempt dials via sx.org. Undefined on the first call → derive
  // from the default policy ('always' routes; 'off'/'429' start direct).
  const route = useSx === undefined ? !!(sx?.useByDefault()) : useSx;

  // Taken before the walk, which can move the observation, and a request cannot
  // confirm the stay its own selection began. A pinned request bypasses
  // selection, so it consults no observation and is no evidence about a rest.
  // A failover hop names its destination up front (ctx.hopTo, set by the 429
  // and 5xx hops below) and is one attempt long: consumed here so the attempt
  // after it, if any, selects normally. Like a pin it bypasses selection, so it
  // is no evidence about a rest either.
  const hopTo = ctx.hopTo ?? null;
  ctx.hopTo = null;
  const restingGen = ctx.pinnedIndex == null && hopTo == null
    ? accountManager.observedGeneration(ctx.sessionId, ctx.model)
    : null;

  // Select account, skipping any already tried (and failed) this request.
  // The model scopes availability so a Fable-exhausted account is skipped only
  // for Fable requests (it still serves other models).
  // A pinned request (via /tc-acct/<name>) forces one exact account and never
  // rotates or fails over: once that account has been tried, `account` is null
  // and the caller gets the exhausted response rather than leaking to another.
  // A cap outranks the pin. Rotation checks it through unavailableReason, but a
  // pinned request never reaches that walk, and a budget a pin can spend past is
  // not a budget. The request gets the exhausted response, exactly as it would
  // for an already-tried pin — it still never leaks to another account.
  const pinned = ctx.pinnedIndex != null && !ctx.tried.has(ctx.pinnedIndex)
    ? accountManager.accounts[ctx.pinnedIndex]
    : null;
  // What this attempt's selection decided beyond which account it returned.
  // Carried on ctx rather than read straight back, because the failover hops
  // below run after an upstream round trip.
  const selection = {};
  // A pin bypasses selection entirely, so the provider partition has to be
  // enforced here too — otherwise TC_ACCT aimed at a Claude subscription would
  // serve a Codex request from it, sending an OpenAI-shaped body to
  // api.anthropic.com with a Claude token. Subscriptions only: an API-key
  // account is metered capacity with no tie to a caller, so a pin to one stands.
  const pinnedWrongProvider = pinned
    && isSubscriptionAccount(pinned)
    && providerOf(pinned) !== (ctx.provider || DEFAULT_PROVIDER);
  // The hop's destination was picked by pickAlternate against this request's
  // own exclusions, and is taken as-is: re-selecting here would walk the fleet
  // cursor onto it, which is exactly the move a detour must not make (#286).
  const account = hopTo != null
    ? accountManager.accounts[hopTo]
    : ctx.pinnedIndex != null
      ? (pinned && !pinnedWrongProvider && !accountManager.capExceeded(pinned, ctx.model) ? pinned : null)
      : accountManager.getActiveAccount(
        ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId, ctx.provider, selection,
      );
  // Accounts a rollover deliberately routed this request away from. Request-
  // scoped: the decision belongs to the request, not to one attempt of it.
  if (selection.rolledOff) {
    ctx.rolledOff ??= new Set();
    for (const i of selection.rolledOff) ctx.rolledOff.add(i);
  }
  if (pinnedWrongProvider && !res.headersSent && !clientGone(res)) {
    // Named plainly: a pin that cannot serve is a configuration mistake, and the
    // exhausted-account response would send the operator looking at quota.
    ctx.status = 400;
    ctx.delivered = true;   // a configuration mistake, answered plainly
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Pinned account "${pinned.name}" is a ${providerOf(pinned)} subscription and cannot serve a ${ctx.provider} request.`,
      },
    }));
    return;
  }
  if (!account) {
    // Every candidate was refused by upstream (403). Waiting will not help — the
    // account needs attention, not a retry — so say so plainly rather than
    // reporting a rate limit. Not a 403 either: the client's own credential is
    // fine, and a 403 would make it drop its login over someone else's problem.
    //
    // Only when the refusals are the WHOLE story, though. If some accounts were
    // refused and others are merely out of quota, a reset will still serve this
    // request — so fall through to the retry-after/hold path below rather than
    // failing fast on the strength of one bad credential. Reporting 502 there
    // would turn a recoverable exhaustion into a hard error, and silently skip
    // the holdSeconds wait an unattended run depends on.
    const rejected = ctx.credentialRejected;
    // Read the manager's cross-request cooldown state, not just the names this
    // request happened to encounter. An account may already have been excluded
    // by an earlier request, and a mixed Claude/Codex fleet contains accounts
    // that are deliberately outside this request's provider partition.
    const requestProvider = ctx.provider || DEFAULT_PROVIDER;
    const relevantAccounts = ctx.pinnedIndex != null
      ? [accountManager.accounts[ctx.pinnedIndex]].filter(a => a && !a.disabled)
      : accountManager.accounts.filter(a =>
        !a.disabled
        && (!isSubscriptionAccount(a) || providerOf(a) === requestProvider)
        && (!ctx.model || accountManager._routeAllows(a, ctx.model)));
    const identityAccounts = relevantAccounts.filter(a =>
      accountManager.unavailableReason(a, ctx.model, ctx.advisorModel) === 'identity-verification');
    const allIdentityRequired = relevantAccounts.length > 0
      && identityAccounts.length === relevantAccounts.length;
    if (allIdentityRequired) {
      const identityNames = identityAccounts.map(a => a.name);
      const names = identityNames.map(n => `"${n}"`).join(', ');
      ctx.status = 502;
      ctx.account = `(${identityNames.join(', ')} require identity verification)`;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'proxy_error',
            message: `Anthropic requires identity verification for every eligible account: ${names}. Complete verification for one of these accounts, then retry.`,
          },
        }));
      }
      return;
    }
    const allRefused = rejected?.size > 0 && (ctx.pinnedIndex != null
      ? rejected.has(accountManager.accounts[ctx.pinnedIndex]?.name)
      : rejected.size === accountManager.accounts.length);
    if (allRefused) {
      const names = [...rejected].map(n => `"${n}"`).join(', ');
      const entitlementDenied = ctx.entitlementDenied;
      const allEntitlementDenied = entitlementDenied?.size === rejected.size
        && [...rejected].every(name => entitlementDenied.has(name));
      let message;
      if (allEntitlementDenied && ctx.pinnedIndex != null) {
        message = `No account served this request. The pinned account ${names} returned OAuth entitlement denial (${OAUTH_ENTITLEMENT_ERROR_CODE}). An explicit pin targets that account exactly; choose a different eligible account or change its organization's OAuth policy.`;
      } else if (allEntitlementDenied) {
        message = `No account served this request. Every configured account returned OAuth entitlement denial (${OAUTH_ENTITLEMENT_ERROR_CODE}): ${names}. AgentLB temporarily removed them from automatic rotation; retry after the cooldown or pin a different eligible account.`;
      } else {
        message = `Upstream refused the credential for account ${names} (403). Check the account, then re-add it with: agentlb login`;
      }
      ctx.status = 502;
      ctx.account = `(${[...rejected].join(', ')} refused)`;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message },
        }));
      }
      return;
    }
    // A pinned request concerns exactly one account: don't compute a fleet-wide
    // retry-after or sleep on other accounts' windows — return immediately.
    if (ctx.pinnedIndex != null) {
      ctx.status = 429;
      ctx.account = '(pinned account unavailable)';
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Pinned account is unavailable (rate-limited, errored, or already tried). Retry shortly.' },
        }));
      }
      return;
    }
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const providerAccounts = status.accounts.filter(a => (a.provider || DEFAULT_PROVIDER) === requestProvider);
    const retryAfter = computeRetryAfter(providerAccounts.length > 0 ? providerAccounts : status.accounts);

    // Long-hold mode: hold the HTTP connection and poll until an account
    // recovers or the budget (holdSeconds) runs out. Claude Code waits for
    // the first response byte, so this is transparent to the client as long
    // as API_TIMEOUT_MS on the Claude Code side is large enough.
    if (ctx.holdBudgetMs > 0) {
      // Cap the per-poll sleep to 60s so a newly-available account (e.g. one
      // manually enabled or whose quota reset early) is picked up within a
      // minute instead of sleeping the full retryAfter (often 3600s).
      const waitMs = Math.min(retryAfter * 1000, ctx.holdBudgetMs, 60_000);
      ctx.holdBudgetMs -= waitMs;
      console.log(`[AgentLB] All accounts exhausted — holding connection, retry in ${Math.ceil(waitMs / 1000)}s (${Math.ceil(ctx.holdBudgetMs / 1000)}s budget left)`);
      await waitForRetry(waitMs, ctx.signal);
      if (clientGone(res)) { ctx.abandoned = true; return; }
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }

    const exhaustedRetries = ctx.exhaustedRetries || 0;
    if (exhaustedRetries < 1 && retryAfter <= INLINE_RETRY_AFTER_MAX_SECONDS) {
      ctx.exhaustedRetries = exhaustedRetries + 1;
      console.log(`[AgentLB] All accounts exhausted — waiting ${retryAfter}s before retry`);
      await waitForRetry(retryAfter * 1000, ctx.signal);
      if (clientGone(res)) { ctx.abandoned = true; return; }
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: exhaustedMessage(accountManager, ctx.model, retryAfter, requestProvider),
      },
    }));
    return;
  }

  ctx.requestedModel ??= ctx.model;
  // Track which account handles this request
  ctx.account = account.name;
  // Pin this session to the serving account for the model's weekly bucket (for
  // affinity) and keep it "active" in the running-sessions readout. Passive when
  // distribution is off.
  accountManager.recordSession(ctx.sessionId, account.index, ctx.model);
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
    ctx.tried.add(account.index);
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
  }

  // Build upstream request headers
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // HTTP/2 pseudo-headers (:method, :path, :authority, :scheme) live in
    // req.headers on the h2 server path; fetch rejects `:`-prefixed names.
    if (lk.startsWith(':')) continue;
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    // Both credential headers are dropped, not just the one the account will
    // set: applyAuthHeaders overwrites `authorization` only for bearer-token
    // accounts, so on an API-key account the CLIENT's own
    // `Authorization: Bearer <its Anthropic OAuth token>` would otherwise ride
    // along untouched — to whatever host that account's `upstream` names.
    if (lk === 'x-api-key' || lk === 'authorization') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    // Headers configured as usage dimensions are addressed to this proxy and
    // carry the operator's own labels (project, branch, team). They are
    // consumed here, so they do not travel upstream.
    if (ctx.stripHeaders?.has(lk)) continue;
    headers[key] = value;
  }

  // Credential presentation is provider-specific: Anthropic OAuth and Codex
  // both use a bearer token, Anthropic API keys use x-api-key, and Codex also
  // needs ChatGPT-Account-Id to scope the token to one account.
  if (ctx.clientEntry?.allowedProviders?.length && !ctx.clientEntry.allowedProviders.includes(providerOf(account))) {
    ctx.status = 403;
    denyClientPolicy(res, { error: 'client key is not authorized for the selected provider' });
    return;
  }
  applyAuthHeaders(headers, account);

  const requestProvider = ctx.requestProvider || ctx.provider || DEFAULT_PROVIDER;
  const servingProvider = providerOf(account);
  const isCrossProvider = servingProvider !== requestProvider;

  // For Anthropic OAuth accounts, ensure Claude Code headers are set so Anthropic accepts the request
  if (servingProvider === 'anthropic' && account.type === 'oauth') {
    if (!headers['anthropic-beta']) {
      headers['anthropic-beta'] = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31';
    } else if (!headers['anthropic-beta'].includes('claude-code-20250219')) {
      headers['anthropic-beta'] = `${headers['anthropic-beta']},claude-code-20250219`;
    }
    if (!headers['user-agent'] || !headers['user-agent'].includes('claude-cli')) {
      headers['user-agent'] = 'claude-cli/2.1.251 (external, sdk-cli)';
    }
    headers['x-app'] ??= 'cli';
    headers['anthropic-version'] ??= '2023-06-01';
  }

  let upstreamUrl = `${upstreamFor(account, upstream)}${req.url}`;
  const method = req.method;

  let sendBody = body;
  const isChatCompletions = (req.url || '').startsWith('/v1/chat/completions');
  if (isChatCompletions && servingProvider === 'codex' && (account.type === 'oauth' || (upstreamFor(account, upstream) || '').includes('chatgpt.com'))) {
    ctx.originalModel = ctx.model;
    upstreamUrl = `${upstreamFor(account, upstream)}/backend-api/codex/responses`;
    sendBody = translateChatCompletionsToCodexResponses(sendBody, substitutedModel(ctx.fallbackPolicy, ctx.requestedModel || ctx.model, 'codex'));
    headers['content-type'] = 'application/json';
    headers['accept'] = 'text/event-stream';
    headers['user-agent'] = 'codex-cli/0.1.0';
    ctx.isCodexResponsesToOpenAI = true;
    let isClientStreaming = false;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (parsed.stream === true) isClientStreaming = true;
    } catch {}
    ctx.isClientStreaming = isClientStreaming;
  } else if (isCrossProvider) {
    if (requestProvider === 'anthropic' && servingProvider === 'codex') {
      if (account.type === 'oauth' || (upstreamFor(account, upstream) || '').includes('chatgpt.com')) {
        ctx.originalModel = ctx.model;
        upstreamUrl = `${upstreamFor(account, upstream)}/backend-api/codex/responses`;
        const openAIBody = translateAnthropicToOpenAI(sendBody, substitutedModel(ctx.fallbackPolicy, ctx.requestedModel || ctx.model, 'codex'));
        sendBody = translateChatCompletionsToCodexResponses(openAIBody, substitutedModel(ctx.fallbackPolicy, ctx.requestedModel || ctx.model, 'codex'));
        headers['content-type'] = 'application/json';
        headers['accept'] = 'text/event-stream';
        headers['user-agent'] = 'codex-cli/0.1.0';
        ctx.isCodexResponsesToAnthropic = true;
        let isClientStreaming = false;
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          if (parsed.stream === true) isClientStreaming = true;
        } catch {}
        ctx.isClientStreaming = isClientStreaming;
      } else {
        upstreamUrl = `${upstreamFor(account, upstream)}/v1/chat/completions`;
        sendBody = translateAnthropicToOpenAI(sendBody, substitutedModel(ctx.fallbackPolicy, ctx.requestedModel || ctx.model, 'codex'));
        headers['content-type'] = 'application/json';
      }
    } else if (requestProvider === 'codex' && servingProvider === 'anthropic') {
      upstreamUrl = `${upstreamFor(account, upstream)}/v1/messages`;
      sendBody = translateOpenAIToAnthropic(sendBody, substitutedModel(ctx.fallbackPolicy, ctx.requestedModel || ctx.model, 'anthropic'));
      headers['content-type'] = 'application/json';
    }
  }

  // Every rewrite below runs inside rewriteRequestBody (exported for tests);
  // Content-Length is refreshed below because the body can shrink.
  const effectiveUrl = (upstreamUrl && upstreamUrl.includes('/v1/messages')) ? '/v1/messages' : req.url;
  sendBody = rewriteRequestBody(sendBody, account, effectiveUrl, headers['content-type'] || req.headers['content-type']);

  const rewrittenModel = parseRequestModel(sendBody);
  if (rewrittenModel) {
    if (!substitutionAllowed(ctx.fallbackPolicy, ctx.requestedModel, servingProvider, rewrittenModel)) {
      ctx.status = 403;
      denyClientPolicy(res, { error: 'model substitution is not approved by fallbackPolicy' });
      return;
    }
    ctx.model = rewrittenModel;
    if (ctx.clientEntry && ctx.clientUsage) {
      const policy = ctx.clientUsage.checkQuota(ctx.client, ctx.clientEntry, rewrittenModel);
      if (!policy.allowed) { ctx.status = policy.status || 403; denyClientPolicy(res, policy); return; }
    }
  }

  // If the body changed length (sanitize, model rewrite, or field strip), update
  // Content-Length so the upstream doesn't receive a mismatched framing and
  // truncate or stall.
  if (sendBody !== body) headers['content-length'] = String(sendBody.length);

  // Streaming request log, opened lazily on the first terminal outcome (a
  // pure-429-then-retry attempt writes no file, matching prior behavior). The
  // request head+body are written once, just before the response is logged.
  let log = null;
  let reqLogged = false;
  const getLog = () => (logDir && ctx.logLevel !== 'off'
    ? (log ||= openRequestLog(logDir, reqId, { level: ctx.logLevel, maxBodyBytes: ctx.logMaxBodyBytes }))
    : null);
  const logRequestHead = () => {
    const l = getLog();
    if (!l || reqLogged) return;
    reqLogged = true;
    l.write(`=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(headers)}`);
    // The body that went upstream, not the one the client sent: they differ
    // exactly when the proxy rewrote it (tool-pair sanitising, account_uuid,
    // modelMap, cache_control strip), which is the first thing to check when
    // upstream rejects it.
    if (sendBody !== body) l.write(`\n(body rewritten by the proxy before sending: ${body.length} → ${sendBody.length} bytes; the upstream copy follows)`);
    if (sendBody.length > 0) l.body('REQUEST BODY', sendBody, req.headers['content-type']);
  };

  let ownsRecoveryProbe = false;
  try {
    // Storm control: pace requests onto a freshly-switched account so a failover
    // burst doesn't slam it all at once and cascade (issue #84). The slot is held
    // only until the response headers arrive — long enough to stagger the burst,
    // then released so streaming bodies don't tie up concurrency. Fail-open: a
    // client that disconnects while waiting just drops out.
    // admit() returns false only when isAborted() fires, and isAborted IS
    // clientGone — so this is a pure abandonment exit. It fires while an account
    // is paused or ramping, which is exactly when clients give up, so leaving it
    // unmarked clustered false positives where the signal is read hardest.
    if (!await accountManager.admit(account.index, () => clientGone(res))) { ctx.abandoned = true; return; }
    // This request may have selected the account before another in-flight request
    // observed an entitlement denial. Re-check after admission, when the queued
    // request is about to send, so the cooldown also drains that preselected
    // backlog. Explicit caller pins still target exactly the requested account.
    if (ctx.pinnedIndex == null && retryCount < maxRetries
        && (accountManager.isEntitlementDenied(account.index)
          || accountManager.isIdentityVerificationRequired(account.index))) {
      accountManager.release(account.index, { successful: false });
      ctx.tried.add(account.index);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }
    const attemptStart = performance.now();
    let upstreamRes;
    let admittedLoad = 0;
    const halfOpen = account.circuitBreakerUntil > 0 && account.circuitBreakerUntil <= Date.now();
    if (halfOpen && account.halfOpenInFlight) {
      accountManager.release(account.index, { successful: false });
      ctx.status = 503;
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { message: 'Backend recovery probe in progress' } })); return;
    }
    if (halfOpen) { account.halfOpenInFlight = true; ownsRecoveryProbe = true; }
    try {
      // Codex translation always streams upstream; otherwise the client's own
      // choice is what upstream sees.
      const upstreamStreams = ctx.isCodexResponsesToOpenAI || ctx.isCodexResponsesToAnthropic || ctx.clientStream !== false;
      upstreamRes = await upstreamFetch(upstreamUrl, {
        headersTimeoutMs: upstreamStreams ? undefined : nonStreamHeadersTimeout(),
        method,
        headers,
        // Cancels the admission wait and the request itself when the client
        // goes away (see the listener's AbortController).
        signal: ctx.signal,
        body: ['GET', 'HEAD'].includes(method) ? undefined : sendBody,
        redirect: 'manual',
      }, sx, route);
    } finally {
      ctx.metrics?.observeHeaders((performance.now() - attemptStart) / 1000);
      admittedLoad = accountManager.release(account.index,
        { successful: !!upstreamRes && upstreamRes.status < 400 }) || 0;
    }

    // Extract rate limit headers. Codex reports the same readings under
    // `x-codex-*`; dropping those here left a Codex account's quota fed only by
    // the background prober, so selection kept choosing a spent account.
    const rateLimitHeaders = {};
    const codexQuotaHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      } else if (key.startsWith('x-codex-')) {
        codexQuotaHeaders[key] = value;
      }
    }
    const isCodexAccount = providerOf(account) === 'codex';
    accountManager.updateQuota(account.index, isCodexAccount ? codexQuotaHeaders : rateLimitHeaders);

    // Any non-429 response is live proof a rate-limit hold no longer binds —
    // this is what lets a revalidation probe (a throttled account selected by
    // _selectProbe) clear its own hold and return the fleet to service.
    if (upstreamRes.status !== 429) accountManager.clearRateLimited(account.index);

    if (upstreamRes.status >= 500) {
      account.consecutiveErrors = (account.consecutiveErrors || 0) + 1;
      if (account.consecutiveErrors >= 3) {
        account.circuitBreakerUntil = Date.now() + 60000;
        console.warn(`[Agent-LB] Circuit breaker tripped on account "${account.name}" (${account.consecutiveErrors} consecutive 5xx) — isolated for 60s`);
      }
    }

    // Two kinds of 429 are handled differently below: a quota rejection rotates
    // to another account; a transient rate-limit throttle pauses + retries the
    // same account (never rotates — see #84).
    if (upstreamRes.status === 429) {
      // Clamp Retry-After to a sane window: missing/invalid falls back to 60s,
      // and out-of-range values are bounded to [1, 300]. A negative value would
      // otherwise bypass the wait cap — setTimeout returns immediately and a
      // pause/hold would be armed in the past.
      const retryAfterHeader = upstreamRes.headers.get('retry-after');
      let retryAfter = parseInt(retryAfterHeader, 10);
      if (Number.isNaN(retryAfter)) retryAfter = 60;
      // A 429 that says nothing about the account — no retry-after, no
      // anthropic-ratelimit-* — is about the REQUEST: a model id upstream
      // refuses, a shape it will not take. Neither of the account-level
      // responses below applies to it. Pausing the account made every other
      // session on it wait out a fabricated 60s for one client's bad model id,
      // and the inline wait then held that client for the same 60s per attempt;
      // together they turned one request's problem into a fleet-wide stall
      // (#288). A throttle, by contrast, always carries the headers.
      // (Codex's x-codex-* readings ride on every response, so they do not
      // make a 429 account-scoped; only a spent quota, detected below, does.)
      let requestScoped = retryAfterHeader == null && Object.keys(rateLimitHeaders).length === 0;
      // The body is diagnostic for a request-scoped refusal (it names the
      // reason) and noise otherwise. A Codex 429 is read either way: ChatGPT
      // states quota exhaustion only in the body (`usage_limit_reached`), and
      // it sends no retry-after.
      let refusal = '';
      let codexLimit = null;
      if (requestScoped || isCodexAccount) {
        const raw = await readErrorBody(upstreamRes.body).catch(() => null);
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw.toString('utf8')) : null; } catch { parsed = null; }
        refusal = String(parsed?.error?.message || '');
        if (isCodexAccount) codexLimit = codexUsageLimit(parsed, codexQuotaHeaders);
        if (codexLimit) requestScoped = false;
      } else {
        await upstreamRes.body?.cancel();
      }

      // Codex quota exhaustion: the account is spent until its window resets,
      // so waiting on it or retrying it is futile. Hold it (selection then
      // skips it for later requests too) and move this request to another one.
      if (codexLimit) {
        const hold = Math.min(Math.max(codexLimit.resetSeconds, 1), 3600);
        console.log(`[AgentLB] Codex usage limit reached on "${account.name}" — holding ${hold}s and switching account`);
        accountManager.markRateLimited(account.index, hold);
        account.lastError = { reason: 'usage-limit', status: 429, error: refusal || 'Codex usage limit reached', timestamp: Date.now() };
        if (retryCount < maxRetries) {
          ctx.tried.add(account.index);
          if (clientGone(res)) { ctx.abandoned = true; return; }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
        }
        ctx.status = 429;
        if (!res.headersSent && !clientGone(res)) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(hold) });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: refusal || 'Codex usage limit reached on every account.' } }));
        }
        return;
      }

      // Durable quota exhaustion vs. a transient rate limit. A "rejected" unified
      // status means a quota bucket is spent, so waiting and retrying the SAME
      // account is futile — switch to another account now (updateQuota above
      // already recorded the spent bucket's utilization from the headers).
      const rl = rateLimitHeaders;
      const generalRejected = rl['anthropic-ratelimit-unified-5h-status'] === 'rejected'
        || rl['anthropic-ratelimit-unified-7d-status'] === 'rejected';
      const fableRejected = rl['anthropic-ratelimit-unified-7d_oi-status'] === 'rejected' && !generalRejected;
      if ((generalRejected || fableRejected) && retryCount < maxRetries) {
        // A Fable-only rejection leaves the account fine for other models, so we
        // do NOT throttle it globally — the recorded Fable utilization makes
        // selection skip it for Fable requests only. A general rejection spends a
        // shared bucket, so hold the whole account for its reset window.
        if (fableRejected) {
          console.log(`[AgentLB] Fable weekly exhausted on "${account.name}" — switching account for this Fable request`);
        } else {
          const hold = Math.min(Math.max(retryAfter, 1), 3600);
          console.log(`[AgentLB] Quota rejection (429) on "${account.name}" — throttling ${hold}s and switching account`);
          accountManager.markRateLimited(account.index, hold);
        }
        ctx.tried.add(account.index);
        if (clientGone(res)) { ctx.abandoned = true; return; }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }

      retryAfter = Math.min(Math.max(retryAfter, 1), 300);

      // sx.org failover: 429s are IP-based, so retry via the proxy's egress IP.
      // 'always' is already on sx; '429' switches direct→sx now and skips the
      // wait (a fresh IP isn't throttled). Also arm the sticky window for MITM.
      const nextUseSx = !!(sx?.useOn429());
      const switchingToSx = nextUseSx && !route;
      // The sticky window routes every new MITM tunnel through sx.org for a
      // while, which is metered. A request-scoped 429 is not an IP limit, so it
      // does not arm it; the one-shot sx retry below still runs, in case an
      // IP-scoped limit ever presents without headers.
      if (!requestScoped) sx?.noteRateLimited(retryAfter);

      // This is a rate-limit 429 (per-minute throttle), NOT quota exhaustion —
      // quota rejection is handled above and is the only thing that rotates.
      // Do NOT switch accounts here: moving the burst to the next account just
      // throttles it too (thundering herd, #84) and discards this account's KV
      // cache. Instead PAUSE this account so concurrent requests wait in admit()
      // (capped, then released through a fresh ramp) instead of piling on, and
      // retry the SAME account. The pause never marks the account throttled, so
      // selection keeps choosing it.
      // Not for a request-scoped 429: the account is fine, and the pause is
      // exactly the fleet-wide stall #288 describes.
      if (!requestScoped) {
        accountManager.pauseAccount(account.index,
          Math.min(retryAfter, RATE_LIMIT_ABSORB_MAX_SECONDS), admittedLoad);
      }

      // ONE bounded failover hop to an idle sibling (#137, #165, #156).
      //
      // #84's argument against rotating on a rate-limit 429 is that moving a
      // shared burst to the next account just throttles that one too and throws
      // away this account's KV cache. That holds under load. It does not hold
      // when a sibling is sitting idle, which is the case every reporter hit: a
      // three-account fleet stalling for 60s at a time on one throttled account
      // while another was at 9% weekly.
      //
      // So the hop is deliberately not a rotation policy: at most once per
      // request, never onto an account already tried, and never onto one inside
      // its own 429 pause — pauseAccount does not mark an account throttled, so
      // selection would otherwise happily hand back an account that is itself
      // waiting out a 429.
      //
      // The budget is one hop for a specific reason. If the SECOND account is
      // rate-limited too, the limit is almost certainly scoped to the egress IP
      // rather than to either account: every account leaves from the same
      // address, which is the premise the sx.org path below is built on. Hopping
      // further would prove nothing and pay a cold cache each time. After the
      // hop ctx.rateLimitHopped is set, this branch does not run again for this
      // request, and the sx fresh-IP retry and the inline wait take over —
      // which is the right response to an IP-scoped limit.
      if (!ctx.rateLimitHopped && retryCount < maxRetries) {
        // ctx.rolledOff as well as tried: an account a rollover moved this
        // request off was never sent a request, so it is not in `tried`, and
        // hopping back onto it would reverse that decision one step later.
        // pickAlternate, not getActiveAccount: the hop detours THIS request and
        // must leave the fleet cursor where it is (#286).
        const alt = accountManager.pickAlternate(
          new Set([...ctx.tried, ...(ctx.rolledOff || []), account.index]),
          ctx.model, ctx.advisorModel, ctx.provider,
        );
        if (alt && !accountManager.isPaused(alt.index)) {
          ctx.rateLimitHopped = true;
          ctx.hopTo = alt.index;
          ctx.tried.add(account.index);
          console.log(`[AgentLB] Rate-limit 429 on "${account.name}" — failing over once to idle account "${alt.name}"`);
          if (clientGone(res)) { ctx.abandoned = true; return; }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
        }
      } else if (ctx.rateLimitHopped && requestScoped) {
        // Second headerless 429, on a different account: it followed the
        // request. Nothing here is about either account.
        console.log(`[AgentLB] 429 followed the request onto "${account.name}" with no rate-limit headers — it is about the request, not the accounts; returning it to the client`
          + (refusal ? ` (${safeLine(refusal)})` : ''));
      } else if (ctx.rateLimitHopped) {
        // Second 429 this request, on a different account. Say so once: the
        // operator chasing "why is my fleet throttled" is looking for exactly
        // this, and it points at the egress IP rather than at the accounts.
        console.log('[AgentLB] Second account rate-limited too — the limit looks IP-scoped, not per-account'
          + (sx?.useOn429() ? '' : ' (sx.org mode "429" would retry from a fresh egress IP)'));
      }

      // sx fresh-IP retry (still the same account) takes precedence over waiting.
      // Bounded by retryCount like the inline-wait path below, so a persistently
      // 429ing upstream can't loop forever through sx.
      if (switchingToSx && retryCount < maxRetries) {
        console.log(`[AgentLB] 429 on "${account.name}" — retrying via sx.org (fresh egress IP)`);
        if (clientGone(res)) { ctx.abandoned = true; return; }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      // A request-scoped 429 goes back to the client now. The hop above (and
      // the sx retry, for the IP-scoped case that might present the same way)
      // has had its chance; a second account saying the same thing about the
      // same request is the answer, and waiting a fabricated 60s to hear it a
      // third time is the other half of #288. With no sibling to hop to, one
      // short retry covers a momentary blip, and then it is the client's turn.
      if (requestScoped) {
        if (!ctx.rateLimitHopped && !ctx.requestScopedRetried && retryCount < maxRetries) {
          ctx.requestScopedRetried = true;
          console.log(`[AgentLB] 429 with no rate-limit headers on "${account.name}" — retrying once in 2s${refusal ? ` (${safeLine(refusal)})` : ''}`);
          await waitForRetry(2000, ctx.signal);
          if (clientGone(res)) { ctx.abandoned = true; return; }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
        }
        ctx.status = 429;
        if (!res.headersSent && !clientGone(res)) {
          // No retry-after: upstream gave none, and inventing one would tell the
          // client to wait for a limit that does not exist. Its own backoff applies.
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: refusal || 'Upstream refused this request (429) without rate-limit headers.' } }));
        }
        return;
      }

      // Absorb short waits inline on the same account — the client never sees the
      // 429. Bounded by retryCount (maxRetries = account count) so a persistently
      // rate-limited account can't loop forever tying up the connection.
      if (retryAfter <= RATE_LIMIT_ABSORB_MAX_SECONDS && retryCount < maxRetries) {
        console.log(`[AgentLB] Rate-limit 429 on "${account.name}" — waiting ${retryAfter}s, retrying same account (no switch)`);
        await waitForRetry(retryAfter * 1000, ctx.signal);
        if (clientGone(res)) { ctx.abandoned = true; return; }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      // Longer retry-after (or retries exhausted): don't hold the connection and
      // don't rotate — surface the 429 with retry-after so the client backs off.
      // The pause above keeps other requests off this account meanwhile.
      console.log(`[AgentLB] Rate-limit 429 on "${account.name}" — retry-after ${retryAfter}s over inline cap; returning 429 to client (no switch)`);
      ctx.status = 429;
      if (!res.headersSent && !clientGone(res)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `Rate limited; retry in ${retryAfter}s.` } }));
      }
      return;
    }

    // A 401 means the credential we injected was rejected. For an OAuth account
    // that usually means the access token was revoked BEFORE its clock expiry —
    // something else refreshed the same token family, so upstream reports it
    // revoked while it still looks fresh locally. ensureTokenFresh's expiry
    // check cannot see that (it only compares the clock), so the account would
    // otherwise keep serving a dead token until the token aged out, and every
    // request in between would surface a 401 to the client with no recovery.
    // Force one refresh and retry. If the refresh is itself rejected the refresh
    // token is dead too: ensureTokenFresh marks the account errored, and the
    // retry's status check rotates to another account. Bounded to one re-auth
    // per account per request, so a genuinely dead credential surfaces the 401
    // instead of looping.
    // Upstream 5xx — 529 "Overloaded" above all (#156). This is the provider
    // saying it cannot serve right now, not anything about this account'"'"'s quota,
    // so surfacing it to the client turns a provider-side transient into a
    // client-visible failure — and Claude Code'"'"'s own retry loop then re-piles the
    // same load onto the same account.
    //
    // One hop, on the same budget and for the same reason as the 429 path above:
    // if a second account is overloaded too, it is the provider that is
    // overloaded, not the account, and walking the fleet would just spend every
    // account'"'"'s cache discovering that. After the hop the response goes to the
    // client as it does today, with its own retry-after intact.
    if (upstreamRes.status >= 500 && !res.headersSent && !ctx.serverErrorHopped && retryCount < maxRetries) {
      // Same exclusion as the 429 hop, and the same cursor-preserving pick.
      const alt = accountManager.pickAlternate(
        new Set([...ctx.tried, ...(ctx.rolledOff || []), account.index]),
        ctx.model, ctx.advisorModel, ctx.provider,
      );
      if (alt && !accountManager.isPaused(alt.index)) {
        await upstreamRes.body?.cancel();
        ctx.serverErrorHopped = true;
        ctx.hopTo = alt.index;
        ctx.tried.add(account.index);
        console.log(`[AgentLB] Upstream ${upstreamRes.status} on "${account.name}" — failing over once to "${alt.name}"`);
        if (clientGone(res)) { ctx.abandoned = true; return; }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }
    }

    // A pending Anthropic identity check is reported as a 400, although the
    // prompt is valid. Claude Code's automatic compaction surfaces that 400 as
    // "Prompt is too long" and cannot recover, even when another configured
    // account is healthy. Inspect the small non-streaming error response before
    // committing headers; if it names the identity-verification gate, cool down
    // this OAuth account and retry the same body on the next eligible one.
    // Other 400s remain byte-for-byte passthrough and are never rotated.
    let bufferedResponseBody = null;
    if (upstreamRes.status === 400 && account.type === 'oauth' && upstreamRes.body) {
      const contentType = upstreamRes.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        bufferedResponseBody = await readBodyBuffer(upstreamRes.body);
        if (isOAuthIdentityVerificationRequired(bufferedResponseBody)) {
          const deniedUntil = accountManager.markIdentityVerificationRequired(account.index);
          account.lastError = {
            reason: 'identity-verification',
            status: 400,
            error: 'Wymagana weryfikacja tożsamości (400 Identity Verification). Zaloguj się na claude.ai i potwierdź numer telefonu/SMS.',
            timestamp: Date.now()
          };
          (ctx.identityVerificationRequired ??= new Set()).add(account.name);
          ctx.tried.add(account.index);
          const cooldown = deniedUntil
            ? ` until ${new Date(deniedUntil).toISOString()}`
            : '';
          console.error(`[AgentLB] 400 on "${account.name}"; Anthropic requires identity verification — excluding account${cooldown} and retrying`);
          if (clientGone(res)) { ctx.abandoned = true; return; }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
        }
      }
    }

    // A 403 ("Request not allowed") is upstream refusing THIS account outright —
    // not a stale token a refresh could fix, and not anything the client sent.
    // The client never sees the credential we inject, so it cannot act on the
    // rejection; Claude Code reads a 403 as "your session is dead", drops its
    // own login and asks for a re-login over an account problem it has no part
    // in. Skip the account for the rest of this request and fail over. With no
    // account left, the no-account branch reports a proxy error instead.
    if (upstreamRes.status === 403 && !res.headersSent) {
      const responseBody = await readErrorBody(upstreamRes.body);
      const entitlementDenied = account.type === 'oauth'
        && responseBody != null
        && isOAuthEntitlementDenied(responseBody);
      const deniedUntil = entitlementDenied
        ? accountManager.markEntitlementDenied(account.index)
        : null;
      if (entitlementDenied) {
        account.lastError = {
          reason: 'entitlement',
          status: 403,
          error: 'Odmowa dostępu OAuth (403 Organization Block). Anthropic zablokował użycie tokenów OAuth dla organizacji konta.',
          timestamp: Date.now()
        };
      } else {
        account.lastError = {
          reason: 'forbidden',
          status: 403,
          error: 'Upstream odmówił dostępu (HTTP 403 Forbidden).',
          timestamp: Date.now()
        };
      }
      // A set, not a name: the no-account branch needs to tell "every account was
      // refused" (fail fast, nothing to wait for) from "this one was, others are
      // just out of quota" (still worth holding for a reset).
      (ctx.credentialRejected ??= new Set()).add(account.name);
      if (entitlementDenied) (ctx.entitlementDenied ??= new Set()).add(account.name);
      ctx.tried.add(account.index);
      const cooldown = deniedUntil
        ? `; OAuth entitlement cooldown until ${new Date(deniedUntil).toISOString()}`
        : '';
      console.error(`[AgentLB] 403 on "${account.name}"; upstream refused the account credential${cooldown}`);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    if (upstreamRes.status === 401 && account.type === 'oauth' && account.refreshToken
        && retryCount < maxRetries && !ctx.reauthed.has(account.index)) {
      ctx.reauthed.add(account.index);
      await upstreamRes.body?.cancel();
      console.log(`[AgentLB] 401 on "${account.name}" — token rejected; forcing refresh and retrying`);
      await accountManager.ensureTokenFresh(account.index, true);
      if (clientGone(res)) { ctx.abandoned = true; return; }
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // A 401 no refresh cured: an API key upstream rejects, or an OAuth token
    // still rejected after the forced refresh above. It is about the pooled
    // credential, which the client never sees — relaying it makes Claude Code
    // and the IDE extensions drop their OWN login ("run /login") over an
    // account problem they have no part in. Treat it like the 403 above: skip
    // the account for this request and fail over; with none left, the
    // no-account branch reports a proxy error instead of a 401.
    if (upstreamRes.status === 401 && !res.headersSent && retryCount < maxRetries) {
      await upstreamRes.body?.cancel();
      account.lastError = {
        reason: 'unauthorized',
        status: 401,
        error: 'Upstream odrzucił poświadczenie konta (HTTP 401) — sprawdź klucz lub zaloguj konto ponownie.',
        timestamp: Date.now(),
      };
      (ctx.credentialRejected ??= new Set()).add(account.name);
      ctx.tried.add(account.index);
      console.error(`[AgentLB] 401 on "${account.name}"; upstream rejected the account credential — failing over`);
      if (clientGone(res)) { ctx.abandoned = true; return; }
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // Log the request head (once) followed by the response headers, streaming
    // to disk from here on.
    logRequestHead();
    getLog()?.write(`\n\n=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers). The
    // connection-specific names are also illegal on an HTTP/2 response — when
    // this runs behind the MITM's h2 server, writeHead would otherwise throw.
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');
    if (isStreaming && upstreamRes.body && ctx.onFirstToken && upstreamRes.status < 400) {
      upstreamRes = { status: upstreamRes.status, headers: upstreamRes.headers, body: observeTokenStream(upstreamRes.body, ctx.onFirstToken) };
    }

    if (upstreamRes.status < 400) {
      if (ctx.isCodexResponsesToOpenAI || ctx.isCodexResponsesToAnthropic) {
        const clientStreaming = ctx.isClientStreaming !== false;
        responseHeaders['content-type'] = clientStreaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8';
      } else if (isCrossProvider) {
        responseHeaders['content-type'] = isStreaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8';
      }
    }

    // Non-streaming Codex translation. Upstream always streams (Codex has no
    // other mode), so the answer is buffered and translated whole — which is
    // what lets a failure it reported INSIDE its 200 stream (response.failed,
    // an error event, a stream cut off) reach the client as an error status.
    // Once the 200 is written that is impossible: the client used to get a
    // 200 with an empty answer and no sign anything went wrong.
    if (upstreamRes.status < 400 && upstreamRes.body && ctx.isClientStreaming === false
        && (ctx.isCodexResponsesToOpenAI || ctx.isCodexResponsesToAnthropic)) {
      const toAnthropic = !!ctx.isCodexResponsesToAnthropic;
      const buf = bufferedResponseBody ?? await collectIdleBody(upstreamRes.body);
      const l = getLog();
      const failure = codexResponseFailure(buf);
      let status = 200;
      let finalBuf;
      if (failure) {
        status = failure.status;
        console.error(`[AgentLB] Codex response failed on "${account.name}" (${safeLine(failure.code)}): ${safeLine(failure.message)}`);
        finalBuf = Buffer.from(JSON.stringify(toAnthropic
          ? { type: 'error', error: { type: failure.type, message: failure.message } }
          : { error: { message: failure.message, type: failure.type, code: failure.code } }), 'utf8');
      } else {
        try {
          const openAIObj = translateCodexResponsesToOpenAIResponse(buf, ctx.originalModel || ctx.model);
          finalBuf = Buffer.from(JSON.stringify(toAnthropic ? translateOpenAIToAnthropicResponse(openAIObj, ctx.model) : openAIObj), 'utf8');
          extractUsageFromBody(finalBuf, account.index, accountManager, ctx.onUsage, ctx.sessionId, ctx.model);
        } catch (e) {
          status = 502;
          console.error(`[AgentLB] Codex response translation failed on "${account.name}": ${safeLine(e.message)}`);
          finalBuf = Buffer.from(JSON.stringify(toAnthropic
            ? { type: 'error', error: { type: 'api_error', message: 'Could not translate the upstream response' } }
            : { error: { message: 'Could not translate the upstream response', type: 'api_error', code: 'translation_failed' } }), 'utf8');
        }
      }
      ctx.status = status;
      if (status < 400) accountManager.confirmStay(account, restingGen, ctx.sessionId, ctx.provider);
      if (l) { l.body('RESPONSE BODY', finalBuf, 'application/json'); l.end(); }
      res.writeHead(status, status < 400
        ? { ...responseHeaders, 'content-type': 'application/json; charset=utf-8' }
        : { 'Content-Type': 'application/json' });
      res.end(finalBuf);
      ctx.delivered = answeredStatus(status);
      return;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    // The catch block's retry is guarded by `!res.headersSent`, so a stay
    // confirmed once the headers are out has no retry behind it.
    if (upstreamRes.status < 400) {
      accountManager.confirmStay(account, restingGen, ctx.sessionId, ctx.provider);
    }

    if (!upstreamRes.body) {
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', null); l.end(); }
      res.end();
      ctx.delivered = answeredStatus(upstreamRes.status);
      return;
    }

    if (upstreamRes.status >= 400) {
      const buf = bufferedResponseBody ?? await collectIdleBody(upstreamRes.body);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
      ctx.delivered = answeredStatus(upstreamRes.status);
      return;
    }

    if (ctx.isCodexResponsesToOpenAI) {
      const isClientStreaming = ctx.isClientStreaming !== false;
      if (isClientStreaming) {
        const l = getLog();
        const transform = createCodexResponsesToOpenAITransformStream(ctx.originalModel || ctx.model, (usage) => {
          const inTok = usage.input_tokens || 0;
          const outTok = usage.output_tokens || 0;
          accountManager.updateUsage(account.index, inTok, outTok);
          ctx.onUsage?.(inTok, outTok);
          accountManager.recordTokenUsage(account.index, ctx.sessionId, ctx.model, usage);
        });
        await pipeline(Readable.from(idleBody(upstreamRes.body)), transform, res);
        l?.end();
        ctx.delivered = answeredStatus(upstreamRes.status);
        return;
      }
    }

    if (ctx.isCodexResponsesToAnthropic) {
      const isClientStreaming = ctx.isClientStreaming !== false;
      if (isClientStreaming) {
        const l = getLog();
        const codexToOpenAI = createCodexResponsesToOpenAITransformStream(ctx.originalModel || ctx.model, (usage) => {
          const inTok = usage.input_tokens || 0;
          const outTok = usage.output_tokens || 0;
          accountManager.updateUsage(account.index, inTok, outTok);
          ctx.onUsage?.(inTok, outTok);
          accountManager.recordTokenUsage(account.index, ctx.sessionId, ctx.model, usage);
        });
        const openAIToAnthropic = createOpenAIToAnthropicTransformStream(ctx.model);
        await pipeline(Readable.from(idleBody(upstreamRes.body)), codexToOpenAI, openAIToAnthropic, res);
        l?.end();
        ctx.delivered = answeredStatus(upstreamRes.status);
        return;
      }
    }

    if (isCrossProvider && requestProvider === 'anthropic' && servingProvider === 'codex') {
      if (isStreaming) {
        const l = getLog();
        const transform = createOpenAIToAnthropicTransformStream(ctx.model);
        await pipeline(Readable.from(idleBody(upstreamRes.body)), transform, res);
        l?.end();
        ctx.delivered = answeredStatus(upstreamRes.status);
        return;
      } else {
        const buf = bufferedResponseBody ?? await collectIdleBody(upstreamRes.body);
        let finalBuf = buf;
        try {
          const translated = translateOpenAIToAnthropicResponse(buf, ctx.model);
          finalBuf = Buffer.from(JSON.stringify(translated), 'utf8');
          extractUsageFromBody(finalBuf, account.index, accountManager, ctx.onUsage, ctx.sessionId, ctx.model);
        } catch (e) {
          console.warn('[Agent-LB] JSON response translation warning:', e.message);
        }
        const l = getLog();
        if (l) { l.body('RESPONSE BODY', finalBuf, 'application/json'); l.end(); }
        res.end(finalBuf);
        ctx.delivered = answeredStatus(upstreamRes.status);
        return;
      }
    }

    if (isCrossProvider && requestProvider === 'codex' && servingProvider === 'anthropic') {
      if (isStreaming) {
        const l = getLog();
        const transform = createAnthropicToOpenAITransformStream(ctx.model);
        await pipeline(Readable.from(idleBody(upstreamRes.body)), transform, res);
        l?.end();
        ctx.delivered = answeredStatus(upstreamRes.status);
        return;
      } else {
        const buf = bufferedResponseBody ?? await collectIdleBody(upstreamRes.body);
        let finalBuf = buf;
        try {
          const translated = translateAnthropicToOpenAIResponse(buf, ctx.model);
          finalBuf = Buffer.from(JSON.stringify(translated), 'utf8');
          extractUsageFromBody(buf, account.index, accountManager, ctx.onUsage, ctx.sessionId, ctx.model);
        } catch (e) {
          console.warn('[Agent-LB] JSON response translation warning:', e.message);
        }
        const l = getLog();
        if (l) { l.body('RESPONSE BODY', finalBuf, 'application/json'); l.end(); }
        res.end(finalBuf);
        ctx.delivered = answeredStatus(upstreamRes.status);
        return;
      }
    }

    if (isStreaming) {
      // Stream each chunk straight to the log as it is relayed — never hold the
      // whole (potentially ~1M-token) SSE body in memory.
      const l = getLog();
      const bw = l ? l.bodyWriter('RESPONSE BODY (streamed)', contentType) : null;
      try {
        await streamResponse(upstreamRes.body, res, account.index, accountManager, bw, ctx.onUsage, ctx.sessionId, ctx.model);
        // Reached only when the stream completed. A stream that dies upstream
        // throws out of streamResponse, so it never marks itself delivered —
        // which is the failure the token counters cannot see, since a stream
        // that emitted message_start has already recorded a usage report.
        if (clientGone(res)) ctx.abandoned = true;
        else ctx.delivered = answeredStatus(upstreamRes.status);
      } finally {
        // Also on the failure path: without the note a capped body reads as a
        // stream that simply stopped, which is the other thing that happens here.
        bw?.end();
      }
      l?.end();
    } else {
      const buf = bufferedResponseBody ?? await collectIdleBody(upstreamRes.body);
      extractUsageFromBody(buf, account.index, accountManager, ctx.onUsage, ctx.sessionId, ctx.model);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
      ctx.delivered = answeredStatus(upstreamRes.status);
    }
  } catch (err) {
    // Two of the things that can throw here are not upstream errors at all:
    // the client left (the request's signal cancelled a wait or the request
    // itself), and the proxy's own upstream admission gate turned the request
    // away. Both still go through the log block below, so the request-log
    // file is closed on every exit from this catch — they are only classified
    // after it.
    const clientLeft = err?.code === 'AGENTLB_CLIENT_GONE';
    const overloaded = err?.code === 'AGENTLB_UPSTREAM_OVERLOADED';
    if (clientLeft) console.log(`[AgentLB] Client disconnected while waiting on "${account.name}" — upstream request cancelled`);
    else if (overloaded) console.error(`[AgentLB] Upstream admission queue full (${describeConnectError(err)}) — 503 to the client, no account rotation`);
    else console.error(`[AgentLB] Upstream error (account "${account.name}"):`, describeConnectError(err));

    logRequestHead();
    const l = getLog();
    if (l) { l.write(`\n\n=== ERROR ===\n${err.stack || err.message}`); l.end(); }

    if (clientLeft) {
      // Observed here, so marked here: neither an answer nor a starvation.
      ctx.abandoned = true;
      ctx.status = 499;
      return;
    }
    if (overloaded) {
      // Local saturation is not an account error: no failover (every account
      // shares the same origin gate, and another attempt only adds load), no
      // sidelining, and the row is not attributed to the account it never
      // reached. A 503 with Retry-After lets the client back off briefly.
      ctx.status = 503;
      ctx.account = '(upstream queue full)';
      if (!res.headersSent && !clientGone(res)) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Proxy upstream queue is full; retry shortly.' } }));
      }
      return;
    }

    account.consecutiveErrors = (account.consecutiveErrors || 0) + 1;
    if (account.consecutiveErrors >= 3) {
      account.circuitBreakerUntil = Date.now() + 60000;
      console.warn(`[Agent-LB] Circuit breaker tripped on account "${account.name}" (${account.consecutiveErrors} consecutive errors) — isolated for 60s`);
    }

    // Would failing over dial anywhere else? Only an untried account pointing at
    // a different `upstream` makes that true, and it is what decides whether a
    // name-resolution failure is worth retrying elsewhere.
    //
    // "Anywhere else" means an account that could actually serve THIS request:
    // selection gates on routes and the disabled flag, so a different-host
    // account this request can never legally route to gives failover nothing to
    // reach. The check reuses the manager's own eligibility predicate rather
    // than restating route logic — and deliberately not getActiveAccount, which
    // can arm the probe cooldown as a side effect. Hosts are compared by
    // hostname, so a port or path difference does not masquerade as a second
    // host.
    //
    // A pinned request never fails over at all: once the pinned account has
    // been tried, selection returns null and the caller sends the informative
    // pinned-unavailable 429. Counting a pin as "somewhere else to go" keeps a
    // host failure on that path instead of a bare reset.
    //
    // The advisor model is deliberately NOT part of the eligibility check:
    // when no account satisfies both models, getActiveAccount degrades to
    // executor-only routing, so failover reaches every executor-eligible
    // account. Gating on the advisor here would call a reachable healthy host
    // "nowhere to go" and reset a request that selection would have served.
    // The scan is deliberately blind to the probe fallback (a soft-exhausted
    // other-host account it rejects could still be probed) — conservative, and
    // self-healing: probes from other requests refresh the stale quota.
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };
    const thisHost = hostOf(account.upstream || upstream);
    const otherHostAvailable = ctx.pinnedIndex != null || accountManager.accounts.some(a =>
      a.index !== account.index && !ctx.tried.has(a.index) &&
      hostOf(a.upstream || upstream) !== thisHost &&
      accountManager._isAvailable(a, ctx.model));
    const isTransient = isTransientUpstreamError(err, { otherHostAvailable });

    // Transient network errors (including a stale-socket headers/body timeout):
    // close the connection and let the client retry. Failing over to another
    // account would not help (the poisoned fetch pool is process-wide), but the
    // fast failure lets Node evict the dead socket so the retry reconnects
    // cleanly. If headers were already sent (a mid-stream body timeout), destroy
    // is the only option — the client sees a broken response and retries.
    if (isTransient) {
      ctx.proxyClosed = true;
      res.destroy();
      return;
    }

    // Any other thrown error is a transport/stream failure, NOT proof the
    // account's credentials are bad — a bad credential comes back as a 401
    // *response*, never a throw. So don't sideline the account (that would drop
    // a healthy account from rotation until a credential change). Instead skip
    // it for the rest of THIS request only and fail over to another account.
    if (retryCount < maxRetries && !res.headersSent) {
      ctx.tried.add(account.index);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      // Generic on purpose, as relayStream's 502 already is: the described
      // error names the resolved upstream hosts and ports (per-account
      // upstreams included), which is the operator's business — it went to
      // the log above — and not the client's.
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: 'Upstream error; see the proxy log' },
      }));
    } else if (!res.writableEnded) {
      // Error after headers were already sent (mid-stream) and it wasn't
      // classified transient: we can't send a status or fail over, and
      // streamResponse deliberately skipped res.end(). Destroy so the client
      // sees a broken response and retries instead of hanging on an open socket.
      ctx.proxyClosed = true;
      res.destroy();
    }
  } finally {
    if (ownsRecoveryProbe) account.halfOpenInFlight = false;
    if (ctx.delivered && ctx.status < 400 && ctx.account === account.name) {
      accountManager.clearIdentityVerification(account.index);
      accountManager.recordAccountSuccess(account);
    }
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
export async function streamResponse(webStream, res, accountIndex, accountManager, bodyWriter, onUsage = null, sessionId = null, model = null) {
  const reader = webStream.getReader();
  // A client that leaves while upstream is silent must not hold the pending
  // read — and with it the upstream socket and its admission permit — until
  // the idle watchdog fires: the clientGone check below runs only after a
  // chunk. Cancelling the reader settles the pending read as done, and the
  // loop exits through the same clientGone break. Optional-chained because
  // tests drive this with a bare Writable.
  const onClose = () => { reader.cancel().catch(() => {}); };
  res.once?.('close', onClose);
  if (clientGone(res)) onClose();
  const idleMs = resolveBodyIdleTimeout();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let errored = false;
  // The message's usage, merged across its two reports and recorded once below.
  const merged = {};

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleMs);
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (clientGone(res)) break;

      // Forward chunk immediately
      const ok = res.write(value);

      // Append to the log as it streams (no whole-body buffering)
      if (bodyWriter) bodyWriter.chunk(Buffer.from(value));
      // ...and let the log's disk keep up: a write the file stream had to queue
      // pauses the relay until it drains, so a slow disk bounds memory instead
      // of the stream's buffer absorbing the body. Resolves on error/close too.
      const logPending = bodyWriter?.drain?.();
      if (logPending) await logPending;

      const text = decoder.decode(value, { stream: true });

      // Parse SSE events for usage tracking
      sseBuffer += text;
      // SSE permits LF or CRLF line endings.  Splitting only on LF silently
      // loses usage events from an upstream that emits the RFC's CRLF form.
      const events = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager, onUsage, merged);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          // Remove BOTH listeners when either fires: otherwise the un-fired one
          // (usually 'close') stays attached and accumulates one leaked listener
          // per backpressure cycle over a long SSE stream to a slow client.
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
        if (clientGone(res)) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager, onUsage, merged);
    }
  } catch (err) {
    // A mid-stream idle timeout (or any read error) means the upstream went
    // silent after headers. Rethrow to the caller's transient handler, which
    // destroys the client connection so the truncated stream is NOT ended
    // cleanly (a clean res.end() would look like a complete response and
    // suppress the client's retry). reader.cancel() in finally evicts the socket.
    errored = true;
    throw err;
  } finally {
    res.off?.('close', onClose);
    // Record the message once, on every exit path. A stream that died after
    // `message_start` still spent the input it reported, so the merge is written
    // even when no `message_delta` ever arrived. An empty merge is written
    // nowhere rather than written as zeroes: plenty of streams carry no usage at
    // all (a ping and some text deltas, or an upstream error after the headers),
    // and recording those would report an observation that never happened.
    if (Object.keys(merged).length) {
      accountManager.recordTokenUsage(accountIndex, sessionId, model, merged);
    }
    // Cancel upstream reader to stop consuming data nobody needs (and, on the
    // timeout path, to destroy the dead socket so the pool drops it).
    reader.cancel().catch(() => {});
    if (!errored && !res.writableEnded) res.end();
  }
}

// A streaming response reports its usage twice. `message_start` carries the
// input side, including the two cache fields, with an output figure that is only
// a placeholder. `message_delta` then reports figures that are cumulative for
// the whole message, so every field it carries supersedes the earlier one rather
// than adding to it.
//
// The two counters therefore consume the stream differently. `updateUsage` is
// incremental, so it takes each side at the event that settles it: input at
// `message_start`, output at `message_delta`. `merged` instead accumulates the
// message's final figures for a single `recordTokenUsage` once the stream is
// over. One record per message is what makes double counting unrepresentable
// rather than merely avoided.
export function parseSSEUsage(event, accountIndex, accountManager, onUsage = null, merged = null) {
  const dataLine = event.split(/\r?\n/).find(l => /^data:\s?/.test(l));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.replace(/^data:\s?/, ''));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
      onUsage?.(data.message.usage.input_tokens || 0, 0);
      if (merged) Object.assign(merged, data.message.usage);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
      onUsage?.(0, data.usage.output_tokens || 0);
      if (merged) Object.assign(merged, data.usage);
    } else if (data.type === 'response.completed' && data.response?.usage) {
      const u = data.response.usage;
      const inTok = u.input_tokens || 0;
      const outTok = u.output_tokens || 0;
      accountManager.updateUsage(accountIndex, inTok, outTok);
      onUsage?.(inTok, outTok);
      if (merged) Object.assign(merged, u);
    } else if (data.usage) {
      const inTok = data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0;
      const outTok = data.usage.completion_tokens ?? data.usage.output_tokens ?? 0;
      if (inTok || outTok) {
        accountManager.updateUsage(accountIndex, inTok, outTok);
        onUsage?.(inTok, outTok);
        if (merged) Object.assign(merged, data.usage);
      }
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager, onUsage = null, sessionId = null, model = null) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
      onUsage?.(json.usage.input_tokens || 0, json.usage.output_tokens || 0);
      accountManager.recordTokenUsage(accountIndex, sessionId, model, json.usage);
    }
  } catch {
    // not JSON or no usage
  }
}


// Automatically normalize model aliases for Anthropic Claude Code OAuth accounts.
// Claude Code OAuth tokens are restricted to specific model IDs in Anthropic's gateway.
export function normalizeAnthropicModelForOAuth(body) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    if (typeof obj.model === 'string') {
      const trimmed = obj.model.trim();
      let target = null;
      if (trimmed === 'agy' || (trimmed.startsWith('gemini-') && !trimmed.includes('low'))) {
        target = 'claude-sonnet-5';
      } else if (trimmed === 'agy-fast' || (trimmed.startsWith('gemini-') && trimmed.includes('low'))) {
        target = 'claude-haiku-4-5-20251001';
      } else if (trimmed.startsWith('claude-3-7-sonnet') || trimmed === 'claude-3-7') {
        target = 'claude-sonnet-5';
      } else if (trimmed.startsWith('claude-3-5-sonnet') || trimmed === 'claude-3-sonnet-20240229' || trimmed === 'claude-sonnet') {
        target = 'claude-sonnet-4-6';
      } else if (trimmed.startsWith('claude-3-5-haiku') || trimmed.startsWith('claude-3-haiku') || trimmed === 'claude-haiku') {
        target = 'claude-haiku-4-5-20251001';
      } else if (trimmed.startsWith('claude-3-opus') || trimmed === 'claude-opus') {
        target = 'claude-opus-4-6';
      }
      if (target && target !== obj.model) {
        obj.model = target;
        return Buffer.from(JSON.stringify(obj), 'utf8');
      }
    }
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

// Ensure the required Claude Code billing header is present in the system prompt for Anthropic OAuth accounts.
// Without this header, Anthropic returns HTTP 429 ("rate_limit_error": "Error") on Claude Code OAuth tokens.
export function ensureAnthropicBillingHeader(body) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(obj.messages)) return body;

    const billingText = 'x-anthropic-billing-header: cc_version=2.1.251.76b; cc_entrypoint=sdk-cli;';

    if (typeof obj.system === 'string') {
      if (!obj.system.includes('x-anthropic-billing-header')) {
        obj.system = [
          { type: 'text', text: billingText },
          { type: 'text', text: obj.system },
        ];
        return Buffer.from(JSON.stringify(obj), 'utf8');
      }
      return body;
    }

    if (Array.isArray(obj.system)) {
      const hasBilling = obj.system.some(b => b && typeof b.text === 'string' && b.text.includes('x-anthropic-billing-header'));
      if (!hasBilling) {
        obj.system = [
          { type: 'text', text: billingText },
          ...obj.system,
        ];
        return Buffer.from(JSON.stringify(obj), 'utf8');
      }
      return body;
    }

    if (obj.system === undefined || obj.system === null) {
      obj.system = [{ type: 'text', text: billingText }];
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

// Apply every request-body rewrite for the account about to serve it, in
// forward order. Pure (buffer in, buffer out) and exported for tests —
// forwardRequest only threads the result into Content-Length and the log.
// Each step is a no-op returning the same Buffer when it has nothing to do,
// so untouched bodies keep their exact bytes.
export function rewriteRequestBody(body, account, url, contentType) {
  let sendBody = body;
  // The rewrites below are Anthropic-shaped and must not touch another
  // provider's payload: a Responses API body has no metadata.user_id to patch
  // and no Anthropic tool-pairing rule to repair, so running them would at
  // best waste a pass and at worst corrupt a valid request.
  if (rewritesBody(account)) {
    // Strip orphaned tool_use / tool_result blocks so a client that compacted or
    // interrupted a turn can't wedge the session with Anthropic's non-retryable
    // 400 ("tool_use ids were found without tool_result blocks").
    sendBody = sanitizeToolPairs(sendBody, url, contentType);
    // Align the body's account_uuid (in metadata.user_id) with the account whose
    // token we're injecting (same-length patch; no-op if absent).
    if (account.accountUuid) sendBody = patchAccountUuid(sendBody, account.accountUuid);
    // Some strict Anthropic-compatible upstreams reject `cache_control`
    // subfields Claude Code sends (`scope`; `ttl: "1h"` on a few) with a
    // non-retryable 400, breaking EVERY request once such an account is
    // selected. Opt-in per account, like every other rewrite keyed on
    // `upstream`: `stripRequestFields: ["cache_control.scope"]`. A first-party
    // relay that honours every subfield loses nothing by default.
    const ccSubfields = cacheControlSubfieldsToStrip(account.stripRequestFields);
    if (ccSubfields.size) sendBody = sanitizeCacheControl(sendBody, url, contentType, ccSubfields);
  }
  // Rewrite the model name for accounts that target a different upstream (e.g.
  // GLM), which uses different model identifiers than Anthropic.
  if (account.modelMap) sendBody = rewriteModel(sendBody, account.modelMap);
  // ChatGPT Codex backend requires 'gpt-5.6-sol' and rejects generic 'gpt-5.6' / 'gpt-5'.
  if (providerOf(account) === 'codex' && account.type === 'oauth') {
    sendBody = normalizeCodexModelForOAuth(sendBody);
  }
  // Anthropic OAuth backend requires Claude Code billing header and specific model identifiers.
  if (providerOf(account) === 'anthropic' && account.type === 'oauth') {
    sendBody = normalizeAnthropicModelForOAuth(sendBody);
    sendBody = ensureAnthropicBillingHeader(sendBody);
  }
  // Third-party upstreams (e.g. OpenCode Zen, GLM) implement the Anthropic
  // message API but reject fields Claude Code legitimately sends — observed:
  // `context_management` -> 400 "Extra inputs are not permitted", which breaks
  // EVERY request once such an account is selected. Drop the configured
  // top-level fields for those accounts only (the `cache_control.<sub>` entries
  // were consumed above); Anthropic accounts are untouched.
  const topLevel = Array.isArray(account.stripRequestFields)
    ? account.stripRequestFields.filter(f => typeof f === 'string' && !f.includes('.')) : [];
  if (topLevel.length) sendBody = stripBodyFields(sendBody, topLevel);
  return sendBody;
}

// Remove top-level fields from a JSON request body (see stripRequestFields).
// Returns the original buffer when nothing changed or the body isn't JSON, so
// non-messages endpoints pass through untouched. Exported for tests.
export function stripBodyFields(body, fields) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    let changed = false;
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(obj, f)) { delete obj[f]; changed = true; }
    }
    if (changed) return Buffer.from(JSON.stringify(obj), 'utf8');
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

// Rewrite the `model` field in a JSON request body using a per-account map.
// Returns the original buffer unchanged if the model isn't in the map or the
// body isn't valid JSON, so non-messages endpoints pass through safely.
// Exported for tests.
export function rewriteModel(body, modelMap) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    // Own keys only: the map is a plain object, so a model named
    // "constructor" or "toString" would otherwise look up a prototype
    // function, which JSON.stringify then drops — the request goes upstream
    // with no model at all.
    if (typeof obj.model === 'string' && Object.hasOwn(modelMap, obj.model) && typeof modelMap[obj.model] === 'string') {
      obj.model = modelMap[obj.model];
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

// Automatically normalize model aliases for ChatGPT OAuth accounts.
// OpenAI's ChatGPT Codex backend strictly requires 'gpt-5.6-sol' for GPT-5.6
// and rejects generic 'gpt-5.6', 'gpt-5', or 'codex' with HTTP 400.
export function normalizeCodexModelForOAuth(body) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    if (typeof obj.model === 'string') {
      const trimmed = obj.model.trim();
      if (trimmed === 'gpt-6') {
        obj.model = 'gpt-6-astra';
        return Buffer.from(JSON.stringify(obj), 'utf8');
      }
      if (trimmed === 'agy' || (trimmed.startsWith('gemini-') && !trimmed.includes('low')) || trimmed === 'gpt-5.6' || trimmed === 'gpt-5' || trimmed === 'codex') {
        obj.model = 'gpt-5.6-sol';
        return Buffer.from(JSON.stringify(obj), 'utf8');
      }
      if (trimmed === 'agy-fast' || (trimmed.startsWith('gemini-') && trimmed.includes('low')) || trimmed === 'codex-mini') {
        obj.model = 'gpt-5.6-terra';
        return Buffer.from(JSON.stringify(obj), 'utf8');
      }
    }
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

function computeRetryAfter(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const resets = [acct.rateLimitedUntil, acct.entitlementDeniedUntil, acct.identityVerificationUntil, acct.quota.resetsAt]
      .filter(Boolean);
    for (const reset of resets) {
      const ms = new Date(reset).getTime() - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}

function denyClientPolicy(res, policy) {
  res.writeHead(policy.status || 403, { 'Content-Type': 'application/json', ...(policy.retryAfter ? { 'Retry-After': String(policy.retryAfter) } : {}) });
  res.end(JSON.stringify({ error: { type: 'permission_error', message: policy.error } }));
}
