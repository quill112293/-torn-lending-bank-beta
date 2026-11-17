import {fundingRecord,seedHistoricalFundedLoan} from './helpers/funding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {canWithdrawApplication,collateralHolders,refreshCollateralReturn} from '../lib/application-withdrawal.js';
import {loanSlots} from '../lib/preapproval.js';
import {verifyCollateral} from '../lib/collateral-proof.js';

const owner='3542697',borrower='9000001',other='9000002';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function base(){
 const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'initial bank funding');
 TB.person(s,borrower).memberProgram='faction';return s;
}
function request(overrides={}){
 return {...TB.sampleApp({tier:0,items:[],requested:100e6,cashCollateral:100e6,...overrides}),acceptPreapproval:true};
}
function apply(s=base(),accepted=true){return applyAction(s,borrower,'apply',{...request(),acceptPreapproval:accepted},TB.today(),verified);}
function withdraw(s,who=borrower){return applyAction(s,who,'withdrawApplication',{id:s.applications[0].id});}
function collateralTrade(s){
 return {id:130,user:{id:Number(owner)},trader:{id:Number(borrower)},completed_at:Math.ceil(Date.parse(s.applications[0].created)/1000)+1,
  items:[{user_id:Number(borrower),type:'Money',details:{amount:100e6}}]};
}
function received(s=apply()){
 // Imported legacy custody: new separate collateral verification is disabled.
 const record=fundingRecord(s),reference='legacy-collateral:'+record.id;
 record.collateralConfirmed={by:owner,holder:owner,amount:100e6,reference,source:'Historical collateral receipt'};
 s.collateral??=[];s.collateral.push({id:'old-custody:'+record.id,loanId:record.id,event:'received',holder:owner,reference});
 s.receipts??=[];s.receipts.push({id:'old-receipt:'+record.id,loanId:record.id,status:'collateral',reference});return s;
}
function release(s,holder=owner,who=owner){
 return applyAction(s,who,'collateral',{id:fundingRecord(s).id,event:'released',holder,description:'Returned all collateral held for this request',reference:'completed-return:'+holder});
}

test('a borrower can withdraw a pending request while the bank is offline, retaining its history',()=>{
 const s=apply(base(),false),before=TB.clone(s);s.bankOnline=false;
 const a=s.applications[0];assert.equal(a.status,'pending');
 assert.equal(canWithdrawApplication(s,a,borrower),true);
 const changed=withdraw(s),result=changed.applications[0];
 assert.equal(result.status,'withdrawn');assert.equal(result.reference,a.reference);
 assert.equal(result.withdrawal.by,borrower);assert.equal(result.withdrawal.previousStatus,'pending');
 assert.equal(result.withdrawal.date,changed.testDate);assert.ok(Number.isFinite(Date.parse(result.withdrawal.at)));
 assert.deepEqual(result.reviewReasons,a.reviewReasons);assert.deepEqual(result.items,a.items);
 assert.equal(result.collateralReturnRequired,false);assert.deepEqual(changed.loans,[]);
 assert.deepEqual(changed.ledger,before.ledger);assert.deepEqual(changed.borrowers,before.borrowers);
 const event=changed.audit.at(-1);assert.equal(event.event,'Application withdrawn');assert.equal(event.actor,borrower);
 assert.deepEqual(event.subjectIds,[borrower]);assert.deepEqual(event.references,[a.reference]);assert.equal(event.applicationId,a.id);
 assert.deepEqual(event.loanIds,[]);assert.equal(canWithdrawApplication(changed,result,borrower),false);
 assert.equal(project(changed,borrower).state.applications[0].status,'withdrawn');
 assert.equal(s.applications[0].status,'pending');
});

test('approved withdrawal releases the loan slot and manual lender reservation without changing bank cash or trust',()=>{
 let s=apply(base(),false);
 s=applyAction(s,owner,'approve',{id:s.applications[0].id,amount:100e6,reason:'Staff reviewed',checks:true});
 const before=TB.clone(s),loan=fundingRecord(s),decision=TB.clone(s.applications[0].decision);
 assert.equal(TB.spendable(s,owner),900e6);assert.equal(loanSlots(s,borrower,{lane:'faction',tier:0}).remaining,0);
 s=withdraw(s);
 assert.equal(fundingRecord(s).status,'withdrawn');assert.equal(fundingRecord(s).principal,100e6);
 assert.equal(fundingRecord(s).withdrawal.previousStatus,'approved');assert.equal(fundingRecord(s).withdrawal.by,borrower);
 assert.deepEqual(s.applications[0].decision,decision);assert.equal(fundingRecord(s).issuer,owner);
 assert.equal(TB.cash(s,owner),1e9);assert.equal(TB.spendable(s,owner),1e9);
 assert.deepEqual(s.ledger,before.ledger);assert.deepEqual(s.borrowers,before.borrowers);
 assert.deepEqual(loanSlots(s,borrower,{lane:'faction',tier:0}),{open:0,limit:1,remaining:1});
 assert.deepEqual(TB.balance(fundingRecord(s),TB.addDays(s.testDate,120)),{principal:0,interest:0,total:0,late:0,unknown:false,allocations:[]});
 assert.deepEqual(TB.scheduleRows(fundingRecord(s),TB.addDays(s.testDate,120)),[]);
 assert.equal(TB.overview(s).principal,0);
 s=apply(s);assert.equal(s.applications.at(-1).status,'approved');assert.equal(s.fundingRequests.at(-1).status,'approved');
 assert.equal(fundingRecord(s).status,'withdrawn');assert.equal(s.borrowers[borrower].completed,before.borrowers[borrower].completed);
});

test('withdrawal is borrower-owned, terminal, and idempotent',()=>{
 const s=apply();
 for(const who of [other,owner]){
  assert.equal(canWithdrawApplication(s,s.applications[0],who),false);
  assert.throws(()=>withdraw(s,who),/Only the borrower/);
 }
 assert.throws(()=>applyAction(s,borrower,'withdrawApplication',{id:'not-found'}),/Only the borrower/);
 const once=withdraw(s),twice=withdraw(once);
 assert.deepEqual(twice,once);assert.equal(twice.audit.filter(event=>event.event==='Application withdrawn').length,1);
 for(const action of ['approve','deny','editApplication']){
  assert.throws(()=>applyAction(once,owner,action,{id:once.applications[0].id,amount:100e6,checks:true,reason:'Old screen',application:s.applications[0]}),/pending/i);
 }
 for(const action of ['fund','startDate','confirmTerms']){
  assert.throws(()=>applyAction(once,owner,action,{id:fundingRecord(once).id,start:TB.today(),reference:'Old screen'}),/unfunded|disbursement|closed|trade-page menu/i);
 }
 assert.throws(()=>verifyCollateral(once,owner,fundingRecord(once).id,collateralTrade(s),{checked:true}),/trade page|trade-page menu|standalone/i);
 assert.throws(()=>applyAction(once,owner,'piCollateral',{id:fundingRecord(once).id}),/trade page|trade-page menu|standalone/i);
 assert.throws(()=>applyAction(once,borrower,'paymentIntent',{id:fundingRecord(once).id,amount:1,recipient:owner}),/not active/);
});

test('denied requests and every funded or closed linked loan reject withdrawal',()=>{
 let pending=apply(base(),false);
 const denied=applyAction(pending,owner,'deny',{id:pending.applications[0].id,reason:'Declined'});
 assert.throws(()=>withdraw(denied),/Only pending or approved/);
 for(const status of ['active','repaid','defaulted','cancelled']){
  const s=apply();fundingRecord(s).status=status;
  assert.equal(canWithdrawApplication(s,s.applications[0],borrower),false);
  assert.throws(()=>withdraw(s),/funding or repayment records/);
 }
 const funded=received();
 const active=seedHistoricalFundedLoan(funded,fundingRecord(funded).id,{staffId:owner});
 const before=TB.clone(active);assert.throws(()=>withdraw(active),/funding or repayment records/);assert.deepEqual(active,before);
});

test('loan-linked cash movements and repayment evidence prevent withdrawal even with stale approved statuses',()=>{
 for(const evidence of [
  s=>s.ledger.push({id:'cash-out',loanId:fundingRecord(s).id,type:'disbursement',from:owner,to:'borrower:'+borrower,amount:100e6}),
  s=>s.ledger.push({id:'cash-in',loanId:fundingRecord(s).id,type:'repayment',from:'borrower:'+borrower,to:owner,amount:1}),
  s=>fundingRecord(s).payments.push({id:'accepted',date:TB.today(),credited:1}),
  s=>s.pendingPayments.push({id:'accepted',loanId:fundingRecord(s).id,status:'accepted'})
 ]){
  const s=apply();evidence(s);const before=TB.clone(s);
  assert.equal(canWithdrawApplication(s,s.applications[0],borrower),false);
  assert.throws(()=>withdraw(s),/funding or repayment records/);assert.deepEqual(s,before);
 }
 let s=base();s.borrowers[borrower].testParticipant=true;s=received(apply(s));
 s=seedHistoricalFundedLoan(s,fundingRecord(s).id,{staffId:owner});
 const loanId=fundingRecord(s).id;
 s=applyAction(s,owner,'removeRecords',{kind:'loan',id:loanId,confirm:'REMOVE '+loanId,reason:'Archived test record'});
 assert.equal(s.loans.length,0);assert.equal(s.applications[0].status,'approved');
 assert.throws(()=>withdraw(s),/funding or repayment records/);
});

test('direct funding is unavailable even for legacy collateral and stale approved statuses',()=>{
 const original=received();
 for(const mutate of [
  s=>{s.applications[0].status='withdrawn';},
  s=>{s.ledger.push({id:'already-funded',loanId:fundingRecord(s).id,type:'disbursement',from:owner,to:'borrower:'+borrower,amount:100e6});},
  s=>{fundingRecord(s).payments.push({id:'already-paid'});}
 ]){
  const s=TB.clone(original);s.actorId=owner;mutate(s);const before=TB.clone(s);
  assert.throws(()=>TB.fund(s,fundingRecord(s).id,'Duplicate or stale disbursement'),/trade-page menu|Separate disbursement/);
  assert.deepEqual(s,before);
 }
});

test('archived held collateral blocks withdrawal while completed archived returns and no custody allow it',()=>{
 for(const custody of ['held','returned','none']){
  let s=base();s.borrowers[borrower].testParticipant=true;s=apply(s);
  if(custody!=='none')s=received(s);
  if(custody==='returned'){
   // A reconciled historical import can retain approval while also recording
   // the completed return; the archive's own custody trail is authoritative.
   s.collateral.push({id:'historical-return',loanId:fundingRecord(s).id,borrowerId:borrower,event:'released',holder:owner,by:owner,description:'All collateral returned',reference:'completed historical return',date:TB.today()});
  }
  const loanId=fundingRecord(s).id;
  // Reproduce an archive created by the old separate-loan workflow.
  s.recordArchives=[{id:'old-archive',records:{loans:[fundingRecord(s)],collateral:TB.clone(s.collateral||[]),receipts:TB.clone(s.receipts||[])}}];
  s.fundingRequests=s.fundingRequests.filter(record=>record.id!==loanId);s.collateral=[];s.receipts=[];
  assert.equal(s.loans.length,0);assert.equal(s.applications[0].status,'approved');
  const before=TB.clone(s);
  if(custody==='held'){
   assert.equal(canWithdrawApplication(s,s.applications[0],borrower),false);
   assert.throws(()=>withdraw(s),/staff.*reconcile the archived collateral/i);
   assert.deepEqual(s,before);
  }else{
   assert.equal(canWithdrawApplication(s,s.applications[0],borrower),true);
   const result=withdraw(s);assert.equal(result.applications[0].status,'withdrawn');
   assert.equal(result.applications[0].collateralReturnRequired,false);
   assert.deepEqual(result.recordArchives,before.recordArchives);assert.deepEqual(result.ledger,before.ledger);
  }
 }
});

test('received collateral remains held after withdrawal until staff records its complete return',()=>{
 const original=received(),loanId=fundingRecord(original).id;
 const custody=TB.clone(original.collateral),receipt=TB.clone(original.receipts),confirmation=TB.clone(fundingRecord(original).collateralConfirmed);
 let s=withdraw(original);
 assert.equal(s.applications[0].collateralReturnRequired,true);assert.equal(fundingRecord(s).collateralReturnRequired,true);
 assert.deepEqual(s.collateral,custody);assert.deepEqual(s.receipts,receipt);assert.deepEqual(fundingRecord(s).collateralConfirmed,confirmation);
 assert.deepEqual(collateralHolders(s,fundingRecord(s)),[owner]);assert.deepEqual(s.ledger,original.ledger);
 assert.throws(()=>release(s,owner,borrower),/Staff permission/);
 s.staff.push({id:'9000102',role:'staff'});
 assert.throws(()=>release(s,'9000102'),/no outstanding collateral/);
 assert.throws(()=>applyAction(s,owner,'collateral',{id:loanId,event:'liquidated',holder:owner,description:'Liquidation',reference:'not-permitted'}),/must be returned/);
 s=release(s);
 assert.equal(fundingRecord(s).collateralReturnRequired,false);assert.equal(s.applications[0].collateralReturnRequired,false);
 assert.equal(fundingRecord(s).collateralReturned.by,owner);assert.equal(fundingRecord(s).collateralReturned.reference,'completed-return:'+owner);
 assert.deepEqual(s.collateral.slice(0,custody.length),custody);assert.equal(s.collateral.at(-1).event,'released');
 assert.deepEqual(s.receipts,receipt);assert.deepEqual(fundingRecord(s).collateralConfirmed,confirmation);assert.deepEqual(s.ledger,original.ledger);
 assert.throws(()=>release(s),/no outstanding collateral/);
 const next=apply(s);assert.equal(next.fundingRequests.at(-1).status,'approved');
 assert.throws(()=>verifyCollateral(next,owner,next.fundingRequests.at(-1).id,collateralTrade(original),{checked:true}),/trade page|standalone|separate/i);
});

test('return tracking handles multiple holders and collateral received after withdrawal',()=>{
 let s=received();s.staff.push({id:'9000102',role:'staff'});
 s.collateral.push({id:'second-old-custody',loanId:fundingRecord(s).id,event:'received',holder:'9000102',description:'Historical received assets',reference:'second receipt'});
 s=withdraw(s);assert.deepEqual(new Set(collateralHolders(s,fundingRecord(s))),new Set([owner,'9000102']));
 s=release(s,owner);assert.equal(fundingRecord(s).collateralReturnRequired,true);assert.equal(s.applications[0].collateralReturnRequired,true);
 s=release(s,'9000102');assert.equal(fundingRecord(s).collateralReturnRequired,false);assert.equal(s.applications[0].collateralReturnRequired,false);
 assert.throws(()=>applyAction(s,owner,'collateral',{id:fundingRecord(s).id,event:'received',holder:owner,description:'Late arriving collateral',reference:'late receipt'}),/trade-page menu/);
 s.collateral.push({id:'old-late-custody',loanId:fundingRecord(s).id,event:'received',holder:owner,reference:'historical late receipt'});refreshCollateralReturn(s,fundingRecord(s));
 assert.equal(fundingRecord(s).collateralReturnRequired,true);assert.equal(s.applications[0].collateralReturnRequired,true);assert.equal(fundingRecord(s).collateralReturned,undefined);
 assert.equal(fundingRecord(s).status,'withdrawn');assert.equal(s.applications[0].status,'withdrawn');
 s=release(s);assert.equal(fundingRecord(s).collateralReturnRequired,false);
});

test('proposed collateral alone does not become held collateral or a recorded return',()=>{
 const s=withdraw(apply());assert.equal(s.applications[0].cashCollateral,100e6);
 assert.equal(s.applications[0].collateralReturnRequired,false);assert.equal(fundingRecord(s).collateralReturnRequired,false);
 assert.equal(fundingRecord(s).collateralReturned,undefined);
 assert.throws(()=>release(s),/no outstanding collateral/);
});

test('legacy unknown custody can be resolved with an actual holder and disabled holders can return assets',()=>{
 let legacy=apply();fundingRecord(legacy).collateralConfirmed=true;
 legacy=withdraw(legacy);assert.deepEqual(collateralHolders(legacy,fundingRecord(legacy)),['']);
 assert.throws(()=>release(legacy,''),/actual holder/);
 legacy=release(legacy,owner);assert.equal(fundingRecord(legacy).collateralReturnRequired,false);
 assert.equal(fundingRecord(legacy).collateralConfirmed,true);
 let recorded=apply();fundingRecord(recorded).collateralConfirmed=true;
 recorded.staff.push({id:'9000102',role:'staff',disabled:true});
 recorded.collateral=[{loanId:fundingRecord(recorded).id,event:'received',holder:'9000102',description:'Existing custody with former staff',reference:'legacy-receipt'}];
 recorded=withdraw(recorded);assert.deepEqual(collateralHolders(recorded,fundingRecord(recorded)),['9000102']);
 recorded=release(recorded,'9000102');assert.equal(fundingRecord(recorded).collateralReturnRequired,false);
 assert.equal(recorded.collateral.at(-1).holder,'9000102');assert.equal(recorded.collateral.at(-1).by,owner);
});

test('PI payment collateral can be released after withdrawal without deleting its original payment evidence',()=>{
 let s=base();Object.assign(s.borrowers[borrower],{memberProgram:'external',piRto:true});
 s=applyAction(s,borrower,'apply',request({lane:'external',tier:4,product:'bank',piRto:true,cashCollateral:0,piCollateral:10e6}),TB.today(),verified);
 fundingRecord(s).collateralConfirmed={by:owner,holder:owner,amount:10e6,piAmount:10e6,reference:'PI-001 payment ledger',source:'Historical PI collateral'};
 s.collateral=[{loanId:fundingRecord(s).id,event:'received',holder:owner,amount:10e6,reference:'PI-001 payment ledger'}];
 const confirmation=TB.clone(fundingRecord(s).collateralConfirmed),custody=TB.clone(s.collateral[0]),ledger=TB.clone(s.ledger);
 s=withdraw(s);assert.equal(fundingRecord(s).collateralReturnRequired,true);
 s=release(s);assert.equal(fundingRecord(s).collateralReturnRequired,false);
 assert.deepEqual(fundingRecord(s).collateralConfirmed,confirmation);assert.deepEqual(s.collateral[0],custody);assert.deepEqual(s.ledger,ledger);
 assert.equal(fundingRecord(s).status,'withdrawn');
});
