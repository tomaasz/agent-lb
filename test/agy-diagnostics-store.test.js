import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAccountStore } from '../src/agy-accounts.js';
const token = email => ({token:{refresh_token:'test'},id_token_email:email});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'agy-diagnostics-store-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'a.json');
  return { path, store: new AgyAccountStore(path) };
}
test('CAS discards old results after relogin and deletion; private durable history',t=>{
  const {path,store:s}=fixture(t); const a=s.upsert(token('a@example.com'));
  const old=s.snapshot(a.id); const second=new AgyAccountStore(path);
  second.upsert(token('a@example.com'));
  assert.equal(s.applyDiagnostics(a.id,old.version,{status:'forbidden'}),false);
  const fresh=s.snapshot(a.id);
  const batch=s.beginBatch('manual'); assert.equal(second.beginBatch('manual'),null);
  assert.equal(s.applyDiagnostics(a.id,fresh.version,{status:'available',checkedAt:100,telemetry:{plan:{observedAt:100,data:{tierId:'free-tier',projectId:null}}}}),true);
  s.finishBatch(batch,{checked:1});
  assert.equal(new AgyAccountStore(path).history().batches[0].checked,1);
  assert.equal(statSync(path).mode&0o777,0o600);
  second.remove(a.id); assert.equal(s.applyDiagnostics(a.id,fresh.version,{status:'available'}),false);
  assert.equal(s.list().length,0);
});
test('failed measurements retain timestamps, changed context drops previous quotas',t=>{
 const {store:s}=fixture(t); const a=s.upsert(token('a@example.com')); const v=s.snapshot(a.id).version;
 const plan=tierId=>({observedAt:100,data:{tierId,projectId:null}});
 s.applyDiagnostics(a.id,v,{status:'available',checkedAt:100,telemetry:{plan:plan('free-tier'),models:{observedAt:100,data:[]},quotaSummary:{observedAt:100,data:[]}}});
 s.applyDiagnostics(a.id,v,{status:'error',checkedAt:200,telemetry:{}});
 assert.equal(s.list()[0].diagnostics.telemetry.models.observedAt,100);
 assert.equal(s.list()[0].diagnostics.telemetry.models.stale,true);
 s.applyDiagnostics(a.id,v,{status:'available',checkedAt:300,telemetry:{plan:plan('g1-pro-tier')}});
 assert.equal(s.list()[0].diagnostics.telemetry.models,undefined);
});
test('stale mutations preserve other process updates and corrupt files survive',t=>{
 const {path,store:s}=fixture(t); const a=s.upsert(token('a@example.com')); const other=new AgyAccountStore(path);
 const b=s.upsert(token('b@example.com')); other.rename(a.id,'hello');
 assert.equal(s.list().length,2); other.markSeeded(a.id); assert.ok(s.snapshot(b.id));
 writeFileSync(path,'{broken'); assert.throws(()=>s.setEnabled(a.id,false));
 assert.equal(readFileSync(path,'utf8'),'{broken');
});
test('confirmed restrictions survive transport failure until positive check or relogin',t=>{
 const {store:s}=fixture(t); const a=s.upsert(token('a@example.com')); const v=s.snapshot(a.id).version;
 s.applyDiagnostics(a.id,v,{status:'subscription_required',checkedAt:100,checks:{models:{status:'available'}},telemetry:{}});
 assert.equal(s.select(),null);
 s.applyDiagnostics(a.id,v,{status:'error',checkedAt:200,telemetry:{}});
 assert.equal(s.pick(),null);
 s.applyDiagnostics(a.id,v,{status:'available',checkedAt:300,telemetry:{}});
 assert.equal(s.pick().id,a.id);
});
test('pending request counters merge with external changes exactly once',t=>{
 const {path,store:s}=fixture(t); s.now=()=>1000;
 const a=s.upsert(token('a@example.com')); const other=new AgyAccountStore(path,()=>1000);
 s.recordRequest(a.id,{inputTokens:2,outputTokens:3});
 other.rename(a.id,'renamed');
 assert.equal(s.list()[0].stats.requests,1);
 s.setEnabled(a.id,false);
 assert.equal(new AgyAccountStore(path).list()[0].stats.requests,1);
 assert.equal(s.list()[0].name,'renamed');
 s.recordRequest(a.id,{inputTokens:4});
 s.setEnabled(a.id,true);
 assert.equal(new AgyAccountStore(path).list()[0].stats.requests,2);
 clearTimeout(s.statsSaveTimer);
});
