import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade} from '../lib/collateral-trade.js';
import {inspectLoanTrade,selectLoanTrade,applyLoanTrade} from '../lib/loan-trade.js';
import {tradeReplacementEligibility,inspectTradeReplacement,collectTradeReplacementEvidence,applyTradeReplacement} from '../lib/trade-replacement.js';

const owner='3542697',borrower='9000001',other='9000002',vault='9000101';
const now=Date.now(),started=now-20*60000,apiId='88444',nativeId='11687899';
function fixture(manual=false){
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Fixture cash');TB.person(state,borrower).memberProgram='faction';
 const application={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[{itemId:206,name:'Xanax',qty:14,reference:800000}]}),acceptPreapproval:!manual};
 state=applyAction(state,borrower,'apply',application,TB.today(),{networth:1e9,factionMember:true,checkedAt:new Date().toISOString()});
 if(manual)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,checks:true,reason:'Reviewed'});
 state.applications[0].created=new Date(started-60000).toISOString();
 state.staff.push({id:vault,name:'Other staff',role:'vault'});
 const loan=state.loans[0];prepareCollateralTrade(state,borrower,{loanId:loan.id,recipientId:owner},started);
 claimCollateralTrade(state,borrower,{loanId:loan.id,intentId:loan.collateralTrade.intentId},started+1);
 recordCollateralTrade(state,borrower,{loanId:loan.id,intentId:loan.collateralTrade.intentId,uiTradeId:nativeId,reference:loan.reference},started+2);
 return state;
}
const input=(state,extra={})=>({loanId:state.loans[0].id,intentId:state.loans[0].collateralTrade.intentId,recipientId:owner,checked:true,...extra});
const evidence=(state,changes={})=>({ongoing:[],finished:[],since:Math.floor(started/1000)-1,startedAt:new Date(now-1000).toISOString(),checkedAt:new Date(now).toISOString(),ongoingComplete:true,finishedComplete:true,finishedRequests:1,...changes});
const replace=(state,changes={},proof=evidence(state))=>applyTradeReplacement(state,borrower,'replace-expired',input(state,changes),proof,now);
const reconcile=(state,changes={},proof=evidence(state))=>applyTradeReplacement(state,owner,'reconcile-expired',input(state,{returnedAmount:state.loans[0].principal,notes:'Checked the expired trade and my returned Torn cash.',...changes}),proof,now);
const flow=(state,extra={})=>({version:1,reference:state.loans[0].reference,borrowerId:borrower,staffId:owner,apiTradeId:apiId,nativeTradeId:nativeId,stage:'collateral_placed',reservedBy:null,collateralPlaced:{by:borrower,at:new Date(started+3000).toISOString()},...extra});
const record=(state,id=apiId,completed=null)=>({id:Number(id),description:state.loans[0].reference,user:{id:Number(borrower)},trader:{id:Number(owner)},completed_at:completed,expires_at:completed?null:Math.floor(now/1000)+600,modified_at:completed?null:Math.floor(now/1000)});
const financial=state=>({ledger:state.ledger,collateral:state.collateral,receipts:state.receipts,borrowers:state.borrowers,terms:state.loans[0].borrowerConfirmed,issuer:state.loans[0].issuer,principal:state.loans[0].principal,status:state.loans[0].status});

test('every auto/staff approved loan can repeatedly replace expired attempts with the same reference and new single-use intents',()=>{
 for(const manual of [false,true]){
  let state=fixture(manual);const original=TB.clone(state),reference=state.loans[0].reference,terms=TB.clone(state.loans[0].borrowerConfirmed||null),ids=new Set();
  for(let iteration=0;iteration<4;iteration++){
   const loan=state.loans[0],old=TB.clone(loan.collateralTrade);ids.add(old.intentId);
   loan.tradeFlow=flow(state,{apiTradeId:String(Number(apiId)+iteration),nativeTradeId:old.uiTradeId});const savedFlow=TB.clone(loan.tradeFlow);
   const result=replace(state),next=result.state.loans[0];
   assert.equal(result.replacementCheck.status,'prepared');assert.equal(result.replacementCheck.previousIntentId,old.intentId);
   assert.equal(next.reference,reference);assert.equal(next.collateralTrade.reference,reference);assert.equal(next.collateralTrade.status,'prepared');
   assert.ok(!ids.has(next.collateralTrade.intentId));assert.equal(next.collateralTrade.replacesIntentId,old.intentId);assert.equal(next.tradeFlow,undefined);
   assert.equal(next.collateralTradeHistory.length,iteration+1);assert.deepEqual(next.collateralTradeHistory.at(-1).intent,old);assert.deepEqual(next.collateralTradeHistory.at(-1).flow,savedFlow);
   assert.deepEqual(financial(result.state),financial(state));assert.deepEqual(next.borrowerConfirmed||null,terms);
   assert.throws(()=>claimCollateralTrade(result.state,borrower,{loanId:next.id,intentId:old.intentId},now+1),/does not match/);
   assert.throws(()=>recordCollateralTrade(result.state,borrower,{loanId:next.id,intentId:old.intentId,uiTradeId:old.uiTradeId,reference}),/does not match/);
   // Advance this newly prepared attempt through creation, then model its later expiry.
   next.collateralTrade.requestedAt=new Date(started+iteration*1000).toISOString();next.collateralTrade.expiresAt=started+iteration*1000+120000;
   claimCollateralTrade(result.state,borrower,{loanId:next.id,intentId:next.collateralTrade.intentId},started+iteration*1000+1);
   assert.throws(()=>recordCollateralTrade(result.state,borrower,{loanId:next.id,intentId:next.collateralTrade.intentId,uiTradeId:old.uiTradeId,reference},started+iteration*1000+2),/previous attempt/);
   recordCollateralTrade(result.state,borrower,{loanId:next.id,intentId:next.collateralTrade.intentId,uiTradeId:String(Number(nativeId)+iteration+1),reference},started+iteration*1000+2);
   state=result.state;
  }
  assert.deepEqual(original.loans[0].collateralTradeHistory,undefined);
 }
});

test('replacement requires the current own approved attempt, explicit returned-assets acknowledgement and a settled setup',()=>{
 const state=fixture(),before=TB.clone(state);
 for(const actor of [owner,other,vault])assert.throws(()=>applyTradeReplacement(state,actor,'replace-expired',input(state),evidence(state),now),/Only|receiving/);
 assert.throws(()=>replace(state,{checked:false}),/Confirm the old trade/);
 assert.throws(()=>replace(state,{intentId:'stale'}),/attempt changed/);
 assert.throws(()=>replace(state,{recipientId:'9999999'}),/enabled receiving staff/);
 const recent=TB.clone(state);recent.loans[0].collateralTrade.claimedAt=new Date(now).toISOString();assert.throws(()=>replace(recent),/still recent/);
 for(const status of ['active','withdrawn','repaid']){const invalid=TB.clone(state);invalid.loans[0].status=status;assert.equal(tradeReplacementEligibility(invalid,invalid.loans[0],borrower).available,false);assert.throws(()=>replace(invalid),/Only/);}
 for(const mutate of [s=>{s.loans[0].collateralConfirmed={amount:1,by:owner};},s=>{s.loans[0].fundsReceived={amount:100e6};},s=>{s.ledger.push({loanId:s.loans[0].id});},s=>{s.collateral.push({loanId:s.loans[0].id,event:'received',holder:owner});},s=>{s.recordArchives=[{records:{loans:[{...s.loans[0],status:'active'}]}}];}]){const invalid=TB.clone(state);mutate(invalid);assert.throws(()=>replace(invalid),/records|reconciliation/);}
 assert.deepEqual(state,before);
});

test('ongoing or completed evidence blocks both replacement and manual reconciliation, including retired API IDs with changed descriptions',()=>{
 const state=fixture();state.loans[0].tradeFlow=flow(state,{reservedBy:owner,fundsAdded:{by:owner},stage:'funds_added'});
 const ongoing=record(state),finished=record(state,apiId,Math.floor(now/1000));
 for(const proof of [evidence(state,{ongoing:[ongoing]}),evidence(state,{finished:[finished]}),evidence(state,{finished:[{...finished,description:'changed'}]})])assert.throws(()=>reconcile(state,{},proof),/ongoing|completed/);
 state.loans[0].tradeFlow.reservedBy=null;delete state.loans[0].tradeFlow.fundsAdded;
 for(const proof of [evidence(state,{ongoing:[ongoing]}),evidence(state,{finished:[finished]})])assert.throws(()=>replace(state,{},proof),/ongoing|completed/);
 for(const proof of [evidence(state,{finishedComplete:false}),evidence(state,{since:Math.floor(now/1000)}),evidence(state,{startedAt:new Date(now-130000).toISOString()})])assert.throws(()=>replace(state,{},proof),/complete fresh|expired/);
});

test('history coverage begins at preparation even when native creation happened before the bank claim saved',()=>{
 const state=fixture();state.loans[0].collateralTrade.claimedAt=new Date(started+60000).toISOString();
 const context=inspectTradeReplacement(state,borrower,'replace-expired',input(state),now);
 assert.equal(context.since,Math.floor(started/1000)-1);
 const finished=record(state,apiId,Math.floor((started+30000)/1000));
 assert.throws(()=>replace(state,{},evidence(state,{finished:[finished]})),/completed Torn trade/);
});

test('only receiving staff can explicitly reconcile all returned funds; absence never releases a reservation',()=>{
 const state=fixture();state.loans[0].tradeFlow=flow(state,{reservedBy:owner,fundsAdded:{by:owner,at:new Date(started+4000).toISOString()},fundsReviewed:{by:borrower},stage:'funds_reviewed'});
 const before=TB.clone(state),reserved=TB.reserved(state,owner),eligible=tradeReplacementEligibility(state,state.loans[0],borrower);
 assert.equal(eligible.available,true);assert.equal(eligible.canReplace,false);assert.match(eligible.reason,/staff member/);assert.equal(tradeReplacementEligibility(state,state.loans[0],owner).canReconcile,true);
 assert.throws(()=>replace(state),/returned/);
 for(const actor of [borrower,vault])assert.throws(()=>applyTradeReplacement(state,actor,'reconcile-expired',input(state,{returnedAmount:100e6,notes:'All funds returned.'}),evidence(state),now),/Only/);
 for(const values of [{checked:false},{returnedAmount:99e6},{returnedAmount:'100000000'},{notes:'ok'}])assert.throws(()=>reconcile(state,values),/Confirm|partial|Describe/);
 const result=reconcile(state),loan=result.state.loans[0];
 assert.equal(result.replacementCheck.reconciled,true);assert.equal(loan.tradeFlow.reservedBy,null);assert.equal(loan.tradeFlow.stage,'');assert.equal(loan.tradeFlow.fundsAdded,undefined);
 assert.equal(TB.reserved(result.state,owner),reserved-100e6);assert.deepEqual(financial(result.state),financial(state));
 assert.deepEqual(loan.collateralTrade.fundsReturnReconciled.previousFlow,before.loans[0].tradeFlow);assert.equal(loan.collateralTrade.fundsReturnReconciled.source,'Staff confirmed expired trade funds returned');
 assert.throws(()=>inspectLoanTrade(result.state,borrower,loan.id),/reconciled/);
 const replaced=replace(result.state);assert.equal(replaced.state.loans[0].collateralTrade.status,'prepared');assert.equal(replaced.state.loans[0].collateralTradeHistory[0].intent.fundsReturnReconciled.amount,100e6);
 assert.deepEqual(state,before);
});

test('new attempts cannot review retired API/native trades or accept stale intent form submissions',async()=>{
 const state=fixture();state.loans[0].tradeFlow=flow(state);const result=replace(state),loan=result.state.loans[0],intent=loan.collateralTrade;
 assert.throws(()=>inspectLoanTrade(result.state,borrower,loan.id),/Create and open/);
 intent.status='created';intent.uiTradeId='11687900';
 assert.throws(()=>selectLoanTrade(result.state,borrower,loan.id,[],apiId),/earlier attempt/);
 const newTrade={...record(result.state,'88445'),items:[{user_id:Number(borrower),type:'Money',details:{amount:100e6}},{user_id:Number(borrower),type:'Item',details:{id:206,amount:14}}]};
 const check={loanId:loan.id,intentId:intent.intentId,nativeTradeId:intent.uiTradeId,checked:true};
 await assert.rejects(applyLoanTrade(result.state,borrower,'collateral-placed',{...check,intentId:'old'},newTrade),/attempt changed/);
 await assert.rejects(applyLoanTrade(result.state,borrower,'collateral-placed',{...check,intentId:undefined},newTrade),/Refresh the replacement/);
 await assert.rejects(applyLoanTrade(result.state,borrower,'collateral-placed',{...check,nativeTradeId:nativeId},newTrade),/earlier attempt/);
 await assert.rejects(applyLoanTrade(result.state,borrower,'collateral-placed',check,{...newTrade,id:Number(apiId)}),/earlier attempt/);
 const fresh=await applyLoanTrade(result.state,borrower,'collateral-placed',check,newTrade);assert.equal(fresh.state.loans[0].tradeFlow.apiTradeId,'88445');assert.equal(fresh.state.loans[0].tradeFlow.stage,'collateral_placed');
});

test('finished-history collection checks ongoing first and splits full timestamp ranges without dropping shared timestamps',async()=>{
 const state=fixture(),base=Math.floor(Date.now()/1000)-10,calls=[];
 const rows=Array.from({length:120},(_,i)=>({...record(state,String(1000+i),base+(i<60?1:2)),description:'Unrelated'}));
 const read=async path=>{
  const url=new URL('https://api.torn.com/v2/'+path);calls.push(url);
  if(url.searchParams.get('cat')==='ongoing')return {trades:[]};
  assert.equal(url.searchParams.get('sort'),'ASC');
  const found=rows.filter(row=>row.completed_at>Number(url.searchParams.get('from'))&&row.completed_at<=Number(url.searchParams.get('to')));
  return {trades:found.slice(0,100),_metadata:{links:{next:found.length>100?'https://api.torn.com/v2/user/trades?cat=finished':null}}};
 };
 const proof=await collectTradeReplacementEvidence(read,base);
 assert.equal(calls[0].searchParams.get('cat'),'ongoing');assert.equal(calls.at(-1).searchParams.get('cat'),'ongoing');assert.equal(proof.finished.length,120);assert.equal(new Set(proof.finished.map(row=>row.id)).size,120);assert.equal(proof.finishedComplete,true);assert.ok(proof.finishedRequests>1);
});

test('retired API and native IDs cannot be reused by a different loan, including archived attempts',async()=>{
 for(const archived of [false,true]){
  const state=fixture(),loan=state.loans[0],oldLoan={id:'OLD-LOAN',applicationId:'OLD-APP',collateralTradeHistory:[{intent:{uiTradeId:nativeId},flow:{apiTradeId:apiId,nativeTradeId:nativeId}}]};
  if(archived)state.recordArchives=[{records:{loans:[oldLoan]}}];else state.loans.push(oldLoan);
  assert.throws(()=>selectLoanTrade(state,borrower,loan.id,[],apiId),/earlier attempt/);
  await assert.rejects(applyLoanTrade(state,borrower,'refresh',input(state),record(state)),/earlier attempt/);
  await assert.rejects(applyLoanTrade(state,borrower,'refresh',input(state),record(state,'88445')),/earlier attempt/);
  loan.collateralTrade.status='claimed';delete loan.collateralTrade.uiTradeId;
  assert.throws(()=>recordCollateralTrade(state,borrower,{loanId:loan.id,intentId:loan.collateralTrade.intentId,reference:loan.reference,uiTradeId:nativeId}),/previous attempt/);
 }
});

test('an ongoing trade appearing while finished history is checked still blocks replacement',async()=>{
 const state=fixture();let reads=0;
 const proof=await collectTradeReplacementEvidence(async path=>path.includes('cat=ongoing')?{trades:++reads===1?[]:[record(state)]}:{trades:[],_metadata:{links:{next:null}}},Math.floor(started/1000)-1);
 assert.equal(reads,2);assert.equal(proof.ongoing.length,1);
 assert.throws(()=>applyTradeReplacement(state,borrower,'replace-expired',input(state),proof,Date.now()),/ongoing Torn trade/);
});

test('renaming an ongoing trade during history checks cannot erase the initial matching observation',async()=>{
 const state=fixture();let reads=0;
 const proof=await collectTradeReplacementEvidence(async path=>path.includes('cat=ongoing')?{trades:[{...record(state),description:++reads===1?state.loans[0].reference:'Renamed during check'}]}:{trades:[],_metadata:{links:{next:null}}},Math.floor(started/1000)-1);
 assert.equal(proof.ongoing.length,2);
 assert.throws(()=>applyTradeReplacement(state,borrower,'replace-expired',input(state),proof,Date.now()),/ongoing Torn trade/);
});

test('history collection fails closed on missing metadata, API errors, malformed pages and saturated single-second windows',async()=>{
 const state=fixture(),base=Math.floor(Date.now()/1000)-10;
 for(const malformed of [{trades:[]},{trades:'no',_metadata:{links:{next:null}}},{trades:[{id:1}],_metadata:{links:{next:null}}},{trades:[record(state,'1000',base-1)],_metadata:{links:{next:null}}}]){
  await assert.rejects(collectTradeReplacementEvidence(async path=>path.includes('cat=ongoing')?{trades:[]}:malformed,base),/complete|inconsistent|incomplete/);
 }
 await assert.rejects(collectTradeReplacementEvidence(async()=>{throw Error('API unavailable');},base),/API unavailable/);
 const crowded=Array.from({length:100},(_,i)=>record(state,String(1000+i),base+1));
 await assert.rejects(collectTradeReplacementEvidence(async path=>{if(path.includes('cat=ongoing'))return {trades:[]};const url=new URL('https://api.torn.com/v2/'+path),rows=crowded.filter(row=>row.completed_at>Number(url.searchParams.get('from'))&&row.completed_at<=Number(url.searchParams.get('to')));return {trades:rows,_metadata:{links:{next:null}}};},base),/same timestamp/);
});
