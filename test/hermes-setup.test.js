import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
});
