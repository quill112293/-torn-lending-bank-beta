import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade} from '../lib/collateral-trade.js';
import {applyManualLoanTrade} from '../lib/manual-loan-trade.js';
import {createTradeLoanDetailsController,loanTradeActions} from '../src/trade-loan-match.js';
import {acceptTradeRoute,loanAcceptPolicy} from '../src/trade-accept-guard.js';
import {fundingRecord,readyFunding} from './helpers/funding.mjs';

const owner='3542697',borrower='9000001',nativeTradeId='11687899';
const values={checked:true,cashCollateral:'100m',itemReference:'11.2m',piAmount:'0',fundsAmount:'100m',notes:'Checked fourteen Xanax and the full collateral cash before confirming loan funds.'};
function approved(staffApproval){
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Recorded bank cash');TB.person(state,borrower).memberProgram='faction';
 const application={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[{itemId:206,name:'Xanax',qty:14,reference:800000}]}),acceptPreapproval:!staffApproval};
 state=applyAction(state,borrower,'apply',application,TB.today(),{networth:1e9,factionMember:true,checkedAt:new Date().toISOString()});
 if(staffApproval)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,checks:true,reason:'Reviewed application'});
 const loan=fundingRecord(state),now=Date.now();state.applications[0].created=new Date(now-60000).toISOString();
 const intent=prepareCollateralTrade(state,borrower,{loanId:loan.id,recipientId:owner},now-59000);
 claimCollateralTrade(state,borrower,{loanId:loan.id,intentId:intent.intentId},now-58000);
 recordCollateralTrade(state,borrower,{loanId:loan.id,intentId:intent.intentId,reference:loan.reference,uiTradeId:nativeTradeId},now-57000);
 return state;
}

test('real projected bank records carry three manual controller confirmations through Accept readiness and ticket closure',async()=>{
 for(const setup of ['automatic-approval','staff-approval','legacy-in-progress']){
  let state=approved(setup==='staff-approval');
  if(setup==='legacy-in-progress')state=await readyFunding(state,{itemReference:11.2e6,notes:values.notes});
  const loanId=fundingRecord(state).id,reference=fundingRecord(state).reference,submittedAt=state.applications[0].created,calls=[];
  const view=actor=>({...project(state,actor),user:{id:actor}});
  const policy=actor=>loanAcceptPolicy(view(actor),acceptTradeRoute('https://www.torn.com/trade.php#step=view&ID='+nativeTradeId,actor),{reference,referenceEvidence:'loan-reference',ambiguous:false});
  const step=async(actor,action,input,finished=false)=>{
   const context={page:true,route:finished?'https://www.torn.com/trade.php':'https://www.torn.com/trade.php#step=view&ID='+nativeTradeId,accountId:actor,tradeId:finished?null:nativeTradeId,reference:finished?'Trade completed':reference,referenceEvidence:finished?'unclassified':'loan-reference',ambiguous:false};
   const transport={ready:Promise.resolve(),canRestore:()=>true,getSavedKey:()=>'',async request(path,payload){
    calls.push({path,actor,payload:structuredClone(payload)});
    if(path==='bank')return view(actor);
    assert.equal(path,'loan-trade');assert.equal(payload.manual,true);assert.equal(Object.hasOwn(payload,'key'),false);assert.equal(Object.hasOwn(payload,'tradeId'),false);
    const result=await applyManualLoanTrade(state,actor,payload.action,payload);
    state=result.state;if(result.changed)state.revision++;
    return {...view(actor),tradeCheck:result.tradeCheck};
   }};
   let updated=0;const controller=createTradeLoanDetailsController({transport,readContext:()=>context,onTradeUpdated:()=>updated++});
   await controller.setOpen(true);if(finished)controller.select(loanId);
   assert.equal(controller.getState().selectedLoanId,loanId,setup+' / '+action);
   assert.equal(loanTradeActions(view(actor),fundingRecord(state))[action],true);
   assert.equal(controller.beginReview(action),true);await controller.submitReview(input);
   const model=controller.getState();assert.equal(model.reviewError,'',setup+' / '+action);assert.ok(model.success,setup+' / '+action);assert.equal(updated,1);
   if(finished)assert.equal(model.open,false);
   controller.dispose();
  };
  for(const actor of [borrower,owner])assert.equal((await policy(actor)).ready,false);
  await step(borrower,'collateral-placed',{checked:true,...(setup==='staff-approval'?{acceptTerms:true}:{})});
  assert.equal(state.loans.length,0);for(const actor of [borrower,owner])assert.equal((await policy(actor)).ready,false);
  await step(owner,'funds-added',values);
  assert.equal(state.loans.length,0);assert.equal(TB.reserved(state,owner),100e6);
  for(const actor of [borrower,owner]){const check=await policy(actor);assert.equal(check.ready,true,setup+' / '+actor+' / '+check.reason);}
  await step(owner,'complete',{checked:true},true);
  assert.equal(state.fundingRequests.length,0);assert.equal(state.loans.length,1);assert.equal(state.loans[0].id,loanId);assert.equal(state.loans[0].status,'active');
  assert.equal(state.ledger.filter(entry=>entry.type==='disbursement').length,1);assert.equal(state.collateral.length,1);assert.equal(TB.reserved(state,owner),0);
  assert.equal(state.applications[0].created,submittedAt);assert.equal(state.applications[0].tradeCompletion.source,'Manual staff confirmation');
  assert.equal(state.loans[0].tradeFlow.fundsReviewed,undefined);assert.equal(calls.filter(call=>call.path==='loan-trade').length,3);
  for(const actor of [borrower,owner])assert.equal((await policy(actor)).ready,false);
 }
});

test('real stale manual terms are explicitly accepted again without losing the existing trade reservation',async()=>{
 let state=approved(false);
 const apply=async(actor,action,extra={})=>{
  const loan=fundingRecord(state),result=await applyManualLoanTrade(state,actor,action,{manual:true,loanId:loan.id,intentId:loan.collateralTrade.intentId,reference:loan.reference,nativeTradeId,checked:true,reviewRevision:state.revision,...extra});
  state=result.state;if(result.changed)state.revision++;return result;
 };
 await apply(borrower,'collateral-placed');await apply(owner,'funds-added',{cashCollateral:100e6,itemReference:11.2e6,piAmount:0,fundsAmount:100e6,notes:values.notes});
 const previousConsent=structuredClone(fundingRecord(state).borrowerConfirmed),intentId=fundingRecord(state).collateralTrade.intentId;
 fundingRecord(state).rate=.02;state.revision++;
 const view=()=>({...project(state,borrower),user:{id:borrower}}),loan=fundingRecord(state);
 const context={page:true,route:'https://www.torn.com/trade.php#step=view&ID='+nativeTradeId,accountId:borrower,tradeId:nativeTradeId,reference:loan.reference,referenceEvidence:'loan-reference',ambiguous:false};
 let writes=0;
 const transport={ready:Promise.resolve(),canRestore:()=>true,getSavedKey:()=>'',async request(path,payload){
  if(path==='bank')return view();writes++;
  const result=await applyManualLoanTrade(state,borrower,payload.action,payload);state=result.state;if(result.changed)state.revision++;
  return {...view(),tradeCheck:result.tradeCheck};
 }};
 const controller=createTradeLoanDetailsController({transport,readContext:()=>context});
 await controller.setOpen(true);assert.equal(controller.beginReview('collateral-placed'),false);assert.equal(controller.beginReview('refresh'),true);
 await controller.submitReview({checked:true});assert.match(controller.getState().reviewError,/terms changed/);
 assert.equal(controller.beginReview('collateral-placed'),true);assert.equal(controller.getState().review.requiresTermsAcceptance,true);
 await controller.submitReview({checked:true});assert.equal(writes,1);
 await controller.submitReview({checked:true,acceptTerms:true});assert.equal(writes,2);assert.equal(controller.getState().reviewError,'');assert.ok(controller.getState().success);
 const saved=fundingRecord(state);assert.equal(saved.tradeFlow.stage,'collateral_placed');assert.equal(saved.tradeFlow.fundsAdded,undefined);assert.equal(saved.tradeFlow.reservedBy,owner);assert.equal(saved.collateralTrade.intentId,intentId);
 assert.equal(saved.borrowerConfirmed.source,'Accepted with manual collateral confirmation');assert.notDeepEqual(saved.borrowerConfirmed,previousConsent);assert.equal(saved.tradeVerificationHistory.at(-1).flow.stage,'funds_added');
 assert.equal(state.loans.length,0);assert.equal(TB.reserved(state,owner),100e6);controller.dispose();
});
