import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseCommandLine,
  stripEnvAssignments,
  extractCommandPrefix,
  extractFilepathsFromCommand,
  extractTextFromContent,
  getSingleUserTurn,
  getRequestSystemText,
  isQuotaCheckRequest,
  isPrefixDetectionRequest,
  isTitleGenerationRequest,
  isSuggestionModeRequest,
  isFilepathExtractionRequest,
  tryFastPathOptimization,
  sendFastPathResponse,
} from '../src/fast-path-optimizations.js';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { createDefaultConfig } from '../src/config.js';

test('Fast-path optimizations: shell command parsing & prefix extraction', () => {
  // Safe command line tokenizer
  assert.deepEqual(parseCommandLine('git commit -m "initial commit"'), [
    'git',
    'commit',
    '-m',
    'initial commit',
  ]);
  assert.deepEqual(parseCommandLine("grep -r 'pattern with spaces' ."), [
    'grep',
    '-r',
    'pattern with spaces',
    '.',
  ]);
  assert.deepEqual(parseCommandLine(''), []);

  // Strip env assignments
  assert.deepEqual(
    stripEnvAssignments(['FOO=1', 'BAR=test', 'npm', 'run', 'build']),
    ['npm', 'run', 'build'],
  );
  assert.deepEqual(stripEnvAssignments(['git', 'status']), ['git', 'status']);

  // Command prefix detection
  assert.equal(extractCommandPrefix('git status'), 'git status');
  assert.equal(extractCommandPrefix('git commit -m "fix"'), 'git commit');
  assert.equal(extractCommandPrefix('npm test'), 'npm test');
  assert.equal(extractCommandPrefix('docker ps -a'), 'docker ps');
  assert.equal(extractCommandPrefix('cargo build --release'), 'cargo build');
  assert.equal(extractCommandPrefix('ls -la /tmp'), 'ls');
  assert.equal(extractCommandPrefix('NODE_ENV=production npm start'), 'npm start');

  // Command injection detection
  assert.equal(
    extractCommandPrefix('cat $(which git)'),
    'command_injection_detected',
  );
  assert.equal(
    extractCommandPrefix('echo `whoami`'),
    'command_injection_detected',
  );
});

test('Fast-path optimizations: filepath extraction', () => {
  // Listing commands yield empty filepaths
  assert.equal(
    extractFilepathsFromCommand('ls -la /tmp', 'total 0'),
    '<filepaths>\n</filepaths>',
  );
  assert.equal(
    extractFilepathsFromCommand('find . -name "*.js"', './index.js'),
    '<filepaths>\n</filepaths>',
  );

  // Reading commands extract targets
  assert.equal(
    extractFilepathsFromCommand('cat src/index.js src/server.js', 'content'),
    '<filepaths>\nsrc/index.js\nsrc/server.js\n</filepaths>',
  );
  assert.equal(
    extractFilepathsFromCommand('head -n 20 README.md', 'heading'),
    '<filepaths>\nREADME.md\n</filepaths>',
  );

  // Grep extraction
  assert.equal(
    extractFilepathsFromCommand('grep pattern src/file1.js src/file2.js', 'matches'),
    '<filepaths>\nsrc/file1.js\nsrc/file2.js\n</filepaths>',
  );
  assert.equal(
    extractFilepathsFromCommand('grep -e "pattern" src/file1.js', 'match'),
    '<filepaths>\nsrc/file1.js\n</filepaths>',
  );
});

test('Fast-path optimizations: content & request detection utilities', () => {
  // Text extraction
  assert.equal(extractTextFromContent('simple string'), 'simple string');
  assert.equal(
    extractTextFromContent([
      { type: 'text', text: 'part 1' },
      { type: 'image', source: {} },
      { type: 'text', text: 'part 2' },
    ]),
    'part 1\npart 2',
  );

  // Single user turn detection
  assert.equal(
    getSingleUserTurn([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])?.content,
    'hello',
  );
  assert.equal(
    getSingleUserTurn([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]),
    null,
  );

  // System text extraction
  assert.equal(
    getRequestSystemText({
      system: 'top level sys',
      messages: [{ role: 'system', content: 'msg sys' }, { role: 'user', content: 'hi' }],
    }),
    'top level sys\nmsg sys',
  );
});

test('Fast-path optimizations: detectors', () => {
  // 1. Quota check
  const quotaReq = {
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Check quota status' }],
  };
  assert.equal(isQuotaCheckRequest(quotaReq), true);

  const nonQuotaReq = {
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'Write code' }],
  };
  assert.equal(isQuotaCheckRequest(nonQuotaReq), false);

  // 2. Prefix detection
  const prefixReq = {
    messages: [
      {
        role: 'user',
        content: '<policy_spec>\nRule: allow git\n</policy_spec>\nCommand: git checkout -b fix',
      },
    ],
  };
  const prefixDet = isPrefixDetectionRequest(prefixReq);
  assert.equal(prefixDet.matched, true);
  assert.equal(prefixDet.command, 'git checkout -b fix');

  // 3. Title generation
  const titleReq = {
    system: 'Generate a sentence-case title for this session',
    messages: [{ role: 'user', content: 'Help me debug my server' }],
  };
  assert.equal(isTitleGenerationRequest(titleReq), true);

  const titleReqJson = {
    system: 'Return JSON with field "title" for this coding session',
    messages: [{ role: 'user', content: 'Help me refactor' }],
  };
  assert.equal(isTitleGenerationRequest(titleReqJson), true);

  const nonTitleReq = {
    tools: [{ name: 'bash' }],
    system: 'Generate title',
    messages: [{ role: 'user', content: 'Run command' }],
  };
  assert.equal(isTitleGenerationRequest(nonTitleReq), false);

  // 4. Suggestion mode
  const suggestionReq = {
    messages: [
      {
        role: 'user',
        content: '[SUGGESTION MODE: Suggest the next bash command based on history]',
      },
    ],
  };
  assert.equal(isSuggestionModeRequest(suggestionReq), true);

  // 5. Filepath extraction
  const fpReq = {
    system: 'Extract any file paths that this command read',
    messages: [
      {
        role: 'user',
        content: 'Command: cat /etc/hosts\nOutput: 127.0.0.1 localhost\n<filepaths>',
      },
    ],
  };
  const fpDet = isFilepathExtractionRequest(fpReq);
  assert.equal(fpDet.matched, true);
  assert.equal(fpDet.command, 'cat /etc/hosts');
});

test('Fast-path optimizations: tryFastPathOptimization dispatcher and config toggles', () => {
  const req = {
    max_tokens: 1,
    messages: [{ role: 'user', content: 'quota probe' }],
  };

  // Enabled by default
  const res1 = tryFastPathOptimization(req, {});
  assert.equal(res1?.type, 'quota_probe');
  assert.equal(res1?.text, 'Quota check passed.');

  // Globally disabled
  const res2 = tryFastPathOptimization(req, { enabled: false });
  assert.equal(res2, null);

  // Specific toggle disabled
  const res3 = tryFastPathOptimization(req, { quotaProbe: false });
  assert.equal(res3, null);
});

test('Fast-path optimizations: sendFastPathResponse formatting (JSON & SSE)', async () => {
  // Non-streaming response
  let status = null;
  let headers = {};
  const bodyChunks = [];
  const mockRes = {
    writeHead(s, h) {
      status = s;
      headers = h;
    },
    write(chunk) {
      bodyChunks.push(chunk);
    },
    end(finalChunk) {
      if (finalChunk) bodyChunks.push(finalChunk);
    },
  };

  sendFastPathResponse(
    mockRes,
    { model: 'claude-3-5-sonnet', stream: false },
    { type: 'quota_probe', text: 'Quota check passed.', inputTokens: 10, outputTokens: 5 },
  );

  assert.equal(status, 200);
  assert.match(headers['Content-Type'], /application\/json/);
  const parsed = JSON.parse(bodyChunks.join(''));
  assert.equal(parsed.type, 'message');
  assert.equal(parsed.role, 'assistant');
  assert.equal(parsed.model, 'claude-3-5-sonnet');
  assert.equal(parsed.content[0].text, 'Quota check passed.');
  assert.equal(parsed.usage.input_tokens, 10);
  assert.equal(parsed.usage.output_tokens, 5);

  // Streaming SSE response
  status = null;
  headers = {};
  bodyChunks.length = 0;

  sendFastPathResponse(
    mockRes,
    { model: 'claude-3-7-sonnet', stream: true },
    { type: 'prefix_detection', text: 'git status', inputTokens: 100, outputTokens: 5 },
  );

  assert.equal(status, 200);
  assert.match(headers['Content-Type'], /text\/event-stream/);
  const sseData = bodyChunks.join('');
  assert.match(sseData, /event: message_start/);
  assert.match(sseData, /event: content_block_start/);
  assert.match(sseData, /git status/);
  assert.match(sseData, /event: content_block_stop/);
  assert.match(sseData, /event: message_delta/);
  assert.match(sseData, /event: message_stop/);
});

test('Fast-path optimizations: integration test via AgentLB server', async () => {
  const config = createDefaultConfig();
  config.proxy.port = 0; // Ephemeral port
  config.fastPathOptimizations = {
    enabled: true,
    quotaProbe: true,
    prefixDetection: true,
    titleGeneration: true,
    suggestionMode: true,
    filepathExtraction: true,
  };

  const server = createProxyServer(
    new AccountManager([], 0.98),
    config,
    {},
    null,
    null,
    null,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Send Quota Probe request to /v1/messages
    const postData = JSON.stringify({
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Check quota status' }],
    });

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'x-api-key': config.proxy.apiKey,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
        },
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.data);
    assert.equal(parsed.content[0].text, 'Quota check passed.');

    // 2. Send Prefix Detection request with stream: true
    const prefixPostData = JSON.stringify({
      model: 'claude-3-7-sonnet-20250219',
      stream: true,
      messages: [
        {
          role: 'user',
          content: '<policy_spec>\nRule\n</policy_spec>\nCommand: git push origin main',
        },
      ],
    });

    const streamRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(prefixPostData),
            'x-api-key': config.proxy.apiKey,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }));
        },
      );
      req.on('error', reject);
      req.write(prefixPostData);
      req.end();
    });

    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.headers['content-type'], /text\/event-stream/);
    assert.match(streamRes.data, /git push/);

    // 3. Verify Prometheus /metrics records agentlb_fast_path_total
    const metricsRes = await new Promise((resolve, reject) => {
      http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/metrics',
          headers: { 'x-api-key': config.proxy.apiKey },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ statusCode: res.statusCode, data }));
        },
      ).on('error', reject);
    });

    assert.equal(metricsRes.statusCode, 200);
    assert.match(metricsRes.data, /agentlb_fast_path_total\{type="quota_probe"\} 1/);
    assert.match(metricsRes.data, /agentlb_fast_path_total\{type="prefix_detection"\} 1/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
