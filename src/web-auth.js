import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';

const PROCESS_SESSION_SECRET = randomBytes(32);
let pythonJobs = 0;

// Secrets travel over stdin, never in the process list or child error text.
function runPython(script, values, timeout = 5000) {
  if (pythonJobs >= 4) return Promise.reject(new Error('Authentication service busy'));
  pythonJobs++;
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-c', script], { timeout, maxBuffer: 4096 }, (err, stdout) => {
      pythonJobs--;
      if (err) reject(new Error('Authentication helper failed'));
      else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {}); // exit/timeout may close stdin first
    child.stdin.end(JSON.stringify(values));
  });
}

// Bounded, per-socket-peer and global limits; forwarded IP headers are untrusted.
export class AuthAttemptLimiter {
  constructor({ limit = 10, totalLimit = 60, windowMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { limit, totalLimit, windowMs, now });
    this.peers = new Map();
    this.total = { count: 0, until: 0 };
  }
  /** @returns {number} Retry-After in seconds, or zero when admitted. */
  take(peer) {
    const now = this.now();
    for (const [key, entry] of this.peers) if (entry.until <= now) this.peers.delete(key);
    if (this.total.until <= now) this.total = { count: 0, until: now + this.windowMs };
    let entry = this.peers.get(peer);
    if (!entry && this.peers.size < 1024) {
      entry = { count: 0, until: now + this.windowMs };
      this.peers.set(peer, entry);
    }
    const blocked = !entry || entry.count >= this.limit || this.total.count >= this.totalLimit;
    if (blocked) return Math.max(1, Math.ceil(((entry?.count >= this.limit ? entry.until : this.total.until) - now) / 1000));
    entry.count++;
    this.total.count++;
    return 0;
  }
}

// In-memory store for active password reset requests (expires in 15 minutes)
const RESET_EXPIRY_MS = 15 * 60 * 1000;
const resetByToken = new Map();
const resetByPin = new Map();

function cleanExpiredResets() {
  const now = Date.now();
  for (const [token, data] of resetByToken.entries()) {
    if (data.expiresAt <= now) {
      resetByToken.delete(token);
      resetByPin.delete(data.pin);
    }
  }
}

/**
 * Verify candidate password against a hash or fallback API key.
 * Supports bcrypt ($2a$, $2b$) via python3 or fallback key comparison.
 */
export async function verifyPassword(candidate, passwordHash, fallbackApiKey) {
  if (typeof candidate !== 'string' || !candidate || Buffer.byteLength(candidate) > 1024) return false;
  // Check the master key before launching the expensive password helper.
  if (typeof fallbackApiKey === 'string' && fallbackApiKey) {
    const a = Buffer.from(candidate), b = Buffer.from(fallbackApiKey);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  if (typeof passwordHash !== 'string' || !/^\$2[ab]\$/.test(passwordHash)) return false;
  try {
    return await runPython('import bcrypt, json, sys; p, h = json.load(sys.stdin); print("yes" if bcrypt.checkpw(p.encode(), h.encode()) else "no")', [candidate, passwordHash]) === 'yes';
  } catch {
    console.error('[AgentLB] Password verification helper unavailable or failed');
    return false;
  }
}

/** Hash using the existing bcrypt format without blocking the proxy event loop. */
export async function hashPassword(plainText) {
  if (typeof plainText !== 'string' || plainText.length < 12 || Buffer.byteLength(plainText) > 72) {
    throw new Error('Password must contain at least 12 characters and at most 72 UTF-8 bytes');
  }
  const hash = await runPython('import bcrypt, json, sys; p = json.load(sys.stdin); print(bcrypt.hashpw(p.encode(), bcrypt.gensalt(12)).decode())', plainText);
  if (!hash.startsWith('$2')) throw new Error('Failed to generate password hash');
  return hash;
}

/**
 * Create an HMAC-signed session token.
 */
export function createSessionToken(username, secret, maxAgeSeconds = 30 * 24 * 3600) {
  const payload = {
    u: username,
    exp: Date.now() + maxAgeSeconds * 1000
  };
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const hmac = createHmac('sha256', secret || PROCESS_SESSION_SECRET)
    .update(b64)
    .digest('base64url');
  return `${b64}.${hmac}`;
}

/**
 * Serialize a session Set-Cookie header.
 */
export function serializeSessionCookie(username, secret, maxAgeSeconds = 30 * 24 * 3600) {
  const token = createSessionToken(username, secret, maxAgeSeconds);
  return `agentlb_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/**
 * Serialize a clear session Set-Cookie header.
 */
export function serializeLogoutCookie() {
  return 'agentlb_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax';
}

/**
 * Parse Cookie header and verify the agentlb_session token.
 */
export function verifySession(cookieHeader, secret) {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return { valid: false };
  }
  const match = cookieHeader.match(/(?:^|;\s*)agentlb_session=([^;]+)/);
  if (!match) return { valid: false };

  const rawToken = match[1].trim();
  const parts = rawToken.split('.');
  if (parts.length !== 2) return { valid: false };

  const [b64, signature] = parts;
  const expectedHmac = createHmac('sha256', secret || PROCESS_SESSION_SECRET)
    .update(b64)
    .digest('base64url');

  const bSig = Buffer.from(signature);
  const bExp = Buffer.from(expectedHmac);
  if (bSig.length !== bExp.length || !timingSafeEqual(bSig, bExp)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (typeof payload.u !== 'string' || !payload.u || !Number.isFinite(payload.exp)) {
      return { valid: false };
    }
    if (Date.now() > payload.exp) {
      return { valid: false, expired: true };
    }
    return { valid: true, username: payload.u };
  } catch {
    return { valid: false };
  }
}

/**
 * Send email via Postfix on Tailscale (100.96.24.39:25).
 */
export async function sendEmail(toAddress, subject, bodyText) {
  try {
    await runPython(`import smtplib, json, sys
from email.message import EmailMessage
to, subject, body = json.load(sys.stdin)
m = EmailMessage()
m["From"] = "agentlb@gotovalues.com"
m["To"] = to
m["Subject"] = subject
m.set_content(body)
with smtplib.SMTP("100.96.24.39", 25, timeout=10) as s:
    s.send_message(m)`, [toAddress, subject, bodyText], 15000);
    return true;
  } catch {
    console.error('[AgentLB] Password reset email delivery failed');
    return false;
  }
}

/**
 * Initiate password reset for user or email.
 */
export async function requestPasswordReset(target, config, { send = sendEmail } = {}) {
  cleanExpiredResets();

  const webAuth = config.proxy?.webAuth || {};
  const validUser = (webAuth.username || 'tomaasz').trim().toLowerCase();
  const validEmail = (webAuth.email || '').trim().toLowerCase();
  // Public URL is operator configuration, never a request Host header.
  const publicUrl = new URL(webAuth.publicUrl || 'https://agentlb.gotova.pl');
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) {
    throw new Error('webAuth.publicUrl must be an HTTPS URL without credentials');
  }
  const host = publicUrl.host;

  const input = typeof target === 'string' ? target.trim().toLowerCase() : '';
  const response = { ok: true, message: 'Jeśli konto istnieje, instrukcje resetowania zostały wysłane.' };
  if (!validEmail || (input !== validUser && input !== validEmail)) return response;

  const token = randomBytes(32).toString('hex');
  const pin = randomInt(100000, 1000000).toString();
  const expiresAt = Date.now() + RESET_EXPIRY_MS;

  const data = {
    username: validUser,
    email: validEmail,
    token,
    pin,
    expiresAt
  };

  const resetUrl = `https://${host}/dashboard?reset_token=${token}`;
  const emailBody = `Cześć Tomasz,

Otrzymaliśmy prośbę o zresetowanie hasła do panelu Agent LB (https://${host}).

Aby ustawić nowe hasło, kliknij w poniższy link:
${resetUrl}

Możesz również podać jednorazowy 6-cyfrowy kod PIN:
${pin}

Link oraz kod PIN są ważne przez 15 minut.
Jeśli nie prosiłeś o reset hasła, możesz bezpiecznie zignorować tę wiadomość.

--
Agent LB Security System
`;

  const sent = await send(validEmail, '[Agent LB] Resetowanie hasła do panelu', emailBody);
  if (!sent) {
    return { ok: false, error: 'Błąd podczas wysyłania wiadomości e-mail. Spróbuj ponownie później.' };
  }

  // Keep one active reset per user and only commit after successful delivery.
  for (const [oldToken, old] of resetByToken) {
    if (old.username === validUser) { resetByToken.delete(oldToken); resetByPin.delete(old.pin); }
  }
  resetByToken.set(token, data);
  resetByPin.set(pin, data);
  return response;
}

/**
 * Validate a password reset token or PIN code.
 */
export function validateResetCode(code) {
  cleanExpiredResets();
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim();
  const data = resetByToken.get(trimmed) || resetByPin.get(trimmed);
  if (!data || data.expiresAt <= Date.now()) return null;
  return data;
}

/**
 * Complete password reset: verify token/PIN, hash new password, consume token.
 */
export async function completePasswordReset(code, newPassword, persist = async () => {}) {
  const data = validateResetCode(code);
  if (!data || data.processing) return { ok: false, error: 'Kod resetujący lub link wygasł bądź jest nieprawidłowy.' };
  if (typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword) > 72) {
    return { ok: false, error: 'Nowe hasło musi zawierać co najmniej 12 znaków i najwyżej 72 bajty UTF-8.' };
  }
  data.processing = true;
  try {
    const newHash = await hashPassword(newPassword);
    if (validateResetCode(code) !== data) return { ok: false, error: 'Kod resetujący wygasł.' };
    const result = { ok: true, username: data.username, newHash, email: data.email };
    await persist(result);
    // Failed persistence leaves the code usable for a retry.
    resetByToken.delete(data.token);
    resetByPin.delete(data.pin);
    return result;
  } finally {
    data.processing = false;
  }
}
