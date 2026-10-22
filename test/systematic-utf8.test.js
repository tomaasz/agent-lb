import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAIToAnthropicTransformStream,
  createAnthropicToOpenAITransformStream,
  createCodexResponsesToOpenAITransformStream,
} from '../src/provider-translator.js';

const text = 'Zażółć gęślą jaźń 🧪 漢字';
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const cases = [
  ['OpenAI → Anthropic', createOpenAIToAnthropicTransformStream,
    data({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    events => events.filter(x => x.type === 'content_block_delta').map(x => x.delta.text).join('')],
  ['Anthropic → OpenAI', createAnthropicToOpenAITransformStream,
    data({ type: 'content_block_delta', delta: { type: 'text_delta', text } }) +
    data({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + data({ type: 'message_stop' }),
    events => events.map(x => x.choices?.[0]?.delta?.content || '').join('')],
  ['Codex → OpenAI', createCodexResponsesToOpenAITransformStream,
    data({ type: 'response.output_text.delta', delta: text }) + data({ type: 'response.completed', response: {} }),
    events => events.map(x => x.choices?.[0]?.delta?.content || '').join('')],
];

for (const [name, create, input, extract] of cases) {
  test(`${name}: every UTF-8 byte boundary preserves text`, async () => {
    const bytes = Buffer.from(input);
    for (let split = 1; split < bytes.length; split++) {
      const stream = create();
      const output = [];
      stream.on('data', chunk => output.push(chunk));
      const done = new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      stream.write(bytes.subarray(0, split));
      stream.end(bytes.subarray(split));
      await done;
      const events = Buffer.concat(output).toString().split('\n')
        .filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      assert.equal(extract(events), text, `split at byte ${split}`);
    }
  });
}
