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
 const ctx={document:{getElementById:id=>id==='listAgy'?box:node(),createElement:node},agyRenaming:false,agyCheckPending:null,agyAvailable:a=>!!a.enabled,agyCheckAccounts:()=>{},attachListDropTarget(){},t:()=>'',agyT:(pl)=>pl,agyIconButton:(label,title,fn)=>{buttons.push({label,fn});return node();},agyAction:(path,body)=>({path,body}),renderAgyCard:()=>node()};
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
 const more=card.children.find(n=>n.tag==='details'&&n.className==='agy-details');
 assert.equal(more.children[0].textContent,'Szczegóły');
 const modelBox=more.children.find(n=>n.className==='agy-model-catalog');
 assert.equal(modelBox.tag,'details');
 assert.equal(modelBox.children[0].textContent,'Modele do wysyłania zapytań (1)');
 assert.equal(modelBox.children[2].textContent,'gemini-flash-low');
 assert.equal(card.children.filter(n=>n.tag==='details').length,1);
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

test('AGY next-account hint follows pin, then soonest reset and skips unusable accounts', () => {
 const html=renderDashboardHtml();
 const a=html.indexOf('function agyNextAccount(');
 const code=html.slice(a,html.indexOf('// The routing table',a));
 const ctx={agyAvailable:x=>!!x.enabled&&!x.bad,agyQuotaItems:x=>x.items||[],agyBlocks:x=>x.blocks||[]};
 vm.runInNewContext(code,ctx);
 const acc=[{id:'a',enabled:true,usage:{models:[{resetAt:300}]}},{id:'b',enabled:true,usage:{models:[{resetAt:100}]}},{id:'c',enabled:true,bad:true}];
 assert.equal(ctx.agyNextAccount(acc),'b');
 assert.equal(ctx.agyNextAccount([{...acc[0],pinned:true},acc[1]]),'a');
 assert.equal(ctx.agyNextAccount([acc[2]]),null);
 assert.equal(ctx.agyNextAccount([{...acc[1],blocks:['m']},acc[0]]),'a'); // model-blocked account is skipped
 assert.equal(ctx.agyNextAccount([{...acc[1],blocks:['m']}]),'b'); // ...unless nothing else is left
});

test('transient health cooldown is a self-clearing cooldown, not a needs-review error', () => {
 const html=renderDashboardHtml();
 const a=html.indexOf('function agyAccountStatus('), b=html.indexOf('function renderAgyCard(',a);
 const ctx={agyDiagnosticRestricted:()=>false};
 vm.runInNewContext(html.slice(a,b),ctx);
 const now=1000, base={enabled:true};
 assert.equal(ctx.agyAccountStatus({...base,health:{reason:'transport',until:now+5,requiresReview:false}},[],null,now),'cooldown');
 assert.equal(ctx.agyAccountStatus({...base,health:{reason:'access_denied',until:null,requiresReview:true}},[],null,now),'error');
});

test('focused AGY quotas show current families without borrowing legacy or account-wide limits', () => {
 const html=renderDashboardHtml();
 const ctx={agyT:pl=>pl,Date};
 vm.runInNewContext(html.slice(html.indexOf('function agyBlocks('),html.indexOf('function agyQuotaRow(')),ctx);
 const future=Date.now()+3600000;
 const account={modelCatalog:{available:true,stale:false,models:['gemini-3.8-flash-high','gemini-4-carbon-low']},diagnostics:{telemetry:{models:{observedAt:Date.now(),data:[
  {id:'gemini-2.5-flash',remainingFraction:1,resetAt:future},
  {id:'gemini-3.8-flash-tiered',remainingFraction:0.1,resetAt:future}
 ]},quotaSummary:{observedAt:Date.now(),data:[{id:'3p-5h',remainingFraction:1,resetAt:future}]}}},modelQuotas:{'gemini-3.8-flash-high':future}};
 const groups=ctx.agyFocusedQuotas(account);
 assert.deepEqual(Array.from(groups,g=>g.label),['Gemini 3.8 Flash','Gemini 4 Argon','Gemini 4 Carbon']);
 assert.equal(groups[0].readings[0].remaining,0.1);
 assert.equal(groups[0].blocks[0].label,'High');
 assert.equal(groups[1].supported,false);
 assert.equal(groups[1].readings.length,0);
 assert.equal(groups[2].supported,true);
 assert.equal(groups[2].readings.length,0,'catalog access and account-wide quota must not invent a model percentage');
 assert.equal(ctx.agyFocusedQuotas({})[0].supported,null);
});

test('focused AGY quotas preserve different variant readings and ignore expired blocks',()=>{
 const html=renderDashboardHtml(),ctx={agyT:pl=>pl,Date};
 vm.runInNewContext(html.slice(html.indexOf('function agyBlocks('),html.indexOf('function agyQuotaRow(')),ctx);
 const at=Date.now(),future=at+3600000;
 const groups=ctx.agyFocusedQuotas({usage:{updatedAt:at,models:[{label:'gemini-4-carbon-high',remaining:0.8,resetAt:future}]},diagnostics:{telemetry:{models:{observedAt:at-1,data:[{id:'gemini-4-carbon-high',remainingFraction:0.5,resetAt:future},{id:'gemini-4-carbon-low',remainingFraction:0,resetAt:future+1}]}}},modelQuotas:{'gemini-4-carbon-low':at-1}});
 assert.equal(groups[2].readings.length,2);
 assert.equal(groups[2].readings.find(r=>r.variant==='High').remaining,0.8);
 assert.equal(groups[2].readings.find(r=>r.variant==='Low').remaining,0);
 assert.equal(groups[2].blocks.length,0);
});
