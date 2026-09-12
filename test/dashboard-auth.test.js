import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboardHtml, dashboardCsp } from '../src/dashboard.js';
import { resolveClientAuth, safeKeyEqual, isLocalHostHeader } from '../src/server.js';

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

  it('renders both Claude and Codex setup commands and scripts in setup directory', async () => {
    const fs = await import('node:fs');
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="cmdSetupCodexBash"'), 'contains Codex bash command element');
    assert.ok(html.includes('id="cmdSetupCodexPowershell"'), 'contains Codex powershell command element');
    assert.ok(html.includes('btnCopySetupCodexBash'), 'contains copy button for Codex bash');
    assert.ok(html.includes('btnCopySetupCodexPowershell'), 'contains copy button for Codex powershell');

    assert.ok(fs.existsSync('setup/codexlb-setup.sh'), 'setup/codexlb-setup.sh exists');
    assert.ok(fs.existsSync('setup/codexlb-setup.ps1'), 'setup/codexlb-setup.ps1 exists');
    assert.ok(fs.existsSync('setup/codexlb-setup.js'), 'setup/codexlb-setup.js exists');
  });

  it('validates host header correctly for agentlb.gotova.pl and custom domains', () => {
    assert.ok(isLocalHostHeader('localhost:3456'), 'localhost accepted');
    assert.ok(isLocalHostHeader('127.0.0.1:3456'), '127.0.0.1 accepted');
    assert.ok(isLocalHostHeader('agentlb.gotova.pl'), 'agentlb.gotova.pl accepted');
    assert.ok(isLocalHostHeader('teamclaude.gotova.pl'), 'teamclaude.gotova.pl accepted');
    assert.ok(isLocalHostHeader('debian-lite.tail7319.ts.net:3456'), 'tailscale host accepted');
    assert.ok(!isLocalHostHeader('malicious-site.com'), 'malicious host rejected');

    process.env.AGENT_LB_HOST = 'custom1.example.com, custom2.example.com';
    try {
      assert.ok(isLocalHostHeader('custom1.example.com'), 'custom1 in AGENT_LB_HOST accepted');
      assert.ok(isLocalHostHeader('custom2.example.com:8443'), 'custom2 in AGENT_LB_HOST accepted');
      assert.ok(!isLocalHostHeader('unauthorized.example.com'), 'unauthorized host rejected');
    } finally {
      delete process.env.AGENT_LB_HOST;
    }
  });
});

