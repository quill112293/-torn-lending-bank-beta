import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {filterHistory} from '../lib/history.js';

const owner='3542697',borrower='9000001';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function base(){const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'initial');TB.person(s,borrower).piRto=true;return s;}
function proposal(overrides={}){return {...TB.sampleApp({lane:'external',tier:4,product:'bank',piRto:true,networth:1e9,requested:100e6,items:[],cashCollateral:0,piCollateral:10e6,...overrides}),acceptPreapproval:true};}
function pending(s=base()){return applyAction(s,borrower,'apply',proposal(),TB.today(),verified);}
function approved(){let s=pending();return applyAction(s,owner,'approve',{id:s.applications[0].id,amount:100e6,checks:true});}
function payload(s,overrides={}){return {id:s.loans[0].id,amount:10e6,description:'Accepted value from reviewed PI rental payments',holder:owner,checked:true,...overrides};}

test('PI payment proposal supports the requested loan but always needs lender review',()=>{
 const s=pending(),a=s.applications[0];
 assert.equal(a.piCollateral,10e6);assert.equal(a.cashCollateral,0);
 assert.equal(TB.quote(a,s.rules).amount,100e6);assert.equal(a.preapproval.credited,10e6);
 assert.equal(s.loans.length,0);assert.equal(a.status,'pending');
 assert.ok(a.reviewReasons.includes('PI payment collateral requires lender review'));
 const legacy=proposal();delete legacy.piCollateral;
 assert.equal(TB.normalizeApp(legacy).piCollateral,0);assert.equal(TB.quote(legacy).credited,0);
});

test('manual PI collateral needs no trade or reference and enables ordinary funding after terms',()=>{
 let s=approved();const loanId=s.loans[0].id;
 assert.equal(s.loans[0].collateralRequired,10e6);
 assert.throws(()=>applyAction(s,owner,'fund',{id:loanId,reference:'sent'}),/collateral/);
 const before=TB.clone(s),recorded=applyAction(s,owner,'piCollateral',payload(s));
 const confirmation=recorded.loans[0].collateralConfirmed;
 assert.equal(confirmation.amount,10e6);assert.match(confirmation.source,/PI payment/);
 assert.equal(confirmation.evidenceReference,'');assert.equal(confirmation.by,owner);
 assert.deepEqual(recorded.ledger,before.ledger);assert.deepEqual(recorded.pendingPayments,before.pendingPayments);
 assert.deepEqual(recorded.receipts,before.receipts);assert.deepEqual(recorded.loans[0].payments,[]);
 assert.equal(TB.balance(recorded.loans[0],recorded.testDate).principal,100e6);
 assert.equal(recorded.collateral[0].reference,confirmation.reference);
 const history=filterHistory(recorded,{userId:borrower,category:'collateral'});
 assert.equal(history.length,1);assert.match(history[0].event,/PI payment collateral/);
 assert.equal(project(recorded,borrower).state.collateral[0].amount,10e6);
 assert.equal(project(recorded,'9999999').state.collateral.length,0);
 assert.throws(()=>applyAction(recorded,owner,'fund',{id:loanId,reference:'sent'}),/confirmation/);
 s=applyAction(recorded,borrower,'confirmTerms',{id:loanId});
 s=applyAction(s,owner,'fund',{id:loanId,reference:'completed outgoing transfer'});
 assert.equal(s.loans[0].status,'active');assert.equal(TB.cash(s,owner),900e6);
});

test('current saved PI status is required for proposal, edits, approval and confirmation',()=>{
 const s=base();s.borrowers[borrower].piRto=false;
 assert.throws(()=>applyAction(s,borrower,'apply',proposal({lane:'faction',tier:0,product:'house'}),TB.today(),verified),/saved Private Island status/);
 assert.throws(()=>applyAction(s,owner,'apply',proposal()),/saved Private Island status/);
 const p=pending();p.borrowers[borrower].piRto=false;
 assert.throws(()=>applyAction(p,owner,'editApplication',{id:p.applications[0].id,application:p.applications[0]}),/saved Private Island status/);
 assert.throws(()=>applyAction(p,owner,'approve',{id:p.applications[0].id,amount:100e6,checks:true}),/saved Private Island status/);
 const a=approved();a.borrowers[borrower].piRto=false;
 assert.throws(()=>applyAction(a,owner,'piCollateral',payload(a)),/saved Private Island status/);
});

test('PI confirmation rejects borrowers, disabled staff, invalid values and missing evidence',()=>{
 const s=approved();s.staff.push({id:'111',role:'staff',disabled:true});
 for(const id of [borrower,'777','111'])assert.throws(()=>applyAction(s,id,'piCollateral',payload(s)),/Staff permission/);
 for(const value of [0,-1,9999999,1.5,NaN,Infinity,1e15])assert.throws(()=>applyAction(s,owner,'piCollateral',payload(s,{amount:value})),/collateral|between|whole/i);
 for(const fields of [{description:''},{checked:false},{holder:borrower},{holder:'111'}])assert.throws(()=>applyAction(s,owner,'piCollateral',payload(s,fields)),/Explain|Confirm|active lender/);
 assert.equal(s.collateral.length,0);assert.equal(s.loans[0].collateralConfirmed,false);
});

test('PI collateral is recorded once, cannot replace Torn confirmation, and retains lender evidence',()=>{
 const s=approved();s.staff.push({id:'222',role:'staff',name:'Receiving lender'});
 const r=applyAction(s,'222','piCollateral',payload(s,{holder:'222',amount:15e6,evidenceReference:'PI-001 payment ledger'}));
 assert.equal(r.collateral[0].amount,15e6);assert.equal(r.collateral[0].by,'222');assert.equal(r.collateral[0].holder,'222');
 assert.equal(r.collateral[0].evidenceReference,'PI-001 payment ledger');
 assert.throws(()=>applyAction(r,owner,'piCollateral',payload(r)),/awaiting collateral/);
 assert.throws(()=>verifyCollateral(r,owner,r.loans[0].id,{}),/awaiting cash collateral/);
 const t=approved();t.loans[0].collateralConfirmed={reference:'torn-api-trade:123'};
 assert.throws(()=>applyAction(t,owner,'piCollateral',payload(t)),/awaiting collateral/);
 for(const status of ['active','repaid','denied']){const changed=approved();changed.loans[0].status=status;assert.throws(()=>applyAction(changed,owner,'piCollateral',payload(changed)),/awaiting collateral/);}
});

test('existing waiting loans accept PI value after the user is labelled, including archived applications',()=>{
 let s=base();s.borrowers[borrower].piRto=false;
 s=applyAction(s,borrower,'apply',{...proposal({lane:'faction',tier:0,product:'house',piCollateral:0,cashCollateral:100e6,piRto:false})},TB.today(),verified);
 assert.equal(s.loans.length,1);const appId=s.applications[0].id;
 s=applyAction(s,owner,'userStatus',{id:borrower,piRto:true,reason:'Confirmed PI rental participant'});
 s=applyAction(s,owner,'removeRecords',{kind:'application',id:appId,confirm:'REMOVE '+appId,reason:'Archive application only'});
 const result=applyAction(s,owner,'piCollateral',payload(s,{amount:s.loans[0].collateralRequired}));
 assert.ok(result.loans[0].collateralConfirmed);assert.equal(result.applications.length,0);
});
