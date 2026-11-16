import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade,tradeStartUrl} from '../lib/collateral-trade.js';
import {withdrawApplication} from '../lib/application-withdrawal.js';
import {runTradeHandoff,resumeTradeObservation,createTornTradePage,tradeHandoffFailureMessage} from '../src/trade-handoff.js';

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
 fixture.transport={ready:Promise.resolve(),getSavedKey:()=> 'abcdefghijklmnop',async request(path,body){
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
 fixture.run=()=>runTradeHandoff({handoff,transport:fixture.transport,page:fixture.page,now:options.now||(()=>clock+1),requestId:()=>`handoff-${++sequence}`,onStatus:update=>statuses.push(clone(update))});
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

test('a delayed claim response cannot submit after the creation window expires and replacement becomes possible',async()=>{
 let now=clock+1;
 const f=scenario(undefined,{now:()=>now,afterClaim(){now=clock+120001;}});
 await assert.rejects(f.run(),/setup expired while/);
 assert.equal(f.intent().status,'claimed');assert.equal(f.submits,0);
 assert.deepEqual(f.writes.map(write=>write.action),['claimCollateralTrade']);
 assert.equal(f.statuses.at(-1).status,'claimed');
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

test('replacement handoffs carry retired native IDs from every previous attempt into native observation',async()=>{
 const f=scenario('TLB-FUTURE-LOAN');
 f.state.loans[0].collateralTradeHistory=[
  {intent:{intentId:'TRADE-old-1',uiTradeId:'101'},flow:{nativeTradeId:'101',apiTradeId:'9001'}},
  {intent:{intentId:'TRADE-old-2',uiTradeId:'102'},flow:{nativeTradeId:'103',apiTradeId:'9002'}}
 ];
 const seen=[];
 const waitForStart=f.page.waitForStart,waitForResult=f.page.waitForResult;
 f.page.waitForStart=async intent=>{seen.push(clone(intent.excludedNativeTradeIds));return waitForStart(intent);};
 f.page.waitForResult=async intent=>{seen.push(clone(intent.excludedNativeTradeIds));return waitForResult(intent);};
 await f.run();
 assert.deepEqual(seen,[['101','102','103'],['101','102','103']]);
 assert.equal(f.intent().uiTradeId,'11687899');assert.equal(f.submits,1);
 assert.equal(f.intent().excludedNativeTradeIds,undefined,'retired IDs are observation context and not written into the new intent');
 assert.equal(f.state.loans[0].collateralTradeHistory.length,2);
});

test('an earlier observed trade cannot be recorded as the replacement even if a page adapter returns it',async()=>{
 const f=scenario(undefined,{existing:true});
 f.state.loans[0].collateralTradeHistory=[{intent:{uiTradeId:'11687899'}}];
 await assert.rejects(f.run(),/earlier attempt/);
 assert.equal(f.submits,0);assert.deepEqual(f.writes.map(write=>write.action),['claimCollateralTrade']);
 assert.equal(f.intent().uiTradeId,undefined);
});

test('old handoff links and saved observation resumes cannot act after the loan has a replacement intent',async()=>{
 for(const method of ['run','resume']){
  const f=scenario();f.intent().intentId='TRADE-replacement';
  await assert.rejects(f[method](),error=>{assert.equal(error.code,'trade_setup_changed');return true;});
  assert.equal(f.submits,0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.steps,[]);
 }
});

test('a late native result from a retired attempt cannot overwrite or reopen the replacement',async()=>{
 const f=scenario(undefined,{beforeResult(f){
  const loan=f.state.loans[0];loan.collateralTradeHistory=[{intent:clone(loan.collateralTrade)}];
  loan.collateralTrade={...loan.collateralTrade,intentId:'TRADE-new',status:'prepared'};delete loan.collateralTrade.claimedAt;
  f.state.revision++;
 }});
 await assert.rejects(f.run(),error=>{assert.equal(error.code,'trade_setup_changed');return true;});
 assert.equal(f.submits,1);assert.deepEqual(f.writes.map(write=>write.action),['claimCollateralTrade']);
 assert.equal(f.intent().intentId,'TRADE-new');assert.equal(f.intent().status,'prepared');assert.equal(f.intent().uiTradeId,undefined);
 assert.equal(f.statuses.some(update=>update.status==='recorded'),false);
 await assert.rejects(f.resume(),/replaced or changed/);
 assert.equal(f.submits,1);assert.equal(f.writes.length,1);
});

// Explicit native form fixture, grounded in Torn's trade_initiate.js:
// `.inputs input, .inputs textarea` validate ONLY on keyup and enable the
// native submit input when recipient and description are both nonempty.
// This still does not claim live Torn or on-device interaction validation.
function nativeForm({banking=scenario(),validation=true}={}){
 const intent=banking.intent(),events=new Map(),timers=new Map(),editingEvents=[],setters=[],disabledWrites=[];
 let timer=0,clicks=0,nativeSubmissions=0,inValidator=false,disabled=true;
 const window={location:{href:tradeStartUrl(intent)},Event:class{constructor(type,init){this.type=type;Object.assign(this,init);}},setInterval(fn,delay){timers.set(++timer,{fn,delay,type:'interval'});return timer;},clearInterval(id){timers.delete(id);},setTimeout(fn,delay){timers.set(++timer,{fn,delay,type:'timeout'});return timer;},clearTimeout(id){timers.delete(id);}};
 const document={hidden:false,visibilityState:'visible',defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})},getElementById(){return null;},addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);},querySelectorAll(selector){
  if(selector==='script[uid][name]')return [{getAttribute:()=>borrower}];
  if(selector==='.init-trade.m-top10')return [root];
  return [];
 }};
 function node(extra={}){return {ownerDocument:document,hidden:false,disabled:false,readOnly:false,getClientRects:()=>[{}],closest:()=>null,getAttribute:()=>null,...extra};}
 const recipientInput=node({value:'Aaron112293 ['+recipient+']',tagName:'INPUT'});
 const root=node({querySelector:selector=>selector==='#user-id'?recipientInput:null,querySelectorAll:selector=>selector.startsWith('input:not')?[description]:selector.startsWith('button,')?[button]:[]});
 const form=node({closest:selector=>selector==='.init-trade.m-top10'?root:null});
 const description=node({value:'',tagName:'TEXTAREA',maxLength:155,labels:[{textContent:'Description:'}],
  focus(){assert.fail('Programmatic fill must not open the mobile keyboard.');},
  blur(){assert.fail('The keyup compatibility fix must not change native focus.');},
  dispatchEvent(event){
   editingEvents.push(event);
   if(event.type==='keyup'&&validation){
    inValidator=true;
    try{button.disabled=!recipientInput.value||!description.value;}
    finally{inValidator=false;}
   }
   return true;
  }
 });
 function dispatch(type,target,submitter){
  const event={type,target,submitter,preventDefault(){this.prevented=true;},stopImmediatePropagation(){}};
  events.get(type)?.(event);return !event.prevented;
 }
 function enter(){if(!button.disabled&&dispatch('submit',form,undefined))nativeSubmissions++;}
 const button=node({tagName:'INPUT',type:'submit',value:'Initiate',textContent:'',closest(selector){return selector==='.init-trade.m-top10'?root:selector.startsWith('button,')?button:null;},click(){
  if(button.disabled||!dispatch('click',button))return;
  clicks++;
  if(dispatch('submit',form,button))nativeSubmissions++;
 }});
 Object.defineProperty(button,'disabled',{get:()=>disabled,set:value=>{disabledWrites.push({value,fromValidator:inValidator});disabled=value;}});
 window.HTMLInputElement=class{};window.HTMLTextAreaElement=class{};
 Object.defineProperty(window.HTMLInputElement.prototype,'value',{set(value){setters.push('input');this.value=value;}});
 Object.defineProperty(window.HTMLTextAreaElement.prototype,'value',{set(value){setters.push('textarea');this.value=value;}});
 const page=createTornTradePage(document,window);
 return {intent,page,document,window,description,button,root,events,editingEvents,setters,disabledWrites,timers,enter,
  timeout(){const pending=[...timers.values()].find(entry=>entry.type==='timeout');assert.ok(pending,'Expected a pending bounded wait.');pending.fn();},
  get clicks(){return clicks;},get nativeSubmissions(){return nativeSubmissions;}
 };
}

test('native adapter fills the exact reference, handles initially disabled Initiate, and prevents repeated helper and native clicks',async()=>{
 const f=nativeForm();assert.deepEqual(await f.page.waitForStart(f.intent),{existing:null});assert.equal(f.button.disabled,true);
 f.page.fillReference(f.intent);await f.page.waitUntilReady(f.intent);f.page.assertReady(f.intent);f.page.arm(f.intent);f.page.submit(f.intent);
 assert.equal(f.description.value,f.intent.reference);assert.equal(f.clicks,1);assert.equal(f.page.hasInitiated(),true);
 assert.equal(f.nativeSubmissions,1,'the first native click and its default submit must both be allowed');
 f.button.click();f.enter();assert.equal(f.clicks,1);assert.equal(f.nativeSubmissions,1);assert.throws(()=>f.page.submit(f.intent),/already attempted/);
 f.page.dispose();assert.equal(f.events.size,0);
});

test('creation captures Torn’s new view route before markup loads and checks its API description',async()=>{
 const f=nativeForm();
 f.page.fillReference(f.intent);await f.page.waitUntilReady(f.intent);f.page.arm(f.intent);f.page.submit(f.intent);
 f.window.location.href='https://www.torn.com/trade.php#step=view&ID=11687899';
 const result=f.page.waitForResult(f.intent);
 [...f.timers.values()].find(entry=>entry.type==='interval').fn();
 assert.deepEqual(await result,{uiTradeId:'11687899',reference:f.intent.reference,recipientId:recipient,verifyDescription:true});
 assert.equal(f.nativeSubmissions,1);
 const resumed=nativeForm();resumed.window.location.href=f.window.location.href;
 assert.equal(resumed.page.observed(resumed.intent),null,'a bare trade route after a reload is not a creation handoff');
 const bank=scenario();await bank.run();
 assert.equal(bank.writes[1].payload.verifyDescription,true);
});

test('the native textarea enables Initiate only through Torn keyup validation without Enter, focus or a disabled-control bypass',async()=>{
 const f=nativeForm();f.description.value=f.intent.reference;
 f.description.dispatchEvent(new f.window.Event('input',{bubbles:true}));
 f.description.dispatchEvent(new f.window.Event('change',{bubbles:true}));
 assert.equal(f.button.disabled,true,'input and change alone reproduce the beta.63 readiness failure');
 f.editingEvents.length=0;f.page.arm(f.intent);
 f.page.fillReference(f.intent);await f.page.waitUntilReady(f.intent);
 assert.equal(f.button.disabled,false);assert.deepEqual(f.setters,['textarea']);
 assert.equal(f.editingEvents.filter(event=>event.type==='keyup').length,1);
 assert.ok(f.editingEvents.every(event=>event.bubbles===true));
 assert.ok(f.editingEvents.every(event=>!['Enter','Return'].includes(event.key)&&event.keyCode!==13&&event.which!==13));
 assert.deepEqual(f.disabledWrites,[{value:false,fromValidator:true}]);
 assert.equal(f.page.hasInitiated(),false);assert.equal(f.clicks,0);assert.equal(f.nativeSubmissions,0);assert.equal(f.timers.size,0);
 f.page.dispose();
});

test('the keyup-ready native form proceeds through one server claim and one native initiation',async()=>{
 const banking=scenario('TLB-8CE07DA27F6D'),native=nativeForm({banking});
 native.page.waitForResult=async()=>banking.observation();banking.page=native.page;
 await banking.run();
 assert.equal(native.description.value,'TLB-8CE07DA27F6D');assert.equal(native.clicks,1);assert.equal(native.nativeSubmissions,1);
 assert.deepEqual(banking.writes.map(write=>write.action),['claimCollateralTrade','recordCollateralTrade']);
 assert.equal(banking.intent().status,'created');
});

test('an Enter submit during the server claim is observed without another native click or submission',async()=>{
 let native;
 const banking=scenario(undefined,{afterClaim(){native.enter();}});
 native=nativeForm({banking});native.page.waitForResult=async()=>banking.observation();banking.page=native.page;
 await banking.run();
 assert.equal(native.clicks,0);assert.equal(native.nativeSubmissions,1);assert.equal(banking.intent().status,'created');
 assert.deepEqual(banking.writes.map(write=>write.action),['claimCollateralTrade','recordCollateralTrade']);
 native.button.click();native.enter();assert.equal(native.clicks,0);assert.equal(native.nativeSubmissions,1);
});

test('a still-disabled native Initiate times out before any server claim or submission',async()=>{
 const banking=scenario(),native=nativeForm({banking,validation:false});banking.page=native.page;
 const pending=banking.run();
 const rejected=assert.rejects(pending,error=>{assert.equal(error.code,'torn_initiate_disabled');return true;});
 for(let tick=0;tick<12;tick++)await Promise.resolve();
 assert.equal(native.description.value,native.intent.reference);assert.equal(native.button.disabled,true);
 native.timeout();await rejected;
 assert.equal(native.timers.size,0);assert.equal(native.clicks,0);assert.equal(native.nativeSubmissions,0);
 assert.deepEqual(banking.writes,[]);assert.equal(banking.intent().status,'prepared');
 assert.deepEqual(native.disabledWrites,[],'the helper must not force native validation to succeed');
});

test('form-discovery and post-submit observation timeouts identify distinct stages and clear their timers',async()=>{
 for(const [method,code] of [['waitForStart','torn_form_timeout'],['waitForResult','torn_result_timeout']]){
  const f=nativeForm();
  if(method==='waitForStart'){
   const query=f.document.querySelectorAll;
   f.document.querySelectorAll=selector=>selector==='.init-trade.m-top10'?[]:query(selector);
  }
  const pending=f.page[method](f.intent),rejected=assert.rejects(pending,error=>{assert.equal(error.code,code);return true;});
  const queued=[...f.timers.values()].map(entry=>entry.fn);
  f.timeout();await rejected;
  assert.equal(f.timers.size,0);assert.equal(f.clicks,0);assert.equal(f.nativeSubmissions,0);
  let lateReads=0;
  f.document.querySelectorAll=()=>{lateReads++;return [];};
  for(const callback of queued)callback();
  assert.equal(lateReads,0,'callbacks queued before settlement cannot inspect the page again');
 }
});

test('trade failure copy distinguishes an unsubmitted setup from an attempted creation without repeating the retry warning',()=>{
 const before=Object.assign(Error('Torn has not enabled Initiate.'),{code:'torn_initiate_disabled'});
 const beforeMessage=tradeHandoffFailureMessage(before,{attempted:false});
 assert.match(beforeMessage,/has not submitted a trade/);assert.match(beforeMessage,/Return to the bank/);
 const after=Object.assign(Error('Torn has not confirmed the created trade.'),{code:'torn_result_timeout'});
 const afterMessage=tradeHandoffFailureMessage(after,{attempted:true});
 assert.equal((afterMessage.match(/No automatic retry/gi)||[]).length,1);
 assert.doesNotMatch(afterMessage,/has not submitted a trade/);
 assert.equal((beforeMessage.match(/No automatic retry/gi)||[]).length<=1,true);
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
