import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexStreamLimit } from '../src/provider-translator.js';
import { peekSseHead } from '../src/stream-lifecycle.js';

const sse = (...events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

test('codexStreamLimit reads usage_limit_reached from response.failed', () => {
  const head = sse(
    { type: 'response.created', response: {} },
    { type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'spent', resets_in_seconds: 1200 } } },
  );
  assert.deepEqual(codexStreamLimit(head), { message: 'spent', resetSeconds: 1200 });
});

test('codexStreamLimit reads an error event with type usage_limit_reached', () => {
  const head = sse({ type: 'error', error: { type: 'usage_limit_reached', message: 'spent' } });
  assert.deepEqual(codexStreamLimit(head), { message: 'spent', resetSeconds: null });
});

test('codexStreamLimit ignores other failures and healthy streams', () => {
  assert.equal(codexStreamLimit(sse({ type: 'response.failed', response: { error: { code: 'server_error', message: 'x' } } })), null);
  assert.equal(codexStreamLimit(sse({ type: 'response.created', response: {} }, { type: 'response.output_text.delta', delta: 'hi' })), null);
  assert.equal(codexStreamLimit(''), null);
});

function streamOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(c) { if (i < chunks.length) c.enqueue(Buffer.from(chunks[i++])); else c.close(); },
  });
}
const drain = async (body) => {
  const out = [];
  for await (const c of body) out.push(Buffer.from(c));
  return Buffer.concat(out).toString();
};

test('peekSseHead stops at the first content event and replays everything', async () => {
  const chunks = [
    sse({ type: 'response.created', response: {} }),
    sse({ type: 'response.output_text.delta', delta: 'hi' }),
    sse({ type: 'response.completed', response: {} }),
  ];
  const { head, body } = await peekSseHead(streamOf(chunks), { waitMs: 500 });
  assert.match(head, /response\.output_text\.delta/);
  assert.equal(await drain(body), chunks.join(''));
});

test('peekSseHead surfaces a failure that follows response.created', async () => {
  const chunks = [
    sse({ type: 'response.created', response: {} }),
    sse({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'spent' } } }),
  ];
  const { head, body } = await peekSseHead(streamOf(chunks), { waitMs: 500 });
  assert.ok(codexStreamLimit(head));
  assert.equal(await drain(body), chunks.join(''));
});

test('peekSseHead gives up after waitMs and still replays', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const body0 = new ReadableStream({
    async start(c) {
      c.enqueue(Buffer.from(sse({ type: 'response.created', response: {} })));
      await gate;
      c.enqueue(Buffer.from('tail'));
      c.close();
    },
  });
  const { head, body } = await peekSseHead(body0, { waitMs: 50 });
  assert.match(head, /response\.created/);
  release();
  assert.ok((await drain(body)).endsWith('tail'));
});
