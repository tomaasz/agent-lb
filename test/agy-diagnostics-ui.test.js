import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboardHtml } from '../src/dashboard.js';
import { handleAgyRoute } from '../src/agy-accounts.js';
import { Readable } from 'node:stream';

test('AGY pool controls render and invoke real actions without undefined helpers', () => {
 const html=renderDashboardHtml();
 const code=html.slice(html.indexOf('function renderAgyAccounts('),html.indexOf('// The routing table',html.indexOf('function renderAgyAccounts(')));
 const node=()=>({textContent:'',children:[],appendChild(n){this.children.push(n);},addEventListener(){}});
 const box=node(),buttons=[];
 const ctx={document:{getElementById:id=>id==='listAgy'?box:node(),createElement:node},agyRenaming:false,attachListDropTarget(){},t:()=>'',agyT:(pl)=>pl,agyIconButton:(label,title,fn)=>{buttons.push({label,fn});return node();},agyAction:(path,body)=>({path,body}),renderAgyCard:()=>node()};
 vm.runInNewContext(code,ctx);
 ctx.renderAgyAccounts([{id:'a'}]);
 assert.equal(buttons.length,1);
 assert.equal(buttons[0].fn(),undefined); // handler dispatches without returning payload
 assert.equal(box.children.length,3);
});

test('admin diagnostics API exposes history and controlled busy/unknown responses',async()=>{
 const dispatch=async(path,body,checks)=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=body===undefined?'GET':'POST';
  let status,payload;
  const res={writeHead:s=>{status=s;},end:s=>{payload=JSON.parse(s);}};
  await handleAgyRoute(req,res,{normApiPath:path,store:{history:()=>({batches:[],changes:[]}),snapshot:id=>id==='exists'?{}:null},checks});
  return {status,payload};
 };
 assert.equal((await dispatch('/api/agy/history')).status,200);
 assert.equal((await dispatch('/api/agy/accounts/check',{id:'missing'},{})).status,404);
 const busy=await dispatch('/api/agy/accounts/check',{id:'exists'},{run:async opts=>{assert.equal(opts.force,true);return {busy:true};}});
 assert.equal(busy.status,409); assert.equal(busy.payload.ok,false);
});
