// Bounded, observational SSE parser. It never changes the bytes sent downstream.
export function firstTokenObserver(onToken) {
  const decoder = new TextDecoder();
  let pending = '', observed = false, discarding = false;
  return chunk => {
    if (observed) return;
    pending += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      if (discarding) { discarding = false; continue; }
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      try {
        if (hasToken(JSON.parse(data))) { observed = true; pending = ''; onToken(); return; }
      } catch { /* Comments, DONE and malformed diagnostic frames aren't tokens. */ }
    }
    if (pending.length > 64 * 1024) { pending = pending.slice(-2); discarding = true; }
  };
}
function hasToken(value) {
  const text = x => typeof x === 'string' && x.length > 0;
  if (value?.type === 'content_block_delta') return ['text', 'thinking', 'partial_json'].some(k => text(value.delta?.[k]));
  if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(value?.type)) return text(value.delta);
  return value?.choices?.some(c => text(c.delta?.content) || text(c.delta?.reasoning_content) || c.delta?.tool_calls?.some(t => text(t.function?.name) || text(t.function?.arguments))) || false;
}
export function observeTokenStream(body, onToken) {
  const observe = firstTokenObserver(onToken);
  return body.pipeThrough(new TransformStream({ transform(chunk, controller) { observe(chunk); controller.enqueue(chunk); } }));
}
