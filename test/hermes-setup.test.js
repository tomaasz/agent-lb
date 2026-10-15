import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// hermes-setup.sh scala konfigurację przez ruamel.yaml z venva Hermesa.
// Bez takiego interpretera (np. CI bez Hermesa) testy scalania są pomijane.
function findYamlPython() {
  const home = os.homedir();
  const candidates = [process.env.HERMES_SETUP_PYTHON, path.join(home, '.hermes/hermes-agent/venv/bin/python'), 'python3'];
  return candidates.find(c => c && spawnSync(c, ['-c', 'import ruamel.yaml']).status === 0);
}
const PY = findYamlPython();

const LEGACY_BLOCK = `
# --- AgentLB Multi-Provider ---
model_aliases:
  agy:
    model: "gemini-3.8-flash-high"
    provider: "agy"
custom_providers:
  - name: "agentlb"
    base_url: "http://old/v1"
    api_key: "tc-LEAKED-literal"
providers:
  agentlb:
    name: "AgentLB (All Models)"
    api_key: "tc-LEAKED-literal"

# --- End AgentLB ---
auxiliary:
  title_generation:
    model_upgrade_enabled: false
`;

const BASE = `agent:
  max_turns: 150
compression:
  threshold: 0.75
auxiliary:
  vision:
    provider: agentlb
providers:
  agy:
    name: AGY
    provider: agy
    context_length: 1048576
model_aliases:
  agy:
    model: gemini-3.8-flash-high
    provider: agy
`;

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-setup-'));
  const h = path.join(home, '.hermes');
  fs.mkdirSync(path.join(h, 'profiles/coder'), { recursive: true });
  fs.mkdirSync(path.join(h, 'profiles/broken'), { recursive: true });
  fs.mkdirSync(path.join(h, 'plugins/model-providers/agy'), { recursive: true });
  fs.writeFileSync(path.join(h, 'config.yaml'), BASE);
  fs.writeFileSync(path.join(h, 'profiles/coder/config.yaml'), BASE + LEGACY_BLOCK);
  fs.writeFileSync(path.join(h, 'profiles/broken/config.yaml'), 'zzz: 1\nzzz: 2\n');
  fs.writeFileSync(path.join(h, '.env'), 'OPENAI_BASE_URL="x"\nOTHER=1\nOPENAI_BASE_URL="y"\n');
  return { home, h };
}

function run(home) {
  return spawnSync('bash', ['setup/hermes-setup.sh', '--key', 'tc-TEST-not-real', '--url', 'http://127.0.0.1:9'], {
    env: { ...process.env, HOME: home, HERMES_SETUP_PYTHON: PY }, encoding: 'utf8',
  });
}

describe('hermes-setup.sh', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', 'setup/hermes-setup.sh']);
  });

  it('merges idempotently, heals the legacy block, keeps the key out of config.yaml', { skip: !PY && 'no python with ruamel.yaml' }, () => {
    const { home, h } = setupHome();
    try {
      const first = run(home);
      assert.equal(first.status, 1, 'broken profile is reported');
      assert.match(first.stderr, /broken\/config\.yaml.*duplicate key/);
      const snapshot = f => fs.readFileSync(path.join(h, f), 'utf8');
      const afterFirst = ['config.yaml', 'profiles/coder/config.yaml', '.env'].map(snapshot);

      run(home);
      assert.deepEqual(['config.yaml', 'profiles/coder/config.yaml', '.env'].map(snapshot), afterFirst, 'second run changes nothing');

      const coder = snapshot('profiles/coder/config.yaml');
      assert.ok(!coder.includes('AgentLB Multi-Provider'), 'legacy block removed');
      assert.ok(!coder.includes('tc-'), 'no literal key in config');
      assert.equal(coder.match(/^model_aliases:/gm).length, 1);
      assert.equal(coder.match(/^providers:/gm).length, 1);
      assert.equal(coder.match(/^auxiliary:/gm).length, 1);
      assert.match(coder, /api_key: \$\{AGENT_LB_API_KEY\}/);
      assert.match(coder, /max_turns: 150/, 'user values are not rewritten');
      assert.match(coder, /threshold: 0\.75/);
      assert.match(coder, /context_length: 1048576/, 'agy context length kept');
      assert.match(coder, /vision:\n\s+provider: agentlb/, 'unrelated auxiliary settings kept');

      assert.equal(snapshot('profiles/broken/config.yaml'), 'zzz: 1\nzzz: 2\n', 'broken file untouched');
      const env = snapshot('.env');
      assert.equal(env.match(/^OPENAI_BASE_URL=/gm).length, 1, 'no duplicated OPENAI_BASE_URL');
      assert.match(env, /^OTHER=1$/m);
      assert.equal(env.match(/^AGENT_LB_API_KEY=/gm).length, 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  describe('gemini models via /v1/models', { skip: !PY && 'no python with ruamel.yaml' }, () => {
    const FRESH = 'agent:\n  max_turns: 150\n';

    function fakeServer(handler) {
      return new Promise(resolve => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
      });
    }
    const modelsHandler = (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'gemini-3.8-flash-low' }, { id: 'claude-sonnet-5' }, { id: 'gemini-3.8-flash-high' }, { id: 'gemini-3.8-flash-low' }] }));
    };
    // curl w skrypcie blokuje, więc skrypt musi biec asynchronicznie obok serwera w tym procesie.
    function runAsync(home, url) {
      return new Promise(resolve => {
        const child = spawn('bash', ['setup/hermes-setup.sh', '--key', 'tc-TEST-not-real', '--url', url], {
          env: { ...process.env, HOME: home, HERMES_SETUP_PYTHON: PY },
        });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', status => resolve({ status, stderr }));
      });
    }
    function freshHome(config = FRESH) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-setup-'));
      fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
      fs.writeFileSync(path.join(home, '.hermes/config.yaml'), config);
      return home;
    }
    const cfgOf = home => fs.readFileSync(path.join(home, '.hermes/config.yaml'), 'utf8');

    it('adds gemini models from /v1/models to the agentlb provider', async () => {
      const { srv, url } = await fakeServer(modelsHandler);
      const home = freshHome();
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        const cfg = cfgOf(home);
        assert.equal(cfg.match(/^\s+- gemini-3\.8-flash-low$/gm).length, 2, 'once in providers, once in custom_providers');
        assert.equal(cfg.match(/^\s+- gemini-3\.8-flash-high$/gm).length, 2);
        assert.ok(cfg.indexOf('gemini-3.8-flash-low') > cfg.indexOf('gpt-4o-mini'), 'after the static ones');
        assert.ok(cfg.indexOf('gemini-3.8-flash-low') < cfg.indexOf('gemini-3.8-flash-high'), 'stable order');
        assert.ok(!cfg.includes('tc-TEST'), 'key stays out of config');
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('keeps an existing native agy provider untouched', async () => {
      const { srv, url } = await fakeServer(modelsHandler);
      const home = freshHome(`${FRESH}providers:\n  agy:\n    name: AGY\n    provider: agy\n    context_length: 1048576\n`);
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        assert.match(cfgOf(home), /agy:\n\s+name: AGY\n\s+provider: agy\n\s+context_length: 1048576/);
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('does not add native agy providers on a fresh install', async () => {
      const { srv, url } = await fakeServer(modelsHandler);
      const home = freshHome();
      fs.mkdirSync(path.join(home, '.hermes/plugins/model-providers/agy'), { recursive: true });
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        const cfg = cfgOf(home);
        assert.ok(!/^\s+agy(-fast)?:$/m.test(cfg), 'no agy / agy-fast providers or aliases');
        assert.ok(!cfg.includes('model_aliases'));
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('survives /v1/models failure and keeps previously written gemini ids', async () => {
      const { srv, url } = await fakeServer((req, res) => { res.statusCode = 500; res.end('boom'); });
      const seeded = `${FRESH}providers:\n  agentlb:\n    models:\n      - gemini-old-a\n      - gemini-old-b\ncustom_providers:\n  - name: agentlb\n    models:\n      - gemini-old-b\n      - gemini-old-c\n`;
      const home = freshHome(seeded);
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /nie udało się pobrać listy modeli/);
        assert.ok(!r.stderr.includes('tc-TEST'), 'warning has no key');
        const cfg = cfgOf(home);
        assert.ok(cfg.includes('gpt-4o-mini'));
        for (const id of ['gemini-old-a', 'gemini-old-b', 'gemini-old-c']) {
          assert.equal(cfg.match(new RegExp(`^\\s+- ${id}$`, 'gm')).length, 2, `${id} kept in both lists`);
        }
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('fresh install with failing /v1/models adds no gemini models', async () => {
      const { srv, url } = await fakeServer((req, res) => { res.statusCode = 500; res.end('boom'); });
      const home = freshHome();
      try {
        assert.equal((await runAsync(home, url)).status, 0);
        assert.ok(!cfgOf(home).includes('gemini-'));
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('replaces gemini ids on a successful response (removed server-side models disappear)', async () => {
      const { srv, url } = await fakeServer(modelsHandler);
      const home = freshHome(`${FRESH}providers:\n  agentlb:\n    models:\n      - gemini-gone\n`);
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(!cfgOf(home).includes('gemini-gone'));
        assert.ok(cfgOf(home).includes('gemini-3.8-flash-low'));
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('drops gemini ids that fail the strict pattern and caps the count', async () => {
      const many = Array.from({ length: 120 }, (_, i) => ({ id: `gemini-m${i}` }));
      const { srv, url } = await fakeServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'gemini-ok' }, { id: 'gemini-bad id' }, { id: 'gemini-nl\nx' }, { id: `gemini-${'a'.repeat(101)}` }, ...many] }));
      });
      const home = freshHome();
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        const cfg = cfgOf(home);
        assert.ok(cfg.includes('- gemini-ok'));
        assert.ok(!cfg.includes('bad id') && !cfg.includes('nl') && !cfg.includes('aaaaaaaaaaaaaaaaaaaa'));
        assert.equal(cfg.match(/^\s+- gemini-/gm).length, 200, '100 ids x 2 lists');
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('accepts a realistic model catalog larger than 300 KB without E2BIG', async () => {
      const filler = Array.from({ length: 4000 }, (_, i) => ({ id: `claude-padding-${i}`, name: 'x'.repeat(80) }));
      const { srv, url } = await fakeServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [...filler, { id: 'gemini-big-low' }, { id: 'gemini-big-high' }] }));
      });
      const home = freshHome();
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(cfgOf(home).includes('gemini-big-low'));
        assert.ok(cfgOf(home).includes('gemini-big-high'));
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('warns and preserves existing gemini ids when HTTP 200 body is unusable', async () => {
      const { srv, url } = await fakeServer((_req, res) => { res.statusCode = 200; res.end('not json'); });
      const home = freshHome(`${FRESH}providers:\n  agentlb:\n    models:\n      - gemini-existing-low\n`);
      try {
        const r = await runAsync(home, url);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stderr, /nie udało się odczytać listy modeli/);
        assert.ok(cfgOf(home).includes('gemini-existing-low'));
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('is idempotent on second run', async () => {
      const { srv, url } = await fakeServer(modelsHandler);
      const home = freshHome();
      try {
        assert.equal((await runAsync(home, url)).status, 0);
        const first = cfgOf(home);
        assert.equal((await runAsync(home, url)).status, 0);
        assert.equal(cfgOf(home), first);
      } finally {
        srv.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
