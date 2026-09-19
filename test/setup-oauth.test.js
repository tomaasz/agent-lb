import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const installers = ['setup/setup.js'];

function childEnv(home) {
  const env = { ...process.env, HOME: home };
  for (const name of [
    'CLAUDE_LB_API_KEY',
    'AGENT_LB_API_KEY',
    'CODEX_LB_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]) delete env[name];
  return env;
}

test('installers preserve Claude OAuth and authenticate to the proxy with a custom header', async t => {
  const statusServer = http.createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'proxy-test-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => statusServer.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${statusServer.address().port}`;

  try {
    for (const installer of installers) {
      await t.test(installer, async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-oauth-setup-'));
        const claudeDir = path.join(home, '.claude');
        const vscodeDir = path.join(home, '.config', 'Code', 'User');
        await fs.mkdir(claudeDir, { recursive: true });
        await fs.mkdir(vscodeDir, { recursive: true });
        const credentials = { claudeAiOauth: { accessToken: 'oauth-session-token', refreshToken: 'oauth-refresh-token' } };
        await fs.writeFile(path.join(claudeDir, '.credentials.json'), JSON.stringify(credentials));

        try {
          await assert.rejects(
            execFileAsync(process.execPath, [installer, '--url', proxyUrl, '--key', 'proxy-test-key\nX-Evil: injected'], {
              cwd: process.cwd(),
              env: childEnv(home),
            }),
            err => err.code === 1 && /nowej linii/.test(err.stderr),
            'a proxy key must not inject another custom header',
          );

          const first = await execFileAsync(process.execPath, [installer, '--url', proxyUrl, '--key', 'proxy-test-key'], {
            cwd: process.cwd(),
            env: childEnv(home),
          });
          assert.match(first.stdout, /ANTHROPIC_CUSTOM_HEADERS/);

          const settings = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
          assert.equal(settings.env.ANTHROPIC_BASE_URL, proxyUrl);
          assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, 'x-api-key: proxy-test-key');
          assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);

          const vscode = JSON.parse(await fs.readFile(path.join(vscodeDir, 'settings.json'), 'utf8'));
          assert.deepEqual(vscode['claudeCode.environmentVariables'], [
            { name: 'ANTHROPIC_BASE_URL', value: proxyUrl },
            { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'x-api-key: proxy-test-key' },
          ]);

          const envFile = await fs.readFile(path.join(home, '.config', 'agent-lb.env'), 'utf8');
          assert.match(envFile, /^unset ANTHROPIC_API_KEY/m);
          assert.match(envFile, /^export ANTHROPIC_CUSTOM_HEADERS='x-api-key: proxy-test-key'$/m);
          assert.match(envFile, /^export CODEX_LB_API_KEY='proxy-test-key'$/m);

          const second = await execFileAsync(process.execPath, [installer, '--url', proxyUrl, '--skip-vscode', '--skip-env'], {
            cwd: process.cwd(),
            env: childEnv(home),
          });
          assert.match(second.stdout, /Wykryto wcześniej zapisany klucz/);

          await execFileAsync(process.execPath, [installer, '--uninstall'], {
            cwd: process.cwd(),
            env: childEnv(home),
          });
          const uninstalled = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
          assert.equal(uninstalled.env, undefined);
          assert.deepEqual(JSON.parse(await fs.readFile(path.join(claudeDir, '.credentials.json'), 'utf8')), credentials);
          await assert.rejects(fs.access(path.join(home, '.config', 'agent-lb.env')));
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
  }
});

test('installers preserve existing non-proxy custom headers on install and uninstall', async t => {
  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => statusServer.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${statusServer.address().port}`;

  try {
    for (const installer of installers) {
      await t.test(installer, async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-oauth-preserve-'));
        const claudeDir = path.join(home, '.claude');
        const vscodeDir = path.join(home, '.config', 'Code', 'User');
        await fs.mkdir(claudeDir, { recursive: true });
        await fs.mkdir(vscodeDir, { recursive: true });
        const credentials = { claudeAiOauth: { accessToken: 'oauth-session-token' } };
        await fs.writeFile(path.join(claudeDir, '.credentials.json'), JSON.stringify(credentials));

        // Seed existing custom header in claude settings.json and vscode settings.json
        await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({
          env: { ANTHROPIC_CUSTOM_HEADERS: 'x-org-id: my-test-org' }
        }));
        await fs.writeFile(path.join(vscodeDir, 'settings.json'), JSON.stringify({
          'claudeCode.environmentVariables': [
            { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'x-org-id: my-test-org' }
          ]
        }));

        try {
          await execFileAsync(process.execPath, [installer, '--url', proxyUrl, '--key', 'proxy-test-key'], {
            cwd: process.cwd(),
            env: childEnv(home),
          });

          const settings = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
          assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, 'x-org-id: my-test-org\nx-api-key: proxy-test-key');

          const vscode = JSON.parse(await fs.readFile(path.join(vscodeDir, 'settings.json'), 'utf8'));
          const customHdr = vscode['claudeCode.environmentVariables'].find(e => e.name === 'ANTHROPIC_CUSTOM_HEADERS')?.value;
          assert.equal(customHdr, 'x-org-id: my-test-org\nx-api-key: proxy-test-key');

          await execFileAsync(process.execPath, [installer, '--uninstall'], {
            cwd: process.cwd(),
            env: childEnv(home),
          });

          const uninstalled = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
          assert.equal(uninstalled.env.ANTHROPIC_CUSTOM_HEADERS, 'x-org-id: my-test-org');

          const uninstalledVscode = JSON.parse(await fs.readFile(path.join(vscodeDir, 'settings.json'), 'utf8'));
          const uninstalledCustomHdr = uninstalledVscode['claudeCode.environmentVariables'].find(e => e.name === 'ANTHROPIC_CUSTOM_HEADERS')?.value;
          assert.equal(uninstalledCustomHdr, 'x-org-id: my-test-org');
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
  }
});

test('all setup bash scripts pass syntax validation', async () => {
  const setupDir = path.join(process.cwd(), 'setup');
  const files = await fs.readdir(setupDir);
  const shFiles = files.filter(f => f.endsWith('.sh'));
  assert.ok(shFiles.length > 0, 'should have shell scripts in setup/');

  for (const shFile of shFiles) {
    const filePath = path.join(setupDir, shFile);
    await assert.doesNotReject(
      execFileAsync('bash', ['-n', filePath]),
      `syntax error in ${shFile}`,
    );
  }
});
