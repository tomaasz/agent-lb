export async function readControlBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a control-plane object, rejecting malformed JSON before any mutation. */
export async function readControlJson(req) {
  const body = JSON.parse(await readControlBody(req) || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid request body');
  return body;
}
