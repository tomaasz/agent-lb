// Fast-Path API Optimizations for Claude Code and Agent Assistants
//
// Claude Code and similar agent harnesses make frequent background LLM calls
// to Anthropic for non-coding helper operations:
// 1. Quota / network probe requests (e.g. max_tokens=1 with "quota" in user message).
// 2. Prefix detection for policy evaluation (<policy_spec> + Command: ...).
// 3. Title generation (sentence-case title or JSON title field without tools).
// 4. Suggestion mode auto-completions ([SUGGESTION MODE: ...]).
// 5. Filepath extraction from command output (Command: ... Output: ... <filepaths>).
//
// Intercepting these requests in AgentLB and answering them locally:
// - Saves upstream quota and tokens on Anthropic/Codex accounts.
// - Eliminates network round-trip latency (<1ms local response vs 500-2000ms upstream).
// - Avoids burning rate limits on cosmetic or utility probes.

import { randomBytes } from 'node:crypto';

const TWO_WORD_COMMANDS = new Set([
  'git',
  'npm',
  'docker',
  'kubectl',
  'cargo',
  'go',
  'pip',
  'yarn',
  'pnpm',
  'bun',
]);

const LISTING_COMMANDS = new Set([
  'ls',
  'dir',
  'find',
  'tree',
  'pwd',
  'cd',
  'mkdir',
  'rmdir',
  'rm',
]);

const READING_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'type',
]);

/**
 * Safely parse a command line into parts, respecting quotes and escapes.
 * @param {string} command
 * @returns {string[]}
 */
export function parseCommandLine(command) {
  if (typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (!trimmed) return [];

  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * Strip leading environment assignments (e.g. VAR=val) from parsed command parts.
 * @param {string[]} parts
 * @returns {string[]}
 */
export function stripEnvAssignments(parts) {
  let start = 0;
  while (start < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(parts[start])) {
    start++;
  }
  return parts.slice(start);
}

/**
 * Extract the command prefix for fast prefix detection.
 * @param {string} command
 * @returns {string}
 */
export function extractCommandPrefix(command) {
  if (!command || typeof command !== 'string') return 'none';
  if (command.includes('`') || command.includes('$(')) {
    return 'command_injection_detected';
  }

  const parts = parseCommandLine(command);
  const cmdParts = stripEnvAssignments(parts);
  if (!cmdParts || cmdParts.length === 0) return 'none';

  const firstWord = cmdParts[0].split('/').pop().split('\\').pop();

  if (TWO_WORD_COMMANDS.has(firstWord) && cmdParts.length > 1) {
    const secondWord = cmdParts[1];
    if (!secondWord.startsWith('-')) {
      return `${firstWord} ${secondWord}`;
    }
    return firstWord;
  }

  return firstWord;
}

/**
 * Extract file paths from a command and its output locally.
 * @param {string} command
 * @param {string} _output
 * @returns {string}
 */
export function extractFilepathsFromCommand(command, _output) {
  const empty = '<filepaths>\n</filepaths>';
  if (!command || typeof command !== 'string') return empty;

  const parts = parseCommandLine(command);
  const cmdParts = stripEnvAssignments(parts);
  if (!cmdParts || cmdParts.length === 0) return empty;

  const baseCmd = cmdParts[0].split('/').pop().split('\\').pop().toLowerCase();

  if (LISTING_COMMANDS.has(baseCmd)) {
    return empty;
  }

  if (READING_COMMANDS.has(baseCmd)) {
    const flagsWithArgs = new Set(['-n', '-c', '-s', '-C']);
    const filepaths = [];
    let skipNext = false;
    for (const part of cmdParts.slice(1)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (part.startsWith('-')) {
        if (flagsWithArgs.has(part)) {
          skipNext = true;
        }
        continue;
      }
      filepaths.push(part);
    }
    if (filepaths.length > 0) {
      return `<filepaths>\n${filepaths.join('\n')}\n</filepaths>`;
    }
    return empty;
  }

  if (baseCmd === 'grep') {
    const flagsWithArgs = new Set(['-e', '-f', '-m', '-A', '-B', '-C']);
    let patternProvidedViaFlag = false;
    const positional = [];

    let skipNext = false;
    for (const part of cmdParts.slice(1)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (part.startsWith('-')) {
        if (flagsWithArgs.has(part)) {
          if (part === '-e' || part === '-f') {
            patternProvidedViaFlag = true;
          }
          skipNext = true;
        }
        continue;
      }
      positional.push(part);
    }

    const filepaths = patternProvidedViaFlag ? positional : positional.slice(1);
    if (filepaths.length > 0) {
      return `<filepaths>\n${filepaths.join('\n')}\n</filepaths>`;
    }
    return empty;
  }

  return empty;
}

/**
 * Extract plain text from message content (string or array of blocks).
 * @param {any} content
 * @returns {string}
 */
export function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'text' || typeof block.text === 'string'))
    .map((block) => block.text || '')
    .join('\n');
}

/**
 * Return the single conversational user turn, ignoring system messages.
 * @param {any[]} messages
 * @returns {any|null}
 */
export function getSingleUserTurn(messages) {
  if (!Array.isArray(messages)) return null;
  let userTurn = null;
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role !== 'user' || userTurn !== null) return null;
    userTurn = msg;
  }
  return userTurn;
}

/**
 * Extract combined system text from top-level requestBody.system or system messages.
 * @param {object} requestBody
 * @returns {string}
 */
export function getRequestSystemText(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') return '';
  const parts = [];
  if (requestBody.system) {
    const text = extractTextFromContent(requestBody.system);
    if (text) parts.push(text);
  }
  if (Array.isArray(requestBody.messages)) {
    for (const msg of requestBody.messages) {
      if (msg.role === 'system') {
        const text = extractTextFromContent(msg.content);
        if (text) parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Check if the request is a dummy quota probe.
 * @param {object} requestBody
 * @returns {boolean}
 */
export function isQuotaCheckRequest(requestBody) {
  const userTurn = getSingleUserTurn(requestBody?.messages);
  if (!userTurn || requestBody.max_tokens !== 1) return false;
  const text = extractTextFromContent(userTurn.content);
  return text.toLowerCase().includes('quota');
}

/**
 * Check if the request is a fast command prefix detection request.
 * @param {object} requestBody
 * @returns {{ matched: boolean, command: string }}
 */
export function isPrefixDetectionRequest(requestBody) {
  const userTurn = getSingleUserTurn(requestBody?.messages);
  if (!userTurn) return { matched: false, command: '' };
  const content = extractTextFromContent(userTurn.content);
  if (content.includes('<policy_spec>') && content.includes('Command:')) {
    const marker = 'Command:';
    const cmdStart = content.lastIndexOf(marker) + marker.length;
    let cmd = content.slice(cmdStart).trim();
    const endTag = cmd.indexOf('</');
    if (endTag !== -1) cmd = cmd.slice(0, endTag).trim();
    return { matched: true, command: cmd };
  }
  return { matched: false, command: '' };
}

/**
 * Check if the request is a session title generation request.
 * @param {object} requestBody
 * @returns {boolean}
 */
export function isTitleGenerationRequest(requestBody) {
  if (requestBody?.tools && requestBody.tools.length > 0) return false;
  const systemText = getRequestSystemText(requestBody).toLowerCase();
  if (!systemText.includes('title')) return false;
  return (
    systemText.includes('sentence-case title') ||
    (systemText.includes('return json') &&
      systemText.includes('field') &&
      (systemText.includes('coding session') ||
        systemText.includes('this session') ||
        systemText.includes('session')))
  );
}

/**
 * Check if the request is a suggestion mode autocomplete request.
 * @param {object} requestBody
 * @returns {boolean}
 */
export function isSuggestionModeRequest(requestBody) {
  if (!Array.isArray(requestBody?.messages)) return false;
  for (const msg of requestBody.messages) {
    if (msg.role === 'user') {
      const text = extractTextFromContent(msg.content);
      if (text.includes('[SUGGESTION MODE:')) return true;
    }
  }
  return false;
}

/**
 * Check if the request is a filepath extraction request.
 * @param {object} requestBody
 * @returns {{ matched: boolean, command: string, output: string }}
 */
export function isFilepathExtractionRequest(requestBody) {
  const userTurn = getSingleUserTurn(requestBody?.messages);
  if (!userTurn || (requestBody?.tools && requestBody.tools.length > 0)) {
    return { matched: false, command: '', output: '' };
  }
  const content = extractTextFromContent(userTurn.content);
  if (!content.includes('Command:') || !content.includes('Output:')) {
    return { matched: false, command: '', output: '' };
  }
  const userHasFilepaths =
    content.toLowerCase().includes('filepath') || content.includes('<filepaths>');
  const systemText = getRequestSystemText(requestBody).toLowerCase();
  const systemHasExtract =
    systemText.includes('extract any file paths') ||
    systemText.includes('file paths that this command');

  if (!userHasFilepaths && !systemHasExtract) {
    return { matched: false, command: '', output: '' };
  }

  const cmdIdx = content.indexOf('Command:') + 'Command:'.length;
  const outIdx = content.indexOf('Output:', cmdIdx);
  if (outIdx === -1) return { matched: false, command: '', output: '' };

  const command = content.slice(cmdIdx, outIdx).trim();
  let output = content.slice(outIdx + 'Output:'.length).trim();
  const cutIdx = output.search(/<|\n\n/);
  if (cutIdx !== -1) output = output.slice(0, cutIdx).trim();

  return { matched: true, command, output };
}

/**
 * Inspect an incoming Anthropic request body to check if it matches any fast-path optimization.
 * Returns optimization metadata or null.
 *
 * @param {object} requestBody
 * @param {object} [config]
 * @returns {{ type: string, text: string, inputTokens: number, outputTokens: number } | null}
 */
export function tryFastPathOptimization(requestBody, config = {}) {
  if (!requestBody || typeof requestBody !== 'object') return null;

  // Global toggle (default: true)
  if (config.enabled === false) return null;

  // 1. Quota probe mock
  if (config.quotaProbe !== false && isQuotaCheckRequest(requestBody)) {
    return {
      type: 'quota_probe',
      text: 'Quota check passed.',
      inputTokens: 10,
      outputTokens: 5,
    };
  }

  // 2. Prefix detection
  if (config.prefixDetection !== false) {
    const prefixReq = isPrefixDetectionRequest(requestBody);
    if (prefixReq.matched) {
      const prefix = extractCommandPrefix(prefixReq.command);
      return {
        type: 'prefix_detection',
        text: prefix,
        inputTokens: 100,
        outputTokens: 5,
      };
    }
  }

  // 3. Title generation
  if (config.titleGeneration !== false && isTitleGenerationRequest(requestBody)) {
    const systemText = getRequestSystemText(requestBody).toLowerCase();
    const isJson = systemText.includes('json');
    return {
      type: 'title_generation',
      text: isJson ? '{"title": "Coding Session"}' : 'Coding Session',
      inputTokens: 100,
      outputTokens: 5,
    };
  }

  // 4. Suggestion mode skip
  if (config.suggestionMode !== false && isSuggestionModeRequest(requestBody)) {
    return {
      type: 'suggestion_mode',
      text: '',
      inputTokens: 100,
      outputTokens: 1,
    };
  }

  // 5. Filepath extraction mock
  if (config.filepathExtraction !== false) {
    const fpReq = isFilepathExtractionRequest(requestBody);
    if (fpReq.matched) {
      const filepaths = extractFilepathsFromCommand(fpReq.command, fpReq.output);
      return {
        type: 'filepath_extraction',
        text: filepaths,
        inputTokens: 100,
        outputTokens: 10,
      };
    }
  }

  return null;
}

/**
 * Send the simulated fast-path response to the HTTP client (streaming or JSON).
 * @param {import('node:http').ServerResponse} res
 * @param {object} parsedBody
 * @param {{ type: string, text: string, inputTokens: number, outputTokens: number }} optimization
 */
export function sendFastPathResponse(res, parsedBody, optimization) {
  const isStream = parsedBody?.stream === true;
  const model = parsedBody?.model || 'claude-3-7-sonnet-20250219';
  const id = `msg_opt_${randomBytes(12).toString('hex')}`;
  const text = optimization.text;

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const emit = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    emit('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: optimization.inputTokens || 50,
          output_tokens: 1,
        },
      },
    });

    if (text) {
      emit('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });

      emit('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      });

      emit('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      });
    }

    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: optimization.outputTokens || (text ? 5 : 1) },
    });

    emit('message_stop', { type: 'message_stop' });
    res.end();
  } else {
    const payload = {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: text ? [{ type: 'text', text }] : [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: optimization.inputTokens || 50,
        output_tokens: optimization.outputTokens || (text ? 5 : 1),
      },
    };
    const bodyStr = JSON.stringify(payload);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(bodyStr),
    });
    res.end(bodyStr);
  }
}
