import test from 'node:test';
import assert from 'node:assert/strict';
import {createTradeLoanDetailsController,loanTradeActions,parseReviewAmount} from '../src/trade-loan-match.js';

const OWNER='3542697',BORROWER='1234567',OTHER='7654321',KEY='abcdefghijklmnop',REPLACEMENT='1234567890abcdef';
const REFERENCE='TLB-TRADE-1',NATIVE='11687899',API='987654321',DATE='2026-11-16';
const clone=value=>structuredClone(value);
const kinds={'collateral-placed':['',BORROWER,'collateral_placed','collateralPlaced'],'collateral-reviewed':['collateral_placed',OWNER,'collateral_reviewed','collateralReviewed'],'funds-added':['collateral_reviewed',OWNER,'funds_added','fundsAdded'],'funds-reviewed':['funds_added',BORROWER,'funds_reviewed','fundsReviewed'],complete:['funds_reviewed',OWNER,'completed','completion']};
function data(stage='',actor=BORROWER){
 const records={collateralPlaced:{by:BORROWER},collateralReviewed:{by:OWNER},fundsAdded:{by:OWNER},fundsReviewed:{by:BORROWER}};
 const order=['collateral_placed','collateral_reviewed','funds_added','funds_reviewed'];
 const count=order.indexOf(stage)+1;
 const flow=stage?{version:1,reference:REFERENCE,borrowerId:BORROWER,staffId:OWNER,apiTradeId:API,nativeTradeId:NATIVE,stage,...Object.fromEntries(Object.entries(records).slice(0,count)),...(count>=3?{reservedBy:OWNER}:{})}:undefined;
 const loan={id:'LOAN-1',applicationId:'APP-1',reference:REFERENCE,name:'Borrower',borrowerId:BORROWER,status:'approved',principal:130e6,collateralRequired:65e6,collateralConfirmed:false,borrowerConfirmed:{by:BORROWER},start:DATE,maturity:'2027-01-01',rate:.01,rules:{itemCredit:.9},collateralTrade:{recipientId:OWNER,uiTradeId:NATIVE},...(flow?{tradeFlow:flow}:{})};
 return {user:{id:actor},role:actor===OWNER?'owner':'borrower',state:{revision:0,testDate:DATE,bankOnline:true,staff:[{id:OWNER,role:'owner',disabled:false},{id:OTHER,role:'staff'}],borrowers:{[BORROWER]:{piRto:true,flags:[]}},loans:[loan,{...clone(loan),id:'LOAN-2',reference:'TLB-SECOND',borrowerId:OTHER,tradeFlow:undefined,collateralTrade:{recipientId:OWNER,uiTradeId:'11687900'}}],applications:[]}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function scenario(action='collateral-placed'){
 const [stage,actor]=kinds[action]||['funds_reviewed',OWNER];
 const f={data:data(stage,actor),action,key:KEY,calls:[],models:[],consumedCreated:[],readCount:0,onRead:null,onWrite:null,nativeClicks:0,nativeReady:true};
 f.context={page:true,route:'https://www.torn.com/trade.php#step=view&ID='+NATIVE,accountId:actor,tradeId:NATIVE,reference:REFERENCE,ambiguous:false};
 f.result=(payload)=>{
  const loan=f.data.state.loans.find(record=>record.id===payload.loanId);
  loan.tradeFlow??={version:1,reference:loan.reference,borrowerId:loan.borrowerId,staffId:OWNER,apiTradeId:API,nativeTradeId:NATIVE,stage:''};
  const flow=loan.tradeFlow;
  if(payload.action==='collateral-placed'&&payload.acceptTerms===true&&!loan.borrowerConfirmed)loan.borrowerConfirmed={by:loan.borrowerId,reference:loan.reference,source:'Accepted with collateral placement'};
  if(kinds[payload.action]){const next=kinds[payload.action];flow.stage=next[2];flow[next[3]]={by:f.data.user.id,at:'2026-11-16T10:00:00Z'};}
  if(payload.action==='funds-added')flow.reservedBy=OWNER;
  if(payload.action==='complete'){loan.status='active';loan.issuer=OWNER;loan.collateralConfirmed={by:OWNER,amount:65e6,source:'Torn API completed loan trade'};loan.fundsReceived={by:OWNER,amount:130e6,source:'Torn API completed loan trade'};}
  if(payload.action==='reset'){flow.stage='';for(const field of ['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'])delete flow[field];flow.reservedBy=null;}
  return {...clone(f.data),tradeCheck:{stage:flow.stage,ready:payload.action==='accept-ready',apiTradeId:API,nativeTradeId:NATIVE}};
 };
 const transport={ready:Promise.resolve(),canRestore:()=>true,getSavedKey:()=>f.key,async request(path,payload){
  f.calls.push({path,...(payload===undefined?{}:{payload:clone(payload)})});
  if(path==='bank'){f.readCount++;const override=await f.onRead?.(f.readCount,f);return override??clone(f.data);}
  assert.equal(path,'loan-trade');const override=await f.onWrite?.(payload,f);return override??f.result(payload);
 }};
 const nativeAccept={availability:()=>({ready:f.nativeReady,reason:f.nativeReady?'':'Native control unavailable.'}),accept(input){assert.equal(input.flow.apiTradeId,API);assert.equal(input.tradeCheck.ready,true);f.nativeClicks++;return {message:'Continue Torn confirmation. The bank has not marked the transfer complete.'};}};
 f.controller=createTradeLoanDetailsController({transport,readContext:()=>f.context,nativeAccept,onChange:model=>f.models.push(JSON.stringify(model)),onCreatedTradeReviewConsumed:detail=>f.consumedCreated.push(clone(detail))});
 f.open=async()=>{await f.controller.setOpen(true);assert.equal(f.controller.getState().selectedLoanId,'LOAN-1');};
 f.input={checked:true,...(action==='collateral-reviewed'?{itemReference:'12m',piAmount:'2m',notes:'Reviewed exact quantities and accepted values.'}:{})};
 f.posts=()=>f.calls.filter(call=>call.path!=='bank');return f;
}

function createdTrade(f){
 const loan=f.data.state.loans[0];
 Object.assign(loan.collateralTrade,{intentId:'TRADE-1',loanId:loan.id,borrowerId:loan.borrowerId,reference:loan.reference,status:'created'});
 return {loanId:loan.id,intentId:'TRADE-1',nativeTradeId:NATIVE,borrowerId:loan.borrowerId};
}

test('an observed newly created own trade opens its review once after a fresh read, without consent or writes',async()=>{
 const f=scenario(),detail=createdTrade(f);delete f.data.state.loans[0].borrowerConfirmed;
 const before=clone(f.data);f.context={...f.context,reference:'Trade',referenceEvidence:'unclassified'};
 assert.equal(await f.controller.openCreatedTrade(detail),true);
 const model=f.controller.getState();assert.equal(model.open,true);assert.equal(model.selectedLoanId,'LOAN-1');
 assert.deepEqual(model.review,{action:'collateral-placed',loanId:'LOAN-1'});assert.deepEqual(f.calls.map(call=>call.path),['bank']);
 assert.deepEqual(f.data,before);assert.equal(model.data.state.loans[0].borrowerConfirmed,undefined);assert.equal(f.posts().length,0);assert.equal(f.nativeClicks,0);
 assert.deepEqual(f.consumedCreated,[detail]);
 await f.controller.setOpen(false);await f.controller.setOpen(true);const reads=f.calls.length;
 assert.equal(f.controller.getState().review,null);assert.equal(await f.controller.openCreatedTrade(detail),false);assert.equal(f.calls.length,reads);
});

test('observed creation waits for its matching native detail without polling and cancels on an explicit close or different trade',async()=>{
 for(const outcome of ['matching','close','different','account']){
  const f=scenario(),detail=createdTrade(f),matching={...f.context};
  f.context={...f.context,route:'https://www.torn.com/trade.php#step=start',tradeId:null,reference:null};
  assert.equal(await f.controller.openCreatedTrade(detail),false);await f.controller.contextChanged();
  assert.equal(f.calls.length,0);assert.equal(f.controller.getState().open,false);assert.equal(f.consumedCreated.length,0);
  if(outcome==='close')await f.controller.setOpen(false);
  if(outcome==='different'||outcome==='account'){
   f.context={...matching,...(outcome==='different'?{tradeId:'11687900',reference:'TLB-SECOND'}:{accountId:OTHER})};
   await f.controller.contextChanged();assert.equal(f.calls.length,0);assert.equal(f.consumedCreated.length,1);
  }
  f.context=matching;await f.controller.contextChanged();
  assert.equal(!!f.controller.getState().review,outcome==='matching');assert.equal(f.calls.length,outcome==='matching'?1:0);
  assert.equal(f.posts().length,0);assert.equal(f.nativeClicks,0);assert.equal(f.consumedCreated.length,1);
 }
});

test('created-trade events are bound to fresh saved intent, own borrower, native identity and the initial stage',async()=>{
 const mutations=[
  f=>{f.data.state.loans[0].collateralTrade.status='prepared';},
  f=>{f.data.state.loans[0].collateralTrade.intentId='TRADE-OTHER';},
  f=>{f.data.state.loans[0].collateralTrade.loanId='LOAN-2';},
  f=>{f.data.state.loans[0].collateralTrade.uiTradeId='11687900';},
  f=>{f.data.state.loans[0].collateralTrade.borrowerId=OTHER;},
  f=>{f.data.state.loans[0].collateralTrade.reference='TLB-OTHER';},
  f=>{f.data.state.loans[0].collateralTrade.cancellationRequired=true;},
  f=>{f.data.state.loans[0].status='withdrawn';},
  f=>{f.data.state.loans[0].borrowerId=OTHER;},
  f=>{f.data.state.loans[0].tradeFlow={stage:'collateral_placed'};},
  f=>{f.data.user.id=OTHER;},
  f=>{f.context.reference='TLB-OTHER';f.context.referenceEvidence='loan-reference';},
  f=>{f.context.reference='An unrelated item sale';f.context.referenceEvidence='description';},
  f=>{f.context.ambiguous=true;},
  f=>{f.context.accountId=OWNER;},
  ...['accept','accept2','cancel'].map(step=>f=>{f.context.route='https://www.torn.com/trade.php#step='+step+'&ID='+NATIVE;})
 ];
 for(const mutate of mutations){
  const f=scenario(),detail=createdTrade(f);mutate(f);
  assert.equal(await f.controller.openCreatedTrade(detail),false);assert.equal(f.controller.getState().review,null);
  assert.equal(f.posts().length,0);assert.equal(f.nativeClicks,0);assert.equal(f.consumedCreated.length,1);
 }
 const unknown=scenario(),detail=createdTrade(unknown);detail.loanId='LOAN-UNKNOWN';
 assert.equal(await unknown.controller.openCreatedTrade(detail),false);assert.equal(unknown.controller.getState().review,null);
});

test('duplicate created events and cancellation during the fresh read never reopen or submit a stale review',async()=>{
 for(const cancel of [false,true]){
  const f=scenario(),detail=createdTrade(f),pending=deferred();f.onRead=()=>pending.promise;
  const opening=f.controller.openCreatedTrade(detail);await tick();
  assert.equal(await f.controller.openCreatedTrade({...detail,key:REPLACEMENT}),false);assert.equal(f.calls.length,1);
  if(cancel)await f.controller.setOpen(false);
  pending.resolve(clone(f.data));assert.equal(await opening,!cancel);
  assert.equal(!!f.controller.getState().review,!cancel);assert.equal(f.posts().length,0);assert.equal(f.consumedCreated.length,1);
  assert.equal(JSON.stringify(f.consumedCreated).includes(REPLACEMENT),false);
 }
 const busy=scenario(),detail=createdTrade(busy);await busy.open();busy.controller.beginReview(busy.action);
 assert.equal(await busy.controller.openCreatedTrade(detail),false);assert.equal(busy.calls.length,1);assert.ok(busy.controller.getState().review);
 const other=scenario(),event=createdTrade(other);other.data.role='owner';other.data.state.loans[1].borrowerId=BORROWER;await other.open();other.controller.select('LOAN-2');
 assert.equal(await other.controller.openCreatedTrade(event),false);assert.equal(other.calls.length,1);assert.equal(other.controller.getState().selectedLoanId,'LOAN-2');assert.equal(other.controller.getState().review,null);
});

test('both participants can open a non-Accept review from an unclassified heading only with their saved native trade ID',async()=>{
 for(const action of ['collateral-placed','collateral-reviewed']){
  const f=scenario(action);f.context={...f.context,reference:'Current trade',referenceEvidence:'unclassified'};
  await f.controller.setOpen(true);f.controller.select('LOAN-1');
  assert.equal(loanTradeActions(f.data,f.data.state.loans[0])[action],true);
  assert.equal(f.controller.beginReview(action),true,action);
  assert.deepEqual(f.controller.getState().review,{action,loanId:'LOAN-1'});
  assert.deepEqual(f.calls.map(call=>call.path),['bank']);assert.equal(f.posts().length,0);
  await f.controller.submitReview(f.input);
  assert.deepEqual(f.calls.map(call=>call.path),['bank','bank','loan-trade']);
  assert.equal(f.posts()[0].payload.loanId,'LOAN-1');assert.equal(Object.hasOwn(f.posts()[0].payload,'tradeId'),false);
  assert.equal(Object.hasOwn(f.posts()[0].payload,'nativeTradeId'),false);
 }
});

test('unclassified-heading fallback preserves real description, reference, ambiguity, native ID and account conflicts',async()=>{
 const changes=[
  f=>{f.context.reference='TLB-OTHER';f.context.referenceEvidence='loan-reference';},
  f=>{f.context.reference='Trade TLB-OTHER awaiting acceptance';f.context.referenceEvidence='loan-reference';},
  f=>{f.context.reference='An unrelated item sale';f.context.referenceEvidence='description';},
  f=>{f.context.referenceEvidence='description';},
  f=>{delete f.context.referenceEvidence;},
  f=>{f.context.ambiguous=true;},
  f=>{f.context.tradeId='11687900';},
  f=>{f.context.tradeId=null;},
  f=>{delete f.data.state.loans[0].collateralTrade.uiTradeId;if(f.data.state.loans[0].tradeFlow)delete f.data.state.loans[0].tradeFlow.nativeTradeId;},
  f=>{f.context.accountId=OTHER;},
  f=>{f.data.user.id=OTHER;f.context.accountId=OTHER;f.data.role='staff';}
 ];
 for(const action of ['collateral-placed','collateral-reviewed'])for(const mutate of changes){
  const f=scenario(action);f.context={...f.context,reference:'Trade',referenceEvidence:'unclassified'};mutate(f);
  await f.controller.setOpen(true);f.controller.select('LOAN-1');
  assert.equal(f.controller.beginReview(action),false,action);assert.equal(f.controller.getState().review,null);
  await f.controller.submitReview(f.input);assert.equal(f.posts().length,0);
 }
});

test('Accept remains strict and changed heading evidence invalidates an in-flight review',async()=>{
 const accept=scenario('accept-ready');accept.context={...accept.context,reference:'Trade',referenceEvidence:'unclassified'};
 await accept.controller.setOpen(true);accept.controller.select('LOAN-1');
 assert.equal(accept.controller.beginReview('accept-ready'),false);await accept.controller.submitReview({checked:true});
 assert.equal(accept.posts().length,0);assert.equal(accept.nativeClicks,0);
 const f=scenario(),pending=deferred();f.context={...f.context,reference:'Trade',referenceEvidence:'unclassified'};
 await f.controller.setOpen(true);f.controller.select('LOAN-1');assert.equal(f.controller.beginReview(f.action),true);
 f.onRead=n=>n===2?pending.promise:undefined;const submit=f.controller.submitReview(f.input);await tick();
 f.context={...f.context,referenceEvidence:'description'};pending.resolve(clone(f.data));await submit;
 assert.equal(f.posts().length,0);assert.equal(f.controller.getState().success,'');
});

test('roles follow the same-trade stages and only the bound receiving staff can review or fund',()=>{
 for(const [action,[stage,actor]] of Object.entries(kinds)){
  const d=data(stage,actor),loan=d.state.loans[0];assert.equal(loanTradeActions(d,loan)[action],true,action);
  const outsider=clone(d);outsider.user.id=OTHER;outsider.role='staff';assert.equal(loanTradeActions(outsider,loan)[action],false,action);
 }
 const d=data('funds_reviewed',OWNER),loan=d.state.loans[0];
 assert.equal(loanTradeActions(d,loan)['accept-ready'],true);d.state.staff[0].disabled=true;assert.equal(loanTradeActions(d,loan)['accept-ready'],false);assert.equal(loanTradeActions(d,loan).complete,false);
 const borrower=data('funds_reviewed',BORROWER);assert.equal(loanTradeActions(borrower,borrower.state.loans[0])['accept-ready'],true);assert.equal(loanTradeActions(borrower,borrower.state.loans[0]).complete,false);
});

test('legacy accepted collateral, wrong date and lending holds prevent premature steps but completed-proof review stays available',()=>{
 for(const mutate of [d=>{d.state.loans[0].collateralConfirmed={amount:65e6};},d=>{d.state.loans[0].status='withdrawn';}]){
  const d=data();mutate(d);assert.equal(loanTradeActions(d,d.state.loans[0])['collateral-placed'],false);
 }
 for(const mutate of [d=>{d.state.bankOnline=false;},d=>{d.state.borrowers[BORROWER].flags=[{reason:'Hold'}];},d=>{d.state.loans[0].start='2026-11-17';}]){
  const d=data('collateral_reviewed',OWNER);mutate(d);assert.equal(loanTradeActions(d,d.state.loans[0])['funds-added'],false);assert.equal(loanTradeActions(d,d.state.loans[0]).refresh,true);
 }
 const d=data('funds_reviewed',OWNER);d.state.bankOnline=false;d.state.borrowers[BORROWER].flags=[{reason:'Hold'}];
 assert.equal(loanTradeActions(d,d.state.loans[0])['accept-ready'],false);assert.equal(loanTradeActions(d,d.state.loans[0]).complete,true);
 delete d.state.loans[0].tradeFlow.nativeTradeId;assert.equal(loanTradeActions(d,d.state.loans[0])['accept-ready'],false);
});

test('manually approved first placement requires independent explicit terms consent and saves it only with that action',async()=>{
 const f=scenario();delete f.data.state.loans[0].borrowerConfirmed;await f.open();
 assert.equal(loanTradeActions(f.data,f.data.state.loans[0])['collateral-placed'],true);assert.equal(f.controller.beginReview('collateral-placed'),true);
 await f.controller.submitReview({checked:true});assert.equal(f.posts().length,0);assert.equal(f.readCount,1);assert.match(f.controller.getState().reviewError,/explicitly accept the approved loan terms/);
 await f.controller.submitReview({checked:true,acceptTerms:false});assert.equal(f.posts().length,0);
 f.onRead=n=>{if(n===2)f.data.state.revision=7;};
 await f.controller.submitReview({checked:true,acceptTerms:true,termsRevision:999});assert.equal(f.posts().length,1);assert.equal(f.posts()[0].payload.acceptTerms,true);assert.equal(f.posts()[0].payload.termsRevision,7);assert.equal(f.controller.getState().data.state.loans[0].borrowerConfirmed.by,BORROWER);assert.equal(f.controller.getState().data.state.loans[0].tradeFlow.stage,'collateral_placed');
 for(const [action,[stage,actor]] of Object.entries(kinds).filter(([action])=>action!=='collateral-placed')){const d=data(stage,actor);delete d.state.loans[0].borrowerConfirmed;assert.equal(loanTradeActions(d,d.state.loans[0])[action],false,action);}
 const already=scenario();await already.open();already.controller.beginReview('collateral-placed');await already.controller.submitReview({checked:true,acceptTerms:true,termsRevision:999});assert.equal(Object.hasOwn(already.posts()[0].payload,'acceptTerms'),false);assert.equal(Object.hasOwn(already.posts()[0].payload,'termsRevision'),false);
 const staff=scenario('collateral-reviewed');await staff.open();staff.controller.beginReview(staff.action);await staff.controller.submitReview({...staff.input,acceptTerms:true});assert.equal(Object.hasOwn(staff.posts()[0].payload,'acceptTerms'),false);
 const incomplete=scenario();delete incomplete.data.state.loans[0].borrowerConfirmed;await incomplete.open();incomplete.controller.beginReview(incomplete.action);incomplete.onWrite=payload=>{const result=incomplete.result(payload);delete result.state.loans[0].borrowerConfirmed;return result;};await incomplete.controller.submitReview({checked:true,acceptTerms:true});assert.equal(incomplete.controller.getState().success,'');assert.match(incomplete.controller.getState().reviewError,/did not confirm acceptance/);
 const missingRevision=scenario();delete missingRevision.data.state.loans[0].borrowerConfirmed;delete missingRevision.data.state.revision;await missingRevision.open();missingRevision.controller.beginReview(missingRevision.action);await missingRevision.controller.submitReview({checked:true,acceptTerms:true});assert.equal(missingRevision.posts().length,0);assert.match(missingRevision.controller.getState().reviewError,/revision is unavailable/);
});

test('receiving staff can reset only an existing review or reservation; unbound staff can request API participation refresh',()=>{
 const d=data('collateral_placed',OWNER),loan=d.state.loans[0];assert.equal(loanTradeActions(d,loan).reset,true);
 loan.tradeFlow.stage='';delete loan.tradeFlow.collateralPlaced;assert.equal(loanTradeActions(d,loan).reset,false);
 loan.tradeFlow.reservedBy=OWNER;assert.equal(loanTradeActions(d,loan).reset,true);
 delete loan.tradeFlow;delete loan.collateralTrade;assert.equal(loanTradeActions(d,loan).refresh,true);assert.equal(loanTradeActions(d,loan)['collateral-reviewed'],false);
});

test('every explicit confirmation uses fresh bank data and one whitelisted POST; UI trade number is never an API trade ID',async()=>{
 for(const action of Object.keys(kinds)){
  const f=scenario(action);await f.open();assert.equal(f.posts().length,0);assert.equal(f.controller.beginReview(action),true);
  await f.controller.submitReview({...f.input,loanId:'FORGED',action:'complete',nativeTradeId:'FORGED',amount:1});
  assert.deepEqual(f.calls.map(call=>call.path),['bank','bank','loan-trade']);
  const payload=f.posts()[0].payload;assert.equal(payload.action,action);assert.equal(payload.loanId,'LOAN-1');assert.equal(payload.key,KEY);assert.equal(payload.nativeTradeId,NATIVE);assert.equal(payload.checked,true);
  assert.equal(Object.hasOwn(payload,'tradeId'),false);assert.equal(Object.hasOwn(payload,'amount'),false);
  if(action==='collateral-reviewed'){assert.equal(payload.itemReference,12e6);assert.equal(payload.piAmount,2e6);assert.match(payload.notes,/Reviewed exact/);}
  else assert.equal(Object.hasOwn(payload,'itemReference'),false);
  assert.equal(f.controller.getState().data.state.loans[0].tradeFlow.stage,kinds[action][2]);assert.equal(f.controller.getState().review,null);assert.ok(f.controller.getState().success);
 }
});

test('an explicit fallback API ID and temporary key stay separate from native identity and never enter controller state',async()=>{
 const f=scenario();f.key='';await f.open();assert.equal(f.controller.getState().savedKeyAvailable,false);f.controller.beginReview(f.action);
 await f.controller.submitReview({checked:true,key:REPLACEMENT,tradeId:API});
 assert.equal(f.posts()[0].payload.key,REPLACEMENT);assert.equal(f.posts()[0].payload.tradeId,API);assert.equal(f.posts()[0].payload.nativeTradeId,NATIVE);
 for(const model of f.models){assert.equal(model.includes(REPLACEMENT),false);assert.equal(model.includes(KEY),false);}
 assert.equal(f.key,'');
});

test('key, acknowledgement, API identity and value errors fail before preflight and never disclose keys',async()=>{
 for(const input of [{checked:true,key:'bad-key'},{checked:false},{checked:true,tradeId:'https://torn.com/trade.php#ID='+NATIVE}]){
  const f=scenario();await f.open();f.controller.beginReview(f.action);await f.controller.submitReview(input);assert.equal(f.calls.length,1);assert.equal(f.posts().length,0);assert.ok(f.controller.getState().reviewError);
 }
 const f=scenario('collateral-reviewed');await f.open();f.controller.beginReview(f.action);await f.controller.submitReview({...f.input,tradeId:NATIVE});assert.equal(f.posts().length,0);assert.match(f.controller.getState().reviewError,/different Torn API trade/);
 await f.controller.submitReview({...f.input,itemReference:'-3m'});assert.equal(f.posts().length,0);
 await f.controller.submitReview({...f.input,notes:''});assert.equal(f.posts().length,0);
 assert.equal(parseReviewAmount('$12,500,000'),12.5e6);assert.equal(parseReviewAmount('2.5m'),2.5e6);assert.throws(()=>parseReviewAmount('9000000000000000'));
});

test('a changed stage, approval terms, PI status, role or account at preflight prevents the write',async()=>{
 const mutations=[
  f=>{f.data.role='borrower';},f=>{f.data.state.staff[0].disabled=true;},f=>{f.data.state.loans[0].principal++;},f=>{f.data.state.loans[0].reference='TLB-CHANGED';},f=>{f.data.state.loans[0].collateralRequired++;},f=>{f.data.state.loans[0].start='2026-11-17';},f=>{f.data.state.borrowers[BORROWER].piRto=false;},f=>{f.data.state.loans[0].tradeFlow.stage='funds_added';},f=>{f.data.user.id=OTHER;}
 ];
 for(const mutate of mutations){const f=scenario('collateral-reviewed');await f.open();f.controller.beginReview(f.action);f.onRead=n=>{if(n===2)mutate(f);};await f.controller.submitReview(f.input);assert.equal(f.posts().length,0);assert.equal(f.controller.getState().success,'');assert.equal(f.controller.getState().review,null);assert.ok(f.controller.getState().reviewError);}
});

test('closing or navigating while preflight is pending cannot send the stage write',async()=>{
 for(const kind of ['close','navigate','account']){
  const f=scenario('collateral-reviewed'),pending=deferred();await f.open();f.controller.beginReview(f.action);f.onRead=n=>n===2?pending.promise:undefined;
  const submit=f.controller.submitReview(f.input);await tick();
  if(kind==='close')await f.controller.setOpen(false);
  else{f.context={...f.context,route:f.context.route+'&changed=1',...(kind==='account'?{accountId:OTHER}:{tradeId:'11687900',reference:'TLB-SECOND'})};await f.controller.contextChanged();}
  pending.resolve(clone(f.data));await submit;assert.equal(f.posts().length,0);assert.equal(f.controller.getState().success,'');
 }
});

test('duplicate submits, cancel, selector and refresh remain locked through an in-flight write',async()=>{
 const f=scenario('collateral-reviewed'),pending=deferred();await f.open();f.controller.beginReview(f.action);f.onWrite=()=>pending.promise;
 const submit=f.controller.submitReview(f.input);await tick();await f.controller.submitReview(f.input);f.controller.cancelReview();f.controller.select('LOAN-2');await f.controller.refresh();
 assert.equal(f.posts().length,1);assert.equal(f.calls.length,3);assert.equal(f.controller.getState().selectedLoanId,'LOAN-1');assert.ok(f.controller.getState().review);assert.equal(f.controller.getState().saving,true);
 pending.resolve(f.result(f.posts()[0].payload));await submit;assert.equal(f.controller.getState().saving,false);assert.ok(f.controller.getState().success);
});

test('close/reopen preserves the pending-write guard and reconciles without stale success or another POST',async()=>{
 const f=scenario('collateral-reviewed'),pending=deferred();await f.open();f.controller.beginReview(f.action);f.onWrite=()=>pending.promise;
 const submit=f.controller.submitReview(f.input);await tick();await f.controller.setOpen(false);await f.controller.setOpen(true);
 assert.equal(f.controller.getState().saving,true);assert.equal(f.controller.beginReview(f.action),false);await f.controller.submitReview(f.input);assert.equal(f.posts().length,1);
 pending.resolve(f.result(f.posts()[0].payload));await submit;assert.equal(f.controller.getState().saving,false);assert.equal(f.controller.getState().success,'');assert.equal(f.controller.getState().data.state.loans[0].tradeFlow.stage,'collateral_reviewed');assert.equal(f.posts().length,1);
});

test('a lost write response reads back authoritative stage, redacts the key and never automatically replays',async()=>{
 const f=scenario('collateral-reviewed');await f.open();f.controller.beginReview(f.action);f.onWrite=payload=>{f.result(payload);throw Error('Network response lost for key '+KEY);};
 await f.controller.submitReview(f.input);assert.equal(f.posts().length,1);assert.deepEqual(f.calls.map(call=>call.path),['bank','bank','loan-trade','bank']);
 assert.equal(f.controller.getState().data.state.loans[0].tradeFlow.stage,'collateral_reviewed');assert.equal(f.controller.getState().success,'');assert.equal(f.controller.getState().review,null);assert.match(f.controller.getState().reviewError,/No automatic retry/);
 for(const captured of f.models)assert.equal(captured.includes(KEY),false);
});

test('a server refusal updates reset stage and reason without announcing the requested step succeeded',async()=>{
 const f=scenario('funds-reviewed');await f.open();f.controller.beginReview(f.action);
 f.onWrite=()=>{const flow=f.data.state.loans[0].tradeFlow;flow.stage='collateral_reviewed';delete flow.fundsAdded;return {...clone(f.data),tradeCheck:{stage:flow.stage,ready:false,reason:'The loan cash changed. Staff must check it again.',apiTradeId:API,nativeTradeId:NATIVE}};};
 await f.controller.submitReview(f.input);assert.equal(f.controller.getState().data.state.loans[0].tradeFlow.stage,'collateral_reviewed');assert.equal(f.controller.getState().success,'');assert.match(f.controller.getState().reviewError,/cash changed/);assert.equal(f.nativeClicks,0);
});

test('only exact authoritative stage records can produce a success message',async()=>{
 for(const change of [result=>{result.tradeCheck.stage='funds_reviewed';},result=>{result.state.loans[0].tradeFlow.collateralReviewed.by=OTHER;},result=>{result.state.loans[0].tradeFlow.apiTradeId='1';}]){
  const f=scenario('collateral-reviewed');await f.open();f.controller.beginReview(f.action);f.onWrite=payload=>{const result=f.result(payload);change(result);return result;};await f.controller.submitReview(f.input);assert.equal(f.controller.getState().success,'');assert.equal(f.posts().length,1);assert.ok(f.controller.getState().reviewError);
 }
});

test('Accept performs a fresh server readiness check then exactly one native initial click without completing the loan',async()=>{
 const f=scenario('accept-ready');await f.open();assert.equal(f.controller.getState().nativeAcceptAvailable,true);assert.equal(f.controller.beginReview('accept-ready'),true);
 await f.controller.submitReview({checked:true});assert.deepEqual(f.calls.map(call=>call.path),['bank','bank','loan-trade']);assert.equal(f.posts()[0].payload.action,'accept-ready');assert.equal(f.nativeClicks,1);
 assert.match(f.controller.getState().success,/Continue Torn confirmation/);assert.equal(f.controller.getState().data.state.loans[0].status,'approved');assert.equal(f.controller.getState().data.state.loans[0].collateralConfirmed,false);
 await f.controller.submitReview({checked:true});assert.equal(f.nativeClicks,1);
});

test('unready API result or unavailable native control never activates Accept; DOM-only availability changes do not fetch',async()=>{
 const f=scenario('accept-ready');f.nativeReady=false;await f.open();assert.equal(f.controller.beginReview('accept-ready'),false);assert.equal(f.posts().length,0);
 f.nativeReady=true;f.controller.contextChanged();assert.equal(f.controller.getState().nativeAcceptAvailable,true);assert.equal(f.calls.length,1);f.controller.beginReview('accept-ready');
 f.onWrite=payload=>({...f.result(payload),tradeCheck:{stage:'funds_reviewed',ready:false,reason:'Funds changed.',apiTradeId:API,nativeTradeId:NATIVE}});
 await f.controller.submitReview({checked:true});assert.equal(f.nativeClicks,0);assert.equal(f.controller.getState().success,'');assert.match(f.controller.getState().reviewError,/Funds changed/);
});
