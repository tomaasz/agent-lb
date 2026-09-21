// Tool Call Deduplication & Replay Safety (issue inspired by codex-lb).
//
// When Claude Code, Codex CLI, or automated agents (Hermes) experience network
// dropouts, SSE disconnects, or client-side retry loops, they frequently replay
// the previous turn's request.
//
// If that request contained side-effect tool calls (e.g. file edits, patch
// applications, or terminal command executions), executing them a second time
// can corrupt source code, create duplicate files, or fail with git conflicts.
//
// This module provides:
// 1. Classification of tool calls into idempotent reads vs side-effect operations.
// 2. An in-memory bounded LRU / TTL cache tracking recently executed tool-use IDs.
// 3. Inspection of incoming /v1/messages and /backend-api/codex request bodies to
//    flag or prevent duplicate side-effect execution.

import { createHash } from 'node:crypto';

// Common side-effect tool names used across Claude Code, Codex CLI, and agent frameworks.
export const SIDE_EFFECT_TOOLS = new Set([
  'apply_patch',
  'patch',
  'edit_file',
  'write_file',
  'create_file',
  'delete_file',
  'replace_file_content',
  'bash',
  'execute_command',
  'run_command',
  'terminal',
  'notebook_edit',
  'write_to_file',
]);

export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_MAX_CACHE_SIZE = 1024;

/**
 * Check if a tool name represents an operation with persistent side effects.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isSideEffectTool(toolName) {
  if (!toolName || typeof toolName !== 'string') return false;
  const normalized = toolName.trim().toLowerCase();
  if (SIDE_EFFECT_TOOLS.has(normalized)) return true;
  // Substring checks for custom agent tools like "run_bash_command" or "custom_apply_patch"
  return normalized.endsWith('_patch') || normalized.startsWith('edit_') || normalized.startsWith('write_');
}

/**
 * Compute a deterministic digest of tool input parameters.
 * @param {any} input
 * @returns {string}
 */
export function digestArgs(input) {
  if (!input) return '';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return createHash('sha256').update(s).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/**
 * LRU + TTL cache of side-effect tool executions.
 */
export class ToolCallDedupeCache {
  constructor({
    ttlMs = DEFAULT_DEDUPE_TTL_MS,
    maxSize = DEFAULT_MAX_CACHE_SIZE,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    /** @type {Map<string, { seenAt: number, toolName: string }>} */
    this.cache = new Map();
  }

  _makeKey(sessionId, toolId, toolName, argDigest = '') {
    return `${sessionId || 'global'}::${toolName}::${toolId}::${argDigest}`;
  }

  _cleanupExpired(now) {
    for (const [k, v] of this.cache.entries()) {
      if (now - v.seenAt > this.ttlMs) {
        this.cache.delete(k);
      }
    }
  }

  /**
   * Record a tool execution.
   * @param {string} sessionId
   * @param {string} toolId
   * @param {string} toolName
   * @param {any} [args]
   * @param {number} [now]
   */
  record(sessionId, toolId, toolName, args, now = Date.now()) {
    if (!isSideEffectTool(toolName) || !toolId) return;

    if (this.cache.size >= this.maxSize) {
      this._cleanupExpired(now);
      if (this.cache.size >= this.maxSize) {
        // Drop the oldest entry
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
    }

    const key = this._makeKey(sessionId, toolId, toolName, digestArgs(args));
    this.cache.set(key, { seenAt: now, toolName });
  }

  /**
   * Check if a tool execution was already recorded within the TTL.
   * @param {string} sessionId
   * @param {string} toolId
   * @param {string} toolName
   * @param {any} [args]
   * @param {number} [now]
   * @returns {boolean}
   */
  isDuplicate(sessionId, toolId, toolName, args, now = Date.now()) {
    if (!isSideEffectTool(toolName) || !toolId) return false;

    const key = this._makeKey(sessionId, toolId, toolName, digestArgs(args));
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (now - entry.seenAt > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Inspect a request body for a replayed side-effect tool call.
   *
   * Only the LATEST assistant turn is examined. Every request of a
   * conversation re-sends the whole history, so every earlier tool call is
   * legitimately present again on every later turn; inspecting all of them
   * flagged each turn of every session as a "replay". What a genuine replay
   * repeats is the newest turn: the tool call the client has just executed,
   * sent again after a request carrying it already succeeded.
   * @param {any} body - Parsed JSON request body
   * @param {string} [sessionId]
   * @param {number} [now]
   * @returns {{ hasDuplicate: boolean, duplicates: Array<{ id: string, name: string }> }}
   */
  inspectRequest(body, sessionId = '', now = Date.now()) {
    const duplicates = [];
    for (const call of latestToolCalls(body)) {
      if (this.isDuplicate(sessionId, call.id, call.name, call.args, now)) {
        duplicates.push({ id: call.id, name: call.name });
      }
    }
    return { hasDuplicate: duplicates.length > 0, duplicates };
  }

  /**
   * Record the latest assistant turn's side-effect tool calls once a request
   * carrying them has succeeded — the counterpart of inspectRequest.
   * @param {any} body - Parsed JSON request body
   * @param {string} [sessionId]
   * @param {number} [now]
   */
  recordRequest(body, sessionId = '', now = Date.now()) {
    for (const call of latestToolCalls(body)) this.record(sessionId, call.id, call.name, call.args, now);
  }
}

/**
 * Tool calls of the last assistant message in an Anthropic (`tool_use`
 * blocks) or OpenAI (`tool_calls`) request body, as { id, name, args }.
 */
export function latestToolCalls(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let last = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { last = messages[i]; break; }
  }
  if (!last) return [];
  const calls = [];
  if (Array.isArray(last.content)) {
    for (const block of last.content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
        calls.push({ id: block.id, name: block.name, args: block.input });
      }
    }
  }
  if (Array.isArray(last.tool_calls)) {
    for (const call of last.tool_calls) {
      const name = call?.function?.name || call?.name;
      if (typeof name === 'string' && typeof call?.id === 'string') {
        calls.push({ id: call.id, name, args: call.function?.arguments });
      }
    }
  }
  return calls;
}
