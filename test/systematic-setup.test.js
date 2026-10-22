import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// Execute only extracted validation/serialization fragments: no installers or network.
const root = process.env.SETUP_AUDIT_ROOT || fileURLToPath(new URL('../', import.meta.url));
const source = name => fs.readFileSync(path.join(root, 'setup', name), 'utf8');
function connection(overrides = {}) {
  const src = source('codexlb-setup.js');
  const code = src.slice(src.indexOf('async function checkConnection('), src.indexOf('async function handleRestore('));
  const state = {
    checkConnectionNative: async () => { throw new Error('socket disconnected'); },
    hasCommand: () => true,
    execSync: () => { throw new Error('Shell execution is forbidden'); },
    execFileSync: () => '{"data":[{"id":"test-model"}]}',
    ...overrides,
  };
  vm.createContext(state);
  vm.runInContext(code, state);
  return state;
}

test('curl fallback sends hostile-looking credentials through stdin without secret arguments', async () => {
  const key = '$(printf SHELL_COMMAND)";&';
  let invoked = false;
  const c = connection({ execFileSync(cmd, args, options) {
    invoked = true;
    assert.equal(cmd, 'curl');
    assert.ok(args.includes('@-'));
    assert.ok(args.every(arg => !arg.includes(key)));
    assert.equal(options.input, `Authorization: Bearer ${key}\n`);
    assert.ok(args.includes('--fail'));
    return '{"data":[{"id":"test-model"}]}';
  } });
  const result = await c.checkConnection('https://example.invalid', key, false);
  assert.equal(invoked, true);
  assert.equal(result.models[0], 'test-model');
});

for (const key of ['fixture\rInjected: header', 'fixture\nInjected: header']) test('CR/LF credentials are rejected before native or curl requests', async () => {
  let calls = 0;
  const c = connection({
    checkConnectionNative: async () => { calls++; throw new Error('transport failed'); },
    execFileSync: () => { calls++; return '{}'; },
  });
  await assert.rejects(c.checkConnection('https://example.invalid', key, false));
  assert.equal(calls, 0);
});

test('installed curl reads authorization header from stdin against local HTTP fixture', { skip: spawnSync('curl', ['--version']).status !== 0 }, async t => {
  let received;
  const server = http.createServer((req, res) => { received = req.headers.authorization; res.end('{"data":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/backend-api/codex/models`;
  await new Promise((resolve, reject) => {
    const child = spawn('curl', ['--silent', '--show-error', '--fail', '--max-time', '5', '--header', '@-', '--url', url], { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`curl exited ${code}: ${error}`)));
    child.stdin.end('Authorization: Bearer synthetic-local-fixture\n');
  });
  assert.equal(received, 'Bearer synthetic-local-fixture');
});

test('OpenCode full script never prints the configured API key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lb-setup-stdout-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    for (const command of ['mkdir', 'date', 'cp', 'chmod', 'node']) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
      assert.equal(resolved.status, 0);
      fs.symlinkSync(resolved.stdout.trim(), path.join(bin, command));
    }
    const key = 'synthetic-must-not-appear-in-output';
    const result = spawnSync('/bin/bash', [path.join(root, 'setup', 'opencode-setup.sh')], {
      env: { ...process.env, HOME: dir, PATH: bin, AGENT_LB_API_KEY: key, AGENT_LB_URL: 'https://example.invalid' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(key));
    assert.ok(!result.stderr.includes(key));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const statusCode of [401, 403]) test(`native HTTP ${statusCode} is rejected without fallback`, async () => {
  let fallback = false;
  const c = connection({
    checkConnectionNative: async () => { throw Object.assign(new Error(`kod HTTP ${statusCode}`), { statusCode }); },
    execSync: () => { fallback = true; return '{"error":"unauthorized"}'; },
    execFileSync: () => { fallback = true; return '{"error":"unauthorized"}'; },
  });
  await assert.rejects(c.checkConnection('https://example.invalid', 'invalid', false));
  assert.equal(fallback, false);
});

test('curl non-success response rejects configuration', async () => {
  const c = connection({
    execSync: () => '{"error":"unauthorized"}',
    execFileSync: () => { throw new Error('curl exited 22'); },
  });
  await assert.rejects(c.checkConnection('https://example.invalid', 'invalid', false));
});

for (const script of ['claw-setup.sh', 'opencode-setup.sh']) {
  for (const runtime of ['node', 'python3']) {
    function runFragment(dir, key = 'tc-DUMMY-TEST') {
      const src = source(script);
      const marker = [`${runtime} - << EOF\n`, `${runtime} - << 'EOF'\n`].find(value => src.includes(value));
      assert.ok(marker);
      const start = src.indexOf(marker) + marker.length;
      assert.ok(start >= marker.length);
      const code = src.slice(start, src.indexOf('\nEOF', start))
        .replaceAll('$CONFIG_FILE', path.join(dir, 'config.json'))
        .replaceAll('$AUTH_FILE', path.join(dir, 'auth.json'))
        .replaceAll('$URL', 'https://example.invalid')
        .replaceAll('$KEY', key);
      // Child inherits normal 022 umask; serializer must explicitly protect secrets.
      return spawnSync(runtime, runtime === 'node' ? ['--input-type=commonjs', '-'] : ['-'], { input: code, encoding: 'utf8', env: { ...process.env, AGENTLB_SETUP_CONFIG_FILE: path.join(dir, 'config.json'), AGENTLB_SETUP_AUTH_FILE: path.join(dir, 'auth.json'), AGENTLB_SETUP_URL: 'https://example.invalid', AGENTLB_SETUP_KEY: key } });
    }
    test(`${script} ${runtime}: config and auth files are private, including existing files`, { skip: runtime === 'python3' && spawnSync('python3', ['--version']).status !== 0 }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lb-serializer-'));
      const mask = process.umask(0o022);
      try {
        let r = runFragment(dir);
        assert.equal(r.status, 0, r.stderr);
        const names = script.startsWith('opencode') ? ['config.json', 'auth.json'] : ['config.json'];
        for (const name of names) {
          const f = path.join(dir, name);
          assert.equal(fs.statSync(f).mode & 0o777, 0o600, name);
          fs.chmodSync(f, 0o644);
        }
        r = runFragment(dir);
        assert.equal(r.status, 0, r.stderr);
        for (const name of names) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
      } finally { process.umask(mask); fs.rmSync(dir, { recursive: true, force: true }); }
    });
    test(`${script} ${runtime}: key remains literal when serialized`, { skip: runtime === 'python3' && spawnSync('python3', ['--version']).status !== 0 }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lb-serializer-'));
      const key = 'x" + "INJECTED" + "y';
      try {
        const r = runFragment(dir, key);
        assert.equal(r.status, 0, r.stderr);
        const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
        assert.equal(script.startsWith('claw') ? config.models.providers.agentlb.apiKey : config.provider.agentlb.options.apiKey, key);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    if (script === 'opencode-setup.sh') test(`${script} ${runtime}: invalid auth stops before either file is written`, { skip: runtime === 'python3' && spawnSync('python3', ['--version']).status !== 0 }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lb-auth-'));
      try {
        const configPath = path.join(dir, 'config.json');
        const authPath = path.join(dir, 'auth.json');
        const originalConfig = '{"existing":"must survive"}\n';
        for (const invalidAuth of ['{"broken":', '[]', 'null', '42']) {
          fs.writeFileSync(configPath, originalConfig);
          fs.writeFileSync(authPath, invalidAuth);
          const r = runFragment(dir);
          assert.notEqual(r.status, 0, `invalid auth ${invalidAuth} must stop setup`);
          assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
          assert.equal(fs.readFileSync(authPath, 'utf8'), invalidAuth);
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    test(`${script} ${runtime}: malformed config is preserved and reported`, { skip: runtime === 'python3' && spawnSync('python3', ['--version']).status !== 0 }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lb-serializer-'));
      try {
        const f = path.join(dir, 'config.json');
        const original = '{"existing":"must survive",';
        fs.writeFileSync(f, original);
        const r = runFragment(dir);
        assert.notEqual(r.status, 0, 'invalid JSON must stop setup');
        assert.equal(fs.readFileSync(f, 'utf8'), original);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('Codex shell environment quotes key, URL and sourced path literally', () => {
  const src = source('codexlb-setup.js');
  const start = src.indexOf('      const shellQuote =');
  assert.ok(start > 0, 'shell quoting helper is required');
  const end = src.indexOf('      fs.writeFileSync(envFile', start);
  const key = `$(printf EXECUTED)'`;
  const url = 'https://example.invalid/$(printf EXECUTED)';
  const c = { apiKey: key, targetUrl: url, envFile: "/unused", fs: { existsSync: () => false } };
  vm.createContext(c);
  vm.runInContext(src.slice(start, end) + '\nglobalThis.environmentText = envLines;', c);
  const r = spawnSync('/bin/sh', ['-c', c.environmentText + '\nprintf "%s\\n%s" "$CODEX_LB_API_KEY" "$OPENAI_BASE_URL"'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, key + '\n' + url + '/v1');
});


test('Codex existing environment file is restricted before writing credentials', () => {
  const src = source('codexlb-setup.js');
  const start = src.indexOf('      const shellQuote =');
  const end = src.indexOf('      console.log(`[OK] Klucz', start);
  assert.ok(start > 0 && end > start);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lb-codex-env-'));
  const envFile = path.join(dir, 'codex.env');
  try {
    fs.writeFileSync(envFile, 'old', { mode: 0o644 });
    const checkedFs = { ...fs, writeFileSync(file, ...args) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'permissions must be private before the new key is written');
      return fs.writeFileSync(file, ...args);
    } };
    const c = { apiKey: 'fixture', targetUrl: 'https://example.invalid', envFile, fs: checkedFs };
    vm.createContext(c);
    vm.runInContext(src.slice(start, end), c);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(envFile, 'utf8'), /fixture/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
