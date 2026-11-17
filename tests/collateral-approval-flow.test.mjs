import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {reconcileTrade} from '../lib/trades.js';
import {fundingRecord,fundingTrade,fundingStep,readyFunding} from './helpers/funding.mjs';

const owner='3542697',borrower='9000001',apiTradeId=77331;
function approved({cash=65e6,items=[]}={}){
 const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'existing bank funds');
 const a=TB.addApplication(s,TB.sampleApp({lane:'external',tier:1,product:'bank',completed:1,networth:1e9,requested:130e6,cashCollateral:cash,items,created:new Date(Date.now()-60000).toISOString()}));
 const request=TB.approve(s,a.id,130e6,'Reviewed application',true);
 a.reference=request.reference='TLB-COLLATERAL-TEST';request.collateralRequired=TB.collateralRequired(a,request.principal,s.rules);request.collateralConfirmed=false;
 assert.equal(request.collateralRequired,65e6);return s;
}
const item={itemId:206,name:'Xanax',qty:80,reference:838912};
const mixed=()=>approved({cash:5e6,items:[item]});
async function rejectsWithoutChanges(s,actor,action,options,pattern){const before=structuredClone(s);await assert.rejects(fundingStep(s,actor,action,options),pattern);assert.deepEqual(s,before);}

test('standalone collateral verification rejects every role without writing evidence',()=>{
 for(const actor of [owner,borrower,'9999999']){
  const state=approved(),before=TB.clone(state);
  assert.throws(()=>verifyCollateral(state,actor,state.fundingRequests[0].id,{}, {checked:true}),/Torn trade page/);
  assert.deepEqual(state,before);assert.equal(state.loans.length,0);
 }
});

test('cash collateral requires explicit review in the trade menu and the exact approved proposal',async()=>{
 const s=approved(),offer=fundingTrade(s);
 for(const checked of [undefined,false,'true',1])await rejectsWithoutChanges(s,borrower,'collateral-placed',{input:{checked}},/Confirm|Accept/);
 const short={...offer,items:[{user_id:Number(borrower),type:'Money',details:{amount:65e6-1}}]};
 await rejectsWithoutChanges(s,borrower,'collateral-placed',{trade:short},/does not match/);
 const placed=(await fundingStep(s,borrower,'collateral-placed')).state;
 await rejectsWithoutChanges(placed,owner,'collateral-reviewed',{input:{checked:false}},/Confirm/);
 const reviewed=(await fundingStep(placed,owner,'collateral-reviewed')).state;
 assert.equal(reviewed.fundingRequests[0].tradeFlow.collateralReviewed.credited,65e6);assert.equal(reviewed.fundingRequests[0].collateralConfirmed,false);
 assert.deepEqual(reviewed.ledger,s.ledger);assert.equal(reviewed.loans.length,0);
});

test('mixed item collateral uses the staff-reviewed value and item credit within the staged trade',async()=>{
 const s=mixed(),placed=(await fundingStep(s,borrower,'collateral-placed')).state;
 for(const input of [{itemReference:67112960,notes:''},{itemReference:66666666,notes:'Reviewed Xanax value'}])await rejectsWithoutChanges(placed,owner,'collateral-reviewed',{input},/review|cover/i);
 const reviewed=(await fundingStep(placed,owner,'collateral-reviewed',{input:{itemReference:67112960,notes:'Reviewed 80 Xanax at $838,912 each'}})).state;
 const review=reviewed.fundingRequests[0].tradeFlow.collateralReviewed;
 assert.equal(review.cash,5e6);assert.equal(review.itemReference,67112960);assert.equal(review.itemCredit,60401664);assert.equal(review.credited,65401664);
 assert.equal(reviewed.fundingRequests[0].collateralConfirmed,false);assert.equal(reviewed.loans.length,0);assert.deepEqual(reviewed.ledger,s.ledger);
});

test('only the active receiving owner, vault or staff may review collateral through the trade menu',async()=>{
 for(const role of ['owner','vault','staff']){
  const s=approved();s.staff[0].role=role;
  const placed=(await fundingStep(s,borrower,'collateral-placed')).state;
  const reviewed=(await fundingStep(placed,owner,'collateral-reviewed')).state;
  assert.equal(reviewed.fundingRequests[0].tradeFlow.collateralReviewed.by,owner);
 }
 for(const patch of [{disabled:true},{role:'borrower'},{role:'auditor'},{role:undefined}]){
  const placed=(await fundingStep(approved(),borrower,'collateral-placed')).state;Object.assign(placed.staff[0],patch);
  await rejectsWithoutChanges(placed,owner,'collateral-reviewed',{},/receiving|borrower|available/);
 }
 const placed=(await fundingStep(approved(),borrower,'collateral-placed')).state;
 for(const actor of [borrower,'9999999'])await rejectsWithoutChanges(placed,actor,'collateral-reviewed',{},/receiving|borrower/);
});

test('a matching synchronized two-way receipt is consumed once when completed trade creates the loan',async()=>{
 const state=await readyFunding(mixed(),{itemReference:67112960}),offer=fundingTrade(state,{lenderCash:130e6,completed:true});
 const synced=reconcileTrade(state,owner,offer).state,receiptId=synced.receipts[0].id;
 assert.equal(synced.receipts[0].status,'review');assert.equal(synced.loans.length,0);
 const stale=TB.clone(synced);stale.receipts[0].cash=1;
 await rejectsWithoutChanges(stale,owner,'complete',{trade:offer},/assigned|consumed|archived/);
 const done=(await fundingStep(synced,owner,'complete',{trade:offer})).state;
 assert.equal(done.loans.length,1);assert.equal(done.fundingRequests.length,0);assert.equal(done.receipts.length,1);assert.equal(done.receipts[0].id,receiptId);assert.equal(done.receipts[0].status,'loan_trade');
 assert.equal(done.collateral.length,1);assert.equal(done.ledger.filter(entry=>entry.type==='disbursement').length,1);
 const repeated=await fundingStep(done,owner,'complete',{trade:offer});assert.equal(repeated.changed,false);assert.deepEqual(repeated.state,done);
});

test('assigned, consumed, duplicate and archived receipt evidence cannot create another loan',async()=>{
 const ready=await readyFunding(approved()),offer=fundingTrade(ready,{lenderCash:130e6,completed:true});
 for(const patch of [{borrower:'9000002'},{recipient:'9000102'},{status:'credited'},{status:'collateral'},{paymentId:'existing-payment'},{loanId:'existing-loan'}]){
  const state=reconcileTrade(ready,owner,offer).state;Object.assign(state.receipts[0],patch);
  await rejectsWithoutChanges(state,owner,'complete',{trade:offer},/assigned|consumed|archived/);
 }
 const duplicate=reconcileTrade(ready,owner,offer).state;duplicate.receipts.push({...duplicate.receipts[0],id:'duplicate'});
 await rejectsWithoutChanges(duplicate,owner,'complete',{trade:offer},/duplicate/);
 for(const change of [s=>{s.removedReferences=['torn-api-trade:'+apiTradeId];},s=>s.pendingPayments.push({reference:'torn-api-trade:'+apiTradeId}),s=>{s.recordArchives=[{records:{loans:[{id:'OTHER',fundsReceived:{reference:'torn-api-trade:'+apiTradeId}}]}}];}]){
  const state=TB.clone(ready);change(state);await rejectsWithoutChanges(state,owner,'complete',{trade:offer},/recorded|another|archived/);assert.equal(state.loans.length,0);
 }
});
