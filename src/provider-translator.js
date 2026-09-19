// Cross-Provider Protocol Translator (Claude / Anthropic <-> OpenAI / Codex).
//
// Converts between Anthropic (/v1/messages) and OpenAI (/v1/chat/completions)
// wire protocols for both request bodies and responses (streaming SSE & JSON).
// Enables seamless failover when all accounts of one provider are exhausted.

import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { sanitizeToolPairs } from './tool-pair-sanitize.js';

export const DEFAULT_FALLBACK_OPENAI_MODEL = 'gpt-4o';
export const DEFAULT_FALLBACK_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';

/**
 * Model mapping fallback from Claude to OpenAI and vice-versa.
 */
export const MODEL_FALLBACK_MAP = {
  // Claude -> OpenAI
  'claude-sonnet-5': 'gpt-5.6-sol',
  'claude-opus-5': 'gpt-6-astra',
  'claude-opus-4-6': 'gpt-6-astra',
  'claude-sonnet-4-6': 'gpt-5.6-sol',
  'claude-haiku-4-5-20251001': 'gpt-5.6-terra',
  'claude-3-5-sonnet-20241022': 'gpt-4o',
  'claude-3-5-sonnet-20240620': 'gpt-4o',
  'claude-3-7-sonnet-20250219': 'gpt-4o',
  'claude-3-opus-20240229': 'gpt-4o',
  'claude-3-5-haiku-20241022': 'gpt-4o-mini',
  'claude-3-haiku-20240307': 'gpt-4o-mini',
  // OpenAI -> Claude
  'gpt-6-astra': 'claude-opus-5',
  'gpt-6': 'claude-opus-5',
  'gpt-5.6-sol': 'claude-sonnet-5',
  'gpt-5.6': 'claude-sonnet-5',
  'gpt-5.6-terra': 'claude-haiku-4-5-20251001',
  'gpt-5.6-luna': 'claude-haiku-4-5-20251001',
  'gpt-5.5': 'claude-sonnet-4-6',
  'gpt-4o': 'claude-3-5-sonnet-20241022',
  'gpt-4o-mini': 'claude-3-5-haiku-20241022',
  'o1': 'claude-3-7-sonnet-20250219',
  'o3-mini': 'claude-3-5-sonnet-20241022',
  'agy': 'claude-sonnet-5',
  'agy-fast': 'claude-haiku-4-5-20251001',
  'gemini-3.8-flash-high': 'claude-sonnet-5',
  'gemini-3.8-flash-low': 'claude-haiku-4-5-20251001',
};

/**
 * Resolve target model during cross-provider fallback.
 */
export function resolveTargetModel(sourceModel, targetProvider) {
  if (!sourceModel) return targetProvider === 'codex' ? DEFAULT_FALLBACK_OPENAI_MODEL : DEFAULT_FALLBACK_ANTHROPIC_MODEL;
  if (targetProvider === 'anthropic' && sourceModel.startsWith('claude-')) return sourceModel;
  if (targetProvider === 'codex' && (sourceModel.startsWith('gpt-') || sourceModel.startsWith('o1') || sourceModel.startsWith('o3'))) return sourceModel;
  if (targetProvider === 'codex' && (sourceModel === 'codex' || sourceModel === 'gpt-5.6' || sourceModel === 'gpt-5')) return 'gpt-5.6-sol';
  if (targetProvider === 'codex' && sourceModel === 'codex-mini') return 'gpt-5.6-terra';
  if (targetProvider === 'codex' && (sourceModel === 'agy' || (sourceModel.startsWith('gemini-') && !sourceModel.includes('low')))) return 'gpt-5.6-sol';
  if (targetProvider === 'codex' && (sourceModel === 'agy-fast' || (sourceModel.startsWith('gemini-') && sourceModel.includes('low')))) return 'gpt-5.6-terra';
  if (targetProvider === 'anthropic' && (sourceModel === 'agy' || (sourceModel.startsWith('gemini-') && !sourceModel.includes('low')))) return 'claude-sonnet-5';
  if (targetProvider === 'anthropic' && (sourceModel === 'agy-fast' || (sourceModel.startsWith('gemini-') && sourceModel.includes('low')))) return 'claude-haiku-4-5-20251001';
  if (MODEL_FALLBACK_MAP[sourceModel]) return MODEL_FALLBACK_MAP[sourceModel];
  if (targetProvider === 'codex') {
    if (sourceModel.includes('haiku')) return 'gpt-4o-mini';
    return DEFAULT_FALLBACK_OPENAI_MODEL;
  }
  if (sourceModel.includes('mini')) return 'claude-haiku-4-5-20251001';
  return DEFAULT_FALLBACK_ANTHROPIC_MODEL;
}

/**
 * Translate Anthropic /v1/messages request body to OpenAI /v1/chat/completions format.
 */
export function translateAnthropicToOpenAI(body, targetModel = null) {
  const json = typeof body === 'string' ? JSON.parse(body) : (Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body);
  const out = {
    model: targetModel || resolveTargetModel(json.model, 'codex'),
    messages: [],
  };

  if (json.stream != null) out.stream = !!json.stream;
  if (json.max_tokens != null) out.max_tokens = json.max_tokens;
  if (json.temperature != null) out.temperature = json.temperature;

  // System prompt
  if (json.system) {
    let systemText = '';
    if (typeof json.system === 'string') {
      systemText = json.system;
    } else if (Array.isArray(json.system)) {
      systemText = json.system.map(b => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n\n');
    }
    if (systemText) {
      out.messages.push({ role: 'system', content: systemText });
    }
  }

  // Messages
  if (Array.isArray(json.messages)) {
    for (const msg of json.messages) {
      if (!msg) continue;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      if (typeof msg.content === 'string') {
        out.messages.push({ role, content: msg.content });
        continue;
      }

      if (Array.isArray(msg.content)) {
        let textParts = [];
        let toolCalls = [];

        for (const block of msg.content) {
          if (!block) continue;
          if (block.type === 'text') {
            if (block.text) textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
              },
            });
          } else if (block.type === 'tool_result') {
            // First flush any accumulated text for user
            if (textParts.length > 0) {
              out.messages.push({ role: 'user', content: textParts.join('\n') });
              textParts = [];
            }
            let resContent = '';
            if (typeof block.content === 'string') {
              resContent = block.content;
            } else if (Array.isArray(block.content)) {
              resContent = block.content.map(b => (b && b.text ? b.text : JSON.stringify(b))).join('\n');
            } else if (block.content != null) {
              resContent = JSON.stringify(block.content);
            }
            out.messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: resContent,
            });
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          const m = { role };
          if (textParts.length > 0) m.content = textParts.join('\n');
          if (toolCalls.length > 0) m.tool_calls = toolCalls;
          out.messages.push(m);
        }
      }
    }
  }

  // Tools
  if (Array.isArray(json.tools) && json.tools.length > 0) {
    out.tools = json.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || undefined,
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  return Buffer.from(JSON.stringify(out), 'utf8');
}

/**
 * Translate OpenAI chat completion JSON response to Anthropic message format.
 */
export function translateOpenAIToAnthropicResponse(openaiJson, requestedModel = 'claude-3-5-sonnet-20241022') {
  const json = typeof openaiJson === 'string' ? JSON.parse(openaiJson) : (Buffer.isBuffer(openaiJson) ? JSON.parse(openaiJson.toString('utf8')) : openaiJson);
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        parsedArgs = { raw: tc.function?.arguments };
      }
      content.push({
        type: 'tool_use',
        id: tc.id || `call_${randomUUID().slice(0, 8)}`,
        name: tc.function?.name || 'unknown_tool',
        input: parsedArgs,
      });
    }
  }

  let stopReason = 'end_turn';
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
  else if (choice.finish_reason === 'stop') stopReason = 'end_turn';

  const out = {
    id: `msg_${(json.id || randomUUID()).replace(/^chatcmpl-/, '')}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };

  return out;
}

/**
 * Creates a Transform stream converting OpenAI SSE chunks into Anthropic SSE events.
 */
export function createOpenAIToAnthropicTransformStream(requestedModel = 'claude-3-5-sonnet-20241022') {
  let buffer = '';
  let msgStarted = false;
  let textStarted = false;
  let activeToolIndex = -1;
  let totalOutputTokens = 0;
  const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();

        if (dataStr === '[DONE]') {
          // Stream completed
          if (textStarted) {
            this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
            textStarted = false;
          }
          if (activeToolIndex >= 0) {
            this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${activeToolIndex}}\n\n`);
            activeToolIndex = -1;
          }
          this.push(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${totalOutputTokens}}}\n\n`);
          this.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          continue;
        }

        try {
          const payload = JSON.parse(dataStr);
          const choice = payload.choices?.[0];
          if (!choice) continue;

          if (!msgStarted) {
            msgStarted = true;
            this.push(`event: message_start\ndata: {"type":"message_start","message":{"id":"${msgId}","type":"message","role":"assistant","content":[],"model":"${requestedModel}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`);
          }

          const delta = choice.delta;
          if (!delta) continue;

          // Text content delta
          if (delta.content != null && delta.content !== '') {
            if (!textStarted) {
              textStarted = true;
              this.push(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
            }
            totalOutputTokens += Math.max(1, Math.ceil(delta.content.length / 4));
            const deltaEvt = {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta.content },
            };
            this.push(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvt)}\n\n`);
          }

          // Tool call delta
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 1;
              if (activeToolIndex !== idx) {
                if (textStarted) {
                  this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
                  textStarted = false;
                }
                activeToolIndex = idx;
                const startEvt = {
                  type: 'content_block_start',
                  index: idx,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id || `call_${randomUUID().slice(0, 8)}`,
                    name: tc.function?.name || '',
                    input: {},
                  },
                };
                this.push(`event: content_block_start\ndata: ${JSON.stringify(startEvt)}\n\n`);
              }

              if (tc.function?.arguments) {
                totalOutputTokens += Math.max(1, Math.ceil(tc.function.arguments.length / 4));
                const argEvt = {
                  type: 'content_block_delta',
                  index: idx,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                };
                this.push(`event: content_block_delta\ndata: ${JSON.stringify(argEvt)}\n\n`);
              }
            }
          }

          // Finish reason
          if (choice.finish_reason) {
            let stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn');
            if (textStarted) {
              this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
              textStarted = false;
            }
            if (activeToolIndex >= 0) {
              this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${activeToolIndex}}\n\n`);
              activeToolIndex = -1;
            }
            this.push(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":${totalOutputTokens}}}\n\n`);
            this.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          }
        } catch {
          // Incomplete or non-JSON data line, pass through
        }
      }
      callback();
    },
    flush(callback) {
      if (textStarted) {
        this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
      }
      if (activeToolIndex >= 0) {
        this.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${activeToolIndex}}\n\n`);
      }
      if (msgStarted) {
        this.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      }
      callback();
    },
  });
}

/**
 * Translate OpenAI /v1/chat/completions request body to Anthropic /v1/messages format.
 */
export function translateOpenAIToAnthropic(body, targetModel = null) {
  const json = typeof body === 'string' ? JSON.parse(body) : (Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body);
  const out = {
    model: targetModel || resolveTargetModel(json.model, 'anthropic'),
    messages: [],
    max_tokens: json.max_tokens || json.max_completion_tokens || 4096,
  };

  if (json.stream != null) out.stream = !!json.stream;
  if (json.temperature != null) out.temperature = json.temperature;

  const systemTexts = [];
  if (Array.isArray(json.messages)) {
    for (const msg of json.messages) {
      if (!msg) continue;
      if (msg.role === 'system' || msg.role === 'developer') {
        if (typeof msg.content === 'string') {
          systemTexts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && typeof part.text === 'string') systemTexts.push(part.text);
          }
        }
      } else if (msg.role === 'user') {
        const userBlocks = [];
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          userBlocks.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue;
            if (typeof part === 'string' && part.length > 0) {
              userBlocks.push({ type: 'text', text: part });
            } else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
              userBlocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_url' && part.image_url?.url) {
              const url = part.image_url.url;
              const m = url.match(/^data:([^;]+);base64,(.+)$/);
              if (m) {
                userBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: m[1],
                    data: m[2],
                  },
                });
              }
            } else if (part.type === 'tool_result') {
              userBlocks.push(part);
            }
          }
        }
        const lastMsg = out.messages[out.messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = lastMsg.content.length > 0 ? [{ type: 'text', text: lastMsg.content }] : [];
          } else if (!Array.isArray(lastMsg.content)) {
            lastMsg.content = [];
          }
          if (userBlocks.length > 0) {
            lastMsg.content.push(...userBlocks);
          }
        } else {
          out.messages.push({
            role: 'user',
            content: userBlocks.length > 0 ? userBlocks : (typeof msg.content === 'string' ? msg.content : ''),
          });
        }
      } else if (msg.role === 'assistant') {
        const contentBlocks = [];
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          contentBlocks.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue;
            if (typeof part === 'string' && part.length > 0) {
              contentBlocks.push({ type: 'text', text: part });
            } else if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
              contentBlocks.push({ type: 'text', text: part.text });
            }
          }
        }

        const toolCalls = Array.isArray(msg.tool_calls) ? [...msg.tool_calls] : [];
        if (msg.function_call && typeof msg.function_call === 'object') {
          toolCalls.push({
            id: msg.function_call.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            type: 'function',
            function: msg.function_call,
          });
        }

        for (const tc of toolCalls) {
          if (!tc) continue;
          const fn = tc.function || tc;
          let input = {};
          const rawArgs = fn.arguments;
          if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
            try {
              input = JSON.parse(rawArgs);
            } catch {
              input = { raw: rawArgs };
            }
          } else if (rawArgs && typeof rawArgs === 'object') {
            input = rawArgs;
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: fn.name || 'unknown_tool',
            input: (input && typeof input === 'object' && !Array.isArray(input)) ? input : {},
          });
        }

        const lastMsg = out.messages[out.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          const prevBlocks = Array.isArray(lastMsg.content)
            ? lastMsg.content
            : (typeof lastMsg.content === 'string' && lastMsg.content.length > 0 ? [{ type: 'text', text: lastMsg.content }] : []);
          lastMsg.content = [...prevBlocks, ...contentBlocks];
        } else {
          out.messages.push({
            role: 'assistant',
            content: contentBlocks.length > 0 ? contentBlocks : (typeof msg.content === 'string' ? msg.content : ''),
          });
        }
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let resultContent = '';
        if (typeof msg.content === 'string') {
          resultContent = msg.content;
        } else if (msg.content != null) {
          resultContent = JSON.stringify(msg.content);
        }
        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || msg.id || '',
          content: resultContent,
        };
        if (msg.is_error) {
          toolResultBlock.is_error = true;
        }
        const lastMsg = out.messages[out.messages.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = lastMsg.content.length > 0 ? [{ type: 'text', text: lastMsg.content }] : [];
          } else if (!Array.isArray(lastMsg.content)) {
            lastMsg.content = [];
          }
          lastMsg.content.push(toolResultBlock);
        } else {
          out.messages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      }
    }
  }

  // Anthropic requires the first message to have role 'user'
  if (out.messages.length > 0 && out.messages[0].role !== 'user') {
    out.messages.unshift({
      role: 'user',
      content: 'Hello',
    });
  }

  if (systemTexts.length > 0) {
    out.system = systemTexts.join('\n\n');
  }

  // Tools
  if (Array.isArray(json.tools) && json.tools.length > 0) {
    out.tools = json.tools.map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || undefined,
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    });
  }

  // Tool choice
  if (json.tool_choice) {
    if (json.tool_choice === 'auto') {
      out.tool_choice = { type: 'auto' };
    } else if (json.tool_choice === 'none') {
      delete out.tools;
    } else if (json.tool_choice === 'required') {
      out.tool_choice = { type: 'any' };
    } else if (typeof json.tool_choice === 'object') {
      const fnName = json.tool_choice.function?.name || json.tool_choice.name;
      if (fnName) {
        out.tool_choice = { type: 'tool', name: fnName };
      }
    }
  }

  const rawBuf = Buffer.from(JSON.stringify(out), 'utf8');
  return sanitizeToolPairs(rawBuf, '/v1/messages', 'application/json');
}

/**
 * Translate Anthropic /v1/messages JSON response to OpenAI /v1/chat/completions format.
 */
export function translateAnthropicToOpenAIResponse(anthropicJson, requestedModel = 'gpt-4o') {
  const json = typeof anthropicJson === 'string' ? JSON.parse(anthropicJson) : (Buffer.isBuffer(anthropicJson) ? JSON.parse(anthropicJson.toString('utf8')) : anthropicJson);

  let content = '';
  const toolCalls = [];

  if (Array.isArray(json.content)) {
    for (const block of json.content) {
      if (!block) continue;
      if (block.type === 'text') {
        content += block.text || '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: {
            name: block.name || 'unknown_tool',
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
          },
        });
      }
    }
  }

  let finishReason = 'stop';
  if (json.stop_reason === 'tool_use') finishReason = 'tool_calls';
  else if (json.stop_reason === 'max_tokens') finishReason = 'length';
  else if (json.stop_reason === 'end_turn') finishReason = 'stop';

  const message = {
    role: 'assistant',
    content: content || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${(json.id || randomUUID()).replace(/^msg_/, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: json.usage?.input_tokens || 0,
      completion_tokens: json.usage?.output_tokens || 0,
      total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
    },
  };
}

/**
 * Creates a Transform stream converting Anthropic SSE chunks into OpenAI SSE events.
 */
export function createAnthropicToOpenAITransformStream(requestedModel = 'gpt-4o') {
  let buffer = '';
  const chunkId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const created = Math.floor(Date.now() / 1000);
  let firstChunk = true;

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const payload = JSON.parse(dataStr);
          if (payload.type === 'content_block_delta' && payload.delta) {
            if (payload.delta.type === 'text_delta' && payload.delta.text) {
              const deltaObj = { content: payload.delta.text };
              if (firstChunk) {
                deltaObj.role = 'assistant';
                firstChunk = false;
              }
              const sseChunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [{ index: 0, delta: deltaObj, finish_reason: null }],
              };
              this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
            } else if (payload.delta.type === 'input_json_delta' && payload.delta.partial_json) {
              const sseChunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: payload.index || 0,
                      function: { arguments: payload.delta.partial_json },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
            }
          } else if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
            const sseChunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: payload.index || 0,
                    id: payload.content_block.id,
                    type: 'function',
                    function: { name: payload.content_block.name, arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            };
            this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
          } else if (payload.type === 'message_delta') {
            let finishReason = 'stop';
            if (payload.delta?.stop_reason === 'tool_use') finishReason = 'tool_calls';
            else if (payload.delta?.stop_reason === 'max_tokens') finishReason = 'length';
            const sseChunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            };
            this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
          } else if (payload.type === 'message_stop') {
            this.push('data: [DONE]\n\n');
          }
        } catch {
          // pass through non-JSON
        }
      }
      callback();
    },
    flush(callback) {
      this.push('data: [DONE]\n\n');
      callback();
    },
  });
}

/**
 * Translate OpenAI Chat Completions request body to Codex Responses API format.
 */
export function translateChatCompletionsToCodexResponses(body, targetModel = 'gpt-5.6-sol') {
  const json = typeof body === 'string' ? JSON.parse(body) : (Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body);
  let effectiveModel = targetModel || json.model || 'gpt-5.6-sol';
  if (effectiveModel === 'codex' || effectiveModel === 'gpt-5.6' || effectiveModel === 'gpt-5' || effectiveModel === 'agy') {
    effectiveModel = 'gpt-5.6-sol';
  } else if (effectiveModel === 'codex-mini' || effectiveModel === 'agy-fast') {
    effectiveModel = 'gpt-5.6-terra';
  } else if (effectiveModel === 'gpt-6') {
    effectiveModel = 'gpt-6-astra';
  }

  const input = [];
  if (Array.isArray(json.messages)) {
    for (const msg of json.messages) {
      if (!msg) continue;

      // Tool response message
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id || '',
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
        });
        continue;
      }

      const role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');

      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map(b => (b && typeof b.text === 'string' ? b.text : ''))
          .filter(Boolean)
          .join('\n');
      }

      if (text) {
        input.push({
          role,
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
        });
      }

      // Tool calls made by assistant
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc) continue;
          input.push({
            type: 'function_call',
            call_id: tc.id || `call_${randomUUID().slice(0, 8)}`,
            name: tc.function?.name || '',
            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
          });
        }
      }
    }
  }

  const out = {
    model: effectiveModel,
    store: false,
    stream: true,
    input
  };

  // Tools
  if (Array.isArray(json.tools) && json.tools.length > 0) {
    out.tools = json.tools.map(t => {
      if (t.type === 'function' && t.function) {
        return {
          type: 'function',
          name: t.function.name,
          description: t.function.description || undefined,
          parameters: t.function.parameters || { type: 'object', properties: {} }
        };
      }
      return t;
    });
  }

  // Reasoning effort
  const effort = json.reasoning_effort || json.reasoningEffort || json.reasoning?.effort;
  if (typeof effort === 'string' && effort.trim()) {
    out.reasoning = { effort: effort.trim().toLowerCase() };
  }

  return Buffer.from(JSON.stringify(out), 'utf8');
}

/**
 * Creates a Transform stream converting Codex Responses SSE events into OpenAI Chat Completion chunks.
 */
export function createCodexResponsesToOpenAITransformStream(requestedModel = 'gpt-5.6-sol', onUsage = null) {
  let buffer = '';
  let chunkId = null;
  let created = Math.floor(Date.now() / 1000);
  let firstChunk = true;
  let doneSent = false;
  let hasToolCalls = false;
  let activeToolIndex = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const payload = JSON.parse(dataStr);
          if (payload.type === 'response.created' && payload.response) {
            if (payload.response.id) {
              chunkId = `chatcmpl-${payload.response.id.replace(/^resp_/, '')}`;
            }
            if (payload.response.created_at) {
              created = payload.response.created_at;
            }
          } else if (payload.type === 'response.output_text.delta' && payload.delta != null) {
            chunkId ??= `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const deltaObj = firstChunk
              ? { role: 'assistant', content: payload.delta }
              : { content: payload.delta };
            firstChunk = false;
            const sseChunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{ index: 0, delta: deltaObj, finish_reason: null }]
            };
            this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
          } else if (payload.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
            hasToolCalls = true;
            chunkId ??= `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const idx = payload.output_index ?? activeToolIndex++;
            const deltaObj = {
              tool_calls: [{
                index: idx,
                id: payload.item.call_id || payload.item.id || `call_${randomUUID().slice(0, 8)}`,
                type: 'function',
                function: { name: payload.item.name || '', arguments: '' }
              }]
            };
            if (firstChunk) {
              deltaObj.role = 'assistant';
              firstChunk = false;
            }
            const sseChunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{
                index: 0,
                delta: deltaObj,
                finish_reason: null
              }]
            };
            this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
          } else if (payload.type === 'response.function_call_arguments.delta' && payload.delta != null) {
            hasToolCalls = true;
            chunkId ??= `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const idx = payload.output_index ?? Math.max(0, activeToolIndex - 1);
            const sseChunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: idx,
                    function: { arguments: payload.delta }
                  }]
                },
                finish_reason: null
              }]
            };
            this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
          } else if (payload.type === 'response.completed') {
            if (payload.response?.id) {
              chunkId = `chatcmpl-${payload.response.id.replace(/^resp_/, '')}`;
            }
            chunkId ??= `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
            const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
            const sseChunk = {
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            };
            if (payload.response?.usage) {
              const u = payload.response.usage;
              const inTok = u.input_tokens || 0;
              const outTok = u.output_tokens || 0;
              sseChunk.usage = {
                prompt_tokens: inTok,
                completion_tokens: outTok,
                total_tokens: inTok + outTok
              };
              if (onUsage) {
                try { onUsage(u); } catch {}
              }
            }
            this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);
            this.push('data: [DONE]\n\n');
            doneSent = true;
          }
        } catch {
          // pass through non-JSON
        }
      }
      callback();
    },
    flush(callback) {
      if (!doneSent) {
        this.push('data: [DONE]\n\n');
      }
      callback();
    }
  });
}

/**
 * Translates Codex Responses API buffered stream or JSON into an OpenAI Chat Completion response object.
 */
export function translateCodexResponsesToOpenAIResponse(buffer, requestedModel = 'gpt-5.6-sol') {
  const text = typeof buffer === 'string' ? buffer : (Buffer.isBuffer(buffer) ? buffer.toString('utf8') : JSON.stringify(buffer));
  let id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let created = Math.floor(Date.now() / 1000);
  let content = '';
  const toolCallsMap = new Map();
  let usage = null;
  let hasTools = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === '[DONE]') continue;
    try {
      const payload = JSON.parse(dataStr);
      if (payload.type === 'response.created' && payload.response) {
        if (payload.response.id) id = `chatcmpl-${payload.response.id.replace(/^resp_/, '')}`;
        if (payload.response.created_at) created = payload.response.created_at;
      } else if (payload.type === 'response.output_text.delta' && payload.delta) {
        content += payload.delta;
      } else if (payload.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
        hasTools = true;
        const idx = payload.output_index ?? toolCallsMap.size;
        toolCallsMap.set(idx, {
          id: payload.item.call_id || payload.item.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: { name: payload.item.name || '', arguments: '' }
        });
      } else if (payload.type === 'response.function_call_arguments.delta' && payload.delta) {
        hasTools = true;
        const idx = payload.output_index ?? Math.max(0, toolCallsMap.size - 1);
        const existing = toolCallsMap.get(idx);
        if (existing) existing.function.arguments += payload.delta;
      } else if (payload.type === 'response.completed' && payload.response?.usage) {
        usage = payload.response.usage;
      }
    } catch {}
  }

  const toolCalls = Array.from(toolCallsMap.values());
  const inTokens = usage?.input_tokens || 0;
  const outTokens = usage?.output_tokens || 0;

  return {
    id,
    object: 'chat.completion',
    created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        },
        finish_reason: hasTools ? 'tool_calls' : 'stop'
      }
    ],
    usage: {
      prompt_tokens: inTokens,
      completion_tokens: outTokens,
      total_tokens: inTokens + outTokens,
      input_tokens: inTokens,
      output_tokens: outTokens
    }
  };
}



