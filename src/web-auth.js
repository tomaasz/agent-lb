import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
export function verifyPassword(candidate, passwordHash, fallbackApiKey) {
  if (!candidate || typeof candidate !== 'string') return false;

  // 1. If passwordHash looks like bcrypt ($2a$ or $2b$), test via python3 bcrypt
  if (passwordHash && (passwordHash.startsWith('$2a$') || passwordHash.startsWith('$2b$'))) {
    try {
      execFileSync('python3', [
        '-c',
        'import bcrypt, sys; sys.exit(0 if bcrypt.checkpw(sys.argv[1].encode(), sys.argv[2].encode()) else 1)',
        candidate,
        passwordHash
      ], { timeout: 4000, stdio: 'ignore' });
      return true;
    } catch {
      // Failed bcrypt check or python3 not available
    }
  }

  // 2. Check fallback API key (master key) using constant-time comparison
  if (fallbackApiKey && typeof fallbackApiKey === 'string') {
    const ba = Buffer.from(candidate);
    const bb = Buffer.from(fallbackApiKey);
    if (ba.length === bb.length && timingSafeEqual(ba, bb)) {
      return true;
    }
  }

  return false;
}

/**
 * Hash a new password using bcrypt (via python3) with cost 12.
 */
export function hashPassword(plainText) {
  if (!plainText || typeof plainText !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  try {
    const out = execFileSync('python3', [
      '-c',
      'import bcrypt, sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(12)).decode())',
      plainText
    ], { timeout: 5000 });
    const hash = out.toString().trim();
    if (hash.startsWith('$2')) return hash;
  } catch (err) {
    // If python3 bcrypt is not installed, fallback or rethrow
    throw new Error(`Failed to generate password hash: ${err.message}`);
  }
  throw new Error('Failed to generate password hash');
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
  const hmac = createHmac('sha256', secret || 'agent-lb-default-secret')
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
  const expectedHmac = createHmac('sha256', secret || 'agent-lb-default-secret')
    .update(b64)
    .digest('base64url');

  const bSig = Buffer.from(signature);
  const bExp = Buffer.from(expectedHmac);
  if (bSig.length !== bExp.length || !timingSafeEqual(bSig, bExp)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload.u || !payload.exp || typeof payload.exp !== 'number') {
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
export function sendEmail(toAddress, subject, bodyText) {
  try {
    execFileSync('python3', [
      '-c',
      `import smtplib, sys
from email.message import EmailMessage
m = EmailMessage()
m["From"] = "agentlb@gotovalues.com"
m["To"] = sys.argv[1]
m["Subject"] = sys.argv[2]
m.set_content(sys.argv[3])
with smtplib.SMTP("100.96.24.39", 25, timeout=10) as s:
    s.send_message(m)`,
      toAddress,
      subject,
      bodyText
    ], { timeout: 15000, stdio: 'ignore' });
    return true;
  } catch (err) {
    console.error(`[AgentLB] Failed to send email to ${toAddress}:`, err.message);
    return false;
  }
}

/**
 * Initiate password reset for user or email.
 */
export function requestPasswordReset(target, config, host = 'agentlb.gotova.pl') {
  cleanExpiredResets();

  const webAuth = config.proxy?.webAuth || {};
  const validUser = (webAuth.username || 'tomaasz').trim().toLowerCase();
  const validEmail = (webAuth.email || 'tomaasz@gmail.com').trim().toLowerCase();

  const input = (target || '').trim().toLowerCase();
  if (input !== validUser && input !== validEmail && input !== 'tomaasz' && input !== 'tomaasz@gmail.com') {
    return { ok: false, error: 'Nie znaleziono użytkownika lub adresu e-mail.' };
  }

  const token = randomBytes(32).toString('hex');
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + RESET_EXPIRY_MS;

  const data = {
    username: validUser,
    email: validEmail,
    token,
    pin,
    expiresAt
  };

  resetByToken.set(token, data);
  resetByPin.set(pin, data);

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

  const sent = sendEmail(validEmail, '[Agent LB] Resetowanie hasła do panelu', emailBody);
  if (!sent) {
    return { ok: false, error: 'Błąd podczas wysyłania wiadomości e-mail. Spróbuj ponownie później.' };
  }

  const masked = validEmail.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 5)) + c);
  return {
    ok: true,
    message: `Link oraz kod PIN do zresetowania hasła zostały wysłane na adres ${masked}.`,
    email: masked
  };
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
export function completePasswordReset(code, newPassword) {
  const data = validateResetCode(code);
  if (!data) {
    return { ok: false, error: 'Kod resetujący lub link wygasł bądź jest nieprawidłowy.' };
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4) {
    return { ok: false, error: 'Nowe hasło musi zawierać co najmniej 4 znaki.' };
  }

  const newHash = hashPassword(newPassword);

  // Consume the reset token & PIN so it cannot be reused
  resetByToken.delete(data.token);
  resetByPin.delete(data.pin);

  return {
    ok: true,
    username: data.username,
    newHash,
    email: data.email
  };
}
