import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {reconcileTrade} from '../lib/trades.js';

const owner='3542697',borrower='9000001';
const created='2026-11-16T05:00:00.000Z';
const accepted={checked:true};

function approved(){
 const s=TB.newState();s.bankOnline=true;
 TB.topup(s,1e9,'existing bank funds');
 const a=TB.addApplication(s,TB.sampleApp({
  lane:'external',tier:1,product:'bank',completed:1,networth:1e9,
  requested:130e6,cashCollateral:65e6,items:[],created,
  start:'2026-11-16',maturity:'2027-02-14'
 }));
 const l=TB.approve(s,a.id,130e6,'Reviewed application',true);
 l.collateralRequired=TB.collateralRequired(a,l.principal,s.rules);
 l.collateralConfirmed=false;l.reference='TLB-COLLATERAL-TEST';
 assert.equal(l.collateralRequired,65e6);
 return s;
}

function trade({cash=65e6,items=[],recipient=owner,id=123}={}){
 return {
  id,user:{id:Number(recipient)},trader:{id:Number(borrower)},
  completed_at:Date.parse(created)/1000+60,
  items:[{user_id:Number(borrower),type:'Money',details:{amount:cash}},...items]
 };
}

const xanax={user_id:Number(borrower),type:'Item',details:{id:206,amount:80}};

function rejectsWithoutChanges(s,receipt,review,pattern,staff=owner){
 const before=structuredClone(s);
 assert.throws(()=>verifyCollateral(s,staff,s.loans[0].id,receipt,review),pattern);
 assert.deepEqual(s,before);
}

test('cash collateral needs explicit staff acceptance and the full required amount',()=>{
 const s=approved(),t=trade();
 for(const checked of [undefined,false,'true',1]){
  rejectsWithoutChanges(s,t,{checked},/Confirm you reviewed and accept the collateral trade/);
 }
 rejectsWithoutChanges(s,trade({cash:65e6-1}),accepted,/does not cover/);
 const ledger=TB.clone(s.ledger);
 verifyCollateral(s,owner,s.loans[0].id,t,accepted);
 assert.equal(s.loans[0].collateralConfirmed.amount,65e6);
 assert.equal(s.loans[0].collateralConfirmed.by,owner);
 assert.equal(s.loans[0].status,'approved');
 assert.deepEqual(s.ledger,ledger);
 assert.deepEqual(s.loans[0].payments,[]);
});

test('mixed item collateral uses accepted value and item credit before enabling funding',()=>{
 const s=approved(),t=trade({cash:5e6,items:[xanax]});
 const review={checked:true,itemReference:80*838912,notes:'Received 80 Xanax; reviewed current market value.'};
 rejectsWithoutChanges(s,t,{...review,checked:false},/Confirm you reviewed and accept/);
 rejectsWithoutChanges(s,t,{...review,notes:''},/review and accept the received item values/);
 rejectsWithoutChanges(s,t,{...review,itemReference:66666666},/does not cover/);
 const ledger=TB.clone(s.ledger);
 verifyCollateral(s,owner,s.loans[0].id,t,review);
 const confirmation=s.loans[0].collateralConfirmed;
 assert.equal(confirmation.cash,5e6);
 assert.equal(confirmation.itemReference,67112960);
 assert.equal(confirmation.itemCredit,60401664);
 assert.equal(confirmation.amount,65401664);
 assert.equal(confirmation.notes,review.notes);
 assert.deepEqual(s.receipts[0].items,[xanax]);
 assert.equal(s.loans[0].status,'approved');
 assert.deepEqual(s.ledger,ledger);
});

test('only active owner, vault and staff accounts may accept collateral',()=>{
 for(const role of ['owner','vault','staff']){
  const s=approved();s.staff[0].role=role;
  verifyCollateral(s,owner,s.loans[0].id,trade(),accepted);
  assert.equal(s.loans[0].collateralConfirmed.by,owner);
 }
 for(const patch of [{disabled:true},{role:'borrower'},{role:'auditor'},{role:undefined}]){
  const s=approved();Object.assign(s.staff[0],patch);
  rejectsWithoutChanges(s,trade(),accepted,/Only receiving staff/,owner);
 }
 for(const id of [borrower,'9999999']){
  rejectsWithoutChanges(approved(),trade(),accepted,/Only receiving staff/,id);
 }
});

test('a synchronized unassigned receipt is claimed once using the freshly verified trade',()=>{
 const t=trade({cash:5e6,items:[xanax]});
 const s=reconcileTrade(approved(),owner,t).state;
 const receipt=s.receipts[0],receiptId=receipt.id;
 assert.equal(receipt.status,'review');
 assert.equal(receipt.paymentId,undefined);
 assert.equal(receipt.loanId,undefined);
 // A cached summary never replaces the newly fetched completed trade evidence.
 receipt.cash=1;receipt.items=[];
 const ledger=TB.clone(s.ledger);
 verifyCollateral(s,owner,s.loans[0].id,t,{checked:true,itemReference:80*838912,notes:'Reviewed received Xanax.'});
 assert.equal(s.receipts.length,1);
 assert.equal(s.receipts[0].id,receiptId);
 assert.equal(s.receipts[0].status,'collateral');
 assert.equal(s.receipts[0].loanId,s.loans[0].id);
 assert.equal(s.receipts[0].cash,5e6);
 assert.deepEqual(s.receipts[0].items,[xanax]);
 assert.equal(s.collateral.length,1);
 assert.deepEqual(s.ledger,ledger);
 rejectsWithoutChanges(s,t,accepted,/awaiting cash collateral/);
 const second={...TB.clone(s.loans[0]),id:'other-approved-loan',collateralConfirmed:false};
 s.loans.push(second);
 assert.throws(()=>verifyCollateral(s,owner,second.id,t,{checked:true,itemReference:80*838912,notes:'Repeated trade.'}),/already recorded/);
 assert.equal(s.receipts.length,1);
 assert.equal(s.collateral.length,1);
});

test('mismatched, assigned, consumed and duplicate receipts cannot be reclaimed as collateral',()=>{
 const t=trade();
 for(const patch of [
  {borrower:'9000002'},{recipient:'9000102'},{status:'credited'},{status:'collateral'},
  {paymentId:'existing-payment'},{loanId:'existing-loan'}
 ]){
  const s=reconcileTrade(approved(),owner,t).state;
  Object.assign(s.receipts[0],patch);
  rejectsWithoutChanges(s,t,accepted,/already recorded/);
 }
 const duplicate=reconcileTrade(approved(),owner,t).state;
 duplicate.receipts.push({...duplicate.receipts[0],id:'duplicate-receipt'});
 rejectsWithoutChanges(duplicate,t,accepted,/already recorded/);
 for(const markConsumed of [
  s=>{s.removedReferences=['torn-api-trade:123'];},
  s=>{s.pendingPayments.push({reference:'torn-api-trade:123'});},
  s=>{s.loans[0].payments.push({reference:'torn-api-trade:123'});},
  s=>{s.loans.push({...TB.clone(s.loans[0]),id:'other-loan',collateralConfirmed:{reference:'torn-api-trade:123'}});}
 ]){
  const s=reconcileTrade(approved(),owner,t).state;
  markConsumed(s);
  rejectsWithoutChanges(s,t,accepted,/already recorded/);
 }
});
