import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { handleAgyCompletion, parseQuotaResetSeconds } from '../src/agy-gateway.js';
import { AgyAccountStore } from '../src/agy-accounts.js';
import { createProxyServer, normalizeAnthropicModelForOAuth, normalizeCodexModelForOAuth } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { resolveTargetModel } from '../src/provider-translator.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}
function responseCapture() {
  const res = new EventEmitter();
  res.headersSent = false; res.writableEnded = false; res.statusCode = 200; res.headers = {}; res.chunks = [];
  res.writeHead = (status, headers = {}) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
  res.write = chunk => { res.headersSent = true; res.chunks.push(Buffer.from(chunk)); return true; };
  res.end = chunk => { if (chunk) res.write(chunk); res.writableEnded = true; res.emit('finish'); };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return res;
}
function fakeStore(accounts) {
  const spent = []; const stats = []; const failures = [];
  return {
    accounts,
    pick(exclude) { return accounts.find(a => !exclude.has(a.id) && !a.spent) || null; },
    markQuota(id, seconds, message) { spent.push({ id, seconds, message }); accounts.find(a => a.id === id).spent = true; },
    markFailure(id, reason) { failures.push({id, reason}); }, failures,
    recordRequest(id, usage) { stats.push({ id, ...usage }); }, spent, stats,
  };
}
function fakePool(workers) {
  const active = new Map();
  return {
    async acquire(id) { active.set(id, (active.get(id) || 0) + 1); const w = workers[id]; return { ...w, release: () => active.set(id, active.get(id) - 1) }; },
    busy(id) { return active.get(id) || 0; },
  };
}
const catalog = { resolveAlias: m => m === 'agy' ? 'gemini-real-high' : (m === 'gemini-real-high' ? m : null) };
async function run({ handlers, body = { model: 'agy', stream: true } }) {
  const servers = []; const workers = {};
  for (const [id, handler] of Object.entries(handlers)) { const x = await listen(handler); servers.push(x.server); workers[id] = { port: x.port, token: `worker-${id}` }; }
  const store = fakeStore(Object.keys(handlers).map(id => ({ id })));
  const pool = fakePool(workers); const req = new EventEmitter(); req.destroyed = false;
  const res = responseCapture();
  try { await handleAgyCompletion(req, res, { body: Buffer.from(JSON.stringify(body)), model: body.model, store, pool, catalog, usageRecorder: { onUsage() {} }, hooks: {} }); }
  finally { for (const s of servers) await new Promise(r => s.close(r)); }
  return { text: Buffer.concat(res.chunks).toString(), res, store, pool, req };
}

test('streams completion unchanged, rewrites alias, records final usage, and hides worker token', async () => {
  let received;
  const out = await run({ handlers: { a: (req, res) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ received=JSON.parse(b); res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n'); }); } } });
  assert.equal(received.model, 'gemini-real-high');
  assert.match(out.text, /content":"hi/);
  assert.deepEqual(out.store.stats, [{ id: 'a', inputTokens: 3, outputTokens: 4 }]);
  assert.doesNotMatch(out.text, /worker-a/);
});

test('HTTP 429 marks quota and retries next account', async () => {
  const out = await run({ handlers: {
    a: (_q,r) => { r.writeHead(429, {'retry-after':'7'}); r.end('{"error":{"message":"AGY quota exhausted: Resets in 1h2m3s"}}'); },
    b: (_q,r) => { r.writeHead(200); r.end('ok'); },
  }, body: { model:'gemini-real-high', stream:false } });
  assert.equal(out.text, 'ok'); assert.equal(out.store.spent[0].seconds, 3723);
});

test('in-band quota after keep-alive retries and forwards keep-alives', async () => {
  const out = await run({ handlers: {
    a: (_q,r) => { r.writeHead(200); r.end(': keep-alive\n\ndata: {"error":{"message":"AGY quota exhausted: Resets in 2d3h4m5s"}}\n\n'); },
    b: (_q,r) => { r.writeHead(200); r.end('data: success\n\n'); },
  } });
  assert.equal(out.text, ': keep-alive\n\ndata: success\n\n');
  assert.equal(out.store.spent[0].seconds, 183845);
});

test('all spent returns 429 without looping', async () => {
  let calls=0; const q=(_q,r)=>{calls++;r.writeHead(429);r.end('{"error":{"message":"AGY quota exhausted"}}');};
  const out=await run({handlers:{a:q,b:q}}); assert.equal(calls,2); assert.equal(out.res.statusCode,429); assert.match(out.text,/Brak konta AGY/);
});

test('all accounts exhausted after keep-alives returns an SSE error and DONE', async () => {
  const q=(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.end(': keep-alive\n\ndata: {"error":{"message":"AGY quota exhausted"}}\n\n');};
  const out=await run({handlers:{a:q,b:q}});
  assert.match(out.text,/^: keep-alive/m);
  assert.match(out.text,/data: \{"error":\{"type":"rate_limit_error"/);
  assert.match(out.text,/data: \[DONE\]\n\n$/);
  assert.equal(out.res.writableEnded,true);
});

test('real HTTP client promptly receives a path-free 502 when acquire rejects', async () => {
  const handler=(req,res)=>{let body=[];req.on('data',c=>body.push(c));req.on('end',()=>handleAgyCompletion(req,res,{
    body:Buffer.concat(body),model:'agy',store:fakeStore([{id:'a'}]),
    pool:{acquire:async()=>{throw new Error('agybridge worker failed to start: spawn /secret/bin/agybridge ENOENT');}},
    catalog,usageRecorder:{onUsage(){}},hooks:{},
  }));};
  const {server,port}=await listen(handler);
  try {
    const reply=await Promise.race([
      fetch(`http://127.0.0.1:${port}`,{method:'POST',body:'{"model":"agy","stream":false}'}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('client hung')),1000)),
    ]);
    assert.equal(reply.status,502);
    const text=await reply.text();
    assert.match(text,/agybridge worker failed to start/);
    assert.doesNotMatch(text,/\/secret\/bin|ENOENT/);
  } finally { await new Promise(r=>server.close(r)); }
});

test('client leaving while queued releases the late lease without calling worker', async () => {
  let resolveAcquire; let releases=0; let calls=0;
  const worker=await listen((_q,r)=>{calls++;r.end('wrong');});
  const req=new EventEmitter();req.destroyed=false;const res=responseCapture();
  const pending=handleAgyCompletion(req,res,{
    body:Buffer.from('{"model":"agy","stream":false}'),model:'agy',store:fakeStore([{id:'a'}]),
    pool:{acquire:()=>new Promise(r=>{resolveAcquire=r;})},catalog,usageRecorder:{onUsage(){}},hooks:{},
  });
  await new Promise(r=>setImmediate(r));
  res.emit('close');
  resolveAcquire({port:worker.port,token:'secret',release(){releases++;}});
  await pending;
  assert.equal(releases,1);assert.equal(calls,0);
  await new Promise(r=>worker.server.close(r));
});

for (const scenario of [
  { name: 'truncated HTTP 429', status: 429, stream: true, partial: '{"error":', truncate: true },
  { name: 'truncated JSON', status: 200, stream: false, partial: '{"choices":', truncate: true },
  { name: 'truncated SSE after keep-alive', status: 200, stream: true, partial: ': keep-alive\n\n', truncate: true },
  { name: 'stalled HTTP 429', status: 429, stream: true, partial: '{"error":', truncate: false },
]) {
  test(`${scenario.name} answers the real client and releases the slot once`, async () => {
    let releases = 0;
    const worker = await listen((_q, r) => {
      r.writeHead(scenario.status, { 'content-type': scenario.stream ? 'text/event-stream' : 'application/json' });
      r.write(scenario.partial);
      if (scenario.truncate) setImmediate(() => r.socket.destroy());
    });
    const proxy = await listen((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => handleAgyCompletion(req, res, {
        body: Buffer.concat(chunks), model: 'agy', store: fakeStore([{ id: 'a' }]), catalog,
        pool: { async acquire() { return { port: worker.port, token: 'fake-worker-token', release() { releases++; } }; } },
        attemptTimeoutMs: 100,
      }));
    });
    try {
      const reply = await fetch(`http://127.0.0.1:${proxy.port}`, {
        method: 'POST', body: JSON.stringify({ model: 'agy', stream: scenario.stream }),
        signal: AbortSignal.timeout(2000),
      });
      const text = await reply.text();
      assert.equal(reply.status, scenario.name.includes('keep-alive') ? 200 : (scenario.truncate ? 502 : 504));
      assert.match(text, scenario.truncate ? /"type":"api_error"/ : /AGY worker timed out/);
      if (scenario.name.includes('keep-alive')) assert.match(text, /data: \[DONE\]\n\n$/);
      assert.equal(releases, 1);
      assert.doesNotMatch(text, /fake-worker-token/);
    } finally {
      proxy.server.closeAllConnections(); worker.server.closeAllConnections();
      await Promise.all([new Promise(r => proxy.server.close(r)), new Promise(r => worker.server.close(r))]);
    }
  });
}

test('hung worker is aborted at injected timeout, reports 504, and releases slot', async () => {
  const worker=await listen(()=>{});let releases=0;
  const req=new EventEmitter();req.destroyed=false;const res=responseCapture();
  await handleAgyCompletion(req,res,{
    body:Buffer.from('{"model":"agy","stream":false}'),model:'agy',store:fakeStore([{id:'a'}]),
    pool:{async acquire(){return{port:worker.port,token:'secret',release(){releases++;}};}},
    catalog,usageRecorder:{onUsage(){}},hooks:{},attemptTimeoutMs:20,
  });
  assert.equal(res.statusCode,504);assert.equal(releases,1);
  assert.match(Buffer.concat(res.chunks).toString(),/timed out/);
  worker.server.closeAllConnections?.();await new Promise(r=>worker.server.close(r));
});

test('error after real content is passed through without retry', async () => {
  let second=0; const out=await run({handlers:{a:(_q,r)=>{r.writeHead(200);r.end('data: token\n\ndata: {"error":{"message":"AGY quota exhausted"}}\n\n');},b:(_q,r)=>{second++;r.end('wrong');}}});
  assert.equal(second,0); assert.match(out.text,/data: token/); assert.match(out.text,/quota exhausted/);
});

test('unknown model returns model_not_found', async () => {
  const out=await run({handlers:{a:(_q,r)=>r.end('wrong')},body:{model:'gemini-9',stream:false}}); assert.equal(out.res.statusCode,404); assert.match(out.text,/model_not_found/);
});

test('local overload rotates without recording Google quota and local auth never rotates', async () => {
  const overload = await run({handlers:{a:(_q,r)=>{r.writeHead(429);r.end('{"error":{"code":"busy"}}');},b:(_q,r)=>r.end('ok')},body:{model:'agy',stream:false}});
  assert.equal(overload.text,'ok');
  assert.equal(overload.store.spent.length,0);
  assert.deepEqual(overload.store.failures,[{id:'a',reason:'overloaded'}]);
  let second=0;
  const auth = await run({handlers:{a:(_q,r)=>{r.writeHead(401);r.end('{"error":{"message":"worker-secret"}}');},b:(_q,r)=>{second++;r.end('wrong');}},body:{model:'agy',stream:false}});
  assert.equal(second,0); assert.equal(auth.store.spent.length,0);
  assert.equal(auth.res.statusCode,503);
  assert.doesNotMatch(auth.text,/worker-secret/);
});

test('full queue returns retry-after without penalizing the Google account', async () => {
  const store=fakeStore([{id:'a'}]); const res=responseCapture(); const req=new EventEmitter();
  await handleAgyCompletion(req,res,{body:Buffer.from('{"model":"agy","stream":false}'),model:'agy',store,catalog,
    pool:{acquire:async()=>{throw Object.assign(new Error(),{code:'AGY_QUEUE_FULL'});}}});
  assert.equal(res.statusCode,503);assert.equal(res.headers['retry-after'],'5');
  assert.equal(store.spent.length,0);assert.equal(store.failures.length,0);
});

test('response close aborts upstream and releases account slot exactly once', async () => {
  const upstream=await listen(()=>{}); const store=fakeStore([{id:'a'}]);
  let releases=0; const basePool=fakePool({a:{port:upstream.port,token:'secret'}}); const pool={...basePool,async acquire(id){const lease=await basePool.acquire(id);const release=lease.release;return{...lease,release(){releases++;release();}};}};
  const req=new EventEmitter(); req.destroyed=false; const res=responseCapture();
  const pending=handleAgyCompletion(req,res,{body:Buffer.from('{"model":"agy","stream":true}'),model:'agy',store,pool,catalog,usageRecorder:{onUsage(){}},hooks:{}});
  setTimeout(()=>res.emit('close'),10);
  const released=await Promise.race([pending.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]);
  await new Promise(r=>setTimeout(r,10));
  upstream.server.closeAllConnections?.(); await new Promise(r=>upstream.server.close(r));
  assert.equal(released,true); assert.equal(pool.busy('a'),0); assert.equal(releases,1);
});

test('stream preserves a UTF-8 code point split across TCP chunks', async () => {
  const expected='data: {"choices":[{"delta":{"content":"zażółć 🙂"}}]}\n\n';
  const bytes=Buffer.from(expected); const marker=Buffer.from('🙂'); const split=bytes.indexOf(marker)+2;
  const out=await run({handlers:{a:(_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});r.write(bytes.subarray(0,split));setImmediate(()=>r.end(bytes.subarray(split)));}}});
  assert.equal(out.text,expected);
});

test('configured AGY accountsPath is used when model listing initializes AGY first', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-config-path-')); const configured=path.join(dir,'configured.json');
  fs.writeFileSync(configured,JSON.stringify({accounts:[{id:'agy-123456789abc',email:'x@example.com',enabled:true,token:{token:{refresh_token:'x'},id_token:`h.${Buffer.from(JSON.stringify({email:'x@example.com'})).toString('base64url')}.s`}}]}));
  const worker=await listen((_q,r)=>r.end('{"choices":[]}')); let acquired=null;
  const hooks={
    agyModels:{async list(){return[{id:'gemini-real-high',name:'Gemini'}];},resolveAlias(m){return m==='agy'?'gemini-real-high':m;}},
    agyPool:{async acquire(id){acquired=id;return{port:worker.port,token:'worker',release(){}};},stopAll(){}},
  };
  const server=createProxyServer(new AccountManager([]),{agy:{accountsPath:configured},proxy:{apiKey:'k',trustLoopback:false,trustTailnet:false}},hooks);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const models=await fetch(`http://127.0.0.1:${server.address().port}/v1/models`,{headers:{'x-api-key':'k'}}); assert.equal(models.status,200);
    const completion=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'x-api-key':'k','content-type':'application/json'},body:'{"model":"agy","stream":false}'});
    assert.equal(completion.status,200); assert.equal(acquired,'agy-123456789abc');
  } finally { await new Promise(r=>server.close(r)); await new Promise(r=>worker.server.close(r)); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('parseQuotaResetSeconds uses duration then Retry-After then one hour', () => {
  assert.equal(parseQuotaResetSeconds('x Resets in 93h56m25s', null),338185);
  assert.equal(parseQuotaResetSeconds('', '12'),12); assert.equal(parseQuotaResetSeconds('', null),3600);
});

test('gemini models are never silently substituted to Claude or GPT', () => {
  for (const model of ['agy', 'agy-fast', 'gemini-real-high']) {
    const body = Buffer.from(JSON.stringify({ model }));
    assert.equal(JSON.parse(normalizeAnthropicModelForOAuth(body)).model, model);
    assert.equal(JSON.parse(normalizeCodexModelForOAuth(body)).model, model);
    assert.equal(resolveTargetModel(model, 'anthropic'), model);
    assert.equal(resolveTargetModel(model, 'codex'), model);
  }
});

test('store pick honors available pinned then earliest reset and recordRequest throttles disk writes', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-store-')); const file=path.join(dir,'a.json'); let now=1000;
  const s=new AgyAccountStore(file,()=>now);
  const add = email => s.upsert({ token: {refresh_token:'test'}, id_token:`h.${Buffer.from(JSON.stringify({email})).toString('base64url')}.s` }).id;
  const x=add('x@example.com'), p=add('p@example.com'), y=add('y@example.com'), off=add('off@example.com');
  s.setUsage(x,[{label:"x",remaining:1,resetAt:5000}]); s.setUsage(y,[{label:"y",remaining:1,resetAt:3000}]); s.setEnabled(off,false); s.pin(p);
  assert.equal(s.pick(new Set()).id,p); assert.equal(s.pick(new Set([p])).id,y);
  s.recordRequest(y,{inputTokens:2,outputTokens:3}); s.recordRequest(y,{inputTokens:4,outputTokens:5}); assert.deepEqual(s._find(y).stats,{requests:2,inputTokens:6,outputTokens:8,lastAt:1000});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('Argon routing skips incompatible pinned/priority Pro accounts without consuming the retry budget', async () => {
  const { AgyAccountModelCatalog } = await import('../src/agy-models.js');
  const accounts = [{ id: 'pro1' }, { id: 'pro2' }, { id: 'ultra1' }, { id: 'ultra2' }];
  const store = fakeStore(accounts);
  const catalog = new AgyAccountModelCatalog({ accounts: () => accounts,
    homeFor: id => id, run: async id => (id.startsWith('ultra') ? 'gemini-argon-low\tArgon\n' : '') + 'gemini-flash-low\tFlash\n' });
  const worker = await listen((req, res) => {
    if (req.headers.authorization === 'Bearer ultra1') {
      res.writeHead(429); res.end('{"error":{"message":"AGY quota exhausted"}}');
    } else { res.writeHead(200); res.end('ok'); }
  });
  const acquired = [];
  const pool = { async acquire(id) { acquired.push(id); return { port: worker.port, token: id, release() {} }; } };
  const req = new EventEmitter(); req.destroyed = false;
  const res = responseCapture();
  try {
    await handleAgyCompletion(req, res, { body: Buffer.from('{"model":"gemini-argon-low","stream":false}'),
      model: 'gemini-argon-low', store, pool, catalog });
    assert.deepEqual(acquired, ['ultra1', 'ultra2']);
    assert.equal(res.statusCode, 200);
    assert.equal(Buffer.concat(res.chunks).toString(), 'ok');
    assert.equal(store.failures.some(f => f.id.startsWith('pro')), false);
  } finally { await new Promise(resolve => worker.server.close(resolve)); }
});

test('the Test button discovers models in the tested account instead of borrowing the pooled Ultra catalog', async () => {
  const { AgyAccountModelCatalog } = await import('../src/agy-models.js');
  const { testAgyAccount } = await import('../src/agy-gateway.js');
  const accounts = [{ id: 'ultra', enabled: true }, { id: 'pro', enabled: true }];
  const catalog = new AgyAccountModelCatalog({ accounts: () => accounts, homeFor: id => id,
    run: async id => (id === 'ultra' ? 'gemini-argon-low\tArgon\n' : '') + 'gemini-flash-low\tFlash\n' });
  let sentModel;
  const worker = await listen((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      sentModel = JSON.parse(body).model;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  try {
    const result = await testAgyAccount({ store: { list: () => accounts },
      pool: { acquire: async () => ({ port: worker.port, token: 'synthetic', release() {} }) }, catalog, id: 'pro' });
    assert.equal(result.ok, true);
    assert.equal(result.model, 'gemini-flash-low');
    assert.equal(sentModel, 'gemini-flash-low');
  } finally { await new Promise(resolve => worker.server.close(resolve)); }
});

test('the management API exposes model IDs separately for each Google account', async () => {
  const { AgyAccountModelCatalog } = await import('../src/agy-models.js');
  const accounts = [{ id: 'ultra', enabled: true }, { id: 'pro', enabled: true }];
  const catalog = new AgyAccountModelCatalog({ accounts: () => accounts, homeFor: id => id,
    run: async id => (id === 'ultra' ? 'gemini-argon-low\tArgon\n' : '') + 'gemini-flash-low\tFlash\n' });
  const store = { list: () => accounts, data: { pinned: 'pro' } };
  const server = createProxyServer(new AccountManager([]), { proxy: { apiKey: 'synthetic' }, agy: { checksEnabled: false } },
    { agyModels: catalog, agyStore: store, agyPool: { busy: () => 0, stopAll() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/agent-lb/api/agy/accounts`, { headers: { 'x-api-key': 'synthetic' } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.models, ['gemini-argon-low', 'gemini-flash-low']);
    assert.deepEqual(data.accounts.find(a => a.id === 'pro').modelCatalog.models, ['gemini-flash-low']);
    assert.deepEqual(data.accounts.find(a => a.id === 'ultra').modelCatalog.models, ['gemini-argon-low', 'gemini-flash-low']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const mode of ['routing', 'test']) test(`${mode} rechecks entitlements after a queued lease and never sends after account disable`, async () => {
  const { AgyAccountModelCatalog } = await import('../src/agy-models.js');
  const { testAgyAccount } = await import('../src/agy-gateway.js');
  const accounts = [{ id: 'ultra', enabled: true }];
  const catalog = new AgyAccountModelCatalog({ accounts: () => accounts, homeFor: id => id,
    run: async () => 'gemini-argon-low\tArgon\n' });
  let hits = 0; let releases = 0; let finish; let acquired;
  const started = new Promise(resolve => { acquired = resolve; });
  const worker = await listen((_req, res) => { hits++; res.end('wrong'); });
  const pool = { acquire: () => { acquired(); return new Promise(resolve => { finish = resolve; }); } };
  const store = { ...fakeStore(accounts), list: () => accounts };
  const req = new EventEmitter(); req.destroyed = false;
  const res = responseCapture();
  try {
    const pending = mode === 'test' ? testAgyAccount({ store, pool, catalog, id: 'ultra' })
      : handleAgyCompletion(req, res, { body: Buffer.from('{"model":"gemini-argon-low","stream":false}'),
        model: 'gemini-argon-low', store, pool, catalog });
    await started;
    accounts[0].enabled = false;
    finish({ port: worker.port, token: 'synthetic', release() { releases++; } });
    const result = await pending;
    assert.equal(hits, 0);
    assert.equal(releases, 1);
    if (mode === 'test') assert.equal(result.ok, false);
    else assert.equal(res.statusCode, 429);
  } finally { await new Promise(resolve => worker.server.close(resolve)); }
});
