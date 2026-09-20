import { timingSafeEqual } from 'node:crypto';
import { ClientUsageTracker } from './client-usage.js';

// Constant-time proxy-API-key comparison (both the HTTP gate and the CONNECT
// gate use it). Returns false on any type/length mismatch without leaking timing.
export function safeKeyEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Credentials and session material must never be returned by status output or
// written to request logs.  The status endpoint is also available to a client
// key (not only the administrator key), so exposing a raw client key there
// would turn any delegated key into a fleet-wide credential dump.
export const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'cookie',
  'set-cookie', 'www-authenticate',
]);

export function maskSecret(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

// True if a socket's remote address is loopback — the proxy-key gate exempts
// localhost on both the HTTP and CONNECT paths.
export function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Headers a forwarding proxy adds to name the caller it forwards for. Any of
// them on a loopback-sourced request says the socket's peer is a proxy on this
// host, not the caller.
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'];

/** Whether the request carries a forwarding proxy's mark. */
export function isForwardedRequest(headers) {
  return FORWARDED_HEADERS.some(h => headers?.[h] != null && headers[h] !== '');
}

/**
 * Whether a key-less caller is admitted on the strength of its address alone.
 * All three gates — HTTP, CONNECT and the WebSocket upgrade — ask this one
 * question, so they cannot drift apart.
 *
 * The exemption is trying to answer "is this caller on this machine", and the
 * socket address stops answering that as soon as anything forwards. The
 * ordinary way this proxy is deployed on a public name is nginx or Caddy
 * terminating TLS in front of a listener bound to 127.0.0.1 — and then every
 * caller on the internet is loopback-sourced, the key gate never runs, and an
 * anonymous POST /v1/messages spends the fleet's quota (#324). The browser
 * checks that sit behind this one (Origin, Host) do not catch it: curl sends
 * neither, and the Host header is written by the operator's own reverse proxy,
 * so it reports the proxy's configuration rather than the request's provenance.
 *
 * Two answers, cheapest first:
 *   - A request carrying a forwarding header (X-Forwarded-For, X-Real-IP,
 *     Forwarded) is refused the exemption. Costs nothing to configure and fails
 *     closed on exactly the deployments that are exposed; a reverse proxy set
 *     up to send none of them is the case the setting below is for.
 *   - `proxy.trustLoopback: false` switches the exemption off outright. The CLI
 *     presents the proxy key on every call of its own, so a local install keeps
 *     working with it; documented as required behind a reverse proxy.
 */
export function loopbackExempt(headers, remoteAddress, proxyConfig) {
  if (proxyConfig?.trustLoopback !== true) return false;
  if (!isLoopbackAddr(remoteAddress)) return false;
  return !isForwardedRequest(headers);
}

export function isTailnetAddr(addr) {
  if (typeof addr !== 'string') return false;
  const clean = addr.replace(/^::ffff:/, '').trim().toLowerCase();
  if (clean === '127.0.0.1' || clean === '::1') return true;
  if (clean.startsWith('fd7a:115c:a1e0:')) return true;
  const parts = clean.split('.').map(Number);
  if (parts.length === 4 && !parts.some(n => isNaN(n) || n < 0 || n > 255)) {
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  }
  return false;
}

// Explicit opt-in for direct Tailnet peers only; forwarded identity is never trusted.
export function tailnetExempt(headers, remoteAddress, proxyConfig) {
  // Forwarded headers are client-controlled unless a separately configured
  // trusted proxy verifies them. Address-only trust is direct and opt-in.
  if (proxyConfig?.trustTailnet !== true) return false;
  if (isLoopbackAddr(remoteAddress) || isForwardedRequest(headers)) return false;
  return isTailnetAddr(remoteAddress);
}


/**
 * Which identity a presented key authenticates as, checked against the shared
 * `proxy.apiKey` and every `proxy.clientKeys` entry ({ name, key }).
 *
 * Returns { ok, client }: ok=false → reject; `client` is the matching entry's
 * name (per-client usage is booked against it), or null for the shared key —
 * the shared key predates client identities and stays unattributed rather than
 * inventing one. With no keys configured at all the gate is open (unchanged
 * behavior), also unattributed.
 *
 * Client keys are checked first so a clientKeys entry that duplicates the
 * shared key still yields its name. Every candidate uses the constant-time
 * compare; the key count is operator-controlled and small, so scanning all of
 * them leaks nothing useful.
 */
// Config arrays already checked for shape, so the warnings below fire once per
// loaded list (a reload hands over a new array) rather than once per request.
const checkedClientKeys = new WeakSet();
function usableClientKeys(clientKeys) {
  if (!checkedClientKeys.has(clientKeys)) {
    checkedClientKeys.add(clientKeys);
    const seen = new Set();
    for (const entry of clientKeys) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name || !entry?.key) {
        console.error('[AgentLB] proxy.clientKeys: an entry without a name and a key is ignored (usage is attributed by name)');
      } else if (seen.has(name)) {
        console.error(`[AgentLB] proxy.clientKeys: duplicate name "${name}" — its keys share one usage counter`);
      }
      seen.add(name);
    }
  }
  return clientKeys.filter(e => typeof e?.name === 'string' && e.name.trim() && e.key);
}

export function resolveClientAuth(proxyConfig, presented) {
  const shared = proxyConfig?.apiKey;
  const clientKeys = Array.isArray(proxyConfig?.clientKeys) ? usableClientKeys(proxyConfig.clientKeys) : [];
  if (!shared && clientKeys.length === 0) return { ok: true, client: null, entry: null };
  for (const entry of clientKeys) {
    if (safeKeyEqual(presented, entry.key)) {
      return { ok: true, client: entry.name.trim(), entry };
    }
  }
  if (shared && safeKeyEqual(presented, shared)) return { ok: true, client: null, entry: null };
  return { ok: false, client: null, entry: null };
}

// A restricted credential may only use metered inference requests: an opaque
// relay cannot enforce provider/model/token policies on the tunneled traffic.
export function relayPolicyAllowed(auth, tracker = new ClientUsageTracker()) {
  if (!auth.ok) return false;
  const entry = auth.entry;
  if (!entry) return true;
  if (!tracker.checkQuota(auth.client, entry).allowed) return false;
  return !entry.allowedProviders?.length && !entry.allowedModels?.length &&
    !entry.maxDailyTokens && !entry.maxMonthlyTokens;
}
