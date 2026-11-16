import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade,tradeStartUrl} from '../lib/collateral-trade.js';
import {withdrawApplication} from '../lib/application-withdrawal.js';
import {runTradeHandoff,resumeTradeObservation,createTornTradePage} from '../src/trade-handoff.js';

const borrower='9000001',recipient='3542697',clock=1900000000000;
const clone=value=>structuredClone(value);

function scenario(reference='TLB-0BE1AA730D7B',options={}){
 let state=TB.newState();state.actorId=borrower;state.revision=4;
 state.applications=[{id:'APP-1',reference,borrowerId:borrower,status:'approved'}];
 state.loans=[{id:'LOAN-1',applicationId:'APP-1',borrowerId:borrower,reference,status:'approved',principal:1e6,collateralRequired:5e5,collateralConfirmed:false,issuer:null,payments:[]}];
 prepareCollateralTrade(state,borrower,{loanId:'LOAN-1',recipientId:recipient},clock);
 const intent=state.loans[0].collateralTrade,handoff={loanId:'LOAN-1',intentId:intent.intentId,recipientId:recipient};
 const writes=[],steps=[],statuses=[],user={id:borrower};let submits=0,manual=false,assertions=0,sequence=0;
 const response=()=>({state:clone(state),user:clone(user),role:'borrower'});
 const fixture={get state(){return state;},set state(value){state=value;},user,handoff,writes,steps,statuses,get submits(){return submits;},set manual(value){manual=value;},intent:()=>state.loans[0].collateralTrade,observation:()=>({uiTradeId:'11687899',reference,recipientId:recipient})};
 fixture.transport={ready:Promise.resolve(),async request(path,body){
  assert.equal(path,'bank');
  if(!body)return response();
  writes.push(clone(body));
  await options.beforeWrite?.(body,fixture);
  if(body.revision!==state.revision)throw Error('State changed; refresh before saving.');
  const next=clone(state);
  if(body.action==='claimCollateralTrade')claimCollateralTrade(next,borrower,body.payload,clock+1);
  else if(body.action==='recordCollateralTrade')recordCollateralTrade(next,borrower,body.payload,clock+2);
  else assert.fail('Unexpected write action '+body.action);
  next.revision++;state=next;
  const saved=response();
  if(body.action==='claimCollateralTrade')await options.afterClaim?.(fixture);
  return saved;
 }};
 fixture.page={
  async waitForStart(value){steps.push('wait for form');assert.equal(value.reference,reference);await options.beforeForm?.(fixture);return {existing:options.existing?fixture.observation():null};},
  fillReference(value){steps.push('fill '+value.reference);},
  async waitUntilReady(){steps.push('wait for enabled');},
  assertReady(){steps.push('assert ready');assertions++;options.assertReady?.(assertions,fixture);},
  arm(){steps.push('watch native initiation');},
  hasInitiated(){return manual;},
  submit(value){steps.push('initiate');assert.equal(value.reference,reference);submits++;},
  async waitForResult(){steps.push('observe');await options.beforeResult?.(fixture);return options.result===undefined?fixture.observation():options.result;}
 };
 fixture.run=()=>runTradeHandoff({handoff,transport:fixture.transport,page:fixture.page,now:()=>clock+1,requestId:()=>`handoff-${++sequence}`,onStatus:update=>statuses.push(clone(update))});
 fixture.resume=()=>resumeTradeObservation({handoff,transport:fixture.transport,page:fixture.page,requestId:()=>`resume-${++sequence}`,onStatus:update=>statuses.push(clone(update))});
 return fixture;
}

test('each approved loan uses its own reference, claims once, submits once and records only the observed trade',async()=>{
 for(const reference of ['TLB-0BE1AA730D7B','TLB-ANOTHER-LOAN-72']){
  const f=scenario(reference),before=clone(f.state),saved=await f.run();
  assert.equal(saved.status,'created');assert.equal(saved.reference,reference);assert.equal(saved.uiTradeId,'11687899');
  assert.equal(f.submits,1);assert.deepEqual(f.writes.map(write=>write.action),['claimCollateralTrade','recordCollateralTrade']);
  assert.equal(f.writes[1].payload.reference,reference);assert.equal(f.writes[1].revision,f.writes[0].revision+1);
  assert.deepEqual(f.statuses.map(update=>update.status),['checking','claiming','claimed','submitting','submitted','observed','recorded']);
  assert.deepEqual(f.steps,['wait for form','fill '+reference,'wait for enabled','assert ready','watch native initiation','assert ready','initiate','observe']);
  assert.deepEqual(f.state.ledger,before.ledger);assert.deepEqual(f.state.receipts,before.receipts);assert.equal(f.state.loans[0].status,'approved');assert.equal(f.state.loans[0].collateralConfirmed,false);assert.equal(f.state.loans[0].issuer,null);
  await f.run();assert.equal(f.submits,1);assert.equal(f.writes.length,2);
 }
});

test('a form discovery failure never claims, submits or reports creation',async()=>{
 const f=scenario(undefined,{beforeForm(){throw Error('Matching Torn form is unavailable.');}});
 await assert.rejects(f.run(),/form is unavailable/);
 assert.equal(f.intent().status,'prepared');assert.equal(f.submits,0);assert.deepEqual(f.writes,[]);
});

test('ownership, matching setup, references, expiry and approved status are checked before touching the Torn form',async()=>{
 const changes=[
  f=>{f.user.id='9000002';},
  f=>{f.handoff.recipientId='9000002';},
  f=>{f.intent().reference='TLB-FORGED';},
  f=>{f.intent().expiresAt=clock;},
  f=>{f.state.applications[0].status='pending';},
  f=>{f.state.loans[0].status='active';},
  f=>{withdrawApplication(f.state,borrower,'APP-1');}
 ];
 for(const change of changes){
  const f=scenario();change(f);await assert.rejects(f.run());
  assert.equal(f.submits,0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.steps,[]);
 }
});

test('claim conflicts and failed responses never trigger an automatic native click',async()=>{
 for(const afterCommit of [false,true]){
  const options=afterCommit?{afterClaim(){throw Error('Claim response lost.');}}:{beforeWrite(){throw Error('State changed.');}};
  const f=scenario(undefined,options);
  await assert.rejects(f.run(),/response lost|State changed/);assert.equal(f.submits,0);assert.equal(f.writes.length,1);
  assert.equal(f.intent().status,afterCommit?'claimed':'prepared');
  if(afterCommit){await f.resume();assert.equal(f.intent().status,'created');assert.equal(f.submits,0);assert.equal(f.writes.filter(write=>write.action==='claimCollateralTrade').length,1);}
 }
});

test('a changed form after claim publishes claimed recovery state and cannot be automatically retried',async()=>{
 const f=scenario(undefined,{assertReady(count){if(count===2)throw Error('Recipient changed.');}});
 await assert.rejects(f.run(),/Recipient changed/);
 assert.equal(f.intent().status,'claimed');assert.equal(f.submits,0);
 assert.equal(f.statuses.at(-1).status,'claimed');assert.ok(f.statuses.at(-1).intent.claimedAt);
 await assert.rejects(f.run(),/already attempted/);assert.equal(f.submits,0);assert.equal(f.writes.length,1);
});

test('native user initiation during the bank claim is observed without a second helper click',async()=>{
 const f=scenario(undefined,{afterClaim(f){f.manual=true;}});
 await f.run();assert.equal(f.submits,0);assert.equal(f.intent().status,'created');
 assert.deepEqual(f.writes.map(write=>write.action),['claimCollateralTrade','recordCollateralTrade']);
 assert.equal(f.steps.filter(step=>step==='assert ready').length,1);
});

test('an already visible matching trade is linked without filling or submitting a new form',async()=>{
 const f=scenario(undefined,{existing:true});await f.run();
 assert.equal(f.submits,0);assert.deepEqual(f.steps,['wait for form']);assert.equal(f.intent().status,'created');
});

test('opening or timing out on Torn never reports creation; resuming the same claim is observation-only',async()=>{
 let unavailable=true;
 const f=scenario(undefined,{beforeResult(){if(unavailable)throw Error('Torn trade not confirmed.');}});
 await assert.rejects(f.run(),/not confirmed/);
 assert.equal(f.submits,1);assert.equal(f.intent().status,'claimed');assert.equal(f.intent().uiTradeId,undefined);
 assert.deepEqual(f.writes.map(write=>write.action),['claimCollateralTrade']);
 unavailable=false;await f.resume();
 assert.equal(f.submits,1);assert.equal(f.intent().status,'created');assert.equal(f.writes.filter(write=>write.action==='claimCollateralTrade').length,1);
});

test('wrong observed reference, peer, or numeric ID cannot be saved as a created trade',async()=>{
 for(const result of [null,{uiTradeId:'1',reference:'TLB-WRONG',recipientId:recipient},{uiTradeId:'1',reference:'TLB-0BE1AA730D7B',recipientId:'9000002'},{uiTradeId:'javascript:alert(1)',reference:'TLB-0BE1AA730D7B',recipientId:recipient}]){
  const f=scenario(undefined,{result});await assert.rejects(f.run(),/matching created trade/);
  assert.equal(f.submits,1);assert.equal(f.intent().status,'claimed');assert.equal(f.writes.length,1);
 }
});

test('a failed report leaves the existing native trade available for observation-only recovery',async()=>{
 let fail=true;
 const f=scenario(undefined,{beforeWrite(body){if(body.action==='recordCollateralTrade'&&fail)throw Error('Bank save interrupted.');}});
 await assert.rejects(f.run(),/save interrupted/);
 assert.equal(f.submits,1);assert.equal(f.intent().status,'claimed');assert.equal(f.statuses.at(-1).status,'observed');
 fail=false;await f.resume();assert.equal(f.intent().status,'created');assert.equal(f.submits,1);
 assert.equal(f.writes.filter(write=>write.action==='claimCollateralTrade').length,1);
});

test('withdrawal winning before the claim prevents native initiation',async()=>{
 const f=scenario(undefined,{beforeWrite(body,f){if(body.action==='claimCollateralTrade'){withdrawApplication(f.state,borrower,'APP-1');f.state.revision++;}}});
 await assert.rejects(f.run(),/State changed/);
 assert.equal(f.submits,0);assert.equal(f.state.loans[0].status,'withdrawn');assert.equal(f.intent().status,'cancelled');
});

test('a native result arriving after withdrawal saves only its cancellation link',async()=>{
 const f=scenario(undefined,{beforeResult(f){withdrawApplication(f.state,borrower,'APP-1');f.state.revision++;}});
 const before=clone(f.state.ledger);await f.run();
 assert.equal(f.submits,1);assert.equal(f.state.loans[0].status,'withdrawn');assert.equal(f.state.applications[0].status,'withdrawn');
 assert.equal(f.intent().status,'cancelled');assert.equal(f.intent().cancellationRequired,true);assert.equal(f.intent().uiTradeId,'11687899');assert.deepEqual(f.state.ledger,before);
});

test('a claim reported after recorded funding only adds the observed link and never starts a new trade',async()=>{
 const f=scenario(undefined,{beforeResult(f){f.state.loans[0].status='active';f.state.ledger.push({type:'disbursement',loanId:'LOAN-1',to:'borrower:'+borrower,amount:1e6});f.state.revision++;}});
 await f.run();assert.equal(f.submits,1);assert.equal(f.state.loans[0].status,'active');assert.equal(f.intent().reportedAfterFunding,true);assert.equal(f.state.ledger.length,1);
 await f.resume();assert.equal(f.submits,1);assert.equal(f.state.ledger.length,1);
});

test('a remembered prepared intent can never initiate or report from observation-only resume',async()=>{
 const f=scenario();await assert.rejects(f.resume(),/no confirmed creation attempt/);
 assert.equal(f.submits,0);assert.deepEqual(f.steps,[]);assert.deepEqual(f.writes,[]);
});

// Small native form fixture: real page adapter runs unchanged against explicit
// visible controls. These tests do not claim live Torn or on-device validation.
function nativeForm(){
 const f=scenario(),intent=f.intent(),events=new Map(),timers=new Map();let timer=0,clicks=0;
 const window={location:{href:tradeStartUrl(intent)},Event:class{constructor(type,init){this.type=type;Object.assign(this,init);}},setInterval(fn){timers.set(++timer,fn);return timer;},clearInterval(id){timers.delete(id);},setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);}};
 const document={hidden:false,visibilityState:'visible',defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})},getElementById(){return null;},addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);},querySelectorAll(selector){
  if(selector==='script[uid][name]')return [{getAttribute:()=>borrower}];
  if(selector==='.init-trade.m-top10')return [root];
  return [];
 }};
 function node(extra={}){return {ownerDocument:document,hidden:false,disabled:false,readOnly:false,getClientRects:()=>[{}],closest:()=>null,getAttribute:()=>null,...extra};}
 const root=node({querySelector:selector=>selector==='#user-id'?{value:recipient}:null,querySelectorAll:selector=>selector.startsWith('input:not')?[description]:selector.startsWith('button,')?[button]:[]});
 const description=node({value:'',tagName:'INPUT',maxLength:100,labels:[{textContent:'Trade Description'}],dispatchEvent(event){if(event.type==='input')button.disabled=false;}});
 const button=node({textContent:'Initiate',disabled:true,closest(selector){return selector==='.init-trade.m-top10'?root:selector.startsWith('button,')?button:null;},click(){const event={type:'click',target:button,preventDefault(){this.prevented=true;},stopImmediatePropagation(){}};events.get('click')?.(event);if(!event.prevented)clicks++;}});
 window.HTMLInputElement=class{};window.HTMLTextAreaElement=class{};
 Object.defineProperty(window.HTMLInputElement.prototype,'value',{set(value){this.value=value;}});
 const page=createTornTradePage(document,window);
 return {intent,page,document,window,description,button,root,events,get clicks(){return clicks;}};
}

test('native adapter fills the exact reference, handles initially disabled Initiate, and prevents repeated helper and native clicks',async()=>{
 const f=nativeForm();assert.deepEqual(await f.page.waitForStart(f.intent),{existing:null});assert.equal(f.button.disabled,true);
 f.page.fillReference(f.intent);await f.page.waitUntilReady(f.intent);f.page.assertReady(f.intent);f.page.arm(f.intent);f.page.submit(f.intent);
 assert.equal(f.description.value,f.intent.reference);assert.equal(f.clicks,1);assert.equal(f.page.hasInitiated(),true);
 f.button.click();assert.equal(f.clicks,1);assert.throws(()=>f.page.submit(f.intent),/already attempted/);
 f.page.dispose();assert.equal(f.events.size,0);
});

test('native adapter observes a manual Initiate and blocks any subsequent helper submission',async()=>{
 const f=nativeForm();f.page.fillReference(f.intent);await f.page.waitUntilReady(f.intent);f.page.arm(f.intent);f.button.click();
 assert.equal(f.page.hasInitiated(),true);assert.equal(f.clicks,1);assert.throws(()=>f.page.submit(f.intent),/already attempted/);
});

test('native adapter rejects changed account, recipient, loan handoff, hidden tab and changed description',async()=>{
 const changes=[
  f=>{f.document.querySelectorAll=selector=>selector==='script[uid][name]'?[{getAttribute:()=>recipient}]:[];},
  f=>{f.root.querySelector=()=>({value:'9000002'});},
  f=>{f.window.location.href=f.window.location.href.replace('tlbLoan=LOAN-1','tlbLoan=LOAN-2');},
  f=>{f.document.hidden=true;},
  f=>{f.description.value='Different text';},
  f=>{f.button.disabled=true;}
 ];
 for(const change of changes){
  const f=nativeForm();f.page.fillReference(f.intent);await f.page.waitUntilReady(f.intent);change(f);
  assert.throws(()=>f.page.submit(f.intent));assert.equal(f.clicks,0);
 }
});
