import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {allLoanRecords,findLoanRecord,normalizeFundingState} from '../lib/funding-lifecycle.js';
import {loanCounts} from '../lib/loan-counts.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {confirmPICollateral} from '../lib/pi-collateral.js';

const owner='3542697',borrower='9000001',other='9000002';
function approved(manual=false){
 let state=TB.newState();state.bankOnline=true;
 TB.person(state,borrower).memberProgram='faction';
 const input={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:!manual};
 state=applyAction(state,borrower,'apply',input,TB.today(),{networth:1e9,factionMember:true,checkedAt:new Date().toISOString()});
 if(manual)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,checks:true,reason:'Application evidence reviewed'});
 return state;
}

test('automatic and staff approval create only an application funding record, without debt or a loan',()=>{
 for(const manual of [false,true]){
  const state=approved(manual),request=state.fundingRequests[0];
  assert.equal(state.applications[0].status,'approved');
  assert.equal(state.loans.length,0);assert.equal(state.fundingRequests.length,1);
  assert.equal(request.applicationId,state.applications[0].id);
  assert.equal(state.ledger.filter(entry=>entry.type==='disbursement').length,0);
  assert.deepEqual(loanCounts(state,borrower),{recordedActive:0,active:0,open:1,awaitingFunding:1});
  assert.equal(TB.balance(request,TB.addDays(request.start,30)).total,0);
  assert.deepEqual(TB.scheduleRows(request,TB.addDays(request.start,30)),[]);
  assert.equal(TB.overview(state).principal,0);
 }
});

test('legacy pending approvals migrate with trade identities, reservations and held collateral intact',()=>{
 const state=approved(),request=state.fundingRequests[0];
 request.tradeFlow={stage:'funds_added',reservedBy:owner,staffId:owner,apiTradeId:'88444',nativeTradeId:'11687899'};
 request.collateralTrade={intentId:'existing-intent',status:'created',uiTradeId:'11687899'};
 request.collateralTradeHistory=[{intent:{intentId:'old-intent',uiTradeId:'11680000'}}];
 request.collateralConfirmed={holder:owner,reference:'legacy-collateral',amount:100e6};
 state.collateral=[{id:'custody',loanId:request.id,event:'received',holder:owner,reference:'legacy-collateral'}];
 state.loans=state.fundingRequests;delete state.fundingRequests;
 const before=TB.clone(request),cashBefore=TB.spendable(state,owner);
 normalizeFundingState(state);
 assert.deepEqual(state.fundingRequests,[before]);assert.deepEqual(state.loans,[]);
 assert.equal(TB.reserved(state,owner),100e6);assert.equal(TB.spendable(state,owner),cashBefore);
 assert.equal(state.collateral[0].loanId,request.id);
 const saved=JSON.stringify(state);normalizeFundingState(state);assert.equal(JSON.stringify(state),saved);
 assert.deepEqual(normalizeFundingState(JSON.parse(saved)),state);
});

test('withdrawn unfunded legacy applications move out of Loans and retain collateral return obligations',()=>{
 const state=approved(),request=state.fundingRequests[0];
 request.status='withdrawn';request.collateralReturnRequired=true;state.applications[0].status='withdrawn';
 state.loans=[request];delete state.fundingRequests;normalizeFundingState(state);
 assert.equal(state.loans.length,0);assert.equal(state.fundingRequests[0].collateralReturnRequired,true);
 assert.equal(loanCounts(state,borrower).open,0);
});

test('migration never silently reclassifies funding evidence or overwrites conflicting records',()=>{
 for(const evidence of ['ledger','payments','fundsReceived','completion','archived']){
  const state=approved(),record=state.fundingRequests[0];state.loans=[record];state.fundingRequests=[];
  if(evidence==='ledger')state.ledger.push({loanId:record.id,type:'disbursement'});
  if(evidence==='payments')record.payments.push({id:'accepted-payment'});
  if(evidence==='fundsReceived')record.fundsReceived={reference:'already-transferred'};
  if(evidence==='completion')record.tradeFlow={completion:{reference:'completed'}};
  if(evidence==='archived')state.recordArchives=[{records:{loans:[{id:record.id,status:'active'}]}}];
  normalizeFundingState(state);assert.equal(state.loans.length,1,evidence);assert.equal(state.fundingRequests.length,0,evidence);assert.match(state.loans[0].fundingReconciliation.reason,/evidence/);
 }
 const state=approved(),original=state.fundingRequests[0];state.loans=[{...original,principal:200e6}];
 normalizeFundingState(state);assert.equal(state.loans[0].principal,200e6);assert.equal(state.fundingRequests[0].principal,100e6);assert.match(state.loans[0].fundingReconciliation.reason,/Conflicting/);const preserved=JSON.stringify(state);normalizeFundingState(state);assert.equal(JSON.stringify(state),preserved);
});

test('borrower projection includes only their own pending application and custody records',()=>{
 const state=approved(),mine=state.fundingRequests[0];
 const theirs={...TB.clone(mine),id:'other-request',borrowerId:other,applicationId:'other-application'};
 state.fundingRequests.push(theirs);state.applications.push({...state.applications[0],id:'other-application',borrowerId:other});
 state.collateral=[{loanId:mine.id},{loanId:theirs.id}];
 const view=project(state,borrower).state;
 assert.deepEqual(view.loans,[]);assert.equal(view.fundingRequests.length,1);assert.equal(view.fundingRequests[0].borrowerId,borrower);
 assert.deepEqual(view.collateral,[{loanId:mine.id}]);assert.equal(view.applications.length,1);
 assert.deepEqual(allLoanRecords(undefined),[]);assert.equal(findLoanRecord(undefined,'missing'),undefined);
});

test('old standalone verification and funding actions cannot bypass the trade menu, including for the owner',()=>{
 const state=approved(),request=state.fundingRequests[0],before=TB.clone(state);
 for(const actor of [owner,borrower])for(const action of ['confirmTerms','fund','piCollateral']){
  assert.throws(()=>applyAction(state,actor,action,{id:request.id,checked:true,reference:'manual'}),/trade-page menu|Separate verification/i);
 }
 assert.throws(()=>verifyCollateral(state,owner,request.id,{},{}),/trade page|standalone|separate|no longer/i);
 assert.throws(()=>confirmPICollateral(state,owner,request.id,{}),/trade page|standalone|separate/i);
 state.actorId=owner;
 assert.throws(()=>TB.fund(state,request.id,'manual'),/trade-page menu|Separate disbursement/);
 assert.throws(()=>applyAction(state,owner,'collateral',{id:request.id,event:'received',holder:owner,description:'manually accepted',reference:'manual'}),/trade-page menu/);
 assert.deepEqual({...state,actorId:before.actorId},before);
});
