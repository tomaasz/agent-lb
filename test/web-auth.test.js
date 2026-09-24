import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionToken,
  serializeSessionCookie,
  serializeLogoutCookie,
  verifySession,
  verifyPassword,
  validateResetCode,
  completePasswordReset,
  hashPassword,
} from '../src/web-auth.js';

test('Session cookie creation and verification', () => {
  const secret = 'super-secret-key-12345';
  const cookie = serializeSessionCookie('tomaasz', secret, 3600);
  assert.match(cookie, /agentlb_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);

  // Extract cookie value for request header
  const cookieHeader = cookie.split(';')[0];
  const res = verifySession(cookieHeader, secret);
  assert.equal(res.valid, true);
  assert.equal(res.username, 'tomaasz');

  // Tampered cookie fails
  const tampered = cookieHeader + 'abc';
  const resTampered = verifySession(tampered, secret);
  assert.equal(resTampered.valid, false);

  // Wrong secret fails
  const resWrongKey = verifySession(cookieHeader, 'wrong-secret');
  assert.equal(resWrongKey.valid, false);

  // Expired cookie
  const expiredToken = createSessionToken('tomaasz', secret, -10);
  const resExpired = verifySession(`agentlb_session=${expiredToken}`, secret);
  assert.equal(resExpired.valid, false);
});

test('Logout cookie serialization', () => {
  const logout = serializeLogoutCookie();
  assert.match(logout, /agentlb_session=;/);
  assert.match(logout, /Expires=Thu, 01 Jan 1970/);
});

test('Password verification with fallback API key', () => {
  const apiKey = 'tc-master-admin-token-test';
  assert.equal(verifyPassword(apiKey, null, apiKey), true);
  assert.equal(verifyPassword('wrong-key', null, apiKey), false);
  assert.equal(verifyPassword('', null, apiKey), false);
});

test('Password verification with bcrypt hash', () => {
  const testHash = '$2b$12$/8fNK1u.RKEur36.134sluPNnyoTBWgE4bZlrBfpQmJ9eORa97RVm'; // generated for 'test123'
  assert.equal(verifyPassword('test123', testHash, 'fallback-key'), true);
  assert.equal(verifyPassword('wrong', testHash, 'fallback-key'), false);
});

test('Password reset validation and completion', () => {
  const invalid = completePasswordReset('non-existent-code', 'newpassword123');
  assert.equal(invalid.ok, false);
});
