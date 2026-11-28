import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { workstationSetupCommand, stationCanUseAgylb, renderDashboardHtml } from '../src/dashboard.js';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

const run = promisify(execFile);

test('agylb selection follows station relay restrictions and expiry', () => {
  assert.equal(stationCanUseAgylb(), false);
  assert.equal(stationCanUseAgylb({ allowCredentialRelay: false }), false);
  assert.equal(stationCanUseAgylb({ allowCredentialRelay: true }), true);
  for (const policy of [{ maxDailyTokens: 1 }, { maxMonthlyTokens: 1 }, { allowedModels: ['gemini'] }, { allowedProviders: ['agy'] }, { expiresAt: '2020-01-01' }, { expiresAt: 'invalid' }]) {
    assert.equal(stationCanUseAgylb({ allowCredentialRelay: true, ...policy }), false);
  }
});

test('generated shell commands prompt for credentials and have valid quoting', async () => {
  for (const origin of ['https://agentlb.test', "https://weird'host.test"]) {
    const command = workstationSetupCommand(origin, '/setup.sh', 'bash', true);
    await run('bash', ['-n', '-c', command]);
    assert.match(command, /read -rsp/);
    assert.match(command, /\/dev\/tty/);
    assert.match(command, /--with-agylb/);
    assert.doesNotMatch(command, /tc-|--key/);
  }
  const basic = workstationSetupCommand('https://agentlb.test', '/setup.sh');
  assert.doesNotMatch(basic, /--with-agylb/);
  const node = workstationSetupCommand('https://agentlb.test', '/setup.js', 'node');
  await run('bash', ['-n', '-c', node]);
  assert.match(node, /read -rsp.*\/dev\/tty/);
  assert.match(node, /\| node - --url/);
  const ps = workstationSetupCommand('https://agentlb.test', '/setup.ps1', 'ps');
  assert.match(ps, /Read-Host.*AsSecureString/);
  assert.match(ps, /finally.*previousKey/);
  assert.doesNotMatch(ps, /-Key |tc-|-WithAgylb/);
  const psAgylb = workstationSetupCommand('https://agentlb.test', '/setup.ps1', 'ps', true);
  assert.match(psAgylb, /-WithAgylb/);
  assert.doesNotMatch(psAgylb, /-Key |tc-/);
  const psStandalone = workstationSetupCommand('https://agentlb.test', '/agylb-setup.ps1', 'ps');
  assert.match(psStandalone, /\/agylb-setup\.ps1/);
  assert.doesNotMatch(psStandalone, /-Key |tc-/);
});

test('dashboard setup UI exposes agylb and agylb-yolo for POSIX and Windows PowerShell', () => {
  const html = renderDashboardHtml();
  assert.match(html, /id="cmdSetupAgylb"/);
  assert.match(html, /id="cmdSetupAgylbPs"/);
  assert.match(html, /id="btnCopySetupAgylbPs"/);
  assert.match(html, /id="setupAgylbIncludedPs"/);
  assert.match(html, /agylb-yolo/);
  assert.equal((html.match(/\bsetupAgylbCopyPs:/g) || []).length, 2, 'setupAgylbCopyPs in PL and EN');
  assert.match(html, /workstationSetupCommand\(hostUrl, '\/setup\.ps1', 'ps', includeAgylb\)/);
  assert.match(html, /if \(setupAgylbUserChoice === null\) agylbCheckbox\.checked = true;/);
});

test('public agylb routes serve only whitelisted code and refuse other platforms', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agylb-routes-'));
  const server = createProxyServer(new AccountManager([], 0.98), {
    proxy: { apiKey: 'tc-fake-admin' }, agy: { accountsPath: path.join(dir, 'accounts.json') },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [endpoint, filename] of [['/agylb.py', 'clients/agylb.py'], ['/agylb-install.py', 'clients/install_agylb.py']]) {
      const response = await fetch(base + endpoint);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), await fs.readFile(filename, 'utf8'));
      assert.equal(await (await fetch(base + endpoint, { method: 'HEAD' })).text(), '');
    }
    const installer = await fetch(base + '/agylb-setup.sh');
    assert.equal(installer.status, 200);
    assert.match(await installer.text(), /Install interactive agylb/);
    const psInstaller = await fetch(base + '/agylb-setup.ps1');
    assert.equal(psInstaller.status, 200);
    const psBody = await psInstaller.text();
    assert.match(psBody, /Install interactive agylb and agylb-yolo on Windows/);
    assert.doesNotMatch(psBody, /\bexit \$LASTEXITCODE\b/);
    assert.equal((await fetch(base + '/agylb-setup.js')).status, 404);
    assert.notEqual((await fetch(base + '/clients/config.json')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('agylb installer checks access before writing and never exposes keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agylb-installer-'));
  let status = 403;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/agylb.py' || req.url === '/agylb-install.py' || req.url === '/agylb-setup.sh') {
      const file = req.url === '/agylb.py' ? 'clients/agylb.py' : req.url === '/agylb-install.py' ? 'clients/install_agylb.py' : 'setup/agylb-setup.sh';
      res.end(await fs.readFile(file));
      return;
    }
    if (req.url !== '/agy/credential') { res.end('{}'); return; }
    assert.equal(req.headers['x-api-key'], 'tc-private-test');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? JSON.stringify({ account: { id: 'fake' }, token: { token: { refresh_token: 'fake-google-secret' } } }) : '{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HOME: dir, AGENT_LB_URL: `http://127.0.0.1:${server.address().port}`, AGENT_LB_API_KEY: 'tc-private-test' };
  try {
    await fs.mkdir(path.join(dir, '.local/bin'), { recursive: true });
    await fs.writeFile(path.join(dir, '.local/bin/agy'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await assert.rejects(run('bash', ['setup/agylb-setup.sh'], { env }), error => {
      assert.match(error.stderr, /nie ma dostępu/);
      assert.doesNotMatch(error.stdout + error.stderr, /tc-private-test|fake-google-secret/);
      return true;
    });
    await assert.rejects(fs.access(path.join(dir, '.config/agylb/config.json')));
    await fs.writeFile(path.join(dir, '.bashrc'), '# user rc\n');
    status = 200;
    const result = await run('bash', ['setup/agylb-setup.sh'], { env });
    assert.doesNotMatch(result.stdout + result.stderr, /tc-private-test|fake-google-secret/);
    const configPath = path.join(dir, '.config/agylb/config.json');
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).key, 'tc-private-test');
    assert.equal(await fs.readFile(path.join(dir, '.local/bin/agylb'), 'utf8'), await fs.readFile('clients/agylb.py', 'utf8'));
    assert.match(await fs.readFile(path.join(dir, '.local/bin/agylb-yolo'), 'utf8'), /AGYLB_SKIP_PERMISSIONS=1/);
    assert.equal((await fs.stat(path.join(dir, '.local/bin/agylb-yolo'))).mode & 0o777, 0o700);
    assert.equal(((await fs.readFile(path.join(dir, '.bashrc'), 'utf8')).match(/# agylb-path/g) || []).length, 1);
    await assert.rejects(fs.access(path.join(dir, '.gemini/antigravity-cli/antigravity-oauth-token')));
    // The public curl|bash path has no local source tree available.
    const streamedHome = path.join(dir, 'streamed');
    await fs.mkdir(path.join(streamedHome, '.local/bin'), { recursive: true });
    await fs.copyFile(path.join(dir, '.local/bin/agy'), path.join(streamedHome, '.local/bin/agy'));
    const downloadedScript = path.join(dir, 'agylb-setup.sh');
    await fs.copyFile('setup/agylb-setup.sh', downloadedScript);
    const downloaded = await run('bash', [downloadedScript], { env: { ...env, HOME: streamedHome }, timeout: 30000 });
    assert.doesNotMatch(downloaded.stdout + downloaded.stderr, /tc-private-test|fake-google-secret/);
    assert.equal(await fs.readFile(path.join(streamedHome, '.local/bin/agylb'), 'utf8'), await fs.readFile('clients/agylb.py', 'utf8'));
    assert.equal(JSON.parse(await fs.readFile(path.join(streamedHome, '.config/agylb/config.json'), 'utf8')).key, 'tc-private-test');
    for (const [name, command, args] of [
      ['node', process.execPath, ['setup/setup.js']],
      ['bash', 'bash', ['setup/setup.sh']],
    ]) {
      const home = path.join(dir, name);
      await fs.mkdir(path.join(home, '.local/bin'), { recursive: true });
      await fs.copyFile(path.join(dir, '.local/bin/agy'), path.join(home, '.local/bin/agy'));
      const installed = await run(command, [...args, '--url', env.AGENT_LB_URL, '--with-agylb', '--no-install'], {
        env: { ...env, HOME: home, SETUP_FORCE_BASH: '1', AGENT_LB_TEST: '1' }, timeout: 30000,
      });
      assert.doesNotMatch(installed.stdout + installed.stderr, /tc-private-test|fake-google-secret/);
      assert.equal(JSON.parse(await fs.readFile(path.join(home, '.config/agylb/config.json'), 'utf8')).key, 'tc-private-test');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
