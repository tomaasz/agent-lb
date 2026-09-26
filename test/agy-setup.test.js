import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { renderDashboardHtml } from '../src/dashboard.js';

const AGY_MODELS = ['agy', 'agy-fast', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low'];

async function withProxy(fn) {
  const am = new AccountManager([], 0.98);
  const server = createProxyServer(am, { proxy: { apiKey: 'tc-test-admin' } }, {}, null, null, null);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('agybridge setup (real AGY runs locally, not through the proxy)', () => {
  it('serves agy-setup.sh without auth and never falls back to the generic installer', async () => {
    await withProxy(async (base) => {
      const res = await fetch(`${base}/agy-setup.sh`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('agy-setup.sh — instalator agybridge'), 'returns the agybridge installer');
      assert.ok(!body.includes('agent-lb client setup script'), 'not the Claude/Codex installer');

      const alias = await fetch(`${base}/agybridge-setup.sh`);
      assert.equal(alias.status, 200);
      assert.ok((await alias.text()).includes('instalator agybridge'));
    });
  });

  it('does not advertise AGY models the proxy cannot serve', async () => {
    await withProxy(async (base) => {
      const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'tc-test-admin' } });
      assert.equal(res.status, 200);
      const ids = (await res.json()).data.map(m => m.id);
      for (const id of AGY_MODELS) assert.ok(!ids.includes(id), `${id} not listed`);
      assert.ok(ids.includes('claude-opus-5'), 'regular models still listed');
    });
  });

  it('keeps AGY out of the agentlb provider in client installers', () => {
    const opencode = fs.readFileSync('setup/opencode-setup.sh', 'utf8');
    assert.ok(!/"agy(-fast)?":/.test(opencode), 'opencode agentlb provider has no agy models');

    const hermes = fs.readFileSync('setup/hermes-setup.sh', 'utf8');
    assert.ok(!hermes.includes('models.extend(["agy"'), 'python path: agy not in agentlb list');
    assert.ok(!hermes.includes("models.push('agy'"), 'node path: agy not in agentlb list');
    assert.ok(hermes.includes('"agy-fast": {"name": "AGY Fast"'), 'native AGY providers kept for the plugin');
  });

  it('agy-setup.sh is valid bash and keeps the token out of argv and output', () => {
    execFileSync('bash', ['-n', 'setup/agy-setup.sh']);
    const script = fs.readFileSync('setup/agy-setup.sh', 'utf8');
    const echoes = script.split('\n').filter(l => /echo[^\n]*\$TOKEN/.test(l)).map(l => l.trim());
    assert.deepEqual(echoes, ['echo "AGYBRIDGE_TOKEN=$TOKEN"'], 'token is only written into the env file');
    assert.ok(/\} > "\$ENV_FILE"/.test(script), 'that echo is redirected to the env file');
    assert.ok(!/Bearer \$TOKEN/.test(script), 'token is not passed on a command line');
    assert.ok(script.includes('curl -s -o /dev/null') && script.includes('-K -'), 'health check reads the header from stdin');
    assert.ok(script.includes('chmod 600 "$ENV_FILE"'), 'env file is private');
  });

  it('main installers accept --with-agy and delegate to agy-setup.sh', () => {
    const sh = fs.readFileSync('setup/setup.sh', 'utf8');
    assert.ok(sh.includes('--with-agy|--agy) WITH_AGY=1'));
    assert.ok(sh.includes('agy-setup.sh'));
    const js = fs.readFileSync('setup/setup.js', 'utf8');
    assert.ok(js.includes('arg === "--with-agy"'));
    assert.ok(js.includes('installAgyBridge()'));
  });

  it('dashboard offers an AGY quick-install button', () => {
    const html = renderDashboardHtml();
    assert.ok(html.includes('id="btnQuickToolAgy"'));
    assert.ok(html.includes("/agy-setup.sh | bash"));
  });
});
