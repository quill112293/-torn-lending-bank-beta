import {fundingRecord} from './helpers/funding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {canWithdrawApplication} from '../lib/application-withdrawal.js';
import {reconcileTrade} from '../lib/trades.js';
import {inspectLoanTrade,selectLoanTrade,applyLoanTrade,verifyClaimedTradeDescription} from '../lib/loan-trade.js';

const owner='3542697',borrower='9000001',other='9000002',vault='9000101';
const apiTradeId='88444',nativeTradeId='11687899',itemReference=14*800000,notes='Reviewed 14 Xanax in this trade at the accepted reference value.';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function approved(manual=false,overrides={}){
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Initial bank cash');TB.person(state,borrower).memberProgram='faction';
 const application={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[{itemId:206,name:'Xanax',qty:14,reference:800000}],...overrides}),acceptPreapproval:!manual};
 state=applyAction(state,borrower,'apply',application,TB.today(),verified);
 if(manual)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,checks:true,reason:'Reviewed terms'});
 state.applications[0].created=new Date(Date.now()-60000).toISOString();
 return state;
}
function trade(state,lenderCash=0,changes={}){
 const loan=fundingRecord(state),staffId=loan.tradeFlow?.staffId||loan.collateralTrade?.recipientId||owner;
 return {id:Number(apiTradeId),description:loan.reference,user:{id:Number(borrower)},trader:{id:Number(staffId)},completed_at:null,expires_at:Math.floor(Date.now()/1000)+3600,modified_at:Math.floor(Date.now()/1000),items:[{user_id:Number(borrower),type:'Money',details:{amount:100e6}},{user_id:Number(borrower),type:'Item',details:{id:206,uid:null,amount:14}},...(lenderCash?[{user_id:Number(staffId),type:'Money',details:{amount:lenderCash}}]:[])],...changes};
}
const step=(state,actor,action,offer=trade(state),input={},now=Date.now())=>applyLoanTrade(state,actor,action,{loanId:fundingRecord(state).id,nativeTradeId,checked:true,...(input.acceptTerms===true?{termsRevision:state.revision}:{}),...input},offer,now);
async function reviewed(state=approved(),now=Date.now()){
 state=(await step(state,borrower,'collateral-placed',trade(state),{acceptTerms:true},now)).state;
 return (await step(state,owner,'collateral-reviewed',trade(state),{itemReference,notes},now)).state;
}
async function ready(state=approved(),now=Date.now()){
 state=await reviewed(state,now);
 state=(await step(state,owner,'funds-added',trade(state,100e6),{},now)).state;
 return (await step(state,borrower,'funds-reviewed',trade(state,100e6),{},now)).state;
}
function completeTrade(state,now=Date.now()){return trade(state,100e6,{completed_at:Math.ceil(now/1000),expires_at:null,modified_at:null});}
function finances(state){return {ledger:state.ledger,collateral:state.collateral,principal:fundingRecord(state).principal,status:fundingRecord(state).status,issuer:fundingRecord(state).issuer,payments:fundingRecord(state).payments,collateralConfirmed:fundingRecord(state).collateralConfirmed,borrowers:state.borrowers};}

test('automatic and staff approvals settle one gross two-way trade only after all checks and staff completion',async()=>{
 for(const manual of [false,true]){
  const initial=approved(manual),before=TB.clone(initial),state=await ready(initial),loan=fundingRecord(state);
  assert.deepEqual(initial,before,'Staged operations must not mutate their input state.');
  assert.deepEqual(finances(state),finances(before));assert.equal(state.loans.length,0);assert.equal(state.fundingRequests.length,1);assert.equal(TB.balance(loan,state.testDate).total,0);assert.deepEqual(TB.scheduleRows(loan,state.testDate),[]);
  assert.equal(loan.tradeFlow.stage,'funds_reviewed');assert.equal(loan.tradeFlow.reservedBy,owner);
  assert.equal(TB.reserved(state,owner),100e6);assert.equal(TB.spendable(state,owner),900e6);
  assert.equal(loan.tradeFlow.apiTradeId,apiTradeId);assert.equal(loan.tradeFlow.nativeTradeId,nativeTradeId);
  for(const actor of [borrower,owner])assert.equal((await step(state,actor,'accept-ready',trade(state,100e6))).tradeCheck.ready,true);
  assert.equal(loan.collateralConfirmed,false);assert.equal(loan.fundsReceived,undefined);
  const terms=TB.clone(loan.borrowerConfirmed),finished=completeTrade(state),result=await step(state,owner,'complete',finished),saved=result.state,settled=fundingRecord(saved);
  assert.equal(result.tradeCheck.stage,'completed');assert.equal(result.tradeCheck.ready,false);
  assert.equal(saved.loans.length,1);assert.equal(saved.fundingRequests.length,0);assert.equal(settled.status,'active');assert.equal(settled.issuer,owner);assert.equal(settled.tradeFlow.reservedBy,null);
  assert.equal(settled.collateralConfirmed.cash,100e6);assert.equal(settled.collateralConfirmed.amount,100e6+Math.floor(itemReference*.9));
  assert.equal(settled.fundsReceived.amount,100e6);assert.equal(settled.fundsReceived.by,owner);assert.equal(settled.fundsReceived.source,'Torn API completed loan trade');
  assert.equal(TB.cash(saved,owner),900e6,'Incoming collateral is not spendable bank cash and must not net against principal.');
  assert.deepEqual(settled.borrowerConfirmed,terms);assert.equal(saved.collateral.length,1);assert.equal(saved.receipts.length,1);
  assert.equal(saved.receipts[0].status,'loan_trade');assert.equal(saved.receipts[0].cash,100e6);assert.equal(saved.receipts[0].outgoing,100e6);
  assert.equal(saved.ledger.filter(entry=>entry.type==='disbursement').length,1);
  const repeated=await step(saved,owner,'complete',finished);
  assert.equal(repeated.changed,false);assert.deepEqual(repeated.state,saved);
 }
});

test('API trade selection requires exact reference and participants and keeps native IDs separate',()=>{
 const state=approved(),offer=trade(state);
 assert.equal(selectLoanTrade(state,borrower,fundingRecord(state).id,[offer]),apiTradeId);
 assert.throws(()=>selectLoanTrade(state,borrower,fundingRecord(state).id,[offer,{...offer,id:88445}]),/More than one/);
 assert.throws(()=>selectLoanTrade(state,borrower,fundingRecord(state).id,[{...offer,description:'TLB-WRONG'}]),/No matching/);
 assert.throws(()=>selectLoanTrade(state,borrower,fundingRecord(state).id,[{...offer,trader:{id:9999999}}]),/No matching/);
 fundingRecord(state).tradeFlow={apiTradeId,staffId:owner};
 assert.throws(()=>selectLoanTrade(state,borrower,fundingRecord(state).id,[],nativeTradeId),/different Torn API/);
 assert.equal(selectLoanTrade(state,borrower,fundingRecord(state).id,[],apiTradeId),apiTradeId);
});

test('mobile link recovery requires a unique ongoing API description and the assigned staff member',()=>{
 const state=approved(),loan=fundingRecord(state),offer=trade(state);
 loan.collateralTrade={intentId:'trade-attempt',status:'claimed',recipientId:owner};
 const input={loanId:loan.id,intentId:'trade-attempt'};
 assert.doesNotThrow(()=>verifyClaimedTradeDescription(state,borrower,input,[offer]));
 for(const records of [[{...offer,description:'Other'}],[{...offer,trader:{id:other}}],[offer,{...offer,id:88445}],[{...offer,completed_at:100}]]){
  assert.throws(()=>verifyClaimedTradeDescription(state,borrower,input,records),/exactly one ongoing/);
 }
});

test('manual terms require separate explicit borrower consent and audit the actual approved terms',async()=>{
 const state=approved(true),before=TB.clone(state);
 await assert.rejects(step(state,borrower,'collateral-placed'),/Accept the approved loan terms/);
 await assert.rejects(step(state,owner,'collateral-placed',trade(state),{acceptTerms:true}),/Only the borrower/);
 await assert.rejects(step(state,borrower,'collateral-placed',trade(state),{acceptTerms:true,checked:false}),/Accept the approved loan terms/);
 await assert.rejects(step(state,borrower,'collateral-placed',trade(state),{acceptTerms:true,termsRevision:state.revision+1}),/Refresh and explicitly accept/);
 await assert.rejects(step(state,borrower,'collateral-placed',trade(state),{acceptTerms:true,termsRevision:undefined}),/Refresh and explicitly accept/);
 assert.deepEqual(state,before);
 const result=await step(state,borrower,'collateral-placed',trade(state),{acceptTerms:true}),loan=fundingRecord(result.state);
 assert.equal(loan.borrowerConfirmed.by,borrower);assert.equal(loan.borrowerConfirmed.reference,loan.reference);assert.equal(loan.borrowerConfirmed.source,'Accepted with collateral placement');
 const event=result.state.audit.find(entry=>entry.source==='Accepted with collateral placement');
 assert.equal(event.actor,borrower);assert.equal(event.acceptedTerms.principal,loan.principal);assert.equal(event.acceptedTerms.rate,loan.rate);
 const repeat=await step(result.state,borrower,'collateral-placed',trade(result.state),{acceptTerms:true});
 assert.equal(repeat.changed,false);assert.deepEqual(repeat.state,result.state);
});

test('stages cannot be skipped, impersonated, unchecked or rebound to another trade',async()=>{
 const state=approved();
 await assert.rejects(step(state,other,'collateral-placed'),/Only this borrower/);
 for(const action of ['funds-added','collateral-reviewed','complete','reset'])await assert.rejects(step(state,borrower,action),/Only the receiving/);
 await assert.rejects(step(state,owner,'funds-added',trade(state,100e6)),/review the collateral first/);
 await assert.rejects(step(state,borrower,'funds-reviewed',trade(state,100e6)),/confirm and reserve/);
 await assert.rejects(step(state,borrower,'collateral-placed',trade(state),{checked:false}),/Confirm that you reviewed/);
 const current=await ready();
 await assert.rejects(step(current,owner,'complete',trade(current,100e6)),/completed Torn API/);
 await assert.rejects(step(current,borrower,'refresh',{...trade(current),id:88445}),/different Torn API/);
 await assert.rejects(step(current,borrower,'refresh',trade(current),{nativeTradeId:'999'}),/native Torn trade page/);
 current.staff[0].disabled=true;
 await assert.rejects(step(current,borrower,'accept-ready',trade(current,100e6)),/no longer available/);
});

test('placement checks exact proposed cash and item quantities, with explicit staff mapping for legacy names',async()=>{
 for(const mutate of [offer=>{offer.items[0].details.amount=99e6;},offer=>{offer.items[1].details.amount=13;},offer=>{offer.items[1].details.id=999;}]){
  const state=approved(),offer=trade(state);mutate(offer);
  await assert.rejects(step(state,borrower,'collateral-placed',offer),/collateral proposal/);
 }
 const legacy=approved();delete legacy.applications[0].items[0].itemId;delete fundingRecord(legacy).expectedCollateral.items[0].itemId;
 const placed=(await step(legacy,borrower,'collateral-placed')).state;
 assert.equal(fundingRecord(placed).tradeFlow.manualItemReviewRequired,true);
 await assert.rejects(step(placed,owner,'collateral-reviewed',trade(placed),{itemReference,notes:''}),/record notes/);
 const reviewedState=(await step(placed,owner,'collateral-reviewed',trade(placed),{itemReference,notes:'Manually matched 14 Xanax to Torn item206 and reviewed its value.'})).state;
 assert.deepEqual(fundingRecord(reviewedState).tradeFlow.collateralReviewed.items,[{itemId:206,qty:14}]);
 const missing=approved();delete fundingRecord(missing).expectedCollateral;delete missing.applications[0].items;
 assert.throws(()=>inspectLoanTrade(missing,borrower,fundingRecord(missing).id),/breakdown is unavailable/);
});

test('borrower changes persist full invalidation while lender changes preserve reviewed collateral and reservations',async()=>{
 const state=await ready(),review=TB.clone(fundingRecord(state).tradeFlow.collateralReviewed),changedBorrower=trade(state,100e6);
 changedBorrower.items[1].details.amount=15;
 const borrowerResult=await step(state,borrower,'accept-ready',changedBorrower);
 assert.match(borrowerResult.tradeCheck.reason,/borrower collateral changed/);assert.equal(borrowerResult.tradeCheck.stage,'');
 assert.equal(fundingRecord(borrowerResult.state).tradeFlow.collateralReviewed,undefined);assert.equal(fundingRecord(borrowerResult.state).tradeFlow.reservedBy,owner);
 assert.deepEqual(finances(borrowerResult.state),finances(state));
 const lenderResult=await step(state,borrower,'accept-ready',trade(state,99e6));
 assert.equal(lenderResult.tradeCheck.stage,'collateral_reviewed');assert.match(lenderResult.tradeCheck.reason,/lender funds changed/);
 assert.deepEqual(fundingRecord(lenderResult.state).tradeFlow.collateralReviewed,review);assert.equal(fundingRecord(lenderResult.state).tradeFlow.reservedBy,owner);
 assert.equal(canWithdrawApplication(lenderResult.state,lenderResult.state.applications[0],borrower),false);
 const unsupported=trade(state,100e6);unsupported.items.push({user_id:Number(borrower),type:'Property',details:{id:1}});
 const rejected=await step(state,owner,'complete',{...unsupported,completed_at:Math.ceil(Date.now()/1000)});
 assert.equal(rejected.tradeCheck.stage,'');assert.match(rejected.tradeCheck.reason,/cash and item collateral only/);
 assert.equal(fundingRecord(rejected.state).status,'approved');assert.equal(fundingRecord(rejected.state).tradeFlow.reservedBy,owner);
});

test('safe reset requires receiving staff and a current ongoing zero-cash lender offer',async()=>{
 const state=await ready();
 await assert.rejects(step(state,owner,'reset',trade(state,100e6)),/no lender cash/);
 await assert.rejects(step(state,owner,'reset',completeTrade(state)),/ongoing Torn trade/);
 const reset=await step(state,owner,'reset',trade(state,0));
 assert.equal(reset.tradeCheck.stage,'');assert.equal(fundingRecord(reset.state).tradeFlow.reservedBy,null);
 for(const field of ['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'])assert.equal(fundingRecord(reset.state).tradeFlow[field],undefined);
 assert.equal(TB.spendable(reset.state,owner),1e9);assert.deepEqual(finances(reset.state),finances(state));
 assert.equal(fundingRecord(reset.state).tradeFlow.apiTradeId,apiTradeId);
});

test('terms changes invalidate preaccept checks and reserved trades block manual funding',async()=>{
 let state=await reviewed();
 state=applyAction(state,owner,'startDate',{id:fundingRecord(state).id,start:TB.addDays(TB.today(),1)});
 const invalidated=await step(state,borrower,'refresh',trade(state));
 assert.equal(invalidated.tradeCheck.stage,'');assert.match(invalidated.tradeCheck.reason,/terms changed/);assert.equal(fundingRecord(invalidated.state).tradeFlow.collateralReviewed,undefined);
 const locked=await ready(),before=TB.clone(locked);
 assert.throws(()=>applyAction(locked,owner,'fund',{id:fundingRecord(locked).id,reference:'Separate funding'}),/trade-page menu|Torn trade page/);
 assert.throws(()=>applyAction(locked,borrower,'withdrawApplication',{id:locked.applications[0].id}),/trade|reserved/);
 assert.throws(()=>applyAction(locked,owner,'startDate',{id:fundingRecord(locked).id,start:TB.addDays(TB.today(),1)}),/trade|reserved/);
 assert.deepEqual(locked,before);
});

test('reservations use the actual receiving lender once and respect cash, pending handovers and old approval holds',async()=>{
 let state=approved(true);state.staff.push({id:vault,name:'Vault lender',role:'vault',parent:owner});
 TB.requestTransfer(state,vault,300e6);state.actorId=vault;TB.confirmTransfer(state,state.transfers[0].id,'Vault received');state.actorId=owner;
 fundingRecord(state).collateralTrade={recipientId:vault};
 state=(await step(state,borrower,'collateral-placed',trade(state),{acceptTerms:true})).state;
 state=(await step(state,vault,'collateral-reviewed',trade(state),{itemReference,notes})).state;
 assert.equal(TB.reserved(state,owner),100e6);
 state=(await step(state,vault,'funds-added',trade(state,100e6))).state;
 assert.equal(TB.reserved(state,owner),0);assert.equal(TB.reserved(state,vault),100e6);assert.equal(TB.spendable(state,vault),200e6);
 assert.equal(fundingRecord(state).issuer,owner,'Reservation does not pretend disbursement already occurred.');
 const repeated=await step(state,vault,'funds-added',trade(state,100e6));assert.equal(repeated.changed,false);
 const poor=await reviewed();poor.ledger[0].amount=50e6;
 await assert.rejects(step(poor,owner,'funds-added',trade(poor,100e6)),/enough unreserved bank cash/);
 assert.equal(fundingRecord(poor).tradeFlow.reservedBy,null);
});

test('standing, bank availability and start day gate acceptance but completed authorized transfers are still recorded',async()=>{
 const readyState=await ready();
 for(const mutate of [state=>{state.bankOnline=false;},state=>{state.borrowers[borrower].flags.push({id:'ban',reason:'Restricted'});}]){
  const state=TB.clone(readyState);mutate(state);
  await assert.rejects(step(state,borrower,'accept-ready',trade(state,100e6)),/offline|Do Not Lend/);
  const recorded=await step(state,owner,'complete',completeTrade(state));
  assert.equal(fundingRecord(recorded.state).status,'active');assert.deepEqual(recorded.state.borrowers,state.borrowers);
 }
 const state=await reviewed();fundingRecord(state).start=TB.addDays(TB.today(),1);
 const invalidated=await step(state,owner,'funds-added',trade(state,100e6));
 assert.equal(invalidated.tradeCheck.stage,'');assert.equal(fundingRecord(invalidated.state).tradeFlow.reservedBy,null);
});

test('completion after midnight starts the loan on the actual transfer date and preserves the agreed term length',async()=>{
 const previous=TB.addDays(TB.today(),-1),stageTime=Date.parse(previous+'T23:59:50.000Z'),completion=Date.parse(TB.today()+'T00:00:05.000Z');
 const initial=approved();fundingRecord(initial).start=previous;initial.applications[0].created=previous+'T00:00:00.000Z';
 const state=await ready(initial,stageTime),terms={start:fundingRecord(state).start,maturity:fundingRecord(state).maturity,rate:fundingRecord(state).rate};
 const offer=trade(state,100e6,{completed_at:completion/1000,expires_at:null});
 const result=await step(state,owner,'complete',offer,{},Math.max(Date.now(),completion));
 assert.equal(result.state.ledger.find(entry=>entry.type==='disbursement').date,TB.today());
 assert.equal(result.state.loans[0].start,TB.today());assert.equal(result.state.loans[0].maturity,TB.addDays(terms.maturity,1));assert.equal(result.state.loans[0].rate,terms.rate);assert.deepEqual(result.state.loans[0].approvedDates,{start:terms.start,maturity:terms.maturity});
});

test('consumed live or archived proof cannot settle another loan or be reused for repayment',async()=>{
 const state=await ready(),reference='torn-api-trade:'+apiTradeId;
 const conflicts=[
  s=>s.pendingPayments.push({reference}),
  s=>s.receipts.push({id:'Used',reference,status:'credited',paymentId:'PAY-used'}),
  s=>s.ledger.push({id:'Other-ledger',reference,type:'funding',from:'external',to:owner,amount:1,date:TB.today()}),
  s=>{s.removedReferences=[reference];},
  s=>{s.recordArchives=[{records:{loans:[{id:'OTHER',fundsReceived:{reference}}]}}];},
  s=>{s.recordArchives=[{records:{receipts:[{id:'Archived',reference,status:'review'}]}}];}
 ];
 for(const conflict of conflicts){const candidate=TB.clone(state);conflict(candidate);const before=TB.clone(candidate);await assert.rejects(step(candidate,owner,'complete',completeTrade(candidate)),/recorded|archived|consumed|another/);assert.deepEqual(candidate,before);}
 const done=(await step(state,owner,'complete',completeTrade(state))).state;
 assert.throws(()=>applyAction(done,owner,'payment',{id:fundingRecord(done).id,cash:1,reference,recipient:owner,date:TB.today()}),/already recorded/);
});

test('an unassigned matching two-way review receipt is consumed once by the atomic settlement',async()=>{
 const state=await ready(),offer=completeTrade(state),synced=reconcileTrade(state,owner,offer).state,id=synced.receipts[0].id;
 assert.equal(synced.receipts[0].status,'review');
 const done=(await step(synced,owner,'complete',offer)).state;
 assert.equal(done.receipts.length,1);assert.equal(done.receipts[0].id,id);assert.equal(done.receipts[0].status,'loan_trade');
 assert.equal(done.ledger.filter(entry=>entry.type==='disbursement').length,1);
});
