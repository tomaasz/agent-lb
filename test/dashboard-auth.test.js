import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboardHtml, dashboardCsp } from '../src/dashboard.js';
import { resolveClientAuth, safeKeyEqual } from '../src/server.js';

describe('Dashboard Authentication and Layout', () => {
  it('renders modern login card and auth elements in dashboard HTML', () => {
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="keybox"'), 'contains #keybox');
    assert.ok(html.includes('login-card-head'), 'contains modern login card header');
    assert.ok(html.includes('login-card-icon'), 'contains login card icon');
    assert.ok(html.includes('id="keyboxErr"'), 'contains error message container');
    assert.ok(html.includes('id="keyboxInfo"'), 'contains info/logout message container');
    assert.ok(html.includes('id="btnLogout"'), 'contains logout button in header actions');
    assert.ok(html.includes('checkAuthAndStart()'), 'initializes with checkAuthAndStart');
  });

  it('removes duplicate probe button and updates accounts heading', () => {
    const html = renderDashboardHtml();
    // Exactly one occurrence of btnProbeQuota in the DOM, and zero of btnProbeQuotaSec
    const probeMatches = (html.match(/id="btnProbeQuota"/g) || []).length;
    assert.equal(probeMatches, 1, 'exactly one btnProbeQuota button in HTML');
    assert.ok(!html.includes('id="btnProbeQuotaSec"'), 'no duplicate btnProbeQuotaSec in HTML');
    assert.ok(html.includes('Konta Claude & Codex'), 'accounts header mentions both Claude and Codex');
  });

  it('computes valid Content-Security-Policy with sha256 hash', () => {
    const csp = dashboardCsp();
    assert.ok(csp.startsWith("default-src 'none'"), 'starts with default-src none');
    assert.ok(csp.includes("script-src 'sha256-"), 'includes sha256 script hash');
    assert.ok(csp.includes("connect-src 'self'"), 'allows connect-src self');
  });

  it('safely verifies admin keys', () => {
    const adminKey = 'tc-secret-key-12345';
    assert.ok(safeKeyEqual(adminKey, 'tc-secret-key-12345'), 'matches identical key');
    assert.ok(!safeKeyEqual(adminKey, 'wrong-key'), 'rejects mismatched key');
    assert.ok(!safeKeyEqual(null, adminKey), 'rejects null');
    assert.ok(!safeKeyEqual('', adminKey), 'rejects empty string');

    const auth = resolveClientAuth({ apiKey: adminKey }, adminKey);
    assert.equal(auth.ok, true);

    const badAuth = resolveClientAuth({ apiKey: adminKey }, 'bad-key');
    assert.equal(badAuth.ok, false);
  });
});
