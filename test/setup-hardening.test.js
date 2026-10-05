import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Both code paths users actually hit: setup.js (git clone / node present next
// to the script) and the pure-bash fallback (`curl .../setup.sh | bash`).
const installers = [
  { name: 'setup.js', run: (args, env) => execFileAsync(process.execPath, ['setup/setup.js', ...args], { env }) },
  {
    name: 'setup.sh (bash fallback)',
    run: (args, env) => execFileAsync('bash', ['setup/setup.sh', '--no-install', ...args], { env: { ...env, SETUP_FORCE_BASH: '1' } }),
  },
];

function childEnv(home) {
  const env = { ...process.env, HOME: home, AGENT_LB_TEST: '1' };
  for (const name of [
    'CLAUDE_LB_API_KEY', 'AGENT_LB_API_KEY', 'AGENTLB_API_KEY', 'CODEX_LB_API_KEY',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'AGENT_LB_URL', 'AGENTLB_URL', 'CLAUDE_LB_URL',
  ]) delete env[name];
  return env;
}

function parseToml(file) {
  const r = spawnSync('python3', ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', file]);
  assert.equal(r.status, 0, `invalid TOML in ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout.toString());
}

async function listBackups(dir) {
  return (await fs.readdir(dir)).filter(n => /\.bak-/.test(n)).sort();
}

test('setup hardening', async t => {
  const statusServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => statusServer.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${statusServer.address().port}`;
  const key = 'tc-hardening-test-key';

  try {
    for (const installer of installers) {
      await t.test(`${installer.name}: no global OPENAI_*, codex-lb default provider, one backup per file`, async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-hardening-'));
        const env = childEnv(home);
        try {
          await fs.writeFile(path.join(home, '.bashrc'), '# user bashrc\n');
          await fs.mkdir(path.join(home, '.claude'), { recursive: true });
          await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));
          await fs.mkdir(path.join(home, '.codex'), { recursive: true });
          const tomlPath = path.join(home, '.codex', 'config.toml');
          // Layout written by earlier installer versions: [profiles.codexlb] inside config.toml,
          // which Codex >= 0.160 rejects when --profile is used.
          await fs.writeFile(tomlPath, 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n'
            + '# >>> codexlb >>> (zarzadzane przez setup)\n[model_providers.codex-lb]\nname = "openai"\n'
            + 'base_url = "http://old.example/backend-api/codex"\n\n[profiles.codexlb]\nmodel = "gpt-5.6-sol"\n'
            + 'model_provider = "codex-lb"\n# <<< codexlb <<<\n');

          for (let i = 0; i < 3; i++) await installer.run(['--url', proxyUrl, '--key', key], env);

          const envFile = await fs.readFile(path.join(home, '.config', 'agent-lb.env'), 'utf8');
          assert.match(envFile, new RegExp(`^export AGENT_LB_API_KEY='${key}'$`, 'm'));
          assert.match(envFile, new RegExp(`^export CODEX_LB_API_KEY='${key}'$`, 'm'));
          assert.doesNotMatch(envFile, /OPENAI_|ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY=|ANTHROPIC_CUSTOM_HEADERS|CODEX_BASE_URL/);

          const toml = await fs.readFile(tomlPath, 'utf8');
          assert.ok(toml.startsWith('# >>> codexlb-default >>>'), 'default profile block must precede all tables');
          assert.equal(toml.match(/codexlb-default >>>/g).length, 1, 're-runs must not duplicate the block');
          assert.equal(toml.match(/\[model_providers\.codex-lb\]/g).length, 1);
          const parsed = parseToml(tomlPath);
          assert.equal(parsed.profile, undefined, 'Codex >= 0.160 rejects a top-level profile selector');
          assert.equal(parsed.profiles, undefined, 'legacy [profiles.*] tables removed');
          assert.equal(parsed.model_provider, 'codex-lb', 'plain `codex` goes through AgentLB');
          assert.equal(parsed.model, 'o3', 'user top-level keys preserved');
          assert.equal(parsed.mcp_servers.docs.command, 'docs-mcp');
          assert.equal(parsed.model_providers['codex-lb'].base_url, `${proxyUrl}/backend-api/codex`);
          assert.equal(parsed.model_providers['codex-lb'].env_key, 'CODEX_LB_API_KEY');
          const profilePath = path.join(home, '.codex', 'codexlb.config.toml');
          const profile = parseToml(profilePath);
          assert.equal(profile.model_provider, 'codex-lb');
          assert.equal(profile.model, 'gpt-5.6-sol');

          assert.deepEqual(await listBackups(path.join(home, '.claude')), ['settings.json.bak-agent-lb']);
          assert.deepEqual(
            JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json.bak-agent-lb'), 'utf8')),
            { theme: 'dark' },
            'the single backup is the pre-AgentLB original, without the key',
          );
          assert.deepEqual(await listBackups(path.join(home, '.codex')), ['config.toml.bak-agent-lb']);
          assert.deepEqual(await listBackups(path.join(home, '.config')), []);

          const bashrc = await fs.readFile(path.join(home, '.bashrc'), 'utf8');
          assert.equal(bashrc.match(/# agent-lb/g).length, 1);

          await installer.run(['--uninstall'], env);
          const after = await fs.readFile(tomlPath, 'utf8');
          assert.doesNotMatch(after, /codexlb|codex-lb/);
          assert.equal(parseToml(tomlPath).model, 'o3');
          await assert.rejects(fs.access(profilePath), 'managed profile file removed on uninstall');
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      });

      await t.test(`${installer.name}: user's own default Codex profile is left alone`, async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-hardening-'));
        try {
          await fs.mkdir(path.join(home, '.codex'), { recursive: true });
          const tomlPath = path.join(home, '.codex', 'config.toml');
          await fs.writeFile(tomlPath, 'profile = "work"\n\n[profiles.work]\nmodel = "o3"\n');
          const out = await installer.run(['--url', proxyUrl, '--key', key], childEnv(home));
          assert.match(out.stdout, /codex --profile codexlb/);
          const parsed = parseToml(tomlPath);
          assert.equal(parsed.profile, 'work');
          assert.equal(parsed.model_provider, undefined, 'user default left alone');
          assert.ok(parsed.model_providers['codex-lb'], 'provider still defined');
          assert.equal(parseToml(path.join(home, '.codex', 'codexlb.config.toml')).model_provider, 'codex-lb',
            'codexlb stays available explicitly via --profile');
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      });

      await t.test(`${installer.name}: uninstall cleans VS Code Server settings and reports legacy backups`, async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-hardening-'));
        const env = childEnv(home);
        try {
          const machineDir = path.join(home, '.vscode-server', 'data', 'Machine');
          await fs.mkdir(machineDir, { recursive: true });
          await fs.writeFile(path.join(machineDir, 'settings.json'), JSON.stringify({ 'editor.fontSize': 14 }));
          await installer.run(['--url', proxyUrl, '--key', key], env);
          assert.ok((await fs.readFile(path.join(machineDir, 'settings.json'), 'utf8')).includes(key));

          const legacy = path.join(home, '.claude', 'settings.json.bak-1700000000000');
          await fs.writeFile(legacy, JSON.stringify({ env: { ANTHROPIC_API_KEY: key } }));

          const out = await installer.run(['--uninstall'], env);
          const vs = JSON.parse(await fs.readFile(path.join(machineDir, 'settings.json'), 'utf8'));
          assert.ok(!JSON.stringify(vs).includes(key), 'key removed from VS Code Server settings');
          assert.equal(vs['editor.fontSize'], 14);
          assert.match(out.stdout, /settings\.json\.bak-1700000000000/);
          await fs.access(legacy); // reported, never deleted automatically
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      });
    }

    await t.test('setup.sh does not mass-kill codex or install system packages silently', async () => {
      const src = await fs.readFile('setup/setup.sh', 'utf8');
      assert.doesNotMatch(src, /killall/);
      assert.doesNotMatch(src, /^\s*(if\s+|elif\s+)?sudo\s+npm/m, 'sudo npm may be suggested, never run');
      assert.match(src, /INSTALL_NODE" -ne 1/);
      const js = await fs.readFile('setup/setup.js', 'utf8');
      assert.doesNotMatch(js, /sudo npm install -g \$\{pkgName\}`,/);
    });
  } finally {
    await new Promise(resolve => statusServer.close(resolve));
  }
});

test('dashboard install commands pass the station key via environment, not argv', async () => {
  const src = await fs.readFile('src/dashboard.js', 'utf8');
  assert.doesNotMatch(src, /\| bash -s -- --key/);
  assert.doesNotMatch(src, /\| node - --key/);
  assert.doesNotMatch(src, /\.sh --key ' \+/);
});

test('jcode sandbox hides .env files but keeps templates visible', async t => {
  const script = await fs.readFile('setup/jcode-setup.sh', 'utf8');
  const m = script.match(/cat > "\$HOME\/bin\/jcode-sandboxed" <<'__JCODE_EOF__'\n([\s\S]*?)\n__JCODE_EOF__/);
  assert.ok(m, 'embedded jcode-sandboxed found');
  if (spawnSync('bwrap', ['--version']).status !== 0) {
    t.skip('bwrap not installed');
    return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lb-jcode-'));
  try {
    const wrapper = path.join(home, 'jcode-sandboxed');
    await fs.writeFile(wrapper, m[1], { mode: 0o755 });
    await fs.mkdir(path.join(home, '.jcode', 'builds'), { recursive: true });
    const ws = path.join(home, 'proj');
    await fs.mkdir(path.join(ws, 'app'), { recursive: true });
    await fs.mkdir(path.join(ws, '.env-dir-venv', '.env'), { recursive: true });
    await fs.writeFile(path.join(ws, '.env'), 'DB_PASSWORD=sekret\n');
    await fs.writeFile(path.join(ws, 'app', '.env.local'), 'TOKEN=sekret\n');
    await fs.writeFile(path.join(ws, '.env.example'), 'DB_PASSWORD=\n');
    const env = { PATH: process.env.PATH, HOME: home };
    const r = spawnSync(wrapper, ['-w', ws, '--shell', '--', '-c',
      'wc -c < .env; wc -c < app/.env.local; cat .env.example; test -d .env-dir-venv/.env && echo DIR_OK'], { env });
    if (r.status !== 0 && /namespace|Operation not permitted/i.test(r.stderr.toString())) {
      t.skip('user namespaces unavailable');
      return;
    }
    assert.equal(r.status, 0, r.stderr.toString());
    assert.equal(r.stdout.toString(), '0\n0\nDB_PASSWORD=\nDIR_OK\n');

    const shown = spawnSync(wrapper, ['-w', ws, '--shell', '--', '-c', 'cat .env'], { env: { ...env, JCODE_SHOW_ENV_FILES: '1' } });
    assert.equal(shown.stdout.toString(), 'DB_PASSWORD=sekret\n');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
