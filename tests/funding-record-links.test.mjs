import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {allLoanRecords,normalizeFundingState} from '../lib/funding-lifecycle.js';
import {prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade,tradeCreationAllowed} from '../lib/collateral-trade.js';
import {inspectLoanTrade} from '../lib/loan-trade.js';
import {canWithdrawApplication,withdrawApplication,refreshCollateralReturn} from '../lib/application-withdrawal.js';
import {removalPlan,removeRecords} from '../lib/manage.js';
import {managedRecords} from '../lib/manage-catalog.js';
import {historyIndex,historyUsers} from '../lib/history.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {confirmPICollateral} from '../lib/pi-collateral.js';

const owner='3542697',borrower='9000001';
function approved(){
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Fixture cash');
 TB.person(state,borrower).memberProgram='faction';
 const input={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:true};
 state=applyAction(state,borrower,'apply',input,TB.today(),{networth:1e9,factionMember:true,checkedAt:new Date().toISOString()});
 assert.equal(state.loans.length,0);assert.equal(state.fundingRequests.length,1);
 return state;
}
function claimed(state=approved()){
 const request=state.fundingRequests[0],now=Date.now();
 const intent=prepareCollateralTrade(state,borrower,{loanId:request.id,recipientId:owner},now);
 claimCollateralTrade(state,borrower,{loanId:request.id,intentId:intent.intentId},now+1);
 return {state,request,input:{loanId:request.id,intentId:intent.intentId,reference:request.reference,uiTradeId:'11687899'},now:now+2};
}

test('an approved application keeps native trade preparation and observed identity without creating a loan',()=>{
 const {state,request,input,now}=claimed(),ledger=TB.clone(state.ledger);
 recordCollateralTrade(state,borrower,input,now);
 assert.equal(state.fundingRequests[0],request);
 assert.equal(request.collateralTrade.uiTradeId,input.uiTradeId);
 assert.equal(request.collateralTrade.status,'created');
 assert.equal(state.loans.length,0);assert.deepEqual(state.ledger,ledger);
 const view=project(state,borrower).state;
 assert.equal(view.loans.length,0);
 assert.equal(view.fundingRequests[0].collateralTrade.uiTradeId,input.uiTradeId);
 assert.deepEqual(managedRecords(state,'loan'),[]);
 assert.equal(managedRecords(state,'application')[0].id,state.applications[0].id);
});

test('native trade identity cannot be reused from a live or archived application funding request',()=>{
 for(const archived of [false,true])for(const retired of [false,true]){
  const {state,input,now}=claimed();
  const previous={id:'REQUEST-previous',applicationId:'APP-previous',borrowerId:borrower,status:'withdrawn',payments:[],
   ...(retired?{collateralTradeHistory:[{intent:{uiTradeId:input.uiTradeId}}]}:{collateralTrade:{uiTradeId:input.uiTradeId}})};
  if(archived)state.recordArchives=[{records:{fundingRequests:[previous]}}];else state.fundingRequests.push(previous);
  assert.throws(()=>recordCollateralTrade(state,borrower,input,now),/previous attempt|already linked/);
  assert.equal(state.fundingRequests[0].collateralTrade.status,'claimed');
  assert.equal(state.loans.length,0);
 }
});

test('request withdrawal preserves legacy collateral custody until its recorded return',()=>{
 const state=approved(),request=state.fundingRequests[0],application=state.applications[0];
 request.collateralConfirmed={by:owner,holder:owner,amount:75e6,reference:'legacy-held-collateral'};
 state.collateral=[{id:'COL-held',loanId:request.id,borrowerId:borrower,event:'received',holder:owner,reference:'legacy-held-collateral'}];
 assert.equal(tradeCreationAllowed(state,request,borrower),false);
 assert.throws(()=>inspectLoanTrade(state,owner,request.id),/reconcile.*collateral/);
 assert.equal(canWithdrawApplication(state,application,borrower),true);
 withdrawApplication(state,borrower,application.id);
 assert.equal(request.status,'withdrawn');assert.equal(application.status,'withdrawn');
 assert.equal(request.collateralReturnRequired,true);assert.equal(application.collateralReturnRequired,true);
 assert.equal(state.loans.length,0);
 assert.throws(()=>removalPlan(state,'collateral','COL-held'),/retained as evidence/);
 assert.throws(()=>removalPlan(state,'application',application.id),/received collateral/);
 state.collateral.push({id:'COL-returned',loanId:request.id,event:'released',holder:owner,reference:'return-proof'});
 refreshCollateralReturn(state,request);
 assert.equal(request.collateralReturnRequired,false);assert.equal(application.collateralReturnRequired,false);
 assert.equal(request.collateralConfirmed.reference,'legacy-held-collateral');
});

test('committed request funds and attempted trades prevent withdrawal or archive respectively',()=>{
 const state=approved(),request=state.fundingRequests[0],application=state.applications[0];
 request.tradeFlow={reservedBy:owner};
 assert.equal(canWithdrawApplication(state,application,borrower),false);
 assert.throws(()=>withdrawApplication(state,borrower,application.id),/committed/);
 assert.throws(()=>removalPlan(state,'application',application.id),/committed/);
 delete request.tradeFlow;
 const pending=claimed(state);
 assert.throws(()=>removalPlan(state,'application',application.id),/attempted Torn trade/);
 recordCollateralTrade(state,borrower,pending.input,pending.now);
 assert.throws(()=>removalPlan(state,'application',application.id),/attempted Torn trade/);
});

test('archiving an uncommitted application includes its funding request and preserves funded loans and history links',()=>{
 const state=approved(),request=state.fundingRequests[0],application=state.applications[0];
 const funded={...TB.clone(request),id:'LOAN-already-funded',applicationId:'APP-funded',status:'active'};
 state.loans.push(funded);
 const plan=removalPlan(state,'application',application.id);
 assert.deepEqual(plan.fundingRequests,[request.id]);assert.deepEqual(plan.loans,[]);
 removeRecords(state,'application',application.id,'Archive unused approval');
 assert.equal(state.fundingRequests.length,0);assert.equal(state.applications.length,0);
 assert.deepEqual(state.loans,[funded]);
 assert.equal(state.recordArchives[0].records.fundingRequests[0],request);
 assert.ok(historyIndex(state).get(request.id).some(link=>link.id===borrower&&link.reference===request.reference));
 assert.equal(historyUsers(state,[]).find(person=>person.id===borrower).name,request.name);
});

test('legacy pending migration preserves stable records and rejects ambiguous competing evidence',()=>{
 const state=approved(),request=state.fundingRequests.shift();
 request.collateralTrade={intentId:'TRADE-existing',loanId:request.id,borrowerId:borrower,reference:request.reference,status:'created',uiTradeId:'11687899'};
 request.tradeFlow={reservedBy:owner};
 state.loans.push(request);
 normalizeFundingState(state);
 assert.equal(state.loans.length,0);assert.equal(state.fundingRequests[0],request);
 assert.equal(state.fundingRequests[0].collateralTrade.uiTradeId,'11687899');
 assert.equal(TB.reserved(state,owner),request.principal);
 state.loans.push({...TB.clone(request),principal:request.principal+1});
 normalizeFundingState(state);
 assert.equal(allLoanRecords(state).filter(record=>record.id===request.id).length,2);
 assert.ok(request.fundingReconciliation?.reason);
 assert.throws(()=>inspectLoanTrade(state,owner,request.id),/Conflicting funding records/);
 assert.equal(tradeCreationAllowed(state,request,borrower),false);
});

test('stale approved settlement evidence never permits withdrawal of the application',()=>{
 for(const key of ['fundsReceived','completedFlow']){
  const state=approved(),request=state.fundingRequests[0],application=state.applications[0];
  if(key==='fundsReceived')request.fundsReceived={reference:'completed-transfer'};
  else request.tradeFlow={completion:{reference:'completed-transfer'}};
  normalizeFundingState(state);
  assert.ok(request.fundingReconciliation?.reason);
  assert.throws(()=>inspectLoanTrade(state,owner,request.id),/funding evidence needs staff reconciliation/);
  assert.equal(canWithdrawApplication(state,application,borrower),false);
  assert.throws(()=>withdrawApplication(state,borrower,application.id),/funding or repayment records/);
 }
});

test('legacy standalone collateral helpers reject without mutating request or custody state',()=>{
 const state=approved(),before=TB.clone(state),request=state.fundingRequests[0];
 assert.throws(()=>verifyCollateral(state,owner,request.id,{},{}),/Standalone collateral verification/);
 assert.throws(()=>confirmPICollateral(state,owner,request.id,{}),/Standalone PI collateral confirmation/);
 assert.deepEqual(state,before);
});
