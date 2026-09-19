import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboardHtml, dashboardCsp } from '../src/dashboard.js';
import { resolveClientAuth, safeKeyEqual, isLocalHostHeader, createProxyServer } from '../src/server.js';


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

  it('embedded dashboard script has valid syntax and compiles cleanly', () => {
    const html = renderDashboardHtml();
    const scriptStart = html.indexOf('<script>') + 8;
    const scriptEnd = html.indexOf('</script>');
    assert.ok(scriptStart > 8 && scriptEnd > scriptStart, 'found <script> block');
    const script = html.slice(scriptStart, scriptEnd);
    assert.doesNotThrow(() => {
      new vm.Script(script);
    }, 'embedded dashboard script must compile without syntax errors');
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
    assert.ok(isLocalHostHeader('agent-lb.gotova.pl'), 'agent-lb.gotova.pl accepted');
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

  it('renders valid JavaScript without syntax errors in dashboard script', () => {
    const html = renderDashboardHtml();
    const sStart = html.indexOf('<script>') + 8;
    const sEnd = html.indexOf('</script>');
    assert.ok(sStart > 7 && sEnd > sStart, 'script tags found in rendered HTML');
    const script = html.slice(sStart, sEnd);
    assert.doesNotThrow(() => {
      new vm.Script(script);
    }, 'dashboard script must compile without syntax errors');
  });

  it('renders 2-column layout and drag-and-drop elements for Claude and Codex accounts', () => {
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="accountsGrid"'), 'contains #accountsGrid');
    assert.ok(html.includes('id="colClaude"'), 'contains #colClaude');
    assert.ok(html.includes('id="colCodex"'), 'contains #colCodex');
    assert.ok(html.includes('id="listClaude"'), 'contains #listClaude');
    assert.ok(html.includes('id="listCodex"'), 'contains #listCodex');
    assert.ok(html.includes('data-provider="anthropic"'), 'listClaude has data-provider anthropic');
    assert.ok(html.includes('data-provider="codex"'), 'listCodex has data-provider codex');
    assert.ok(html.includes('renderAccountsGrid'), 'script defines renderAccountsGrid');
    assert.ok(html.includes('/api/accounts/reorder'), 'script targets accounts reorder endpoint');
    assert.ok(html.includes('function moveToTop'), 'script defines moveToTop for 1-click priority promotion');
    assert.ok(!html.includes('⚡ Aktywuj'), 'removed confusing Aktywuj button');
    assert.ok(!html.includes('Polityka Burn-first'), 'removed confusing Burn-first button');
    assert.ok(html.includes('card-name-row'), 'dashboard defines card-name-row for dedicated account name line');
    assert.ok(html.includes('btn-rename'), 'dashboard contains account rename button');
    assert.ok(html.includes('function startInlineRename'), 'script defines inline account renaming');
    assert.ok(html.includes('function doRenameAccount'), 'script defines fallback rename helper');
    assert.ok(!html.includes('#1 Główny'), 'rank badge does not contain confusing Główny label');
    assert.ok(html.includes('function doStartOAuth'), 'script defines doStartOAuth');
    assert.ok(html.includes('function doCompleteOAuth'), 'script defines doCompleteOAuth');
    assert.ok(html.includes('function updateAddAccountProviderUI'), 'script defines updateAddAccountProviderUI');
    assert.ok(html.includes('id="btnAddClaudeCol"'), 'contains column btnAddClaudeCol');
    assert.ok(html.includes('id="btnAddCodexCol"'), 'contains column btnAddCodexCol');
    assert.ok(!html.includes('id="btnShowAddClaude"'), 'no duplicate section btnShowAddClaude');
    assert.ok(!html.includes('id="btnShowAddCodex"'), 'no duplicate section btnShowAddCodex');
    assert.ok(html.includes('function openAddAccountModal'), 'script defines openAddAccountModal');
  });

  it('renders spacious policy panel with explanations, PL/EN dual-language support, and dark/light themes', () => {
    const html = renderDashboardHtml();

    // Theme toggles
    assert.ok(html.includes('id="btnThemeToggle"'), 'header contains #btnThemeToggle');
    assert.ok(html.includes('id="btnLoginThemeToggle"'), 'login card contains #btnLoginThemeToggle');
    assert.ok(html.includes('[data-theme="light"]'), 'styles include [data-theme="light"] overrides');

    // Language toggles
    assert.ok(html.includes('id="btnLangToggle"'), 'header contains #btnLangToggle');
    assert.ok(html.includes('id="btnLoginLangToggle"'), 'login card contains #btnLoginLangToggle');

    // Policy Panel & Grid
    assert.ok(html.includes('id="fleetPolicyPanel"'), 'contains #fleetPolicyPanel');
    assert.ok(html.includes('class="policy-panel"'), 'contains .policy-panel');
    assert.ok(html.includes('class="policy-grid"'), 'contains .policy-grid');
    const cardCount = (html.match(/class="policy-card"/g) || []).length;
    assert.equal(cardCount, 4, 'contains exactly 4 policy cards for routing features');

    // Required control IDs preserved
    assert.ok(html.includes('id="selDistributeSessions"'), 'contains #selDistributeSessions');
    assert.ok(html.includes('id="chkExpiryRouting"'), 'contains #chkExpiryRouting');
    assert.ok(html.includes('id="chkCrossProviderFallback"'), 'contains #chkCrossProviderFallback');
    assert.ok(html.includes('id="chkAutoHealthCheck"'), 'contains #chkAutoHealthCheck');
    assert.ok(html.includes('id="btnDrainToggle"'), 'contains #btnDrainToggle');
    assert.ok(html.includes('id="btnTogglePolicyHelp"'), 'contains #btnTogglePolicyHelp');

    // Explanations present
    assert.ok(html.includes('id="descAffinity"'), 'contains prompt cache explanation');
    assert.ok(html.includes('id="descReset"'), 'contains earliest-reset explanation');
    assert.ok(html.includes('id="descFallback"'), 'contains cross-provider fallback explanation');
    assert.ok(html.includes('id="descHealth"'), 'contains auto-health explanation');

    // i18n dictionary and functions in script
    assert.ok(html.includes('var I18N = {'), 'script contains I18N dictionary');
    assert.ok(html.includes('function t('), 'script defines t() translation helper');
    assert.ok(html.includes('function updateI18nDOM()'), 'script defines updateI18nDOM()');
    assert.ok(html.includes('function setLang('), 'script defines setLang()');
    assert.ok(html.includes('function setTheme('), 'script defines setTheme()');
  });

  it('renders redesigned workstations section with dedicated master banner and integrated cards', () => {
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="selQuickStation"'), 'contains workstation quick selector #selQuickStation');
    assert.ok(html.includes('id="btnShowWorkstationGuide"'), 'contains guide button #btnShowWorkstationGuide');
    assert.ok(html.includes('master-key-banner'), 'styles define .master-key-banner');
    assert.ok(html.includes('workstation-card'), 'styles define .workstation-card');
    assert.ok(html.includes('workstation-metrics'), 'styles define .workstation-metrics');
    assert.ok(html.includes('id="clientsWrap" style="display:none;'), 'clientsWrap table is hidden by default');
    assert.ok(html.includes('Podłącz nową stację roboczą'), 'modalAddClientKey contains updated workstation header');
    assert.ok(html.includes('Konfiguracja stacji roboczej'), 'modalKeyCreated contains updated workstation setup header');
    assert.ok(html.includes('Klucz Master Administratora'), 'translations include Master Administrator Key');
    assert.ok(html.includes('💻 Stacje robocze'), 'translations include Workstations title');
  });

  it('updates account priority and persists order on POST /api/accounts/reorder', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-test-'));
    const tmpCfg = path.join(tmpDir, 'config.json');

    const initialConfig = {
      accounts: [
        { name: 'konto-a', type: 'apikey', apiKey: 'sk-ant-test-a', priority: 0 },
        { name: 'konto-b', type: 'apikey', apiKey: 'sk-ant-test-b', priority: 1 },
      ],
      proxy: {
        apiKey: 'admin-secret',
        clientKeys: [{ name: 'worker', key: 'worker-secret-1234', created: '2026-01-01T00:00:00.000Z' }],
      }
    };
    await fs.writeFile(tmpCfg, JSON.stringify(initialConfig, null, 2));
    process.env.AGENT_LB_CONFIG = tmpCfg;

    const dummyAccountManager = {
      accounts: [
        { name: 'konto-a', priority: 0 },
        { name: 'konto-b', priority: 1 },
      ],
      getStatus() { return { accounts: [], sessions: {} }; },
    };

    const server = createProxyServer(dummyAccountManager, initialConfig);
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;

    try {
      // Reorder accounts
      const reorderRes = await fetch(`http://127.0.0.1:${port}/api/accounts/reorder`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'admin-secret',
        },
        body: JSON.stringify({ order: ['konto-b', 'konto-a'] })
      });
      assert.equal(reorderRes.status, 200);
      const reorderData = await reorderRes.json();
      assert.equal(reorderData.ok, true);

      // In-memory dummyAccountManager updated
      assert.equal(dummyAccountManager.accounts.find(a => a.name === 'konto-b').priority, 0);
      assert.equal(dummyAccountManager.accounts.find(a => a.name === 'konto-a').priority, 1);

      // Disk config updated
      const disk = JSON.parse(await fs.readFile(tmpCfg, 'utf8'));
      assert.equal(disk.accounts.find(a => a.name === 'konto-b').priority, 0);
      assert.equal(disk.accounts.find(a => a.name === 'konto-a').priority, 1);

      // Rename account via POST /api/accounts/rename
      const renameRes = await fetch(`http://127.0.0.1:${port}/api/accounts/rename`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'admin-secret',
        },
        body: JSON.stringify({ oldName: 'konto-a', newName: 'konto-glówne' })
      });
      assert.equal(renameRes.status, 200);
      const renameData = await renameRes.json();
      assert.equal(renameData.ok, true);
      assert.equal(renameData.oldName, 'konto-a');
      assert.equal(renameData.newName, 'konto-glówne');

      // In-memory dummyAccountManager and disk updated
      assert.ok(dummyAccountManager.accounts.find(a => a.name === 'konto-glówne'), 'in-memory name updated');
      const diskAfterRename = JSON.parse(await fs.readFile(tmpCfg, 'utf8'));
      assert.ok(diskAfterRename.accounts.find(a => a.name === 'konto-glówne'), 'disk config name updated');

      // Duplicate rename rejected with 409
      const dupRes = await fetch(`http://127.0.0.1:${port}/api/accounts/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'admin-secret' },
        body: JSON.stringify({ oldName: 'konto-glówne', newName: 'konto-b' })
      });
      assert.equal(dupRes.status, 409);

      // Nonexistent account returns 404
      const nonExistentRes = await fetch(`http://127.0.0.1:${port}/api/accounts/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'admin-secret' },
        body: JSON.stringify({ oldName: 'nonexistent', newName: 'anything' })
      });
      assert.equal(nonExistentRes.status, 404);

      const statusRes = await fetch(`http://127.0.0.1:${port}/agent-lb/status`, {
        headers: { 'x-api-key': 'admin-secret' },
      });
      assert.equal(statusRes.status, 200);
      const statusText = await statusRes.text();
      assert.ok(!statusText.includes('admin-secret'), 'status must not expose the admin credential');
      assert.ok(!statusText.includes('worker-secret-1234'), 'status must not expose raw client credentials');
      assert.ok(statusText.includes('work...1234'), 'status may expose only a masked client key');

      // Unauthenticated external request on /api/keys must be rejected
      const unauthKeysRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/keys`, {
        headers: { 'x-forwarded-for': '203.0.113.195' }
      });
      assert.equal(unauthKeysRes.status, 401);

      // Invalid key on /api/keys must be rejected (401)
      const wrongKeysRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/keys`, {
        headers: {
          'x-forwarded-for': '203.0.113.195',
          'x-api-key': 'wrong-secret'
        },
      });
      assert.equal(wrongKeysRes.status, 401);

      // Client key on /api/keys succeeds under unified authentication
      const clientKeysRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/keys`, {
        headers: {
          'x-forwarded-for': '203.0.113.195',
          'x-api-key': 'worker-secret-1234'
        },
      });
      assert.equal(clientKeysRes.status, 200);
      const clientKeysData = await clientKeysRes.json();
      assert.equal(clientKeysData.ok, true);
      assert.equal(clientKeysData.primaryKey, 'admin-secret');

      // Authenticated admin on /api/keys must receive full key, rawKey, and primaryKey
      const adminKeysRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/keys`, {
        headers: { 'x-api-key': 'admin-secret' },
      });
      assert.equal(adminKeysRes.status, 200);
      const adminKeysData = await adminKeysRes.json();
      assert.equal(adminKeysData.ok, true);
      assert.equal(adminKeysData.primaryKey, 'admin-secret');
      assert.equal(adminKeysData.keys.length, 1);
      assert.equal(adminKeysData.keys[0].name, 'worker');
      assert.equal(adminKeysData.keys[0].key, 'worker-secret-1234');
      assert.equal(adminKeysData.keys[0].rawKey, 'worker-secret-1234');
      assert.equal(adminKeysData.keys[0].maskedKey, 'work...1234');

      // /api/auth/verify: Admin key succeeds as primary admin
      const authAdminRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/auth/verify`, {
        headers: { 'x-api-key': 'admin-secret' }
      });
      assert.equal(authAdminRes.status, 200);
      const authAdminData = await authAdminRes.json();
      assert.equal(authAdminData.ok, true);
      assert.equal(authAdminData.role, 'admin');
      assert.equal(authAdminData.isPrimary, true);

      // /api/auth/verify: Client key also succeeds under unified authentication
      const authClientRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/auth/verify`, {
        headers: {
          'x-forwarded-for': '203.0.113.195',
          'x-api-key': 'worker-secret-1234'
        }
      });
      assert.equal(authClientRes.status, 200);
      const authClientData = await authClientRes.json();
      assert.equal(authClientData.ok, true);
      assert.equal(authClientData.role, 'admin');
      assert.equal(authClientData.clientName, 'worker');

      // /api/auth/verify: Invalid key returns 401
      const authInvalidRes = await fetch(`http://127.0.0.1:${port}/agent-lb/api/auth/verify`, {
        headers: {
          'x-forwarded-for': '203.0.113.195',
          'x-api-key': 'totally-wrong'
        }
      });
      assert.equal(authInvalidRes.status, 401);
    } finally {
      delete process.env.AGENT_LB_CONFIG;
      await new Promise(res => server.close(res));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
