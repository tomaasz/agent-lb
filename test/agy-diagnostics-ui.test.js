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
 const ctx={document:{getElementById:id=>id==='listAgy'?box:node(),createElement:node},agyRenaming:false,agyCheckPending:null,agyCheckAccounts:()=>{},attachListDropTarget(){},t:()=>'',agyT:(pl)=>pl,agyIconButton:(label,title,fn)=>{buttons.push({label,fn});return node();},agyAction:(path,body)=>({path,body}),renderAgyCard:()=>node()};
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

function checkController(response) {
 const html=renderDashboardHtml();
 const source=html.slice(html.indexOf('function agyCheckAccounts('),html.indexOf('function agyReorder('));
 const requests=[],renders=[],notices=[];
 let refreshed=0;
 const ctx=vm.createContext({
  agyCheckPending:null,agyCheckExpanded:{},agyData:{accounts:[{id:'a'},{id:'b'}]},
  agyT:pl=>pl, note:(...args)=>notices.push(args),
  renderAgyAccounts:()=>renders.push(ctx.agyCheckPending ? {...ctx.agyCheckPending} : null),
  apiCall:(...args)=>{requests.push(args);return response;},
  loadAgyAccounts:async()=>{refreshed++;},
 });
 vm.runInContext(source,ctx);
 return {ctx,requests,renders,notices,refreshed:()=>refreshed};
}

test('manual check immediately shows pending state, suppresses duplicate clicks, expands result and confirms completion',async()=>{
 let resolve;
 const f=checkController(new Promise(r=>{resolve=r;}));
 const pending=f.ctx.agyCheckAccounts({id:'a'});
 assert.equal(f.ctx.agyCheckPending.id,'a');
 assert.equal(f.ctx.agyCheckExpanded.a,true);
 assert.equal(f.renders.length,1);
 await f.ctx.agyCheckAccounts({id:'b'});
 assert.equal(f.requests.length,1);
 assert.equal(f.requests[0][0],'/agent-lb/api/agy/accounts/check');
 assert.equal(f.requests[0][1],'POST');
 assert.equal(f.requests[0][2].id,'a');
 resolve({ok:true,checked:1,failed:0}); await pending;
 assert.equal(f.ctx.agyCheckPending,null);
 assert.equal(f.notices[0][0],'ok');
 assert.match(f.notices[0][1],/Sprawdzenie zakończone/);
 assert.equal(f.refreshed(),1);
});

test('pool check opens all results and clears progress after server busy, failed probes or network failure',async()=>{
 for (const reply of [{ok:false,busy:true}, {ok:true,checked:2,failed:1}, new Error('network'), null]) {
  const f=checkController(reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply));
  const pending=f.ctx.agyCheckAccounts(null);
  assert.equal(f.ctx.agyCheckExpanded.a,true);
  assert.equal(f.ctx.agyCheckExpanded.b,true);
  assert.equal(f.ctx.agyCheckPending.id,null);
  await pending;
  assert.equal(f.ctx.agyCheckPending,null);
  assert.equal(f.refreshed(),1);
  if (reply!==null) assert.equal(f.notices[0][0],'error');
  else assert.equal(f.notices.length,0,'auth failure must not show success');
 }
});

test('account card keeps progress visible through re-render and distinguishes catalog access from generation',()=>{
 const html=renderDashboardHtml();
 const source=html.slice(html.indexOf('function agyAccountStatus('),html.indexOf('function renderAgyAccounts('));
 const controls=[];
 const el=(tag,className,textContent)=>({tag,className,textContent,children:[],dataset:{},style:{},setAttribute(){},appendChild(n){this.children.push(n);},addEventListener(){}});
 let clicked;
 const ctx=vm.createContext({el,currentLang:'pl',accountDetails:{open(){}},bindAccountDetailsCard(){},t:k=>k,agyT:pl=>pl,agyData:{events:[],queue:[]},agyTests:{},agySubscriptionBusy:{},agyCheckPending:{id:'a'},agyCheckExpanded:{a:true},attachCardDragListeners(){},agyIconButton:(label,title,action)=>{const b=el('button','',label);b.title=title;b.action=action;controls.push(b);return b;},agyCheckAccounts:a=>{clicked=a.id;},agyUsageBlock:()=>el('div'),fmtNum:String});
 vm.runInContext(source,ctx);
 const account={id:'a',email:'a@example.com',enabled:true,modelCatalog:{models:['gemini-flash-low'],stale:false},diagnostics:{status:'available',checkedAt:100,telemetry:{}}};
 const card=ctx.renderAgyCard(account,0,['a']);
 const modelDetails=card.children.find(n=>n.tag==='details'&&n.className==='dim');
 assert.equal(modelDetails.children[0].textContent,'Modele tego konta (1)');
 assert.equal(modelDetails.children[1].textContent,'gemini-flash-low');
 assert.ok(card.children.some(n=>n.textContent==='Sprawdzanie dostępu, planu i limitów…'));
 assert.equal(card.children.find(n=>n.tag==='details').open,true);
 const check=controls.find(n=>n.title==='Sprawdź dostęp, plan i limity');
 assert.equal(check.disabled,true);assert.equal(check.textContent,'…');
 const badges=card.children.find(n=>n.className==='card-header').children[0].children;
 assert.ok(badges.some(n=>n.textContent==='Dostęp do katalogu'));
 assert.ok(!badges.some(n=>n.textContent==='Ostatnio działało'));
 ctx.agyCheckPending=null;controls.length=0;
 ctx.renderAgyCard(account,0,['a']);
 const idle=controls.find(n=>n.title==='Sprawdź dostęp, plan i limity');
 assert.equal(idle.disabled,false);idle.action();assert.equal(clicked,'a');
});
