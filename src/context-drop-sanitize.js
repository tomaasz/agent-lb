// Automatic truncation and synthesis of heavy raw log dumps and tool outputs
// (Context Drop) before they are injected into the main conversation context,
// preserving prompt cache breakpoints and preventing token bloat across turns.
//
// Problem:
// In multi-turn coding sessions (Claude Code, OpenAI Codex), commands such as
// `npm test`, `git log`, `find`, compiler outputs, and stack traces can produce
// tens of thousands of characters (e.g. 20k tokens / 80k+ chars). In subsequent
// turns, re-sending this raw context repeatedly costs ~85k+ tokens over 30 turns,
// degrades prompt cache hit rates, and risks context corruption.
//
// Solution:
// Context Drop inspects incoming request payloads (Anthropic /v1/messages, Codex
// Responses API, OpenAI /v1/chat/completions) and automatically isolates and
// truncates raw log dumps exceeding `maxLogChars` to a concise head + tail
// synthesis, extracting key error signals from the omitted middle.
//
// Zero-cost hot path:
// Requests below `maxLogChars` skip JSON parsing entirely via buffer length
// check. Unmodified payloads preserve Buffer reference identity (sendBody === body)
// so downstream proxy forwarders incur zero re-serialization cost.

export const DEFAULT_CONTEXT_DROP_OPTIONS = {
  enabled: true,
  maxLogChars: 12000,    // ~3,000 tokens
  headChars: 3000,      // ~750 tokens
  tailChars: 3000,      // ~750 tokens
  preserveErrors: true,
  maxErrorLines: 6,
  truncateUserMessages: false,
};

const LOG_KEYWORD_REGEX = /\b(?:stdout|stderr|exit code|finished with exit code|err|error|warn|info|debug|trace|exception|stack trace|failed|failure|passing|npm ERR!|yarn run|build failed|test suite|assertionerror)\b/i;
const ERROR_SIGNAL_REGEX = /(?:\b(?:err|error|failed|failure|fatal|exception|panic|traceback|cannot find|assertionerror|syntaxerror|typeerror|referenceerror|errno)\b|npm ERR!)/i;

/**
 * Estimate token count from character count (~4 characters per token heuristic).
 */
export function estimateTokens(textOrLength) {
  const len = typeof textOrLength === 'number' ? textOrLength : (typeof textOrLength === 'string' ? textOrLength.length : 0);
  return Math.ceil(len / 4);
}

/**
 * Determine whether a text looks like a raw multi-line log or command dump.
 */
export function isLikelyRawLog(text, minLines = 5) {
  if (typeof text !== 'string') return false;
  const matches = text.match(/\n/g);
  if (!matches || matches.length < minLines) return false;
  if (LOG_KEYWORD_REGEX.test(text)) return true;
  return matches.length >= 20;
}

/**
 * Synthesize and truncate a single raw log string into head + synthesis banner + tail.
 */
export function synthesizeAndTruncateLog(text, options = {}) {
  const maxChars = options.maxLogChars ?? DEFAULT_CONTEXT_DROP_OPTIONS.maxLogChars;
  if (typeof text !== 'string' || text.length <= maxChars) {
    return text;
  }

  const headChars = Math.min(options.headChars ?? DEFAULT_CONTEXT_DROP_OPTIONS.headChars, Math.floor(maxChars / 2));
  const tailChars = Math.min(options.tailChars ?? DEFAULT_CONTEXT_DROP_OPTIONS.tailChars, Math.floor(maxChars / 2));

  if (text.length <= headChars + tailChars) {
    return text;
  }

  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const middle = text.slice(headChars, text.length - tailChars);
  const omittedChars = middle.length;
  const omittedLines = (middle.match(/\n/g) || []).length;

  const errorLines = [];
  if (options.preserveErrors !== false) {
    const lines = middle.split('\n');
    const maxErrors = options.maxErrorLines ?? DEFAULT_CONTEXT_DROP_OPTIONS.maxErrorLines;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed && ERROR_SIGNAL_REGEX.test(trimmed)) {
        if (!errorLines.includes(trimmed)) {
          errorLines.push(trimmed.slice(0, 240));
          if (errorLines.length >= maxErrors) break;
        }
      }
    }
  }

  let banner = `\n\n[... Context Drop: truncated ${omittedChars.toLocaleString('en-US')} chars (~${omittedLines} lines) from raw log to protect prompt cache.`;
  if (errorLines.length > 0) {
    banner += `\nKey signals from omitted segment:\n${errorLines.map(l => `  ! ${l}`).join('\n')}`;
  }
  banner += `\nPreserved head (${headChars} chars) and tail (${tailChars} chars) below ...]\n\n`;

  return head + banner + tail;
}

function shouldTruncate(text, roleOrType, options) {
  if (typeof text !== 'string') return false;
  const maxChars = options.maxLogChars ?? DEFAULT_CONTEXT_DROP_OPTIONS.maxLogChars;
  if (text.length <= maxChars) return false;

  // Tool results / function outputs are raw command output by definition
  if (roleOrType === 'tool_result' || roleOrType === 'tool' || roleOrType === 'function_call_output') {
    return true;
  }

  // User messages are truncated only if explicitly configured or if they look like raw logs
  if (roleOrType === 'user') {
    if (options.truncateUserMessages === true) return true;
    return isLikelyRawLog(text);
  }

  return false;
}

/**
 * Strip and synthesize heavy raw logs from a buffered request body across
 * Anthropic (/v1/messages), Codex Responses (/v1/responses), and OpenAI Chat (/v1/chat/completions).
 *
 * @param {Buffer} body fully-buffered request body
 * @param {string} [url] request URL to aid route detection
 * @param {string} [contentType] request Content-Type
 * @param {object} [opts] Context Drop options override
 * @returns {Buffer} original buffer if untouched, or re-serialized buffer with truncated logs
 */
export function sanitizeContextDrop(body, url, contentType, opts = {}) {
  const options = { ...DEFAULT_CONTEXT_DROP_OPTIONS, ...opts };
  if (options.enabled === false) return body;
  if (!Buffer.isBuffer(body) || body.length === 0) return body;

  // Fast path: if the whole body is smaller than maxLogChars, no log inside can exceed it
  if (body.length <= options.maxLogChars) return body;

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // Not JSON — forward untouched
  }

  if (!payload || typeof payload !== 'object') return body;

  let changed = false;

  // 1. Anthropic / standard messages array
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!message || typeof message !== 'object') continue;

      // Case 1A: Plain string content
      if (typeof message.content === 'string') {
        if (shouldTruncate(message.content, message.role, options)) {
          const truncated = synthesizeAndTruncateLog(message.content, options);
          if (truncated !== message.content) {
            message.content = truncated;
            changed = true;
          }
        }
      }
      // Case 1B: Content blocks array (tool_result, text)
      else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'tool_result') {
            if (typeof block.content === 'string') {
              if (shouldTruncate(block.content, 'tool_result', options)) {
                const truncated = synthesizeAndTruncateLog(block.content, options);
                if (truncated !== block.content) {
                  block.content = truncated;
                  changed = true;
                }
              }
            } else if (Array.isArray(block.content)) {
              for (const inner of block.content) {
                if (inner && inner.type === 'text' && typeof inner.text === 'string') {
                  if (shouldTruncate(inner.text, 'tool_result', options)) {
                    const truncated = synthesizeAndTruncateLog(inner.text, options);
                    if (truncated !== inner.text) {
                      inner.text = truncated;
                      changed = true;
                    }
                  }
                }
              }
            }
          } else if (block.type === 'text' && typeof block.text === 'string') {
            if (shouldTruncate(block.text, message.role, options)) {
              const truncated = synthesizeAndTruncateLog(block.text, options);
              if (truncated !== block.text) {
                block.text = truncated;
                changed = true;
              }
            }
          }
        }
      }
    }
  }

  // 2. Codex Responses API: input array with function_call_output
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'function_call_output' && typeof item.output === 'string') {
        if (shouldTruncate(item.output, 'function_call_output', options)) {
          const truncated = synthesizeAndTruncateLog(item.output, options);
          if (truncated !== item.output) {
            item.output = truncated;
            changed = true;
          }
        }
      } else if (item.role === 'user') {
        if (typeof item.content === 'string') {
          if (shouldTruncate(item.content, 'user', options)) {
            const truncated = synthesizeAndTruncateLog(item.content, options);
            if (truncated !== item.content) {
              item.content = truncated;
              changed = true;
            }
          }
        } else if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              if (shouldTruncate(part.text, 'user', options)) {
                const truncated = synthesizeAndTruncateLog(part.text, options);
                if (truncated !== part.text) {
                  part.text = truncated;
                  changed = true;
                }
              }
            }
          }
        }
      }
    }
  }

  if (!changed) return body;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/**
 * Measure and report token / character savings for a given raw log across N turns (Spike helper).
 */
export function measureContextDropSavings(rawText, turns = 30, options = {}) {
  const rawChars = typeof rawText === 'string' ? rawText.length : 0;
  const rawTokens = estimateTokens(rawChars);
  const truncatedText = synthesizeAndTruncateLog(rawText, options);
  const truncatedChars = truncatedText.length;
  const truncatedTokens = estimateTokens(truncatedChars);

  const charsSavedPerTurn = Math.max(0, rawChars - truncatedChars);
  const tokensSavedPerTurn = Math.max(0, rawTokens - truncatedTokens);
  const cumulativeRawTokens = rawTokens * turns;
  const cumulativeDroppedTokens = truncatedTokens * turns;
  const cumulativeTokensSaved = tokensSavedPerTurn * turns;
  const savingsPercent = rawTokens > 0 ? ((tokensSavedPerTurn / rawTokens) * 100).toFixed(1) : '0.0';

  return {
    turns,
    rawChars,
    rawTokens,
    truncatedChars,
    truncatedTokens,
    tokensSavedPerTurn,
    cumulativeRawTokens,
    cumulativeDroppedTokens,
    cumulativeTokensSaved,
    savingsPercent: parseFloat(savingsPercent),
    cacheStability: 'HIGH (prefix bounded, avoiding 20k+ token sliding window invalidations)',
  };
}
