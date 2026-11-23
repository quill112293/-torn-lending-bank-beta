import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade} from '../lib/collateral-trade.js';
import {applyLoanTrade} from '../lib/loan-trade.js';
import {applyManualLoanTrade} from '../lib/manual-loan-trade.js';
import {reconcileTrade} from '../lib/trades.js';
import {fundingRecord,readyFunding,seedHistoricalFundedLoan} from './helpers/funding.mjs';

const owner='3542697',borrower='9000001',outsider='9000102',nativeTradeId='11687899';
const itemReference=14*800000,notes='Manually checked the fourteen Xanax and confirmed their value.';
function approved({staffApproval=false,now=Date.now(),...overrides}={}){
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Initial recorded funds');TB.person(state,borrower).memberProgram='faction';
 const app={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[{itemId:206,name:'Xanax',qty:14,reference:800000}],...overrides}),acceptPreapproval:!staffApproval};
 state=applyAction(state,borrower,'apply',app,TB.today(),{networth:1e9,factionMember:true,checkedAt:new Date(now).toISOString()});
 if(staffApproval)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,checks:true,reason:'Reviewed application'});
 state.applications[0].created=new Date(now-60000).toISOString();
 const loan=fundingRecord(state);
 if(loan.borrowerConfirmed)loan.borrowerConfirmed.at=new Date(now-60000).toISOString();
 const intent=prepareCollateralTrade(state,borrower,{loanId:loan.id,recipientId:owner},now-59000);
 claimCollateralTrade(state,borrower,{loanId:loan.id,intentId:intent.intentId},now-58000);
 recordCollateralTrade(state,borrower,{loanId:loan.id,intentId:intent.intentId,reference:loan.reference,uiTradeId:nativeTradeId},now-57000);
 return state;
}
const payload=(state,action,extra={})=>{
 const loan=fundingRecord(state);
 return {manual:true,action,loanId:loan.id,intentId:loan.collateralTrade.intentId,reference:loan.reference,nativeTradeId,reviewRevision:state.revision,checked:true,...extra};
};
const step=(state,actor,action,extra={},now=Date.now())=>applyManualLoanTrade(state,actor,action,payload(state,action,extra),now);
const staffValues={cashCollateral:100e6,itemReference,piAmount:0,notes,fundsAmount:100e6};
async function placed(state=approved(),now=Date.now()){
 const loan=fundingRecord(state);
 return (await step(state,borrower,'collateral-placed',!loan.borrowerConfirmed?{acceptTerms:true,termsRevision:state.revision}:{},now)).state;
}
async function ready(state=approved(),now=Date.now()){
 state=await placed(state,now);
 return (await step(state,owner,'funds-added',staffValues,now)).state;
}

test('three manual confirmations activate exactly one loan without API or synthetic borrower funds confirmation',async()=>{
 for(const staffApproval of [false,true]){
  const initial=approved({staffApproval}),before=TB.clone(initial),originalCreated=initial.applications[0].created;
  const first=await step(initial,borrower,'collateral-placed',staffApproval?{acceptTerms:true,termsRevision:initial.revision}:{});
  assert.equal(first.tradeCheck.verificationMode,'manual');assert.equal(first.tradeCheck.stage,'collateral_placed');assert.equal(first.tradeCheck.ready,false);
  assert.equal(first.tradeCheck.reference,fundingRecord(initial).reference);assert.equal(first.tradeCheck.nativeTradeId,nativeTradeId);assert.equal(first.tradeCheck.intentId,fundingRecord(initial).collateralTrade.intentId);
  assert.deepEqual(initial,before);assert.equal(first.state.loans.length,0);assert.equal(first.state.ledger.length,1);
  const second=await step(first.state,owner,'funds-added',staffValues),loan=fundingRecord(second.state);
  assert.equal(second.tradeCheck.stage,'funds_added');assert.equal(second.tradeCheck.ready,true);assert.equal(loan.tradeFlow.reservedBy,owner);
  assert.equal(loan.tradeFlow.fundsReviewed,undefined);assert.equal(loan.tradeFlow.collateralReviewed,undefined);assert.equal(loan.tradeFlow.apiTradeId,undefined);
  assert.equal(loan.tradeFlow.fundsAdded.amount,100e6);assert.equal(TB.reserved(second.state,owner),100e6);assert.equal(TB.cash(second.state,owner),1e9);
  assert.equal(TB.balance(loan,second.state.testDate).total,0);assert.equal(second.state.loans.length,0);
  for(const actor of [owner,borrower])assert.equal((await step(second.state,actor,'accept-ready')).tradeCheck.ready,true);
  assert.equal((await step(second.state,borrower,'refresh')).tradeCheck.ready,true);
  const final=await step(second.state,owner,'complete'),saved=fundingRecord(final.state);
  assert.equal(final.tradeCheck.stage,'completed');assert.equal(final.state.loans.length,1);assert.equal(final.state.fundingRequests.length,0);assert.equal(saved.status,'active');
  assert.equal(saved.collateralTrade.status,'completed');assert.equal(saved.tradeFlow.reservedBy,null);
  for(const proof of [saved.tradeFlow.completion,saved.collateralConfirmed,saved.fundsReceived])assert.equal(proof.source,'Manual staff confirmation');
  assert.equal(saved.tradeFlow.completion.reference,'manual-loan-trade:'+nativeTradeId);assert.equal(saved.tradeFlow.completion.apiTradeId,undefined);
  assert.equal(saved.fundsReceived.amount,100e6);assert.equal(saved.collateralConfirmed.amount,100e6+itemReference*.9);
  assert.equal(final.state.ledger.filter(entry=>entry.type==='disbursement').length,1);assert.equal(final.state.collateral.length,1);assert.equal(final.state.receipts.length,1);assert.equal(TB.cash(final.state,owner),900e6);
  assert.equal(final.state.applications[0].created,originalCreated);assert.equal(final.state.applications[0].tradeCompletion.source,'Manual staff confirmation');
  const repeat=await step(final.state,owner,'complete');assert.equal(repeat.changed,false);assert.deepEqual(repeat.state,final.state);
 }
});

test('roles, exact saved identity, checkbox and ordering are enforced without touching input state',async()=>{
 const initial=approved(),before=TB.clone(initial);
 for(const [actor,action] of [[owner,'collateral-placed'],[borrower,'funds-added'],[borrower,'complete'],[outsider,'refresh']])await assert.rejects(step(initial,actor,action,staffValues),/Only/);
 await assert.rejects(step(initial,owner,'funds-added',staffValues),/borrower must manually confirm/);
 await assert.rejects(step(initial,owner,'complete'),/borrower must manually confirm/);
 await assert.rejects(step(initial,borrower,'collateral-placed',{checked:false}),/manually reviewed/);
 for(const extra of [{reference:'TLB-OTHER'},{intentId:'OTHER'},{nativeTradeId:'999'},{manual:false}])await assert.rejects(step(initial,borrower,'collateral-placed',extra),/changed|saved Torn trade|supported manual/);
 for(const action of ['collateral-reviewed','funds-reviewed'])await assert.rejects(step(initial,owner,action),/supported manual/);
 assert.deepEqual(initial,before);
});

test('terms consent is genuine borrower acceptance of the current revision',async()=>{
 const state=approved({staffApproval:true});
 for(const extra of [{},{acceptTerms:true,termsRevision:state.revision+1},{acceptTerms:true,termsRevision:undefined}])await assert.rejects(step(state,borrower,'collateral-placed',extra),/accept|terms|Refresh/);
 const result=await step(state,borrower,'collateral-placed',{acceptTerms:true,termsRevision:state.revision});
 const loan=fundingRecord(result.state);
 assert.equal(loan.borrowerConfirmed.by,borrower);assert.equal(loan.borrowerConfirmed.reference,loan.reference);assert.equal(loan.borrowerConfirmed.source,'Accepted with manual collateral confirmation');
 assert.equal(result.state.audit.find(event=>event.source==='Accepted with manual collateral confirmation').acceptedTerms.principal,100e6);
 const incomplete=approved();fundingRecord(incomplete).borrowerConfirmed={by:owner,at:new Date().toISOString(),reference:loan.reference};
 await assert.rejects(step(incomplete,borrower,'collateral-placed'),/Explicitly accept/);
});

test('staff combines valuation with exact principal and sufficient reserved bank cash',async()=>{
 const state=await placed(),before=TB.clone(state);
 for(const extra of [{fundsAmount:99e6},{cashCollateral:99e6},{itemReference:0},{notes:''},{piAmount:1}])await assert.rejects(step(state,owner,'funds-added',{...staffValues,...extra}),/exact|value|notes|PI/);
 const poor=TB.clone(state);poor.ledger[0].amount=50e6;
 await assert.rejects(step(poor,owner,'funds-added',staffValues),/unreserved bank cash/);
 const result=await step(state,owner,'funds-added',staffValues);
 assert.equal(TB.spendable(result.state,owner),900e6);
 assert.equal((await step(result.state,owner,'funds-added',staffValues)).changed,false);
 await assert.rejects(step(result.state,owner,'funds-added',{...staffValues,itemReference:itemReference+1}),/already confirmed/);
 assert.throws(()=>applyAction(result.state,borrower,'withdrawApplication',{id:result.state.applications[0].id}),/committed|reserved/);
 assert.deepEqual(state,before);
});

test('legacy API progress restarts manual confirmations while preserving reservation and its original evidence',async()=>{
 const initial=await readyFunding(approved(),{itemReference,notes}),old=TB.clone(fundingRecord(initial).tradeFlow);
 assert.equal(old.stage,'funds_reviewed');assert.equal(TB.reserved(initial,owner),100e6);
 const read=await step(initial,owner,'refresh');assert.equal(read.changed,false);assert.equal(read.tradeCheck.stage,'');assert.equal(read.tradeCheck.requiresManualRestart,true);assert.equal(read.tradeCheck.ready,false);
 await assert.rejects(step(initial,owner,'funds-added',staffValues),/borrower must manually confirm/);
 await assert.rejects(step(initial,owner,'complete'),/borrower must manually confirm/);
 const first=await step(initial,borrower,'collateral-placed'),loan=fundingRecord(first.state);
 assert.equal(loan.tradeFlow.verificationMode,'manual');assert.equal(loan.tradeFlow.stage,'collateral_placed');assert.equal(loan.tradeFlow.reservedBy,owner);
 assert.equal(loan.tradeFlow.apiTradeId,old.apiTradeId);assert.deepEqual(loan.tradeVerificationHistory[0].flow,old);
 assert.equal(loan.tradeFlow.fundsReviewed,undefined);assert.equal(loan.tradeFlow.fundsAdded,undefined);assert.equal(TB.reserved(first.state,owner),100e6);
 const second=await step(first.state,owner,'funds-added',staffValues);assert.equal(TB.reserved(second.state,owner),100e6);
 const final=await step(second.state,owner,'complete');assert.equal(final.state.ledger.filter(entry=>entry.type==='disbursement').length,1);
 await assert.rejects(applyLoanTrade(first.state,owner,'refresh',{loanId:loan.id},{}),/manual confirmation/);
});

test('reserved existing funds can be reconfirmed after midnight or a hold without authorizing a new acceptance',async()=>{
 const previous=TB.addDays(TB.today(),-1),stageTime=Date.parse(previous+'T23:59:00Z');
 const initial=await readyFunding(approved({now:stageTime,start:previous}),{itemReference,notes,now:stageTime});
 initial.bankOnline=false;initial.borrowers[borrower].flags.push({reason:'New lending paused'});
 const originalMaturity=fundingRecord(initial).maturity;
 const first=await placed(initial),second=await step(first,owner,'funds-added',staffValues);
 assert.equal(second.tradeCheck.stage,'funds_added');assert.equal(second.tradeCheck.ready,false);assert.match(second.tradeCheck.acceptanceBlockedReason,/offline/);assert.equal(second.tradeCheck.reason,undefined);
 await assert.rejects(step(second.state,borrower,'accept-ready'),/offline/);
 const read=await step(second.state,borrower,'refresh');assert.equal(read.tradeCheck.ready,false);assert.match(read.tradeCheck.reason,/offline/);
 const final=await step(second.state,owner,'complete'),loan=fundingRecord(final.state);
 assert.equal(loan.status,'active');assert.equal(loan.start,TB.today());assert.equal(loan.maturity,TB.addDays(originalMaturity,1));
 const fresh=await placed(approved({start:previous}));await assert.rejects(step(fresh,owner,'funds-added',staffValues),/start day/);
});

test('reset requires explicit staff reconciliation and does not release commitments on rejected requests',async()=>{
 const state=await ready(),before=TB.clone(state);
 for(const [actor,extra] of [[borrower,{notes:'Loan funds removed'}],[owner,{checked:false,notes:'Loan funds removed'}],[owner,{notes:'short'}]])await assert.rejects(step(state,actor,'reset',extra),/Only|reviewed|Describe/);
 assert.deepEqual(state,before);
 const result=await step(state,owner,'reset',{notes:'Trade did not complete and all offered loan funds were removed.'}),loan=fundingRecord(result.state);
 assert.equal(loan.tradeFlow.stage,'');assert.equal(loan.tradeFlow.reservedBy,null);assert.equal(loan.tradeFlow.collateralPlaced,undefined);assert.equal(loan.tradeFlow.fundsAdded,undefined);
 assert.equal(loan.collateralTrade.uiTradeId,nativeTradeId);assert.equal(loan.tradeFlow.lastReset.by,owner);assert.equal(TB.reserved(result.state,owner),0);assert.equal(result.state.loans.length,0);
 assert.equal(loan.tradeVerificationHistory.at(-1).flow.stage,'funds_added');
});

test('changed terms and duplicate or archived settlement evidence cannot create a second loan',async()=>{
 const state=await ready();
 for(const mutate of [s=>{fundingRecord(s).principal+=1;},s=>{fundingRecord(s).rate=.02;},s=>{s.receipts=[{reference:'manual-loan-trade:'+nativeTradeId}];},s=>{s.recordArchives=[{records:{loans:[{...TB.clone(fundingRecord(s)),id:'other-loan',status:'active'}]}}];}]){
  const changed=TB.clone(state);mutate(changed);const before=TB.clone(changed);
  await assert.rejects(step(changed,owner,'complete'),/terms changed|already|Conflicting/);assert.deepEqual(changed,before);
 }
 const settled=(await step(state,owner,'complete')).state;
 settled.actorId=owner;
 assert.throws(()=>TB.submitPayment(settled,fundingRecord(settled).id,{cash:100e6,reference:'manual-loan-trade:'+nativeTradeId,recipient:owner,date:TB.today()}),/already recorded/);
});

test('manual completion ignores client-supplied completion dates and preserves the server timestamp',async()=>{
 const state=await ready(),now=Date.now(),result=await step(state,owner,'complete',{completedAt:'2000-01-01T00:00:00Z',tradeId:'999'},now),loan=fundingRecord(result.state);
 assert.equal(loan.fundedAt,new Date(now).toISOString());assert.equal(loan.tradeFlow.completion.at,new Date(now).toISOString());assert.equal(loan.tradeFlow.completion.apiTradeId,undefined);
});

test('borrower can finish the existing claimed-trade observation during manual placement without an API key',async()=>{
 const state=approved(),loan=fundingRecord(state);
 loan.collateralTrade.status='claimed';delete loan.collateralTrade.uiTradeId;delete loan.collateralTrade.reportedAt;
 const result=await step(state,borrower,'collateral-placed',{linkOpenTrade:true});
 assert.equal(fundingRecord(result.state).collateralTrade.status,'created');assert.equal(fundingRecord(result.state).collateralTrade.uiTradeId,nativeTradeId);assert.equal(result.tradeCheck.stage,'collateral_placed');
});

test('changed manual terms require genuine renewed acceptance even when the old consent marker is valid',async()=>{
 const state=await ready(),loan=fundingRecord(state),oldConsent=TB.clone(loan.borrowerConfirmed);loan.rate+=.001;
 const read=await step(state,borrower,'refresh');
 assert.equal(read.changed,false);assert.equal(read.tradeCheck.requiresManualRestart,true);assert.equal(read.tradeCheck.requiresTermsAcceptance,true);
 await assert.rejects(step(state,borrower,'collateral-placed'),/Explicitly accept/);
 await assert.rejects(step(state,borrower,'collateral-placed',{acceptTerms:true,termsRevision:state.revision+1}),/terms changed/);
 const renewed=await step(state,borrower,'collateral-placed',{acceptTerms:true,termsRevision:state.revision});
 const saved=fundingRecord(renewed.state);
 assert.notDeepEqual(saved.borrowerConfirmed,oldConsent);assert.equal(saved.tradeFlow.stage,'collateral_placed');assert.equal(saved.tradeFlow.fundsAdded,undefined);assert.equal(saved.tradeFlow.reservedBy,owner);
 assert.equal(saved.tradeVerificationHistory.at(-1).flow.stage,'funds_added');assert.equal(renewed.state.loans.length,0);
});

test('stale manual mutations cannot act on reset and newly reconfirmed trade stages',async()=>{
 const state=await ready(),oldComplete=payload(state,'complete'),oldFunds=payload(state,'funds-added',staffValues);
 for(const [action,extra] of [['collateral-placed',{}],['funds-added',staffValues],['complete',{}],['reset',{notes:'All offered funds were removed without completing the trade.'}]]){
  for(const reviewRevision of [undefined,-1,state.revision+1])await assert.rejects(step(state,action==='collateral-placed'?borrower:owner,action,{...extra,reviewRevision}),error=>error.status===409);
 }
 let next=(await step(state,owner,'reset',{notes:'All offered loan funds were removed; the trade did not complete.'})).state;next.revision++;
 next=await placed(next);next.revision++;
 await assert.rejects(applyManualLoanTrade(next,owner,'funds-added',oldFunds),error=>error.status===409);
 next=(await step(next,owner,'funds-added',staffValues)).state;next.revision++;
 await assert.rejects(applyManualLoanTrade(next,owner,'complete',oldComplete),error=>error.status===409);
 const completed=(await step(next,owner,'complete')).state;completed.revision++;
 const retry=await applyManualLoanTrade(completed,owner,'complete',oldComplete);assert.equal(retry.changed,false);assert.equal(retry.tradeCheck.stage,'completed');
});

test('manual completion retains an archived original application and marks that original trade ticket complete',async()=>{
 const state=await ready(),application=state.applications.shift();state.recordArchives=[{records:{applications:[application]}}];
 const result=await step(state,owner,'complete'),saved=result.state.recordArchives[0].records.applications[0];
 assert.equal(result.state.loans.length,1);assert.equal(result.state.fundingRequests.length,0);assert.equal(saved.loanId,result.state.loans[0].id);
 assert.equal(saved.created,application.created);assert.equal(saved.tradeCompletion.source,'Manual staff confirmation');
});

function completedAPITrade(state,id=775511){
 const loan=fundingRecord(state);
 return {id,description:loan.reference,user:{id:Number(borrower)},trader:{id:Number(owner)},completed_at:Math.floor(Date.parse(loan.tradeFlow.completion?.completedAt||new Date().toISOString())/1000),items:[
  {user_id:Number(borrower),type:'Money',details:{amount:100e6}},
  {user_id:Number(borrower),type:'Item',details:{id:206,amount:14}},
  {user_id:Number(owner),type:'Money',details:{amount:100e6}}
 ]};
}

test('later API receipt links to a unique manual funding record without changing its proof or crediting a repayment',async()=>{
 const state=(await step(await ready(),owner,'complete')).state,before=TB.clone(state),trade=completedAPITrade(state);
 const result=reconcileTrade(state,owner,trade),receipt=result.state.receipts.find(entry=>entry.tradeId===String(trade.id));
 assert.equal(receipt.status,'loan_trade');assert.equal(receipt.loanId,state.loans[0].id);assert.equal(receipt.manualReference,'manual-loan-trade:'+nativeTradeId);assert.equal(receipt.nativeTradeId,nativeTradeId);
 assert.equal(receipt.manualFundingReview,false);assert.equal(result.state.receipts.length,2);assert.deepEqual(result.state.loans,state.loans);assert.deepEqual(result.state.ledger,state.ledger);assert.deepEqual(result.state.collateral,state.collateral);
 assert.deepEqual(state,before);assert.equal(reconcileTrade(result.state,owner,trade).status,'Already recorded');
 assert.throws(()=>TB.submitPayment(result.state,state.loans[0].id,{cash:1e6,reference:receipt.reference,recipient:owner,date:TB.today()}),/already recorded/);
 const earlier=TB.clone(state);earlier.receipts.push({id:'existing-api-receipt',reference:receipt.reference,status:'review',borrower,recipient:owner,cash:100e6,outgoing:100e6});
 const upgraded=reconcileTrade(earlier,owner,trade).state;
 assert.equal(upgraded.receipts.length,2);assert.equal(upgraded.receipts.find(entry=>entry.id==='existing-api-receipt').status,'loan_trade');assert.deepEqual(upgraded.ledger,state.ledger);
});

test('inconsistent or ambiguous API evidence for manual funding is held and cannot become a repayment',async()=>{
 const state=(await step(await ready(),owner,'complete')).state,trade=completedAPITrade(state);
 for(const kind of ['missing-outgoing','wrong-items','ambiguous-record']){
  const changed=TB.clone(state),offered=TB.clone(trade);
  if(kind==='missing-outgoing')offered.items=offered.items.filter(entry=>String(entry.user_id)!==owner&&entry.type==='Money');
  if(kind==='wrong-items')offered.items.find(entry=>entry.type==='Item').details.amount--;
  if(kind==='ambiguous-record')changed.recordArchives=[{records:{loans:[TB.clone(changed.loans[0])]}}];
  changed.paymentIntents=[{id:'matching-payment',loanId:changed.loans[0].id,borrowerId:borrower,recipient:owner,amount:100e6,status:'pending',created:TB.today()}];
  const result=reconcileTrade(changed,owner,offered),receipt=result.state.receipts.at(-1);
  assert.equal(receipt.status,'review',kind);assert.equal(receipt.manualFundingReview,true,kind);assert.equal(result.state.pendingPayments.length,0);assert.equal(result.state.loans[0].payments.length,0);assert.deepEqual(result.state.ledger,changed.ledger);
  assert.throws(()=>TB.submitPayment(result.state,changed.loans[0].id,{cash:1e6,reference:receipt.reference,recipient:owner,date:TB.today()}),/funding.*reconciliation/);
  assert.throws(()=>applyAction(result.state,owner,'assignReceipt',{id:receipt.id,loanId:changed.loans[0].id}),/reconciliation/);
 }
});

test('API funding linkage needs the exact original reference, participants and time while later repayments still work',async()=>{
 const state=(await step(await ready(),owner,'complete')).state,trade=completedAPITrade(state);
 for(const mutate of [t=>{t.description+=' extra';},t=>{t.user.id=9000099;for(const item of t.items)if(String(item.user_id)===borrower)item.user_id=9000099;},t=>{t.completed_at-=3600;}]){
  const unrelated=TB.clone(trade);mutate(unrelated);const receipt=reconcileTrade(state,owner,unrelated).state.receipts.at(-1);
  assert.equal(receipt.status,'review');assert.equal(receipt.manualReference,undefined);assert.equal(receipt.manualFundingReview,undefined);
 }
 const later=TB.clone(state),repayment={...trade,id:775512,completed_at:trade.completed_at+2,items:[{user_id:Number(borrower),type:'Money',details:{amount:10e6}}]};
 later.paymentIntents=[{id:'actual-repayment',loanId:later.loans[0].id,borrowerId:borrower,recipient:owner,amount:10e6,status:'pending',created:TB.today()}];
 const result=reconcileTrade(later,owner,repayment);
 assert.equal(result.state.loans[0].payments.length,1);assert.equal(result.state.loans[0].payments[0].credited,10e6);assert.equal(result.state.receipts.at(-1).status,'credited');
});

test('API receipts for open manual funding cannot repay a different active loan and can be linked after final confirmation',async()=>{
 const original=await ready(),trade=completedAPITrade(original),currentId=fundingRecord(original).id,old={...TB.clone(fundingRecord(original)),id:'old-active-loan',applicationId:'old-application',reference:'TLB-OLD',tradeFlow:undefined,collateralTrade:undefined};
 original.fundingRequests.push(old);seedHistoricalFundedLoan(original,old.id,{staffId:owner});
 original.paymentIntents=[{id:'old-payment-intent',loanId:old.id,borrowerId:borrower,recipient:owner,amount:100e6,status:'pending',created:TB.today()}];
 const incomplete={...trade,items:trade.items.filter(entry=>String(entry.user_id)===borrower&&entry.type==='Money')};
 const held=reconcileTrade(original,owner,incomplete).state,heldReceipt=held.receipts.at(-1);
 assert.equal(heldReceipt.status,'review');assert.equal(heldReceipt.manualFundingReview,true);assert.equal(heldReceipt.manualFundingMismatch,true);assert.equal(held.loans[0].payments.length,0);assert.equal(held.pendingPayments.length,0);
 assert.throws(()=>applyAction(held,owner,'assignReceipt',{id:heldReceipt.id,loanId:old.id}),/reconciliation/);
 await assert.rejects(step(held,owner,'complete'),/Imported trade evidence conflicts/);
 const waiting=reconcileTrade(original,owner,trade).state,waitingReceipt=waiting.receipts.at(-1);
 assert.equal(waitingReceipt.manualFundingReview,true);assert.equal(waitingReceipt.manualFundingMismatch,false);
 const completed=(await step(waiting,owner,'complete')).state,proof=TB.clone(completed.loans.find(entry=>entry.id===currentId).tradeFlow.completion);
 const linked=reconcileTrade(completed,owner,trade).state;
 assert.equal(linked.receipts.find(entry=>entry.id===waitingReceipt.id).status,'loan_trade');assert.equal(linked.receipts.length,2);
 assert.equal(linked.loans.find(entry=>entry.id===old.id).payments.length,0);assert.deepEqual(linked.loans.find(entry=>entry.id===currentId).tradeFlow.completion,proof);
});

test('a second distinct API receipt cannot be hidden behind one manual funding completion',async()=>{
 const state=(await step(await ready(),owner,'complete')).state,first=completedAPITrade(state),second={...first,id:first.id+1};
 const linked=reconcileTrade(state,owner,first).state,flagged=reconcileTrade(linked,owner,second).state,receipt=flagged.receipts.at(-1);
 assert.equal(receipt.status,'review');assert.equal(receipt.manualFundingReview,true);assert.equal(receipt.manualFundingMismatch,true);assert.match(receipt.reason,/different API receipt/);assert.deepEqual(flagged.ledger,state.ledger);
 const pending=await ready(),firstPending=completedAPITrade(pending),twice=reconcileTrade(reconcileTrade(pending,owner,firstPending).state,owner,{...firstPending,id:firstPending.id+1}).state;
 await assert.rejects(step(twice,owner,'complete'),/Imported trade evidence conflicts/);
});
