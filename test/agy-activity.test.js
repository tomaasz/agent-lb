import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('AGY completion closes activity once and participates in drain tracking on success', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-activity-'));const accounts=path.join(dir,'accounts.json');
  fs.writeFileSync(accounts,JSON.stringify({accounts:[{id:'a',enabled:true,token:{token:{refresh_token:'x'}}}]}));
  const worker=await listen((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"choices":[]}');});
  const ended=[];let activeDuring=null;let server;
  const hooks={
    agyModels:{async list(){return[{id:'gemini-real-high',name:'Gemini'}];},resolveAlias(){return'gemini-real-high';}},
    agyPool:{async acquire(){activeDuring=server.__agentLbDrainState.activeRequests;return{port:worker.port,token:'worker',release(){}};},stopAll(){}},
    onRequestEnd(_id,event){ended.push(event);},
  };
  server=createProxyServer(new AccountManager([]),{agy:{accountsPath:accounts},proxy:{apiKey:'k',trustLoopback:false,trustTailnet:false}},hooks);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const reply=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'x-api-key':'k','content-type':'application/json'},body:'{"model":"agy","stream":false}'});
    assert.equal(reply.status,200);assert.equal(activeDuring,1);assert.equal(server.__agentLbDrainState.activeRequests,0);
    assert.equal(ended.length,1);assert.equal(ended[0].status,200);
  } finally {await new Promise(r=>server.close(r));await new Promise(r=>worker.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('AGY completion closes activity once with failure status', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-activity-fail-'));const accounts=path.join(dir,'accounts.json');
  fs.writeFileSync(accounts,JSON.stringify({accounts:[{id:'a',enabled:true,token:{token:{refresh_token:'x'}}}]}));
  const ended=[];
  const hooks={
    agyModels:{async list(){return[{id:'gemini-real-high',name:'Gemini'}];},resolveAlias(){return'gemini-real-high';}},
    agyPool:{async acquire(){throw new Error('spawn /secret/agybridge ENOENT');},stopAll(){}},
    onRequestEnd(_id,event){ended.push(event);},
  };
  const server=createProxyServer(new AccountManager([]),{agy:{accountsPath:accounts},proxy:{apiKey:'k',trustLoopback:false,trustTailnet:false}},hooks);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const reply=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'x-api-key':'k','content-type':'application/json'},body:'{"model":"agy","stream":false}'});
    assert.equal(reply.status,502);assert.equal(ended.length,1);assert.equal(ended[0].status,502);
  } finally {await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
